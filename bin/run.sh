#!/usr/bin/env bash
set -euo pipefail
PROJ="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STAGE="${LIQEXPLORER_STAGE:-$HOME/.cache/liq-run/liqexplorer}"
bash "$PROJ/bin/stage.sh"

# Unpackaged Electron from npm cannot use the setuid chrome-sandbox helper on
# most distros (Arch/Fedora especially). --no-sandbox is the normal workaround
# for running from source; packaged AppImages ship their own sandbox setup.
ARGS=(--no-sandbox)
if [ "${LIQEXPLORER_TEST:-}" = "1" ]; then
  # LIQEXPLORER_TEST_DIR lets two test runs coexist: the single-instance lock is
  # per user-data-dir, so sharing one path means the second launch exits quietly
  ARGS+=(--user-data-dir="${LIQEXPLORER_TEST_DIR:-$HOME/.cache/liqexplorer-test}/profile")
fi
exec "$STAGE/electron/electron" "${ARGS[@]}" "$PROJ" "$@"
