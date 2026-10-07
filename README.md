# Litra Glow — GNOME extension

Control a **Logitech Litra Glow / Beam** from the **GNOME Quick Settings** menu
on Debian 13 (GNOME Shell 48, Wayland or X11): power, brightness and colour
temperature. The tile appears only while a device is plugged in.

It is a single GNOME Shell extension in plain JavaScript that talks to the
light directly over its `hidraw` node — no helper binary, no system package,
and nothing installed outside `$HOME` except one udev rule.

```
~/.local/share/gnome-shell/extensions/litra@soylu.me/
├── metadata.json
├── extension.js           ← Quick Settings UI
├── device.js              ← hidraw discovery and async I/O
└── protocol.js            ← the HID++ messages

/etc/udev/rules.d/60-litra.rules    ← the only privileged file
```

## Requirements

* Debian 13 / GNOME Shell 48
* A Litra Glow (`046d:c900`), Beam (`046d:c901`) or Beam LX (`046d:b901` /
  `046d:c903`)
* `make` (and `zip`, only for `make pack`; `node`, only for `make check`)

## Install

Clone anywhere — a temp directory is fine, nothing that gets installed depends
on the checkout surviving:

```bash
git clone https://github.com/orkun-soylu/litra-glow-gnome.git
cd litra-glow-gnome

make install    # installs into ~/.local/share/... (no sudo)
make udev       # installs the udev rule (sudo, once per machine)
```

Then **log out and back in** — Wayland cannot reload GNOME Shell in place.
Plug in the Litra and open Quick Settings: a **Litra Glow** tile appears — with
the current brightness and temperature under its title while the light is on —
and the arrow on its right opens the two sliders.

The checkout can be deleted afterwards.

### Removing it

```bash
make uninstall         # the extension
make uninstall-udev    # the udev rule as well (sudo)
```

### Other targets

`make` on its own lists them: `pack`, `check`, `logs`, `clean`.

## How it works

* The extension finds the light under `/sys/class/hidraw` (Logitech vendor
  id, a known product id, and the HID++ usage page `0xff43` in the report
  descriptor) and exchanges 20-byte HID++ reports with it: get/set power,
  brightness in lumen and colour temperature in kelvin. The message bytes are
  the ones [timrogers/litra-rs](https://github.com/timrogers/litra-rs) sends;
  `tools/selftest.mjs` checks them byte for byte.
* All I/O is asynchronous on the shell's main loop — reads are poll-based and
  cancellable, so nothing is left blocked when the extension is disabled (as it
  is on every screen lock).
* Pressing the light's own buttons makes it send a notification; the extension
  reads the new state right away instead of waiting for the next poll.
* Polling adapts: every 2 s while the Quick Settings panel is open (so the
  sliders track the hardware), every 10 s when it is closed (just enough to
  notice the light being plugged in or out).
* Slider drags are debounced ~220 ms into a single command, and a 2 s hold
  window keeps a poll from fighting a control you are actively using.
* The tile's subtitle (`167 lm · 6500 K`, blank while the light is off) is
  written by the sliders as well as by the poll, so it follows a drag as it
  happens rather than waiting for the hold window to lapse. It shows the value
  actually sent to the device — brightness clamped to the device's range,
  temperature snapped to a multiple of 100 K — so it does not jump when the
  next poll lands.
* `60-litra.rules` tags the Litra's `hidraw` node with `uaccess`, so
  systemd-logind grants an ACL to the locally logged-in user. The rule keeps a
  `video`-group fallback for systems without logind seat management.

## Troubleshooting

* **No tile appears.** Watch `make logs` while replugging the light.
  * `no access to /dev/hidrawN` → the udev rule is missing or was applied too
    late. Run `make udev` and replug the device; `ls -l /dev/hidraw*` should
    then show a `+` (an ACL) on the Litra's node. (A rule file named `99-*`
    will *not* work: it sorts after systemd's `70-uaccess.rules`, so the
    `uaccess` tag is never acted on. Hence the `60-` prefix.)
  * Nothing logged at all → confirm the extension loaded with
    `gnome-extensions info litra@soylu.me`.
* **Sliders jump back.** That is the poll syncing to the device; it yields for
  2 s after you touch a control, and the hardware snaps temperature to
  multiples of 100 K.

## Migrating from the old `.deb`

Earlier versions shipped a `litra-glow-backend` Debian package and installed
the extension with a separate script. Clear the leftovers:

```bash
sudo apt purge litra-glow-backend
sudo rm -f /usr/lib/udev/rules.d/99-litra.rules
```

Membership of the `video` group is harmless to keep; `uaccess` makes it
unnecessary.

## Credits

Message format: [timrogers/litra-rs](https://github.com/timrogers/litra-rs).
The HID protocol was originally reverse-engineered in
[kharyam/litra-driver](https://github.com/kharyam/litra-driver).
