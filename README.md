# Litra Glow — GNOME extension

Control a **Logitech Litra Glow / Beam** from the **GNOME Quick Settings** menu
on Debian 13 (GNOME Shell 48, Wayland or X11): power, brightness and colour
temperature. The tile appears only while a device is plugged in.

It is a single GNOME Shell extension. The `litra` CLI
([timrogers/litra-rs](https://github.com/timrogers/litra-rs)) that does the
USB/HID work is bundled inside the extension's own directory — there is no
system package, and nothing is installed outside `$HOME` except one udev rule.

```
~/.local/share/gnome-shell/extensions/litra@soylu.me/
├── metadata.json
├── extension.js
└── bin/litra              ← the backend, bundled

/etc/udev/rules.d/60-litra.rules    ← the only privileged file
```

## Requirements

* Debian 13 / GNOME Shell 48
* A Litra Glow (`046d:c900`), Beam (`046d:c901`) or Beam LX (`046d:b901` /
  `046d:c903`)
* x86-64 or aarch64 — `make` picks the right upstream binary from `uname -m`
* `make`, `curl` (and `zip`, only for `make pack`)

## Install

Clone anywhere — a temp directory is fine, nothing that gets installed depends
on the checkout surviving:

```bash
git clone https://git.soylu.me/orkun/litra-glow-gnome.git
cd litra-glow-gnome

make install    # builds + installs into ~/.local/share/... (no sudo)
make udev       # installs the udev rule (sudo, once per machine)
```

Then **log out and back in** — Wayland cannot reload GNOME Shell in place.
Plug in the Litra and open Quick Settings: a **Litra Glow** tile appears, and
the arrow on its right opens the brightness and temperature sliders.

The checkout can be deleted afterwards.

### Removing it

```bash
make uninstall         # the extension
make uninstall-udev    # the udev rule as well (sudo)
```

### Other targets

`make` on its own lists them: `build`, `pack`, `check`, `logs`, `clean`,
`distclean`.

## How it works

* The extension never touches USB. It polls `litra devices --json` to detect
  the device and read its state, and sends changes via
  `litra on|off|brightness|temperature`.
* Polling adapts: every 2 s while the Quick Settings panel is open (so the
  sliders track the hardware), every 10 s when it is closed (just enough to
  notice the light being plugged in or out).
* Slider drags are debounced ~220 ms into a single `litra` call, and a 2 s hold
  window keeps a poll from fighting a control you are actively using.
* `60-litra.rules` tags the Litra's `hidraw` node with `uaccess`, so
  systemd-logind grants an ACL to the locally logged-in user. The rule keeps a
  `video`-group fallback for systems without logind seat management.

## Upgrading the bundled `litra`

Bump `LITRA_VERSION` in the `Makefile`, add the new release's sha256 sums to
`checksums.txt`, then `make install`. The download is refused if the hash does
not match.

## Troubleshooting

* **No tile appears.** Check the backend directly:
  `~/.local/share/gnome-shell/extensions/litra@soylu.me/bin/litra devices`
  * Permission denied → the udev rule is missing or was applied too late. Run
    `make udev` and replug the device. (A rule file named `99-*` will *not*
    work: it sorts after systemd's `70-uaccess.rules`, so the `uaccess` tag is
    never acted on. Hence the `60-` prefix.)
  * Works in a terminal but still no tile → confirm the extension loaded with
    `gnome-extensions info litra@soylu.me`, and watch `make logs`.
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

Backend binary: [timrogers/litra-rs](https://github.com/timrogers/litra-rs).
The HID protocol was originally reverse-engineered in
[kharyam/litra-driver](https://github.com/kharyam/litra-driver).
