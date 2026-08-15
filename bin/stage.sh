#!/usr/bin/env bash
# Stage Electron + esbuild into an executable cache dir.
# Idempotent; called by build.sh / run.sh / setup.sh.
#
# Covers:
#  1) CIFS/SMB checkouts where node_modules binaries are not executable
#  2) Modern npm (11.16+ / 12) that skips dependency install scripts
#  3) Broken/partial Electron installs (empty dist/) — falls back to curl+unzip
set -euo pipefail
PROJ="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STAGE="${LIQEXPLORER_STAGE:-$HOME/.cache/liq-run/liqexplorer}"
mkdir -p "$STAGE"

# ---------- esbuild ----------
ESB_PKG="$PROJ/node_modules/@esbuild/linux-x64"
ESB_SRC="$ESB_PKG/bin/esbuild"
if [ ! -f "$ESB_SRC" ] && [ -f "$PROJ/node_modules/esbuild/install.js" ]; then
  echo "[stage] fetching esbuild platform binary…"
  (cd "$PROJ/node_modules/esbuild" && node install.js) || true
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
ELE_BIN="$ELECTRON_DIR/dist/electron"

ensure_electron_dist() {
  if [ -x "$ELE_BIN" ]; then
    return 0
  fi

  echo "[stage] downloading Electron $ELE_VER (one-time)…"

  # Prefer upstream installer when it actually produces a binary.
  rm -rf "$ELECTRON_DIR/dist"
  mkdir -p "$ELECTRON_DIR/dist"
  if (cd "$ELECTRON_DIR" && force_no_cache=true node install.js); then
    if [ -x "$ELE_BIN" ]; then
      return 0
    fi
  fi

  # Fallback: curl the official Linux x64 zip and unzip it.
  # electron's install.js can exit 0 with an empty dist/ on some npm 12 setups.
  if ! command -v curl >/dev/null; then
    echo "[stage] curl missing — cannot download Electron" >&2
    exit 1
  fi
  if ! command -v unzip >/dev/null; then
    echo "[stage] unzip missing — install it (Arch: sudo pacman -S unzip) and retry" >&2
    exit 1
  fi

  local url zip
  url="${ELECTRON_MIRROR:-https://github.com/electron/electron/releases/download}/v${ELE_VER}/electron-v${ELE_VER}-linux-x64.zip"
  # If ELECTRON_MIRROR is a full CDN prefix like https://npmmirror.com/mirrors/electron/
  # the path shape differs — keep GitHub default unless mirror is set as full file URL.
  if [[ "${ELECTRON_MIRROR:-}" == *"/electron-v"*".zip" ]]; then
    url="$ELECTRON_MIRROR"
  elif [[ -n "${ELECTRON_MIRROR:-}" && "${ELECTRON_MIRROR}" != https://github.com/electron/electron/releases/download ]]; then
    # common mirror form: https://npmmirror.com/mirrors/electron/<ver>/electron-v<ver>-linux-x64.zip
    url="${ELECTRON_MIRROR%/}/${ELE_VER}/electron-v${ELE_VER}-linux-x64.zip"
  fi

  zip="$(mktemp /tmp/electron-XXXXXX.zip)"
  echo "[stage] fetching $url"
  if ! curl -L --fail --progress-bar -o "$zip" "$url"; then
    rm -f "$zip"
    echo "[stage] Electron download failed. Check network / ELECTRON_MIRROR." >&2
    exit 1
  fi

  rm -rf "$ELECTRON_DIR/dist"
  mkdir -p "$ELECTRON_DIR/dist"
  unzip -q "$zip" -d "$ELECTRON_DIR/dist"
  rm -f "$zip"
  printf 'electron' > "$ELECTRON_DIR/path.txt"
  printf 'v%s\n' "$ELE_VER" > "$ELECTRON_DIR/dist/version"
  chmod +x "$ELE_BIN" "$ELECTRON_DIR/dist/chrome-sandbox" 2>/dev/null || true

  if [ ! -x "$ELE_BIN" ]; then
    echo "[stage] Electron extract failed — dist/electron still missing" >&2
    exit 1
  fi
}

if [ ! -x "$STAGE/electron-$ELE_VER/electron" ]; then
  ensure_electron_dist
  rm -rf "$STAGE/electron-$ELE_VER.tmp"
  cp -r "$ELECTRON_DIR/dist" "$STAGE/electron-$ELE_VER.tmp"
  chmod +x "$STAGE/electron-$ELE_VER.tmp/electron" "$STAGE/electron-$ELE_VER.tmp/chrome-sandbox" 2>/dev/null || true
  rm -rf "$STAGE/electron-$ELE_VER" && mv "$STAGE/electron-$ELE_VER.tmp" "$STAGE/electron-$ELE_VER"
fi
ln -sfn "$STAGE/electron-$ELE_VER" "$STAGE/electron"
