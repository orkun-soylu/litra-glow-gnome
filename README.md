# Litra Glow — GNOME control

Control a **Logitech Litra Glow / Beam** from the **GNOME Quick Settings** menu
on Debian 13 (GNOME 48, Wayland): power on/off, brightness and colour
temperature. The controls appear only while a device is plugged in.

Two pieces:

| Piece | What it is | Where it runs |
|-------|-----------|---------------|
| **backend** | the [`litra`](https://github.com/timrogers/litra-rs) CLI (Rust) + udev rules, packaged as a `.deb` | does the USB/HID I/O |
| **extension** | a GNOME Shell extension (Quick Settings toggle + sliders) | front-end; shells out to `litra` |

The extension never touches USB directly — it detects the device and reads its
state via `litra devices --json`, and sends changes via `litra on/off/brightness/
temperature`. No Python, no PySimpleGUI.

## Requirements

* Debian 13 / GNOME Shell 48 (Wayland or X11)
* A Litra Glow (`046d:c900`), Beam (`046d:c901`), Beam LX or Beam (`046d:b901` / `046d:c903`)
* x86-64 (`amd64`). For arm64 rebuild the backend with `build-deb.sh arm64`.

## Install

### Quick: one command

Run on the laptop (GNOME + Litra). Detects arch, builds + installs the backend
`.deb` (sudo once), and installs the extension:

```bash
./setup.sh
```

Then **log out and back in**. Done. The manual steps below are the same thing
split apart, if you prefer.

### 1. Backend (`litra` CLI + udev rules)

```bash
# build the .deb (downloads the prebuilt litra binary, ~2 s)
./backend/build-deb.sh amd64          # or: arm64

sudo apt install ./dist/litra-glow-backend_3.3.0_amd64.deb
```

The package's post-install adds you to the `video` group and reloads udev.
**Log out and back in** so the group membership takes effect, then check:

```bash
litra devices        # should list your Litra
```

If it says "permission denied", you are not yet in the `video` group — log out
and back in (or `sudo usermod -aG video "$USER"`).

### 2. GNOME extension

```bash
./install-extension.sh
```

Then **log out and back in** (Wayland can't reload the shell in place). Plug in
the Litra and open Quick Settings (top-right): a **Litra Glow** tile plus
**brightness** and **temperature** sliders appear.

## How it works

* `backend/skel/usr/lib/udev/rules.d/99-litra.rules` gives the `video` group
  `0660` on the Litra `hidraw` node, so `litra` runs without root.
* The extension polls `litra devices --json` every 5 s to show/hide the controls
  and keep them in sync with the physical device. A short hold window keeps a
  poll from fighting a slider you're actively dragging.
* Slider drags are debounced (~220 ms) into a single `litra` invocation.

## Troubleshooting

* **No tile appears:** run `litra devices` in a terminal. Empty/error → udev or
  `video` group issue (see above). Works in terminal but no tile → check the
  extension is enabled: `gnome-extensions info litra@soylu.me`, and watch logs
  with `journalctl -f -o cat /usr/bin/gnome-shell`.
* **Sliders snap back:** that's the 5 s poll syncing to the device; it yields
  for 2 s after you touch a control.

## Credits

Backend binary: [timrogers/litra-rs](https://github.com/timrogers/litra-rs) (the
HID protocol was originally reverse-engineered in
[kharyam/litra-driver](https://github.com/kharyam/litra-driver)).
