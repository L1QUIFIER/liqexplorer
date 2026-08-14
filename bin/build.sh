#!/usr/bin/env bash
set -euo pipefail
PROJ="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STAGE="${LIQEXPLORER_STAGE:-$HOME/.cache/liq-run/liqexplorer}"
bash "$PROJ/bin/stage.sh"
export ESBUILD_BINARY_PATH="$STAGE/esbuild"
cd "$PROJ"
node bin/bundle.mjs "${1:-build}"
