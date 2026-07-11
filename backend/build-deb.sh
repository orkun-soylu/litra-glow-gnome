#!/usr/bin/env bash
# Build the litra-glow-backend .deb by downloading the prebuilt `litra`
# binary from timrogers/litra-rs and wrapping it with udev rules.
#
# Usage: ./build-deb.sh [amd64|arm64] [litra-version]
#   defaults: amd64, 3.3.0
#
# Produces dist/litra-glow-backend_<version>_<arch>.deb
set -euo pipefail

ARCH="${1:-amd64}"
VERSION="${2:-3.3.0}"

case "$ARCH" in
    amd64) ASSET_ARCH="linux-amd64" ;;
    arm64) ASSET_ARCH="linux-aarch64" ;;
    *) echo "Unsupported arch: $ARCH (use amd64 or arm64)" >&2; exit 1 ;;
esac

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$HERE/.." && pwd)"
SKEL="$HERE/skel"
BUILD="$(mktemp -d)"
DIST="$REPO_ROOT/dist"
ASSET="litra_v${VERSION}_${ASSET_ARCH}"
URL="https://github.com/timrogers/litra-rs/releases/download/v${VERSION}/${ASSET}"

trap 'rm -rf "$BUILD"' EXIT
mkdir -p "$DIST"

echo ">> Downloading $ASSET"
curl -fSL -o "$BUILD/litra" "$URL"

echo ">> Assembling package tree"
cp -a "$SKEL/." "$BUILD/pkg" 2>/dev/null || { mkdir -p "$BUILD/pkg"; cp -a "$SKEL/." "$BUILD/pkg/"; }
install -Dm0755 "$BUILD/litra" "$BUILD/pkg/usr/bin/litra"

# Render control.in -> control
sed -e "s/@VERSION@/${VERSION}/" -e "s/@ARCH@/${ARCH}/" \
    "$SKEL/DEBIAN/control.in" > "$BUILD/pkg/DEBIAN/control"
rm -f "$BUILD/pkg/DEBIAN/control.in"

chmod 0755 "$BUILD/pkg/DEBIAN/postinst" "$BUILD/pkg/DEBIAN/postrm"

OUT="$DIST/litra-glow-backend_${VERSION}_${ARCH}.deb"
echo ">> Building $OUT"
dpkg-deb --root-owner-group --build "$BUILD/pkg" "$OUT"

echo ">> Done:"
dpkg-deb --info "$OUT" | sed 's/^/   /'
echo
echo "Install with:  sudo apt install $OUT"
