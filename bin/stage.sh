#!/usr/bin/env bash
# Stage non-executable CIFS binaries into a local, executable location.
# Idempotent; called by build.sh / run.sh / dev.sh.
set -euo pipefail
PROJ="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STAGE="${LIQEXPLORER_STAGE:-$HOME/.cache/liq-run/liqexplorer}"
mkdir -p "$STAGE"

# esbuild: copy the platform binary and expose ESBUILD_BINARY_PATH
ESB_SRC="$PROJ/node_modules/@esbuild/linux-x64/bin/esbuild"
if [ -f "$ESB_SRC" ]; then
  ESB_VER="$(node -e "console.log(require('$PROJ/node_modules/@esbuild/linux-x64/package.json').version)")"
  if [ ! -x "$STAGE/esbuild-$ESB_VER" ]; then
    cp "$ESB_SRC" "$STAGE/esbuild-$ESB_VER.tmp" && chmod +x "$STAGE/esbuild-$ESB_VER.tmp" \
      && mv "$STAGE/esbuild-$ESB_VER.tmp" "$STAGE/esbuild-$ESB_VER"
  fi
  ln -sfn "$STAGE/esbuild-$ESB_VER" "$STAGE/esbuild"
fi

# electron: ensure dist is downloaded (postinstall was skipped), then stage it
ELECTRON_DIR="$PROJ/node_modules/electron"
if [ -d "$ELECTRON_DIR" ]; then
  ELE_VER="$(node -e "console.log(require('$ELECTRON_DIR/package.json').version)")"
  if [ ! -x "$STAGE/electron-$ELE_VER/electron" ]; then
    if [ ! -f "$ELECTRON_DIR/dist/electron" ]; then
      (cd "$ELECTRON_DIR" && node install.js)   # uses ~/.cache/electron
    fi
    rm -rf "$STAGE/electron-$ELE_VER.tmp"
    cp -r "$ELECTRON_DIR/dist" "$STAGE/electron-$ELE_VER.tmp"
    chmod +x "$STAGE/electron-$ELE_VER.tmp/electron" "$STAGE/electron-$ELE_VER.tmp/chrome-sandbox" 2>/dev/null || true
    rm -rf "$STAGE/electron-$ELE_VER" && mv "$STAGE/electron-$ELE_VER.tmp" "$STAGE/electron-$ELE_VER"
  fi
  ln -sfn "$STAGE/electron-$ELE_VER" "$STAGE/electron"
fi
