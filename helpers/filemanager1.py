#!/usr/bin/env python3
"""org.freedesktop.FileManager1 for LiqExplorer.

This is the interface behind "Show in folder" / "Open containing folder" in
Chrome, GIMP, Steam, Thunderbird and most GTK/Qt applications. Without it,
LiqExplorer can be the default file manager for double-clicking a folder while
every "reveal this file" in the system still opens something else — which is
the half of "default everywhere" that is easy to miss.

WHY PYTHON AND NOT ELECTRON. Electron has no D-Bus binding, and adding one
would mean a native npm dependency in a project whose whole design is zero
runtime dependencies plus system tools (see helpers/clipboard-owner.py, which
exists for the same reason). python3-dbus is already installed on Mint.

WHY A SEPARATE PROCESS AND NOT THE APP ITSELF. D-Bus activation must be able to
start the handler when nothing is running, and the caller blocks until the name
is answered. A small always-available service that then launches (or signals)
the app keeps a slow Electron start off the caller's critical path.

The three methods are the whole interface:
    ShowFolders(uris, startup_id)         open these folders
    ShowItems(uris, startup_id)           reveal these files IN their folder
    ShowItemProperties(uris, startup_id)  properties for these items
"""
import os
import subprocess
import sys
from urllib.parse import unquote, urlparse

try:
    import dbus
    import dbus.service
    import dbus.mainloop.glib
    from gi.repository import GLib
except ImportError as exc:  # pragma: no cover - environment problem, not logic
    sys.stderr.write(
        f'liqexplorer FileManager1: missing python3-dbus/pygobject ({exc}).\n'
        'Install with: sudo apt install python3-dbus python3-gi\n')
    raise SystemExit(1)

BUS_NAME = 'org.freedesktop.FileManager1'
OBJ_PATH = '/org/freedesktop/FileManager1'
IFACE = 'org.freedesktop.FileManager1'

PROJECT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RUN_SH = os.path.join(PROJECT, 'bin', 'run.sh')

#: nothing has asked for a window in this long -> the service has no reason to
#: stay resident. D-Bus will start it again on the next call.
IDLE_EXIT_SECONDS = 300


def uri_to_path(uri):
    """file:// URI -> filesystem path. Anything else comes back as None.

    Callers send percent-encoded URIs, and filenames here contain spaces,
    quotes and '#'. urlparse+unquote is the decode that gets those right; naive
    prefix-stripping does not.
    """
    if not uri:
        return None
    if uri.startswith('/'):
        return uri
    parsed = urlparse(uri)
    if parsed.scheme != 'file':
        return None
    return unquote(parsed.path) or None


def launch(args):
    """Start the app detached, so the D-Bus caller is never left waiting."""
    subprocess.Popen(
        ['/bin/bash', RUN_SH] + args,
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        stdin=subprocess.DEVNULL, start_new_session=True)


class FileManager1(dbus.service.Object):
    def __init__(self, bus, loop):
        super().__init__(bus, OBJ_PATH)
        self._loop = loop
        self._idle = None
        self._arm_idle()

    def _arm_idle(self):
        if self._idle is not None:
            GLib.source_remove(self._idle)
        self._idle = GLib.timeout_add_seconds(IDLE_EXIT_SECONDS, self._quit)

    def _quit(self):
        self._loop.quit()
        return False

    @dbus.service.method(IFACE, in_signature='ass', out_signature='')
    def ShowFolders(self, uris, startup_id):
        self._arm_idle()
        paths = [p for p in (uri_to_path(u) for u in uris) if p]
        if paths:
            launch(paths)

    @dbus.service.method(IFACE, in_signature='ass', out_signature='')
    def ShowItems(self, uris, startup_id):
        """Reveal each item — open its PARENT folder with the item selected.

        Opening the file itself would be wrong: "Show in folder" means show me
        where it lives, and for a video it would start playing it instead.
        --select is handled by the app's own argument parsing.
        """
        self._arm_idle()
        args = []
        for uri in uris:
            path = uri_to_path(uri)
            if not path:
                continue
            args += ['--select', path]
        if args:
            launch(args)

    @dbus.service.method(IFACE, in_signature='ass', out_signature='')
    def ShowItemProperties(self, uris, startup_id):
        self._arm_idle()
        args = []
        for uri in uris:
            path = uri_to_path(uri)
            if path:
                args += ['--properties', path]
        if args:
            launch(args)


def main():
    dbus.mainloop.glib.DBusGMainLoop(set_as_default=True)
    bus = dbus.SessionBus()
    # do_not_queue: if something else already owns the name (nemo-desktop does,
    # until it is disabled), fail loudly and exit rather than sitting in a queue
    # for a name that will never be released.
    request = bus.request_name(BUS_NAME, dbus.bus.NAME_FLAG_DO_NOT_QUEUE)
    if request != dbus.bus.REQUEST_NAME_REPLY_PRIMARY_OWNER:
        sys.stderr.write(
            'liqexplorer FileManager1: the name is already owned by another '
            'file manager (usually nemo-desktop). Nothing to do.\n')
        return 1
    loop = GLib.MainLoop()
    FileManager1(dbus.service.BusName(BUS_NAME, bus), loop)
    loop.run()
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
