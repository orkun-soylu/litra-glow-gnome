/* Litra Glow — GNOME Quick Settings control for Logitech Litra devices.
 *
 * This extension is a thin front-end: all USB/HID I/O is done by the `litra`
 * CLI (timrogers/litra-rs), which ships inside this extension's own `bin/`
 * directory and is spawned as a subprocess. State is discovered by polling
 * `litra devices --json`. The toggle is shown only while a device is
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

// Polling adapts to whether the controls are actually on screen: while the
// Quick Settings panel is open the sliders should track the device, but with it
// closed we only need to notice the light being plugged in or out.
const POLL_ACTIVE_SECONDS = 2;
const POLL_IDLE_SECONDS = 10;

const COMMAND_DEBOUNCE_MS = 220;   // coalesce rapid slider drags into one command
const USER_HOLD_MS = 2000;         // don't let a poll fight a recent user change

/* ---------- helpers ---------------------------------------------------- */

function clamp(v, lo, hi) {
    return Math.min(hi, Math.max(lo, v));
}

/* Spawn `litra <args...>`. Both pipes are read to completion, so a chatty child
 * can never wedge on a full pipe buffer, and stderr is available for the log
 * when a command fails. `onDone` gets stdout, or null on failure. */
function litraExec(litraPath, args, cancellable, onDone) {
    let proc;
    try {
        proc = Gio.Subprocess.new(
            [litraPath, ...args],
            Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE);
    } catch (e) {
        console.error(`litra: cannot spawn (${args.join(' ')}): ${e.message}`);
        onDone?.(null);
        return;
    }

    proc.communicate_utf8_async(null, cancellable, (p, res) => {
        let stdout = null;
        try {
            const [, out, err] = p.communicate_utf8_finish(res);
            if (p.get_successful())
                stdout = out;
            else
                console.error(`litra ${args.join(' ')}: ${(err ?? '').trim()}`);
        } catch (e) {
            if (!e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                console.error(`litra ${args.join(' ')}: ${e.message}`);
        }
        onDone?.(stdout);
    });
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
    _init(litraPath) {
        super._init();

        this._litraPath = litraPath;
        this._destroyed = false;
        this._syncing = false;          // suppress handlers during programmatic sync
        this._lastUserAction = 0;       // monotonic ms of last user interaction
        this._cancellable = new Gio.Cancellable();

        // Device limits (lumen / kelvin). These are the Litra Glow's values;
        // they get replaced by whatever the connected device reports.
        this._brightMin = 20;
        this._brightMax = 250;
        this._tempMin = 2700;
        this._tempMax = 6500;

        // Last known device values, from a poll or from the user's own drag.
        this._lumen = NaN;
        this._kelvin = NaN;

        this._brightPending = 0;        // debounce timeout source ids
        this._tempPending = 0;
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
            litraExec(this._litraPath, [this._toggle.checked ? 'on' : 'off'],
                this._cancellable, null);
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
            this._debounce('_brightPending', ['brightness', '--value', String(lumen)]);
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
            const kelvin = clamp(Math.round(raw / 100) * 100, this._tempMin, this._tempMax);
            this._kelvin = kelvin;
            this._syncSubtitle();
            this._debounce('_tempPending', ['temperature', '--value', String(kelvin)]);
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

    /* Coalesce a burst of slider updates into a single `litra` invocation.
     * `slot` names the field holding the pending timeout id. */
    _debounce(slot, args) {
        if (this[slot])
            GLib.source_remove(this[slot]);
        this[slot] = GLib.timeout_add(GLib.PRIORITY_DEFAULT, COMMAND_DEBOUNCE_MS, () => {
            this[slot] = 0;
            litraExec(this._litraPath, args, this._cancellable, null);
            return GLib.SOURCE_REMOVE;
        });
    }

    _poll() {
        litraExec(this._litraPath, ['devices', '--json'], this._cancellable, (stdout) => {
            // A subprocess callback can land after disable(); the actors are
            // gone by then, so there is nothing left to update.
            if (this._destroyed)
                return;

            let devices = null;
            try {
                const parsed = JSON.parse(stdout ?? '');
                if (Array.isArray(parsed))
                    devices = parsed;
            } catch {
                devices = null;
            }

            if (!devices || devices.length === 0) {
                this._setVisible(false);
                return;
            }

            const d = devices[0];       // control the first connected Litra
            this._setVisible(true);

            const name = d.device_type_display || 'Litra Glow';
            this._toggle.title = name;
            this._toggle.menu.setHeader('display-brightness-symbolic', name);

            if (Number.isFinite(d.minimum_brightness_in_lumen))
                this._brightMin = d.minimum_brightness_in_lumen;
            if (Number.isFinite(d.maximum_brightness_in_lumen))
                this._brightMax = d.maximum_brightness_in_lumen;
            if (Number.isFinite(d.minimum_temperature_in_kelvin))
                this._tempMin = d.minimum_temperature_in_kelvin;
            if (Number.isFinite(d.maximum_temperature_in_kelvin))
                this._tempMax = d.maximum_temperature_in_kelvin;

            // Don't yank the controls out from under a recent user interaction.
            const now = GLib.get_monotonic_time() / 1000;
            if (now - this._lastUserAction < USER_HOLD_MS)
                return;

            this._syncing = true;
            try {
                this._toggle.checked = !!d.is_on;

                const lumen = d.brightness_in_lumen;
                const kelvin = d.temperature_in_kelvin;

                if (Number.isFinite(lumen))
                    this._lumen = lumen;
                if (Number.isFinite(kelvin))
                    this._kelvin = kelvin;

                if (this._brightMax > this._brightMin && Number.isFinite(lumen)) {
                    this._bright.slider.value = clamp(
                        (lumen - this._brightMin) / (this._brightMax - this._brightMin), 0, 1);
                }
                if (this._tempMax > this._tempMin && Number.isFinite(kelvin)) {
                    this._temp.slider.value = clamp(
                        (kelvin - this._tempMin) / (this._tempMax - this._tempMin), 0, 1);
                }

                this._syncSubtitle();
            } finally {
                this._syncing = false;
            }
        });
    }

    destroy() {
        this._destroyed = true;

        for (const slot of ['_pollId', '_brightPending', '_tempPending']) {
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

        this._cancellable.cancel();
        this.quickSettingsItems.forEach(item => item.destroy());
        this.quickSettingsItems = [];
        super.destroy();
    }
});

/* ---------- extension entry point -------------------------------------- */

export default class LitraExtension extends Extension {
    enable() {
        // The bundled binary is the supported path; a PATH lookup is kept as a
        // fallback for anyone who already has `litra` installed system-wide.
        const bundled = GLib.build_filenamev([this.path, 'bin', 'litra']);
        const litraPath = GLib.file_test(bundled, GLib.FileTest.IS_EXECUTABLE)
            ? bundled
            : GLib.find_program_in_path('litra');

        if (!litraPath) {
            console.error('litra: no `litra` binary found — reinstall with `make install`');
            return;
        }

        this._indicator = new LitraIndicator(litraPath);
        Main.panel.statusArea.quickSettings.addExternalIndicator(this._indicator);
    }

    disable() {
        this._indicator?.destroy();
        this._indicator = null;
    }
}
