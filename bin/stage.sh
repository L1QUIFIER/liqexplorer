#!/usr/bin/env bash
# Stage Electron + esbuild into an executable cache dir.
# Idempotent; called by build.sh / run.sh / setup.sh.
#
# Covers two cases:
#  1) CIFS/SMB checkouts where node_modules binaries are not executable
#  2) Modern npm (11.16+ / 12) that skips dependency install scripts unless
#     allowScripts approves them — Electron's binary never lands otherwise
set -euo pipefail
PROJ="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STAGE="${LIQEXPLORER_STAGE:-$HOME/.cache/liq-run/liqexplorer}"
mkdir -p "$STAGE"

# ---------- esbuild ----------
ESB_PKG="$PROJ/node_modules/@esbuild/linux-x64"
ESB_SRC="$ESB_PKG/bin/esbuild"
if [ ! -f "$ESB_SRC" ] && [ -f "$PROJ/node_modules/esbuild/install.js" ]; then
  echo "[stage] fetching esbuild platform binary…"
  (cd "$PROJ/node_modules/esbuild" && node install.js)
fi
if [ -f "$ESB_SRC" ]; then
  ESB_VER="$(node -e "console.log(require('$ESB_PKG/package.json').version)")"
  if [ ! -x "$STAGE/esbuild-$ESB_VER" ]; then
    cp "$ESB_SRC" "$STAGE/esbuild-$ESB_VER.tmp" && chmod +x "$STAGE/esbuild-$ESB_VER.tmp" \
      && mv "$STAGE/esbuild-$ESB_VER.tmp" "$STAGE/esbuild-$ESB_VER"
  fi
  ln -sfn "$STAGE/esbuild-$ESB_VER" "$STAGE/esbuild"
elif [ ! -x "$STAGE/esbuild" ]; then
  echo "[stage] esbuild binary missing — run: npm install (and allowScripts for esbuild on npm 12+)" >&2
  exit 1
fi

# ---------- electron ----------
ELECTRON_DIR="$PROJ/node_modules/electron"
if [ ! -d "$ELECTRON_DIR" ]; then
  echo "[stage] electron package missing — run npm install first" >&2
  exit 1
fi
ELE_VER="$(node -e "console.log(require('$ELECTRON_DIR/package.json').version)")"
if [ ! -x "$STAGE/electron-$ELE_VER/electron" ]; then
  if [ ! -f "$ELECTRON_DIR/dist/electron" ]; then
    echo "[stage] downloading Electron $ELE_VER (one-time)…"
    (cd "$ELECTRON_DIR" && node install.js)   # uses ~/.cache/electron
  fi
  if [ ! -f "$ELECTRON_DIR/dist/electron" ]; then
    echo "[stage] Electron download failed. Check network / ELECTRON_MIRROR." >&2
    exit 1
  fi
  rm -rf "$STAGE/electron-$ELE_VER.tmp"
  cp -r "$ELECTRON_DIR/dist" "$STAGE/electron-$ELE_VER.tmp"
  chmod +x "$STAGE/electron-$ELE_VER.tmp/electron" "$STAGE/electron-$ELE_VER.tmp/chrome-sandbox" 2>/dev/null || true
  rm -rf "$STAGE/electron-$ELE_VER" && mv "$STAGE/electron-$ELE_VER.tmp" "$STAGE/electron-$ELE_VER"
fi
ln -sfn "$STAGE/electron-$ELE_VER" "$STAGE/electron"
