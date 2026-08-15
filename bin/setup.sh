#!/usr/bin/env bash
# One-shot setup for building/running from a fresh clone (Arch, Fedora, Debian, …).
# Handles modern npm install-script allowlists (npm 11.16+ / npm 12) and downloads
# the Electron + esbuild binaries that those policies may skip.
set -euo pipefail
PROJ="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$PROJ"

if ! command -v node >/dev/null || ! command -v npm >/dev/null; then
  echo "Need Node.js 20+ and npm on PATH." >&2
  echo "Arch:   sudo pacman -S git nodejs npm gvfs gtk3 python-gobject ripgrep p7zip unzip curl" >&2
  echo "Fedora: sudo dnf install nodejs npm" >&2
  echo "Debian: sudo apt install nodejs npm" >&2
  exit 1
fi
if ! command -v curl >/dev/null || ! command -v unzip >/dev/null; then
  echo "Need curl + unzip to download Electron (Arch: sudo pacman -S curl unzip)." >&2
  exit 1
fi

NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$NODE_MAJOR" -lt 20 ]; then
  echo "Node.js $(node -v) is too old — use Node 20 LTS or newer." >&2
  exit 1
fi
if [ "$NODE_MAJOR" -ge 25 ]; then
  echo "Note: Node $(node -v) is newer than we regularly test. If something fails, try Node 20 or 22 LTS." >&2
fi

# npm 12 blocks dependency install scripts unless allowScripts approves them.
# Older npm ignores these commands — failures are non-fatal.
if npm help approve-scripts >/dev/null 2>&1; then
  echo "Approving Electron/esbuild install scripts (required on npm 12+)…"
  npm approve-scripts electron esbuild --no-allow-scripts-pin 2>/dev/null \
    || npm approve-scripts --all 2>/dev/null \
    || true
fi

echo "Installing npm dependencies…"
npm install

# Always ensure platform binaries exist (covers blocked postinstall + CIFS/noexec).
bash "$PROJ/bin/stage.sh"

echo "Building…"
npm run build

cat <<EOF

Setup complete.

  Run:     npm start
  Menu:    bash bin/install-app.sh
  AppImage (optional): npm run dist:appimage

EOF
