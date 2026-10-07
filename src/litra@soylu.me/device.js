// SPDX-License-Identifier: GPL-2.0-or-later

/* hidraw discovery and asynchronous I/O for a Litra light.
 *
 * Reads use pollable GioUnix streams, so a pending read can be cancelled on
 * disable() instead of leaving a thread blocked in read(). Requests are sent
 * one at a time.
 */

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import GioUnix from 'gi://GioUnix';

import * as Proto from './protocol.js';

const REPLY_TIMEOUT_MS = 1000;
const READ_SIZE = 64;           // one read returns one report

/* Read a small file asynchronously. */
function readFile(path) {
    return new Promise((resolve, reject) => {
        Gio.File.new_for_path(path).load_contents_async(null, (file, res) => {
            try {
                resolve(file.load_contents_finish(res)[1]);
            } catch (e) {
                reject(e);
            }
        });
    });
}

/* Resolves with {path, model} of the first Litra hidraw node, or null. */
export async function findDevice() {
    const base = '/sys/class/hidraw';
    let names = [];
    try {
        const dir = GLib.Dir.open(base, 0);
        let name;
        while ((name = dir.read_name()) !== null)
            names.push(name);
        dir.close();
    } catch {
        return null;
    }
    names = names.sort((a, b) => a.localeCompare(b, undefined, {numeric: true}));

    for (const name of names) {
        const devDir = `${base}/${name}/device`;
        let uevent;
        try {
            uevent = new TextDecoder().decode(await readFile(`${devDir}/uevent`));
        } catch {
            continue;
        }

        // HID_ID=<bus>:<vendor>:<product>, each in hex
        const id = uevent.split('\n').find(l => l.startsWith('HID_ID='));
        if (!id)
            continue;
        const [, vendor, product] = id.slice(7).split(':').map(h => parseInt(h, 16));
        const model = Proto.MODELS.get(product);
        if (vendor !== Proto.VENDOR_ID || !model)
            continue;

        let desc;
        try {
            desc = await readFile(`${devDir}/report_descriptor`);
        } catch {
            continue;
        }

        // Usage Page item: 0x06, then the page as little-endian u16
        const page = Proto.USAGE_PAGE;
        for (let i = 0; i + 2 < desc.length; i++) {
            if (desc[i] === 0x06 && desc[i + 1] === (page & 0xff) && desc[i + 2] === page >> 8)
                return {path: `/dev/${name}`, model};
        }
    }
    return null;
}

export class LitraDevice {
    /* onEvent: the light reported a change itself. onLost: the node failed. */
    constructor(path, model, {onEvent, onLost}) {
        this.path = path;
        this.model = model;
        this._onEvent = onEvent;
        this._onLost = onLost;

        this._io = null;
        this._input = null;
        this._output = null;
        this._cancellable = null;
        this._queue = Promise.resolve();
        this._waiter = null;    // the get in flight
    }

    /** Throws if the node cannot be opened. */
    open() {
        const io = Gio.File.new_for_path(this.path).open_readwrite(null);
        const fd = io.get_input_stream().get_fd();

        this._io = io;
        this._input = GioUnix.InputStream.new(fd, false);
        this._output = GioUnix.OutputStream.new(fd, false);
        this._cancellable = new Gio.Cancellable();
        this._readLoop();
    }

    close() {
        if (!this._io)
            return;

        this._cancellable.cancel();
        this._failWaiter(new Error('device closed'));
        try {
            this._io.close(null);
        } catch {
            // ignore
        }
        this._io = this._input = this._output = this._cancellable = null;
    }

    get isOpen() {
        return this._io !== null;
    }

    /** Resolves with {on, lumen, kelvin}. */
    async readState() {
        const on = Proto.readOn(await this._get(Proto.GET_ON));
        const lumen = Proto.readU16(await this._get(Proto.GET_BRIGHTNESS));
        const kelvin = Proto.readU16(await this._get(Proto.GET_TEMPERATURE));
        return {on, lumen, kelvin};
    }

    setOn(on) {
        return this._set(Proto.setOnReport(this.model, on));
    }

    setBrightness(lumen) {
        return this._set(Proto.setBrightnessReport(this.model, lumen));
    }

    setTemperature(kelvin) {
        return this._set(Proto.setTemperatureReport(this.model, kelvin));
    }

    // Run `task` after the previously queued ones, whatever their outcome.
    _enqueue(task) {
        const result = this._queue.then(task);
        this._queue = result.catch(() => {});
        return result;
    }

    _get(fn) {
        return this._enqueue(() => new Promise((resolve, reject) => {
            if (!this.isOpen) {
                reject(new Error('device closed'));
                return;
            }
            const timeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, REPLY_TIMEOUT_MS, () => {
                this._waiter.timeoutId = 0;
                this._failWaiter(new Error(`no reply to 0x${fn.toString(16)}`));
                return GLib.SOURCE_REMOVE;
            });
            this._waiter = {fn, resolve, reject, timeoutId};
            this._write(Proto.buildReport(this.model.feature, fn))
                .catch(e => this._failWaiter(e));
        }));
    }

    _set(report) {
        return this._enqueue(() => this._write(report));
    }

    _write(report) {
        return new Promise((resolve, reject) => {
            if (!this.isOpen) {
                reject(new Error('device closed'));
                return;
            }
            this._output.write_bytes_async(new GLib.Bytes(report), GLib.PRIORITY_DEFAULT,
                this._cancellable, (stream, res) => {
                    try {
                        stream.write_bytes_finish(res);
                        resolve();
                    } catch (e) {
                        reject(e);
                    }
                });
        });
    }

    _failWaiter(error) {
        const w = this._waiter;
        if (!w)
            return;
        this._waiter = null;
        if (w.timeoutId)
            GLib.source_remove(w.timeoutId);
        w.reject(error);
    }

    _readLoop() {
        this._input.read_bytes_async(READ_SIZE, GLib.PRIORITY_DEFAULT, this._cancellable,
            (stream, res) => {
                let data;
                try {
                    data = stream.read_bytes_finish(res).toArray();
                } catch (e) {
                    if (!e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                        this._lost(e);
                    return;
                }
                if (data.length === 0) {    // EOF
                    this._lost(new Error('end of stream'));
                    return;
                }

                this._dispatch(Proto.parseReport(data));
                if (this.isOpen)
                    this._readLoop();
            });
    }

    _dispatch(report) {
        if (!report)
            return;

        const w = this._waiter;
        switch (report.kind) {
        case 'reply':
            if (w && report.feature === this.model.feature && report.fn === w.fn) {
                this._waiter = null;
                GLib.source_remove(w.timeoutId);
                w.resolve(report.payload);
            }
            break;
        case 'error':
            if (w && report.feature === this.model.feature && report.fn === w.fn)
                this._failWaiter(new Error(`HID++ error 0x${report.code.toString(16)}`));
            else
                console.warn(`litra: HID++ error 0x${report.code.toString(16)} for 0x${report.fn.toString(16)}`);
            break;
        case 'event':
            if (report.feature === this.model.feature)
                this._onEvent?.();
            break;
        }
    }

    _lost(error) {
        this.close();
        this._onLost?.(error);
    }
}
