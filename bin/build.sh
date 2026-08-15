#!/usr/bin/env bash
set -euo pipefail
PROJ="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STAGE="${LIQEXPLORER_STAGE:-$HOME/.cache/liq-run/liqexplorer}"
bash "$PROJ/bin/stage.sh"
export ESBUILD_BINARY_PATH="$STAGE/esbuild"
cd "$PROJ"
node bin/bundle.mjs "${1:-build}"
# a handler nobody imports never registers, and the renderer only finds out when
# a user clicks the thing — warn at build time instead (never fails the build)
node bin/check-ipc.mjs || true
