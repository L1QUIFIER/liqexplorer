#!/usr/bin/env bash
# Take over org.freedesktop.FileManager1 — the D-Bus name behind "Show in
# folder" / "Open containing folder" in Chrome, GIMP, Steam, Thunderbird and
# most GTK/Qt applications.
#
# SEPARATE FROM install-default.sh ON PURPOSE: that one only sets associations,
# this one takes a name off another running process.
#
# The name is held by nemo-desktop, which also draws the desktop icons — so this
# looked like a trade: "Show in folder" OR desktop icons. It is not. nemo-desktop
# claims the name only if it is FREE when it starts, and draws icons perfectly
# well without it, so taking the name during a brief restart keeps both. See
# helpers/filemanager1-autostart.sh.
#
#   install-filemanager1.sh            install the service (no takeover)
#   install-filemanager1.sh --takeover own the name, and keep it across logins
#   install-filemanager1.sh --undo     hand the name back to nemo
set -euo pipefail
PROJ="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SVC_DIR="$HOME/.local/share/dbus-1/services"
SVC="$SVC_DIR/org.freedesktop.FileManager1.service"
LOGIN_ENTRY="$HOME/.config/autostart/liqexplorer-filemanager1.desktop"
HELPER="$PROJ/helpers/filemanager1.py"

need_deps() {
  if ! python3 -c 'import dbus, gi' 2>/dev/null; then
    echo "Missing python3-dbus / python3-gi."
    echo "  sudo apt install python3-dbus python3-gi"
    exit 1
  fi
}

case "${1:-}" in
--undo)
  rm -f "$SVC" "$LOGIN_ENTRY"
  # stop our holder so the name is free again; nemo-desktop takes it on its
  # next start, and desktop icons were never touched
  pkill -f 'helpers/filemanager1.py' 2>/dev/null || true
  pkill -x nemo-desktop 2>/dev/null || true
  sleep 1
  gsettings set org.nemo.desktop show-desktop-icons true 2>/dev/null || true
  echo "Removed the LiqExplorer FileManager1 service."
  exit 0
  ;;
esac

need_deps
mkdir -p "$SVC_DIR"
cat > "$SVC" <<EOF
[D-BUS Service]
Name=org.freedesktop.FileManager1
Exec=/usr/bin/python3 $HELPER
EOF
echo "Installed $SVC"

if [ "${1:-}" != "--takeover" ]; then
  cat <<'EOM'

Service installed, but NOT active: nemo-desktop is still running and owns the
name, so "Show in folder" from other applications still opens Nemo.

To finish the takeover:
    bin/install-filemanager1.sh --takeover

That briefly restarts nemo-desktop to take the name off it. Your desktop icons
come straight back — nemo-desktop keeps drawing them, it just no longer answers
"Show in folder". Undo with:
    bin/install-filemanager1.sh --undo
EOM
  exit 0
fi

# --takeover
#
# It turned out NOT to be necessary to give up the desktop icons for this.
# nemo-desktop claims the name only if it is free when it starts, and it draws
# icons fine without it — so instead of disabling nemo-desktop, we take the name
# while it is briefly stopped and let it come straight back.
# helpers/filemanager1-autostart.sh does that dance; this installs it for login.
mkdir -p "$(dirname "$LOGIN_ENTRY")"
cat > "$LOGIN_ENTRY" <<EOF
[Desktop Entry]
Type=Application
Name=LiqExplorer file-manager integration
Comment=Owns org.freedesktop.FileManager1 so "Show in folder" opens LiqExplorer
Exec=/bin/bash "$PROJ/helpers/filemanager1-autostart.sh"
X-GNOME-Autostart-enabled=true
NoDisplay=true
EOF
echo "Installed $LOGIN_ENTRY"

bash "$PROJ/helpers/filemanager1-autostart.sh"
sleep 1
OWNER=$(dbus-send --session --dest=org.freedesktop.DBus --type=method_call --print-reply \
  /org/freedesktop/DBus org.freedesktop.DBus.GetConnectionUnixProcessID \
  string:org.freedesktop.FileManager1 2>/dev/null | tail -1 | awk '{print $2}')
if ps -p "${OWNER:-0}" -o args= 2>/dev/null | grep -q filemanager1.py; then
  echo "LiqExplorer now answers 'Show in folder'. Your desktop icons are unaffected."
else
  echo "WARNING: the name is still owned by something else; 'Show in folder' is unchanged."
fi
echo "Undo with: $PROJ/bin/install-filemanager1.sh --undo"
