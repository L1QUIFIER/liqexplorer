#!/usr/bin/env bash
# Restart the :99 test instance, reliably.
#
# Two traps this exists to avoid, both of which silently give you a STALE app
# that still answers CDP, so tests "pass" against code you did not build:
#
#  1. The obvious pid is the wrapper (bin/run.sh / dbus-run-session), not the
#     electron main process. Killing it leaves the app running.
#  2. The app takes a single-instance lock per --user-data-dir, so a second
#     launch exits immediately and quietly while the old one keeps the port.
#
# It therefore kills by user-data-dir, WAITS for the process to actually go,
# and refuses to launch while one is still alive.
#
# Usage: bash bin/test-restart.sh [port]   (default 9333)
# Set LIQEXPLORER_TEST_DIR to run a second instance alongside someone else's.
set -uo pipefail
PROJ="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PORT="${1:-9333}"
# LIQEXPLORER_TEST_DIR keeps concurrent test runs off each other's profile
TESTDIR="${LIQEXPLORER_TEST_DIR:-$HOME/.cache/liqexplorer-test}"
PROFILE="$TESTDIR/profile"
LOG="${LIQEXPLORER_TEST_LOG:-/tmp/liqexplorer-test-$PORT.log}"

# the electron MAIN process: has the user-data-dir and no --type= (renderers,
# zygotes and gpu helpers all carry --type= and die with their parent)
mains() {
  ps -eo pid,args | grep -F -- "--user-data-dir=$PROFILE" | grep -v -- '--type=' \
    | grep -v grep | awk '{print $1}'
}

for pid in $(mains); do kill "$pid" 2>/dev/null; done
for _ in $(seq 1 20); do
  [ -z "$(mains)" ] && break
  sleep 0.5
done
for pid in $(mains); do kill -9 "$pid" 2>/dev/null; done
sleep 1

if [ -n "$(mains)" ]; then
  echo "FAILED: a test instance is still alive: $(mains)" >&2
  exit 1
fi

# --remote-allow-origins='*' is required: without it the CDP WebSocket 403s,
# because the debugger connects with an http://127.0.0.1:<port> origin
setsid nohup env DISPLAY=:99 LIQEXPLORER_TEST=1 LIQEXPLORER_TEST_DIR="$TESTDIR" dbus-run-session -- \
  bash "$PROJ/bin/run.sh" \
  --remote-debugging-port="$PORT" --remote-allow-origins='*' \
  >"$LOG" 2>&1 </dev/null &

for _ in $(seq 1 40); do
  sleep 0.5
  if curl -s --max-time 2 "http://127.0.0.1:$PORT/json/list" | grep -q '"type"'; then
    started=$(ps -eo pid,lstart,args | grep -F -- "--user-data-dir=$PROFILE" \
      | grep -v -- '--type=' | grep -v grep | head -1)
    echo "up on $PORT — $started"
    echo "log: $LOG"
    exit 0
  fi
done
echo "FAILED: no CDP on $PORT after 20s; see $LOG" >&2
tail -5 "$LOG" >&2
exit 1
