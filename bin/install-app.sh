#!/usr/bin/env bash
# Install LiqExplorer's icon + menu entry ONLY. Does not change your default
# file manager (that is bin/install-default.sh, which calls this first).
#
# This is what puts the real icon in the applications menu, the panel and the
# window list: Electron does not populate _NET_WM_ICON on X11 (verified with
# xprop), so the desktop environment resolves the icon by matching the window's
# WM_CLASS ('liqexplorer') to StartupWMClass in this .desktop file.
#
# Undo with:  bin/install-app.sh --undo
set -euo pipefail
PROJ="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APPS="$HOME/.local/share/applications"
ICONS="$HOME/.local/share/icons/hicolor"
SIZES=(16 24 32 48 64 128 256 512)
mkdir -p "$APPS"

# gtk-update-icon-cache / update-desktop-database are optional on a given box:
# never let a missing one abort the install (or the undo).
refresh_caches() {
  update-desktop-database "$APPS" 2>/dev/null || true
  gtk-update-icon-cache -qtf "$ICONS" 2>/dev/null || true
}

if [ "${1:-}" = "--undo" ]; then
  rm -f "$APPS/liqexplorer.desktop"
  rm -f "$(xdg-user-dir DESKTOP 2>/dev/null || echo "$HOME/Desktop")/liqexplorer.desktop"
  for size in "${SIZES[@]}"; do
    rm -f "$ICONS/${size}x${size}/apps/liqexplorer.png"
  done
  rm -f "$ICONS/scalable/apps/liqexplorer.svg"
  refresh_caches
  echo "Removed the LiqExplorer menu entry and icons."
  exit 0
fi

for size in "${SIZES[@]}"; do
  install -Dm644 "$PROJ/assets/icons/$size.png" "$ICONS/${size}x${size}/apps/liqexplorer.png"
done
install -Dm644 "$PROJ/assets/icon.svg" "$ICONS/scalable/apps/liqexplorer.svg"

# Launch through bash so Exec= works even when the checkout is on a noexec
# filesystem (common for network shares) where run.sh is readable but not +x.
LAUNCH="/bin/bash \"$PROJ/bin/run.sh\""

# MimeType is declared so LiqExplorer shows up under "Open with" for folders —
# that alone does NOT make it the default (install-default.sh does that).
write_entry() {
  cat > "$1" <<EOF
[Desktop Entry]
Name=LiqExplorer
Comment=Windows 11 style file manager
Exec=$LAUNCH %U
Icon=liqexplorer
Terminal=false
Type=Application
Categories=System;FileTools;FileManager;
MimeType=inode/directory;application/x-gnome-saved-search;
StartupNotify=false
StartupWMClass=liqexplorer
Actions=open-home;open-computer;

[Desktop Action open-home]
Name=Home
Exec=$LAUNCH "$HOME"

[Desktop Action open-computer]
Name=Computer
Exec=$LAUNCH /
EOF
}

write_entry "$APPS/liqexplorer.desktop"

# Desktop shortcut. Cinnamon (nemo-desktop) only runs a .desktop dropped on the
# desktop if it is BOTH executable and marked trusted — otherwise it shows the
# "untrusted application launcher" refusal.
DESKTOP_DIR="$(xdg-user-dir DESKTOP 2>/dev/null || echo "$HOME/Desktop")"
if [ -d "$DESKTOP_DIR" ]; then
  write_entry "$DESKTOP_DIR/liqexplorer.desktop"
  chmod +x "$DESKTOP_DIR/liqexplorer.desktop"
  # gio metadata goes through gvfsd-metadata on the session bus; without the bus
  # (e.g. run from a detached shell) `gio set` silently does nothing, so fall
  # back to the well-known session bus path for this user.
  [ -n "${DBUS_SESSION_BUS_ADDRESS:-}" ] ||
    export DBUS_SESSION_BUS_ADDRESS="unix:path=/run/user/$(id -u)/bus"
  gio set "$DESKTOP_DIR/liqexplorer.desktop" metadata::trusted true 2>/dev/null || true
  gio set "$DESKTOP_DIR/liqexplorer.desktop" metadata::nemo-trusted true 2>/dev/null || true
  # nemo-desktop re-reads the file when its mtime changes
  touch "$DESKTOP_DIR/liqexplorer.desktop"
fi

refresh_caches
echo "Installed the LiqExplorer menu entry, desktop shortcut and icons"
echo "(default file manager unchanged)."
echo "Remove with: $PROJ/bin/install-app.sh --undo"
