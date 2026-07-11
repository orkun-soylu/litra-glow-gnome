/* Litra Glow — GNOME Quick Settings control for Logitech Litra devices.
 *
 * Architecture: this extension is a thin front-end. All device I/O is done by
 * the `litra` CLI (timrogers/litra-rs), which we spawn. State is discovered by
 * polling `litra devices --json`. The toggle + sliders are only shown while a
 * device is connected.
 */

import GObject from 'gi://GObject';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import {QuickSlider, QuickToggle, SystemIndicator} from 'resource:///org/gnome/shell/ui/quickSettings.js';

const POLL_INTERVAL_SECONDS = 5;   // how often we re-check device presence/state
const COMMAND_DEBOUNCE_MS = 220;   // coalesce rapid slider drags into one command
const USER_HOLD_MS = 2000;         // don't let a poll fight a recent user change

/* ---------- helpers ---------------------------------------------------- */

function clamp(v, lo, hi) {
    return Math.min(hi, Math.max(lo, v));
}

// Spawn `litra <args...>` and ignore output (fire-and-forget control command).
function litraRun(litraPath, args) {
    try {
        const proc = Gio.Subprocess.new(
            [litraPath, ...args],
            Gio.SubprocessFlags.STDOUT_SILENCE | Gio.SubprocessFlags.STDERR_PIPE
        );
        proc.wait_check_async(null, (p, res) => {
            try {
                p.wait_check_finish(res);
            } catch (e) {
                logError(e, `litra ${args.join(' ')} failed`);
            }
        });
    } catch (e) {
        logError(e, 'failed to spawn litra');
    }
}

// Run `litra devices --json` and hand the parsed array to `cb`. On any error,
// `cb` is called with null.
function litraDevices(litraPath, cancellable, cb) {
    let proc;
    try {
        proc = Gio.Subprocess.new(
            [litraPath, 'devices', '--json'],
            Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_SILENCE
        );
    } catch (e) {
        cb(null);
        return;
    }
    proc.communicate_utf8_async(null, cancellable, (p, res) => {
        let out = null;
        try {
            const [, stdout] = p.communicate_utf8_finish(res);
            out = JSON.parse(stdout);
            if (!Array.isArray(out))
                out = null;
        } catch (e) {
            out = null;
        }
        cb(out);
    });
}

/* ---------- Quick Settings toggle -------------------------------------- */

const LitraToggle = GObject.registerClass(
class LitraToggle extends QuickToggle {
    _init() {
        super._init({
            title: 'Litra Glow',
            iconName: 'night-light-symbolic',
            toggleMode: true,
        });
    }
});

/* ---------- indicator (owns the toggle + sliders) ---------------------- */

const LitraIndicator = GObject.registerClass(
class LitraIndicator extends SystemIndicator {
    _init(litraPath) {
        super._init();

        this._litraPath = litraPath;
        this._syncing = false;         // suppress handlers during programmatic sync
        this._lastUserAction = 0;       // ms timestamp of last user interaction
        this._cancellable = new Gio.Cancellable();

        // brightness/temperature device limits (lumen / kelvin)
        this._brightMin = 20;
        this._brightMax = 250;
        this._tempMin = 2700;
        this._tempMax = 6500;

        this._brightPending = 0;        // debounce timeout source ids
        this._tempPending = 0;

        // Power toggle
        this._toggle = new LitraToggle();
        this._toggle.connect('notify::checked', () => {
            if (this._syncing)
                return;
            this._markUser();
            litraRun(this._litraPath, [this._toggle.checked ? 'on' : 'off']);
        });

        // Brightness slider
        this._bright = new QuickSlider({iconName: 'display-brightness-symbolic'});
        this._bright.slider.connect('notify::value', () => {
            if (this._syncing)
                return;
            this._markUser();
            const lumen = Math.round(
                this._brightMin + this._bright.slider.value * (this._brightMax - this._brightMin));
            this._debounceBright(clamp(lumen, this._brightMin, this._brightMax));
        });

        // Colour temperature slider
        this._temp = new QuickSlider({iconName: 'weather-clear-symbolic'});
        this._temp.slider.connect('notify::value', () => {
            if (this._syncing)
                return;
            this._markUser();
            const raw = this._tempMin + this._temp.slider.value * (this._tempMax - this._tempMin);
            const kelvin = clamp(Math.round(raw / 100) * 100, this._tempMin, this._tempMax);
            this._debounceTemp(kelvin);
        });

        this.quickSettingsItems.push(this._toggle);
        this.quickSettingsItems.push(this._bright);
        this.quickSettingsItems.push(this._temp);

        this._setVisible(false);        // hidden until a device is found

        // Poll for presence/state.
        this._poll();
        this._pollId = GLib.timeout_add_seconds(
            GLib.PRIORITY_DEFAULT, POLL_INTERVAL_SECONDS, () => {
                this._poll();
                return GLib.SOURCE_CONTINUE;
            });
    }

    _markUser() {
        this._lastUserAction = GLib.get_monotonic_time() / 1000;
    }

    _setVisible(visible) {
        for (const item of this.quickSettingsItems)
            item.visible = visible;
    }

    _debounceBright(lumen) {
        if (this._brightPending)
            GLib.source_remove(this._brightPending);
        this._brightPending = GLib.timeout_add(GLib.PRIORITY_DEFAULT, COMMAND_DEBOUNCE_MS, () => {
            this._brightPending = 0;
            litraRun(this._litraPath, ['brightness', '--value', String(lumen)]);
            return GLib.SOURCE_REMOVE;
        });
    }

    _debounceTemp(kelvin) {
        if (this._tempPending)
            GLib.source_remove(this._tempPending);
        this._tempPending = GLib.timeout_add(GLib.PRIORITY_DEFAULT, COMMAND_DEBOUNCE_MS, () => {
            this._tempPending = 0;
            litraRun(this._litraPath, ['temperature', '--value', String(kelvin)]);
            return GLib.SOURCE_REMOVE;
        });
    }

    _poll() {
        litraDevices(this._litraPath, this._cancellable, (devices) => {
            if (!devices || devices.length === 0) {
                this._setVisible(false);
                return;
            }

            const d = devices[0];      // control the first connected Litra
            this._setVisible(true);
            this._toggle.title = d.device_type_display || 'Litra Glow';

            // Update limits when present.
            if (Number.isFinite(d.minimum_brightness_in_lumen))
                this._brightMin = d.minimum_brightness_in_lumen;
            if (Number.isFinite(d.maximum_brightness_in_lumen))
                this._brightMax = d.maximum_brightness_in_lumen;
            if (Number.isFinite(d.minimum_temperature_in_kelvin))
                this._tempMin = d.minimum_temperature_in_kelvin;
            if (Number.isFinite(d.maximum_temperature_in_kelvin))
                this._tempMax = d.maximum_temperature_in_kelvin;

            // Don't yank controls out from under a recent user interaction.
            const now = GLib.get_monotonic_time() / 1000;
            if (now - this._lastUserAction < USER_HOLD_MS)
                return;

            this._syncing = true;
            try {
                this._toggle.checked = !!d.is_on;
                if (this._brightMax > this._brightMin && Number.isFinite(d.brightness_in_lumen)) {
                    this._bright.slider.value = clamp(
                        (d.brightness_in_lumen - this._brightMin) /
                        (this._brightMax - this._brightMin), 0, 1);
                }
                if (this._tempMax > this._tempMin && Number.isFinite(d.temperature_in_kelvin)) {
                    this._temp.slider.value = clamp(
                        (d.temperature_in_kelvin - this._tempMin) /
                        (this._tempMax - this._tempMin), 0, 1);
                }
            } finally {
                this._syncing = false;
            }
        });
    }

    destroy() {
        if (this._pollId) {
            GLib.source_remove(this._pollId);
            this._pollId = 0;
        }
        if (this._brightPending) {
            GLib.source_remove(this._brightPending);
            this._brightPending = 0;
        }
        if (this._tempPending) {
            GLib.source_remove(this._tempPending);
            this._tempPending = 0;
        }
        this._cancellable.cancel();
        this.quickSettingsItems.forEach(item => item.destroy());
        this.quickSettingsItems = [];
        super.destroy();
    }
});

/* ---------- extension entry point -------------------------------------- */

export default class LitraExtension extends Extension {
    enable() {
        const litraPath = GLib.find_program_in_path('litra') || '/usr/bin/litra';
        this._indicator = new LitraIndicator(litraPath);
        Main.panel.statusArea.quickSettings.addExternalIndicator(this._indicator);
    }

    disable() {
        this._indicator?.destroy();
        this._indicator = null;
    }
}
