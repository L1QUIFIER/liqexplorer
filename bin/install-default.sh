#!/usr/bin/env bash
# Make LiqExplorer the default file browser (REVERSIBLE). Opt-in only; reversible.
# Does NOT touch nemo-desktop / desktop icons / FileManager1 (see docs/PARITY.md).
set -euo pipefail
PROJ="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APPS="$HOME/.local/share/applications"
mkdir -p "$APPS"

cat > "$APPS/liqexplorer.desktop" <<EOF
[Desktop Entry]
Name=LiqExplorer
Comment=Windows 11 style file manager
Exec=$PROJ/bin/run.sh %U
Icon=system-file-manager
Terminal=false
Type=Application
Categories=System;FileTools;FileManager;Utility;Core;
MimeType=inode/directory;application/x-gnome-saved-search;
StartupNotify=false
Actions=open-home;open-computer;

[Desktop Action open-home]
Name=Home
Exec=$PROJ/bin/run.sh $HOME

[Desktop Action open-computer]
Name=Computer
Exec=$PROJ/bin/run.sh /
EOF

update-desktop-database "$APPS" 2>/dev/null || true
xdg-mime default liqexplorer.desktop inode/directory application/x-gnome-saved-search
echo "Default file browser is now LiqExplorer."
echo "Revert with: xdg-mime default nemo.desktop inode/directory application/x-gnome-saved-search"
