#!/usr/bin/env bash
# Make LiqExplorer the system file dialog.
#
# Nothing on Linux draws its own file picker any more: an application asks the
# desktop for one over D-Bus (org.freedesktop.portal.FileChooser), and
# xdg-desktop-portal routes the request to whichever backend implements
# org.freedesktop.impl.portal.FileChooser. On a stock Mint/Cinnamon box exactly
# one thing does — xdg-desktop-portal-gtk — and its dialog cannot be configured,
# extended or improved. This registers LiqExplorer as that backend instead, for
# every application at once: Chrome, Electron apps, Firefox, flatpaks.
#
# Three files, and that is the whole mechanism:
#
#   /usr/share/xdg-desktop-portal/portals/liqexplorer.portal      (root)
#       "this bus name implements FileChooser".  Backends are read from that
#       one directory and nowhere else — there is no per-user equivalent, which
#       is the only reason this script needs sudo at all.
#
#   ~/.local/share/dbus-1/services/…desktop.liqexplorer.service   (user)
#       how to START it. D-Bus activates the helper on the first dialog and it
#       exits again when idle, so nothing sits resident.
#
#   ~/.config/xdg-desktop-portal/<desktop>-portals.conf           (user)
#       "prefer liqexplorer for FileChooser".  First in the search order, so it
#       overrides the system default without touching /usr.
#
# SAFE BY CONSTRUCTION: the helper proxies to xdg-desktop-portal-gtk whenever it
# cannot show a window, so a broken build means the old dialog, never no dialog.
#
#   install-portal.sh          install and switch over
#   install-portal.sh --undo   hand the file dialog back to GTK
#   install-portal.sh --status what is registered and who answers right now
set -euo pipefail
PROJ="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

BUS_NAME="org.freedesktop.impl.portal.desktop.liqexplorer"
PORTAL_DIR="/usr/share/xdg-desktop-portal/portals"
PORTAL_FILE="$PORTAL_DIR/liqexplorer.portal"
SVC_DIR="$HOME/.local/share/dbus-1/services"
SVC="$SVC_DIR/$BUS_NAME.service"
CONF_DIR="$HOME/.config/xdg-desktop-portal"
HELPER="$PROJ/helpers/filechooser-portal.py"

# xdg-desktop-portal looks for "<lowercased XDG_CURRENT_DESKTOP>-portals.conf"
# before the generic portals.conf. Writing the desktop-specific name is what
# makes it win against /usr/share/xdg-desktop-portal/x-cinnamon-portals.conf,
# which is where Mint sets its own defaults.
DESKTOP="$(printf '%s' "${XDG_CURRENT_DESKTOP:-X-Cinnamon}" | cut -d: -f1 | tr '[:upper:]' '[:lower:]')"
CONF="$CONF_DIR/${DESKTOP}-portals.conf"

restart_portal() {
  # The frontend reads .portal files and portals.conf ONCE, at startup, so
  # nothing below takes effect until it is restarted. It is socket/D-Bus
  # activated, so killing it is enough — the next dialog starts it again.
  systemctl --user restart xdg-desktop-portal.service 2>/dev/null ||
    pkill -x xdg-desktop-portal 2>/dev/null || true
  sleep 1
}

case "${1:-}" in
--status)
  echo "backend manifest : $([ -f "$PORTAL_FILE" ] && echo "$PORTAL_FILE" || echo 'not installed')"
  echo "activation       : $([ -f "$SVC" ] && echo "$SVC" || echo 'not installed')"
  echo "preference       : $([ -f "$CONF" ] && echo "$CONF" || echo 'not installed')"
  [ -f "$CONF" ] && sed 's/^/                   /' "$CONF"
  echo -n "owner of $BUS_NAME: "
  if busctl --user status "$BUS_NAME" >/dev/null 2>&1; then echo "running"; else echo "not running (normal — D-Bus activated on demand)"; fi
  exit 0
  ;;
--undo)
  sudo rm -f "$PORTAL_FILE"
  rm -f "$SVC" "$CONF"
  pkill -f 'helpers/filechooser-portal.py' 2>/dev/null || true
  restart_portal
  echo "File dialogs handed back to xdg-desktop-portal-gtk."
  echo "Applications already running may need a restart to notice."
  exit 0
  ;;
esac

if ! python3 -c 'import dbus, gi' 2>/dev/null; then
  echo "Missing python3-dbus / python3-gi."
  echo "  sudo apt install python3-dbus python3-gi"
  exit 1
fi
if [ ! -f "$PROJ/dist/main/index.js" ]; then
  echo "No build found at dist/main/index.js — run bin/build.sh first."
  exit 1
fi

# 1. the backend manifest. UseIn is deprecated but still honoured, and is what
#    covers a session whose portals.conf we did not write (a different desktop,
#    or a login before this ran).
sudo install -Dm644 /dev/stdin "$PORTAL_FILE" <<EOF
[portal]
DBusName=$BUS_NAME
Interfaces=org.freedesktop.impl.portal.FileChooser;
UseIn=X-Cinnamon;GNOME;MATE;XFCE;
EOF
echo "Installed $PORTAL_FILE"

# 2. D-Bus activation. Launched through python3 by absolute path: the project
#    may live on a CIFS share where the exec bit cannot be set, so the helper's
#    own shebang is never usable.
mkdir -p "$SVC_DIR"
cat > "$SVC" <<EOF
[D-BUS Service]
Name=$BUS_NAME
Exec=/usr/bin/python3 $HELPER
EOF
echo "Installed $SVC"

# 3. the preference. `default=` is left as the distro had it so only the file
#    chooser moves — screenshots, settings, inhibit and the rest keep answering
#    exactly as before.
mkdir -p "$CONF_DIR"
cat > "$CONF" <<EOF
[preferred]
default=xapp;gtk;
org.freedesktop.impl.portal.FileChooser=liqexplorer;gtk;
EOF
echo "Installed $CONF"

restart_portal

cat <<EOM

LiqExplorer is now the system file dialog.

Try it:  every "attach", "upload", "open" and "save as" in Chrome, Electron
applications, Firefox and flatpaks. Applications that are ALREADY running keep
a handle on the old backend until they are restarted.

The GTK dialog is still listed as the fallback, and the helper proxies to it
whenever it cannot show a window — so the worst case is the dialog you had
before, never no dialog at all.

Undo:    bin/install-portal.sh --undo
Check:   bin/install-portal.sh --status
EOM
