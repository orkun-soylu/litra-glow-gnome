#!/usr/bin/env bash
# Install the Litra Glow GNOME Shell extension for the current user.
# Run this on the machine with GNOME + the Litra device (not on a headless box).
set -euo pipefail

UUID="litra@soylu.me"
HERE="$(cd "$(dirname "$0")" && pwd)"
SRC="$HERE/extension/$UUID"
DEST="${XDG_DATA_HOME:-$HOME/.local/share}/gnome-shell/extensions/$UUID"

if [ ! -f "$SRC/metadata.json" ]; then
    echo "Cannot find extension source at $SRC" >&2
    exit 1
fi

echo ">> Installing extension to $DEST"
mkdir -p "$DEST"
cp -a "$SRC/." "$DEST/"

echo ">> Enabling extension"
if command -v gnome-extensions >/dev/null 2>&1; then
    gnome-extensions enable "$UUID" 2>/dev/null || \
        echo "   (could not enable yet — enable it after the next login)"
fi

cat <<EOF

Done. On Wayland you must log out and back in for GNOME Shell to load the
extension (you cannot restart the shell in place under Wayland).

After logging back in:
  * plug in the Litra — a "Litra Glow" tile plus brightness/temperature
    sliders appear in the Quick Settings menu (top-right).
  * verify the backend first with:  litra devices
EOF
