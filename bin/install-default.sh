#!/usr/bin/env bash
# Make LiqExplorer the default file browser (REVERSIBLE). Opt-in only.
# Installs the icon + menu entry via bin/install-app.sh, then points the
# folder mime types at it.
# Does NOT touch nemo-desktop / desktop icons / FileManager1 (see docs/PARITY.md).
# Undo restores the PREVIOUS default handler (saved on first opt-in), not a
# hard-coded Nemo — so GNOME/KDE/Arch users get their original FM back.
# Undo everything this script did with:  bin/install-default.sh --undo
set -euo pipefail
PROJ="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MIMES=(inode/directory application/x-gnome-saved-search)
STATE_DIR="${XDG_STATE_HOME:-$HOME/.local/state}/liqexplorer"
PREV_FILE="$STATE_DIR/previous-default-handler"

# Common desktop file ids if we have nothing saved to restore.
fallback_previous() {
  for cand in \
      nemo.desktop \
      org.gnome.Nautilus.desktop \
      org.kde.dolphin.desktop \
      thunar.desktop \
      caja.desktop \
      pcmanfm.desktop \
      pcmanfm-qt.desktop
  do
    if [ -f "/usr/share/applications/$cand" ] || [ -f "$HOME/.local/share/applications/$cand" ]; then
      echo "$cand"
      return 0
    fi
  done
  echo "nemo.desktop"
}

if [ "${1:-}" = "--undo" ]; then
  prev=""
  if [ -f "$PREV_FILE" ]; then
    prev="$(tr -d '[:space:]' < "$PREV_FILE" || true)"
  fi
  if [ -z "$prev" ] || [ "$prev" = "liqexplorer.desktop" ]; then
    prev="$(fallback_previous)"
  fi
  xdg-mime default "$prev" "${MIMES[@]}"
  rm -f "$PREV_FILE"
  bash "$PROJ/bin/install-app.sh" --undo
  echo "Reverted: default file browser is $prev again."
  exit 0
fi

mkdir -p "$STATE_DIR"
# Save current default once (don't overwrite if re-run while already default)
current="$(xdg-mime query default inode/directory 2>/dev/null || true)"
if [ -n "$current" ] && [ "$current" != "liqexplorer.desktop" ]; then
  printf '%s\n' "$current" > "$PREV_FILE"
elif [ ! -f "$PREV_FILE" ]; then
  printf '%s\n' "$(fallback_previous)" > "$PREV_FILE"
fi

bash "$PROJ/bin/install-app.sh"
xdg-mime default liqexplorer.desktop "${MIMES[@]}"
echo "Default file browser is now LiqExplorer."
echo "Previous handler saved to $PREV_FILE"
echo "Revert with: $PROJ/bin/install-default.sh --undo"
