#!/usr/bin/env python3
# X11 clipboard interop helper for LiqExplorer (python3 + GTK3 via gi).
#
# Two modes:
#   own mode:   clipboard-owner.py own <json-file>     (file path or '-' for stdin)
#               reads {"op":"cut"|"copy","paths":["/abs/a","/abs/b"]}, owns the
#               CLIPBOARD selection offering the file-manager targets
#               (x-special/gnome-copied-files, x-special/mate-copied-files,
#               application/x-kde-cutselection, text/uri-list, text/plain...),
#               prints "OWNED" when ready and "LOST" + exits 0 when another
#               application takes the clipboard. SIGTERM exits cleanly.
#   read mode:  clipboard-owner.py --read
#               reads the current clipboard (priority gnome -> mate -> kde +
#               uri-list -> uri-list), prints JSON {"op":...,"paths":[...]} or
#               "null", exits.
#
# NOTE: Gtk.Clipboard.set_with_data is not introspectable from Python, so own
# mode uses the lower-level GtkSelection API (selection_owner_set +
# selection-get / selection-clear-event) which is fully introspectable. GTK
# answers TARGETS/TIMESTAMP/MULTIPLE for us.

import json
import os
import signal
import sys

import gi
gi.require_version('Gtk', '3.0')
gi.require_version('Gdk', '3.0')
from gi.repository import Gtk, Gdk, GLib  # noqa: E402

TARGET_GNOME = 'x-special/gnome-copied-files'
TARGET_MATE = 'x-special/mate-copied-files'
TARGET_KDE = 'application/x-kde-cutselection'
TARGET_URI_LIST = 'text/uri-list'
TARGET_TEXT_UTF8 = 'text/plain;charset=utf-8'
TARGET_TEXT = 'text/plain'
TARGET_UTF8_STRING = 'UTF8_STRING'

CLIPBOARD = Gdk.Atom.intern('CLIPBOARD', False)


def build_payloads(op: str, paths: list):
    uris = [GLib.filename_to_uri(p, None) for p in paths]
    gnome = (op + '\n' + '\n'.join(uris)).encode('utf-8')
    kde = b'1' if op == 'cut' else b'0'
    uri_list = ''.join(u + '\r\n' for u in uris).encode('utf-8')
    text = '\n'.join(paths).encode('utf-8')
    return {
        TARGET_GNOME: gnome,
        TARGET_MATE: gnome,
        TARGET_KDE: kde,
        TARGET_URI_LIST: uri_list,
        TARGET_TEXT_UTF8: text,
        TARGET_TEXT: text,
        TARGET_UTF8_STRING: text,
    }


def run_own(argv):
    src = argv[0] if argv else '-'
    if src == '-':
        raw = sys.stdin.read()
    else:
        with open(src, 'r', encoding='utf-8') as f:
            raw = f.read()
    req = json.loads(raw)
    op = req.get('op')
    paths = req.get('paths') or []
    if op not in ('cut', 'copy') or not paths:
        print('ERROR bad request', flush=True)
        return 1

    payloads = build_payloads(op, paths)
    target_names = list(payloads.keys())

    widget = Gtk.Invisible()
    widget.realize()

    def on_selection_get(_w, selection_data, info, _time):
        name = target_names[info] if 0 <= info < len(target_names) else None
        if name is None:
            return
        data = payloads[name]
        selection_data.set(Gdk.Atom.intern(name, False), 8, data)

    def on_selection_clear(_w, _event):
        # Another application took the CLIPBOARD.
        print('LOST', flush=True)
        Gtk.main_quit()
        return False

    widget.connect('selection-get', on_selection_get)
    widget.connect('selection-clear-event', on_selection_clear)
    for i, name in enumerate(target_names):
        Gtk.selection_add_target(widget, CLIPBOARD, Gdk.Atom.intern(name, False), i)

    if not Gtk.selection_owner_set(widget, CLIPBOARD, Gdk.CURRENT_TIME):
        print('ERROR cannot own clipboard', flush=True)
        return 1

    def on_sigterm():
        Gtk.main_quit()
        return GLib.SOURCE_REMOVE

    GLib.unix_signal_add(GLib.PRIORITY_DEFAULT, signal.SIGTERM, on_sigterm)
    GLib.unix_signal_add(GLib.PRIORITY_DEFAULT, signal.SIGINT, on_sigterm)

    # Safety net: if the parent (Electron main) died without killing us, exit so
    # orphaned helpers don't accumulate across app restarts.
    def check_orphaned():
        if os.getppid() == 1:
            Gtk.main_quit()
            return GLib.SOURCE_REMOVE
        return GLib.SOURCE_CONTINUE

    GLib.timeout_add_seconds(5, check_orphaned)

    print('OWNED', flush=True)
    Gtk.main()
    return 0


def uris_to_paths(uris):
    paths = []
    for u in uris:
        u = u.strip()
        if not u or u.startswith('#'):
            continue
        if not u.startswith('file://'):
            continue  # skip non-file schemes (smb://, trash:// ...)
        try:
            filename, _host = GLib.filename_from_uri(u)
        except Exception:
            continue
        if filename:
            paths.append(filename)
    return paths


def read_target(clip, name):
    sel = clip.wait_for_contents(Gdk.Atom.intern(name, False))
    if sel is None:
        return None
    data = sel.get_data()
    if data is None:
        return None
    return bytes(data)


def run_read():
    clip = Gtk.Clipboard.get(CLIPBOARD)

    # Priority 1+2: gnome / mate copied-files ("cut|copy\nuri\nuri...")
    for name in (TARGET_GNOME, TARGET_MATE):
        data = read_target(clip, name)
        if data:
            lines = data.decode('utf-8', 'replace').split('\n')
            op = lines[0].strip()
            if op in ('cut', 'copy'):
                paths = uris_to_paths(lines[1:])
                if paths:
                    print(json.dumps({'op': op, 'paths': paths}), flush=True)
                    return 0

    # Priority 3: kde cutselection flag + uri-list
    uri_data = read_target(clip, TARGET_URI_LIST)
    if uri_data:
        paths = uris_to_paths(uri_data.decode('utf-8', 'replace').replace('\r\n', '\n').split('\n'))
        if paths:
            kde = read_target(clip, TARGET_KDE)
            op = 'cut' if (kde is not None and kde[:1] == b'1') else 'copy'
            print(json.dumps({'op': op, 'paths': paths}), flush=True)
            return 0

    print('null', flush=True)
    return 0


def main():
    argv = sys.argv[1:]
    if argv and argv[0] == '--read':
        return run_read()
    if argv and argv[0] == 'own':
        return run_own(argv[1:])
    # No explicit mode: treat first arg (or stdin) as the own-mode request file.
    return run_own(argv)


if __name__ == '__main__':
    sys.exit(main())
