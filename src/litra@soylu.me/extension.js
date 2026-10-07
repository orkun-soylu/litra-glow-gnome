// SPDX-License-Identifier: GPL-2.0-or-later

/* Litra Glow — GNOME Quick Settings control for Logitech Litra devices.
 *
 * The light is driven directly over its hidraw node (device.js, protocol.js);
 * nothing outside this directory is needed except a udev rule granting access.
 * State is discovered by polling. The toggle is shown only while a device is
 * connected; brightness and temperature live in the toggle's popup menu.
 */

import GObject from 'gi://GObject';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import {QuickMenuToggle, SystemIndicator} from 'resource:///org/gnome/shell/ui/quickSettings.js';
import {Slider} from 'resource:///org/gnome/shell/ui/slider.js';

import {LitraDevice, findDevice} from './device.js';
import * as Proto from './protocol.js';

// Polling adapts to whether the controls are actually on screen: while the
// Quick Settings panel is open the sliders should track the device, but with it
// closed we only need to notice the light being plugged in or out.
const POLL_ACTIVE_SECONDS = 2;
const POLL_IDLE_SECONDS = 10;

const COMMAND_DEBOUNCE_MS = 220;   // coalesce rapid slider drags into one command
const USER_HOLD_MS = 2000;         // don't let a poll fight a recent user change
const EVENT_POLL_DELAY_MS = 150;   // coalesce the light's own change notifications

/* ---------- helpers ---------------------------------------------------- */

function clamp(v, lo, hi) {
    return Math.min(hi, Math.max(lo, v));
}

/* ---------- slider row inside the toggle's popup menu ------------------- */

/* A popup-menu row holding an icon + a Slider. `activate: false` keeps a click
 * on the row from closing the menu; forwarding key and scroll events gives the
 * row the same keyboard/wheel behaviour as the shell's own volume slider. */
const SliderMenuItem = GObject.registerClass(
class SliderMenuItem extends PopupMenu.PopupBaseMenuItem {
    _init(iconName) {
        super._init({activate: false});

        this.add_child(new St.Icon({
            iconName,
            styleClass: 'popup-menu-icon',
        }));

        this.slider = new Slider(0);
        this.slider.x_expand = true;
        this.add_child(this.slider);

        this.connect('key-press-event', (actor, event) =>
            this.slider.emit('key-press-event', event));
        this.connect('scroll-event', (actor, event) =>
            this.slider.emit('scroll-event', event));
    }
});

/* ---------- Quick Settings toggle -------------------------------------- */

const LitraToggle = GObject.registerClass(
class LitraToggle extends QuickMenuToggle {
    _init() {
        super._init({
            title: 'Litra Glow',
            iconName: 'display-brightness-symbolic',
            toggleMode: true,
        });

        this.menu.setHeader('display-brightness-symbolic', 'Litra Glow');

        this.brightness = new SliderMenuItem('display-brightness-symbolic');
        this.temperature = new SliderMenuItem('weather-clear-symbolic');

        this.menu.addMenuItem(this.brightness);
        this.menu.addMenuItem(this.temperature);
    }
});

/* ---------- indicator (owns the toggle) -------------------------------- */

const LitraIndicator = GObject.registerClass(
class LitraIndicator extends SystemIndicator {
    _init() {
        super._init();

        this._device = null;
        this._destroyed = false;
        this._polling = false;
        this._lastProblem = null;       // last logged discovery/IO problem, to log each once
        this._syncing = false;          // suppress handlers during programmatic sync
        this._lastUserAction = 0;       // monotonic ms of last user interaction

        // Device limits (lumen / kelvin). These are the Litra Glow's values;
        // they get replaced by the connected model's.
        this._brightMin = 20;
        this._brightMax = 250;
        this._tempMin = Proto.MIN_KELVIN;
        this._tempMax = Proto.MAX_KELVIN;

        // Last known device values, from a poll or from the user's own drag.
        this._lumen = NaN;
        this._kelvin = NaN;

        this._brightPending = 0;        // debounce timeout source ids
        this._tempPending = 0;
        this._eventPollId = 0;
        this._pollId = 0;
        this._pollSeconds = 0;

        // Power toggle; the two sliders live in its popup menu, reached via the
        // arrow on the toggle's right.
        this._toggle = new LitraToggle();
        this._toggle.connect('notify::checked', () => {
            if (this._syncing)
                return;
            this._markUser();
            this._syncSubtitle();
            const on = this._toggle.checked;
            this._command(d => d.setOn(on));
        });

        this._bright = this._toggle.brightness;
        this._bright.slider.connect('notify::value', () => {
            if (this._syncing)
                return;
            this._markUser();
            const lumen = clamp(Math.round(this._brightMin +
                this._bright.slider.value * (this._brightMax - this._brightMin)),
                this._brightMin, this._brightMax);
            this._lumen = lumen;
            this._syncSubtitle();
            this._debounce('_brightPending', d => d.setBrightness(lumen));
        });

        this._temp = this._toggle.temperature;
        this._temp.slider.connect('notify::value', () => {
            if (this._syncing)
                return;
            this._markUser();
            // The hardware only accepts multiples of 100 K. The slider is left
            // where the user put it; the next poll snaps it to the value the
            // device actually took.
            const raw = this._tempMin +
                this._temp.slider.value * (this._tempMax - this._tempMin);
            const step = Proto.KELVIN_STEP;
            const kelvin = clamp(Math.round(raw / step) * step, this._tempMin, this._tempMax);
            this._kelvin = kelvin;
            this._syncSubtitle();
            this._debounce('_tempPending', d => d.setTemperature(kelvin));
        });

        this.quickSettingsItems.push(this._toggle);
        this._setVisible(false);        // hidden until a device is found

        // Poll faster while the Quick Settings panel is open — that is the only
        // time the controls are visible.
        this._panelMenu = Main.panel.statusArea.quickSettings.menu;
        this._panelMenuId = this._panelMenu.connect('open-state-changed', (menu, isOpen) => {
            this._setPollInterval(isOpen ? POLL_ACTIVE_SECONDS : POLL_IDLE_SECONDS);
            if (isOpen)
                this._poll();
        });

        this._poll();
        this._setPollInterval(POLL_IDLE_SECONDS);
    }

    _markUser() {
        this._lastUserAction = GLib.get_monotonic_time() / 1000;
    }

    /* The subtitle mirrors whatever we last knew, no matter where it came from.
     * Deriving it from a poll alone would leave it stale for the whole time a
     * drag keeps renewing the user-hold window that suppresses that poll. */
    _syncSubtitle() {
        this._toggle.subtitle =
            this._toggle.checked && Number.isFinite(this._lumen) && Number.isFinite(this._kelvin)
                ? `${this._lumen} lm · ${this._kelvin} K`
                : null;
    }

    _setVisible(visible) {
        for (const item of this.quickSettingsItems)
            item.visible = visible;
    }

    _setPollInterval(seconds) {
        if (this._pollSeconds === seconds && this._pollId)
            return;
        if (this._pollId)
            GLib.source_remove(this._pollId);
        this._pollSeconds = seconds;
        this._pollId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, seconds, () => {
            this._poll();
            return GLib.SOURCE_CONTINUE;
        });
    }

    /* Send one change to the light, if one is connected. */
    _command(send) {
        if (!this._device)
            return;
        send(this._device).catch(e => {
            if (!this._destroyed)
                console.error(`litra: ${e.message}`);
        });
    }

    /* Coalesce a burst of slider updates into a single command. `slot` names
     * the field holding the pending timeout id. */
    _debounce(slot, send) {
        if (this[slot])
            GLib.source_remove(this[slot]);
        this[slot] = GLib.timeout_add(GLib.PRIORITY_DEFAULT, COMMAND_DEBOUNCE_MS, () => {
            this[slot] = 0;
            this._command(send);
            return GLib.SOURCE_REMOVE;
        });
    }

    /* Log a problem once, not on every poll while it persists. */
    _problem(message) {
        if (message !== this._lastProblem && message !== null)
            console.warn(`litra: ${message}`);
        this._lastProblem = message;
    }

    /* The open device, opening the first one found if there is none yet. */
    _ensureDevice() {
        if (this._device)
            return this._device;

        const found = findDevice();
        if (!found)
            return null;

        const device = new LitraDevice(found.path, found.model, {
            // The light reports button presses on its own; read the new state.
            onEvent: () => this._schedulePoll(),
            onLost: () => this._dropDevice(),
        });
        try {
            device.open();
        } catch (e) {
            this._problem(e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.PERMISSION_DENIED)
                ? `no access to ${found.path} — install the udev rule (make udev) and replug the light`
                : `cannot open ${found.path}: ${e.message}`);
            return null;
        }

        this._device = device;
        this._brightMin = device.model.minLumen;
        this._brightMax = device.model.maxLumen;
        this._toggle.title = device.model.name;
        this._toggle.menu.setHeader('display-brightness-symbolic', device.model.name);
        return device;
    }

    _dropDevice() {
        this._device?.close();
        this._device = null;
        if (!this._destroyed)
            this._setVisible(false);
    }

    _schedulePoll() {
        if (this._eventPollId)
            return;
        this._eventPollId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, EVENT_POLL_DELAY_MS, () => {
            this._eventPollId = 0;
            this._poll();
            return GLib.SOURCE_REMOVE;
        });
    }

    async _poll() {
        if (this._polling || this._destroyed)
            return;
        this._polling = true;
        try {
            const device = this._ensureDevice();
            if (!device) {
                this._setVisible(false);
                return;
            }

            let state;
            try {
                state = await device.readState();
            } catch (e) {
                // disable() closes the device under a poll in flight
                if (this._destroyed)
                    return;
                this._problem(`lost ${device.path}: ${e.message}`);
                this._dropDevice();
                return;
            }
            if (this._destroyed || device !== this._device)
                return;

            this._problem(null);
            this._setVisible(true);
            this._applyState(state);
        } finally {
            this._polling = false;
        }
    }

    _applyState({on, lumen, kelvin}) {
        // Don't yank the controls out from under a recent user interaction.
        const now = GLib.get_monotonic_time() / 1000;
        if (now - this._lastUserAction < USER_HOLD_MS)
            return;

        this._syncing = true;
        try {
            this._toggle.checked = on;
            this._lumen = lumen;
            this._kelvin = kelvin;

            if (this._brightMax > this._brightMin) {
                this._bright.slider.value = clamp(
                    (lumen - this._brightMin) / (this._brightMax - this._brightMin), 0, 1);
            }
            if (this._tempMax > this._tempMin) {
                this._temp.slider.value = clamp(
                    (kelvin - this._tempMin) / (this._tempMax - this._tempMin), 0, 1);
            }

            this._syncSubtitle();
        } finally {
            this._syncing = false;
        }
    }

    destroy() {
        this._destroyed = true;

        for (const slot of ['_pollId', '_eventPollId', '_brightPending', '_tempPending']) {
            if (this[slot]) {
                GLib.source_remove(this[slot]);
                this[slot] = 0;
            }
        }
        if (this._panelMenuId) {
            this._panelMenu.disconnect(this._panelMenuId);
            this._panelMenuId = 0;
        }
        this._panelMenu = null;

        this._device?.close();
        this._device = null;
        this.quickSettingsItems.forEach(item => item.destroy());
        this.quickSettingsItems = [];
        super.destroy();
    }
});

/* ---------- extension entry point -------------------------------------- */

export default class LitraExtension extends Extension {
    enable() {
        this._indicator = new LitraIndicator();
        Main.panel.statusArea.quickSettings.addExternalIndicator(this._indicator);
    }

    disable() {
        this._indicator?.destroy();
        this._indicator = null;
    }
}
