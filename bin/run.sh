#!/usr/bin/env bash
set -euo pipefail
PROJ="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STAGE="${LIQEXPLORER_STAGE:-$HOME/.cache/liq-run/liqexplorer}"
bash "$PROJ/bin/stage.sh"
# DO NOT RAISE UV_THREADPOOL_SIZE. It was tried, and it is the wrong lever.
#
# The pool serves every fs call this process makes (default four). On slow
# network filesystems a single uncached read can hold a thread for a long time,
# so raising the pool looked attractive. A microbenchmark agreed — then a real
# copy-while-browsing measurement showed the opposite: larger pools made the
# UI far less responsive (bigger callback backlog on the main thread, and more
# concurrent requests against one SMB connection made each slower).
#
# If this is ever revisited, measure with a real transfer and the in-app
# health/lag instrumentation — not a synthetic loop.

# Unpackaged Electron from npm cannot use setuid chrome-sandbox on most
# distros (Arch/Fedora especially). Always pass --no-sandbox for from-source.
ARGS=(--no-sandbox)
if [ "${LIQEXPLORER_TEST:-}" = "1" ]; then
  # LIQEXPLORER_TEST_DIR lets two test runs coexist: the single-instance lock is
  # per user-data-dir, so sharing one path means the second launch exits quietly
  ARGS+=(--user-data-dir="${LIQEXPLORER_TEST_DIR:-$HOME/.cache/liqexplorer-test}/profile")
fi
# KEEP THE OUTPUT. A crash used to leave nothing behind but a kernel trap line
# in dmesg. Chromium prints CHECK failures to stderr; keep the last two runs.
# Test instances must not rotate the user's real run.log away.
if [ "${LIQEXPLORER_TEST:-}" = "1" ]; then
  LOG_DIR="${LIQEXPLORER_TEST_DIR:-$HOME/.cache/liqexplorer-test}/logs"
else
  LOG_DIR="${XDG_STATE_HOME:-$HOME/.local/state}/liqexplorer"
fi
mkdir -p "$LOG_DIR"
[ -f "$LOG_DIR/run.log" ] && mv -f "$LOG_DIR/run.log" "$LOG_DIR/run.prev.log"
# `exec cmd | tee` would leave a shell+tee in the process tree. A terminal still
# gets its output; a desktop launcher (no tty) gets the file.
if [ -t 1 ]; then
  exec "$STAGE/electron/electron" "${ARGS[@]}" "$PROJ" "$@" 2>&1 | tee "$LOG_DIR/run.log"
else
  exec "$STAGE/electron/electron" "${ARGS[@]}" "$PROJ" "$@" >"$LOG_DIR/run.log" 2>&1
fi
