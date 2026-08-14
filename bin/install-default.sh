#!/usr/bin/env bash
# Make LiqExplorer the default file browser (REVERSIBLE). Opt-in only.
# Installs the icon + menu entry via bin/install-app.sh, then points the
# folder mime types at it.
# Does NOT touch nemo-desktop / desktop icons / FileManager1 (see docs/PARITY.md).
# Undo everything this script did with:  bin/install-default.sh --undo
set -euo pipefail
PROJ="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MIMES=(inode/directory application/x-gnome-saved-search)

if [ "${1:-}" = "--undo" ]; then
  xdg-mime default nemo.desktop "${MIMES[@]}"
  bash "$PROJ/bin/install-app.sh" --undo
  echo "Reverted: default file browser is Nemo again."
  exit 0
fi

bash "$PROJ/bin/install-app.sh"
xdg-mime default liqexplorer.desktop "${MIMES[@]}"
echo "Default file browser is now LiqExplorer."
echo "Revert with: $PROJ/bin/install-default.sh --undo"
