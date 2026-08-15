#!/usr/bin/env bash
# Make LiqExplorer the default file browser, and put it on the Cinnamon panel.
# REVERSIBLE: --undo restores exactly what was there before.
#
# WHY THE SNAPSHOT. This script used to hard-code `xdg-mime default nemo.desktop`
# as its undo. On this machine the default was org.kde.dolphin.desktop, so the
# "revert" would have quietly handed folders to a file manager the user had not
# chosen — a worse state than before the script ran. It now records what each
# association actually was and puts that back, including "unset".
#
# NOT touched here (see docs/PARITY.md and --dbus below):
#   * nemo-desktop, which draws the desktop icons AND owns the
#     org.freedesktop.FileManager1 name that "Show in folder" uses.
set -euo pipefail
PROJ="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STATE="${XDG_STATE_HOME:-$HOME/.local/state}/liqexplorer"
SNAP="$STATE/default-handler-before.json"
DESKTOP=liqexplorer.desktop

# inode/directory + x-directory/normal are the folder types themselves.
# x-gnome-saved-search is a saved search folder. The two schemes are how some
# applications ask for "open this location" rather than "open this file".
MIMES=(inode/directory x-directory/normal application/x-directory
       application/x-gnome-saved-search
       x-scheme-handler/file x-scheme-handler/trash)

# Other file managers this replaces. Their .desktop ids are removed from the
# taskbar pins and the panel launchers, because "make LiqExplorer the default"
# and "still have Dolphin pinned to the taskbar" are not the same wish — the
# mime default decides what a double-click does, the pin is a second, separate
# way in that no association can reach.
REPLACES=(org.kde.dolphin.desktop nemo.desktop org.gnome.Nautilus.desktop
          nautilus.desktop thunar.desktop)

panel_json() { echo "$HOME/.config/cinnamon/spices/panel-launchers@cinnamon.org/30.json"; }

# Cinnamon keeps taskbar pins per grouped-window-list INSTANCE — one per panel,
# so a multi-monitor setup has several and fixing only one leaves the others.
set_pinned() {
  python3 - "$DESKTOP" "$1" "${REPLACES[@]}" <<'PY'
import glob, json, os, sys
entry, mode = sys.argv[1], sys.argv[2]
replaces = set(sys.argv[3:])
found = 0
for path in sorted(glob.glob(os.path.expanduser(
        '~/.config/cinnamon/spices/grouped-window-list@cinnamon.org/*.json'))):
    try:
        doc = json.load(open(path))
    except Exception:
        continue
    node = doc.get('pinned-apps')
    if not isinstance(node, dict) or 'value' not in node:
        continue
    cur = list(node['value'])
    if mode == 'add':
        out = [entry if a in replaces else a for a in cur]
        if entry not in out:
            out.insert(0, entry)
    else:
        out = [a for a in cur if a != entry]
    # de-dupe while keeping order: replacing two managers with one would double it
    seen, deduped = set(), []
    for a in out:
        if a not in seen:
            seen.add(a); deduped.append(a)
    if deduped == cur:
        continue
    node['value'] = deduped
    json.dump(doc, open(path, 'w'), indent=2)
    print(f'  pinned ({os.path.basename(path)}):', ', '.join(deduped) or '(none)')
    found += 1
if not found:
    print('  pinned: nothing to change')
PY
}

# The desktop's Trash shortcut launches a file manager by NAME, so no mime
# association can redirect it.
set_trash_shortcut() {
  python3 - "$1" "$PROJ" <<'PY'
import os, re, sys
mode, proj = sys.argv[1], sys.argv[2]
p = os.path.expanduser('~/Desktop/Trash.desktop')
if not os.path.exists(p):
    print('  trash shortcut: none'); raise SystemExit(0)
text = open(p).read()
# straight at the app rather than through `gio open trash:///`: that would
# depend on the x-scheme-handler/trash association still being ours, which is
# one more thing to go wrong for a shortcut that only ever means one thing
new_exec = (f'Exec=/bin/bash "{proj}/bin/run.sh" trash://'
            if mode == 'add' else 'Exec=nemo trash:///')
out = re.sub(r'^Exec=.*$', new_exec, text, count=1, flags=re.M)
if out == text:
    print('  trash shortcut: unchanged'); raise SystemExit(0)
open(p, 'w').write(out)
print('  trash shortcut:', new_exec.split('=', 1)[1])
PY
}

snapshot() {
  mkdir -p "$STATE"
  python3 - "$SNAP" "$(panel_json)" "${MIMES[@]}" <<'PY'
import json, os, subprocess, sys, time
snap_path, panel_path = sys.argv[1], sys.argv[2]
mimes = sys.argv[3:]
# never overwrite an existing snapshot: running the installer twice must not
# record the state IT created as the thing to go back to
if os.path.exists(snap_path):
    print('  (keeping the existing snapshot)')
    raise SystemExit(0)
def q(m):
    return subprocess.run(['xdg-mime', 'query', 'default', m],
                          capture_output=True, text=True).stdout.strip()
snap = {'takenAt': time.strftime('%Y-%m-%dT%H:%M:%S'),
        'mime': {m: q(m) for m in mimes}}
try:
    snap['panelLaunchers'] = json.load(open(panel_path))['launcherList']['value']
except Exception:
    snap['panelLaunchers'] = None
os.makedirs(os.path.dirname(snap_path), exist_ok=True)
json.dump(snap, open(snap_path, 'w'), indent=1)
print('  recorded previous state ->', snap_path)
PY
}

set_panel() {
  # add or remove the launcher, preserving everything else in the list
  python3 - "$(panel_json)" "$DESKTOP" "$1" <<'PY'
import json, sys
path, entry, mode = sys.argv[1], sys.argv[2], sys.argv[3]
try:
    doc = json.load(open(path))
except Exception as e:
    print(f'  panel: not updated ({e})'); raise SystemExit(0)
cur = list(doc.get('launcherList', {}).get('value', []))
if mode == 'add':
    if entry in cur:
        print('  panel: already there'); raise SystemExit(0)
    cur.insert(0, entry)          # a file manager belongs at the front
else:
    if entry not in cur:
        print('  panel: nothing to remove'); raise SystemExit(0)
    cur = [x for x in cur if x != entry]
doc['launcherList']['value'] = cur
json.dump(doc, open(path, 'w'), indent=2)
print('  panel:', ', '.join(cur))
PY
}

if [ "${1:-}" = "--undo" ]; then
  if [ -f "$SNAP" ]; then
    python3 - "$SNAP" <<'PY'
import json, subprocess, sys
snap = json.load(open(sys.argv[1]))
for m, was in snap.get('mime', {}).items():
    if was:
        subprocess.run(['xdg-mime', 'default', was, m], check=False)
        print(f'  {m} -> {was}')
    else:
        # xdg-mime has no "unset"; strip the line from mimeapps.list directly
        import os
        p = os.path.expanduser('~/.config/mimeapps.list')
        try:
            lines = open(p).read().splitlines(True)
            open(p, 'w').writelines(l for l in lines if not l.startswith(m + '='))
            print(f'  {m} -> (unset again)')
        except Exception:
            pass
PY
  else
    echo "  no snapshot found — leaving the mime associations alone"
  fi
  set_panel remove
  set_pinned remove
  set_trash_shortcut remove
  bash "$PROJ/bin/install-app.sh" --undo
  echo "Reverted."
  exit 0
fi

echo "Installing the application entry…"
bash "$PROJ/bin/install-app.sh"
echo "Recording what is there now…"
snapshot
echo "Pointing folder types at LiqExplorer…"
for m in "${MIMES[@]}"; do xdg-mime default "$DESKTOP" "$m"; done
update-desktop-database "$HOME/.local/share/applications" 2>/dev/null || true
echo "Adding it to the panel…"
set_panel add
set_pinned add
set_trash_shortcut add
echo
echo "LiqExplorer is now the default file browser."
echo "  Revert everything with: $PROJ/bin/install-default.sh --undo"
echo
echo "NOT changed: 'Show in folder' from other applications still goes to Nemo,"
echo "because nemo-desktop owns org.freedesktop.FileManager1 and also draws your"
echo "desktop icons. Run bin/install-filemanager1.sh to take that over."
