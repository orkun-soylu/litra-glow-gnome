#!/usr/bin/env bash
# One-shot installer: builds + installs the litra backend .deb and installs the
# GNOME extension. Run this on the laptop (GNOME + Litra), NOT on a headless box.
#
#   ./setup.sh
#
# Needs sudo once (for the .deb / udev rule). The rest is user-local.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
LITRA_VERSION="3.3.0"

# --- sanity checks -----------------------------------------------------------
if ! command -v gnome-shell >/dev/null 2>&1; then
    echo "!! gnome-shell not found — run this on the GNOME laptop, not here." >&2
    exit 1
fi

case "$(uname -m)" in
    x86_64)  ARCH=amd64 ;;
    aarch64) ARCH=arm64 ;;
    *) echo "!! Unsupported CPU arch: $(uname -m)" >&2; exit 1 ;;
esac
echo ">> Detected arch: $ARCH"

# --- 1. backend .deb ---------------------------------------------------------
echo ">> Building backend .deb"
"$HERE/backend/build-deb.sh" "$ARCH" "$LITRA_VERSION"

DEB="$HERE/dist/litra-glow-backend_${LITRA_VERSION}_${ARCH}.deb"
echo ">> Installing $DEB (sudo)"
sudo apt install -y "$DEB"

# --- 2. GNOME extension ------------------------------------------------------
echo ">> Installing GNOME extension"
"$HERE/install-extension.sh"

# --- done --------------------------------------------------------------------
GN_VER="$(gnome-shell --version | grep -oE '[0-9]+' | head -1)"
cat <<EOF

============================================================================
Setup complete (GNOME $GN_VER, $ARCH).

Two things remain, both because of Wayland / group membership:

  1. LOG OUT and back in  — activates the 'video' group AND loads the
     extension (Wayland can't reload the shell in place).

  2. After logging back in, plug in the Litra and check the backend:
         litra devices
     then open Quick Settings (top-right): a "Litra Glow" tile plus
     brightness/temperature sliders should appear.
============================================================================
EOF
