#!/usr/bin/env bash
# Live phase-3 check. Talks to Yandex — not part of `npm test`.
#   bash scripts/live-cbir.sh /path/to/image.jpg
set -euo pipefail
PROJ="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STAGE="${LIQEXPLORER_STAGE:-$HOME/.cache/liq-run/liqexplorer}"
OUT="$STAGE/live-cbir.js"
export ESBUILD_BINARY_PATH="$STAGE/esbuild"
bash "$PROJ/bin/stage.sh" >/dev/null
cd "$PROJ"
# the staged BINARY, not node_modules/esbuild/lib/main.js — the JS wrapper exits 0 and writes
# nothing when the package sits on the CIFS share
"$STAGE/esbuild" scripts/live-cbir.ts \
  --bundle --platform=node --format=cjs --target=node20 --external:electron \
  --outfile="$OUT" --log-level=warning
# :99 under Xvfb — a hidden window is still a window
# the share strips the exec bit, so the staged copy is the only runnable electron
exec env DISPLAY="${DISPLAY_OVERRIDE:-:99}" "$STAGE/electron/electron" "$OUT" --no-sandbox "$@"
