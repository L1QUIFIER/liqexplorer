#!/usr/bin/env bash
set -euo pipefail
PROJ="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STAGE="${LIQEXPLORER_STAGE:-$HOME/.cache/liq-run/liqexplorer}"
bash "$PROJ/bin/stage.sh"
ARGS=()
if [ "${LIQEXPLORER_TEST:-}" = "1" ]; then
  ARGS+=(--user-data-dir="$HOME/.cache/liqexplorer-test/profile" --no-sandbox)
fi
exec "$STAGE/electron/electron" "${ARGS[@]}" "$PROJ" "$@"
