#!/usr/bin/env bash
# Claim org.freedesktop.FileManager1 at login WITHOUT losing the desktop icons.
#
# The obvious approach — disable nemo-desktop so the name is free — costs the
# desktop icons, because nemo-desktop is what draws them. It turns out not to be
# necessary: nemo-desktop only takes the name if it is FREE when it starts, and
# it draws icons perfectly well without it. So the trick is to be holding the
# name by the time it comes back.
#
# Hence the dance, which is the sequence proved by hand before it was written
# down here:
#   1. turn the desktop-icons setting off  -> Cinnamon stops respawning nemo-desktop
#   2. stop nemo-desktop                   -> the name is released
#   3. claim the name                      -> ours, and it never lets go
#   4. turn desktop icons back on          -> nemo-desktop returns, icons return,
#                                             and it does not contest the name
#
# The visible cost is the desktop icons blinking once at login.
set -uo pipefail
PROJ="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HELPER="$PROJ/helpers/filemanager1.py"

owner_pid() {
  dbus-send --session --dest=org.freedesktop.DBus --type=method_call --print-reply \
    /org/freedesktop/DBus org.freedesktop.DBus.GetConnectionUnixProcessID \
    string:org.freedesktop.FileManager1 2>/dev/null | tail -1 | awk '{print $2}'
}

# Already ours from an earlier run? Then there is nothing to do, and in
# particular no reason to blink the desktop icons.
current="$(owner_pid || true)"
if [ -n "${current:-}" ] && ps -p "$current" -o args= 2>/dev/null | grep -q filemanager1.py; then
  exit 0
fi

had_icons="$(gsettings get org.nemo.desktop show-desktop-icons 2>/dev/null || echo true)"

if [ "$had_icons" = "true" ]; then
  gsettings set org.nemo.desktop show-desktop-icons false
  sleep 1
fi
pkill -x nemo-desktop 2>/dev/null || true
sleep 2

setsid "$HELPER" >/dev/null 2>&1 < /dev/null &
# give it a moment to actually own the name before nemo-desktop is invited back
sleep 3

if [ "$had_icons" = "true" ]; then
  gsettings set org.nemo.desktop show-desktop-icons true
fi
