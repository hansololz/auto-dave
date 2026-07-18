#!/usr/bin/env bash
# Build the production distribution (SPEC §3): "Auto Dave.app" with the
# relocatable CPython (python-build-standalone) + the autodave backend and
# curated packages in Contents/Resources/python/, plus a DMG — both under
# build/. Signing: Developer ID with hardened runtime when CODESIGN_IDENTITY
# is set (notarization itself is not performed), ad-hoc otherwise (local use only).
#
#   ./scripts/prod.sh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"

# ---- fast build first (venv + deps + typecheck + renderer bundle) ----
"$ROOT/scripts/build.sh"

BUILD="$ROOT/build"
CACHE="$BUILD/cache"
mkdir -p "$CACHE"

ARCH="$(uname -m)"                       # arm64 | x86_64
case "$ARCH" in
  arm64)  PBS_ARCH="aarch64-apple-darwin" ;;
  x86_64) PBS_ARCH="x86_64-apple-darwin" ;;
  *) echo "unsupported arch: $ARCH"; exit 1 ;;
esac

# ---- bundled relocatable CPython (python-build-standalone, pinned) ----
PBS_TAG="20260623"
PY_FULL="3.14.6"
PBS_URL="${AUTODAVE_PBS_URL:-https://github.com/astral-sh/python-build-standalone/releases/download/$PBS_TAG/cpython-$PY_FULL+$PBS_TAG-$PBS_ARCH-install_only.tar.gz}"
TARBALL="$CACHE/$(basename "$PBS_URL")"
if [ ! -f "$TARBALL" ]; then
  echo "· downloading bundled Python ($PY_FULL, $PBS_ARCH)"
  curl -fL --retry 3 -o "$TARBALL.tmp" "$PBS_URL"
  mv "$TARBALL.tmp" "$TARBALL"
fi

PYSTAGE="$BUILD/python"
echo "· staging bundled Python → build/python"
rm -rf "$PYSTAGE"
mkdir -p "$PYSTAGE"
tar -xzf "$TARBALL" -C "$PYSTAGE" --strip-components 1   # tarball root is python/

# Backend + curated packages (§6.2) install into the bundled interpreter.
# pip's bin/ entry-point scripts get absolute staging-path shebangs, so inside
# the bundle the backend/CLI execute as `python3 -m autodave.main` / `-m autodave.cli`.
echo "· installing backend into bundled Python"
"$PYSTAGE/bin/python3" -m pip -q install "$ROOT/backend"

# ---- app icon (.icns from the dock PNG) ----
ICONSET="$BUILD/appIcon.iconset"
rm -rf "$ICONSET"
mkdir -p "$ICONSET"
for s in 16 32 128 256 512; do
  sips -z "$s" "$s" "$ROOT/app/electron/appIcon.png" --out "$ICONSET/icon_${s}x${s}.png" > /dev/null
  sips -z "$((s*2))" "$((s*2))" "$ROOT/app/electron/appIcon.png" --out "$ICONSET/icon_${s}x${s}@2x.png" > /dev/null
done
iconutil -c icns -o "$BUILD/appIcon.icns" "$ICONSET"

# ---- package Electron (.app) ----
# Only electron/ + dist/ + package.json ship: the renderer is fully bundled into
# dist/ and main.cjs/preload.cjs use Electron builtins only, so node_modules,
# src/ and the vite scaffolding stay out of the bundle.
echo "· packaging Auto Dave.app"
(cd "$ROOT/app" && npx electron-packager . "Auto Dave" \
  --platform=darwin --arch="$ARCH" --out "$BUILD/pkg" --overwrite \
  --icon "$BUILD/appIcon.icns" \
  --app-bundle-id com.autodave.app \
  --ignore '^/src($|/)' \
  --ignore '^/node_modules($|/)' \
  --ignore '^/drive[^/]*\.cjs$' \
  --ignore '^/index\.html$' \
  --ignore '^/vite\.config\.ts$' \
  --ignore '^/tsconfig\.json$' \
  --ignore '^/UI-GUIDE\.md$' \
  --ignore '^/package-lock\.json$')

APP="$BUILD/pkg/Auto Dave-darwin-$ARCH/Auto Dave.app"
[ -d "$APP" ] || { echo "packaging failed: $APP missing"; exit 1; }

echo "· bundling Python → Contents/Resources/python"
rm -rf "$APP/Contents/Resources/python"
cp -R "$PYSTAGE" "$APP/Contents/Resources/python"

# ---- codesign ----
if [ -n "${CODESIGN_IDENTITY:-}" ]; then
  # SPEC §3: every Mach-O in the Python tree needs hardened runtime for
  # notarization — sign the shared objects first, then the bundle.
  echo "· codesigning (identity: $CODESIGN_IDENTITY, hardened runtime)"
  find "$APP/Contents/Resources/python" -type f \( -name '*.so' -o -name '*.dylib' \) -print0 \
    | xargs -0 -n 16 codesign --force --options runtime --timestamp -s "$CODESIGN_IDENTITY"
  find "$APP/Contents/Resources/python/bin" -type f -perm +111 -print0 \
    | xargs -0 -n 16 codesign --force --options runtime --timestamp -s "$CODESIGN_IDENTITY"
  codesign --force --options runtime --timestamp -s "$CODESIGN_IDENTITY" --deep "$APP"
else
  echo "· codesigning (ad-hoc — set CODESIGN_IDENTITY for a distributable signature)"
  codesign --force --deep -s - "$APP"
fi
codesign --verify --deep --strict "$APP"

# ---- smoke check: bundled interpreter works from inside the bundle ----
"$APP/Contents/Resources/python/bin/python3" -c \
  'import autodave, fastapi, uvicorn, websockets, yaml, keyring, requests, httpx, bs4, lxml, feedparser, dateutil' \
  || { echo "bundled Python smoke check failed"; exit 1; }
echo "· bundled Python imports OK"

# ---- DMG ----
VERSION="$(node -p "require('$ROOT/app/package.json').version")"
DMG="$BUILD/Auto Dave-$VERSION-$ARCH.dmg"
rm -f "$DMG"
hdiutil create -volname "Auto Dave" -srcfolder "$APP" -ov -quiet -format UDZO "$DMG"

echo "· dist done:"
echo "    $APP"
echo "    $DMG"
