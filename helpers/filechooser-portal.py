#!/usr/bin/env python3
"""org.freedesktop.impl.portal.FileChooser for LiqExplorer.

THIS IS THE SYSTEM FILE DIALOG. On Linux an application does not draw its own
file picker: it asks the desktop for one over D-Bus, and xdg-desktop-portal
routes the request to whichever backend implements this interface. Out of the
box that is xdg-desktop-portal-gtk, and its dialog is a dead end — no columns,
no useful search, none of the places this file manager knows about, and nothing
configurable. Registering LiqExplorer here replaces it for Chrome, Electron
applications, Firefox, flatpaks and anything else that asks, all at once,
because they all ask the same question of the same bus name.

Install with bin/install-portal.sh (and undo it with --undo).

WHY PYTHON AND NOT ELECTRON — same reason as helpers/filemanager1.py: Electron
has no D-Bus binding, and this project takes no native npm dependencies.

WHY IT NEVER FAILS CLOSED. A file dialog that does not appear is far worse than
an ugly one: the application is left with no way to open anything at all. So
every path that cannot produce a LiqExplorer window — app not installed, build
missing, window never appeared, crash, unimplemented method — PROXIES the call
straight through to xdg-desktop-portal-gtk and the user gets the old dialog
instead of nothing. See _ask_gtk().

THE THREE METHODS
    OpenFile(handle, app_id, parent, title, options)   pick existing file(s)
        options['directory'] makes it a folder picker
    SaveFile(handle, app_id, parent, title, options)   pick a destination path
    SaveFiles(handle, app_id, parent, title, options)  pick a folder for N names

Each returns (response, results): response 0 = success, 1 = cancelled by the
user, 2 = other error; results['uris'] carries the answer.
"""
import json
import os
import socket
import subprocess
import sys
import tempfile
import threading
from urllib.parse import quote, unquote, urlparse

try:
    import dbus
    import dbus.service
    import dbus.mainloop.glib
    from gi.repository import GLib
except ImportError as exc:  # pragma: no cover - environment problem, not logic
    sys.stderr.write(
        f'liqexplorer FileChooser portal: missing python3-dbus/pygobject ({exc}).\n'
        'Install with: sudo apt install python3-dbus python3-gi\n')
    raise SystemExit(1)

BUS_NAME = 'org.freedesktop.impl.portal.desktop.liqexplorer'
OBJ_PATH = '/org/freedesktop/portal/desktop'
IFACE = 'org.freedesktop.impl.portal.FileChooser'
REQUEST_IFACE = 'org.freedesktop.impl.portal.Request'

#: where calls go when we cannot serve them ourselves
GTK_BUS_NAME = 'org.freedesktop.impl.portal.desktop.gtk'

PROJECT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RUN_SH = os.path.join(PROJECT, 'bin', 'run.sh')

#: How long to wait for LiqExplorer to connect back on the socket. It is not a
#: pick timeout — the user may browse for as long as they like once the window
#: is up — only a "did it start at all" deadline. Cold-starting Electron off a
#: CIFS share is slow, hence the generous value. Overridable so the fallback
#: path can be exercised without waiting half a minute for it.
STARTUP_TIMEOUT = float(os.environ.get('LIQEXPLORER_PICK_TIMEOUT') or 25.0)

#: no dialog for this long -> nothing needs a resident service; D-Bus restarts
#: it on the next call.
IDLE_EXIT_SECONDS = 900


def log(msg):
    """Journal, not stdout: this runs D-Bus activated with no terminal."""
    sys.stderr.write(f'liqexplorer-portal: {msg}\n')
    sys.stderr.flush()


def path_to_uri(path):
    # quote() with an explicit safe set: '#' and '?' in a filename MUST be
    # escaped or the receiving application truncates the path at them.
    return 'file://' + quote(path, safe='/')


def uri_to_path(uri):
    if not uri:
        return None
    if uri.startswith('/'):
        return uri
    parsed = urlparse(uri)
    if parsed.scheme != 'file':
        return None
    return unquote(parsed.path) or None


def _decode_bytes(raw):
    """Portal `ay` values are NUL-terminated byte arrays, not strings.

    Paths are bytes on purpose in this interface — a filename on Linux is not
    required to be valid UTF-8 — so the trailing NUL has to be stripped by
    hand, and a name that will not decode is replaced rather than thrown away.
    """
    if raw is None:
        return None
    try:
        data = bytes(bytearray(raw))
    except TypeError:
        return None
    return data.split(b'\0', 1)[0].decode('utf-8', 'replace') or None


def _bytes_option(options, key):
    return _decode_bytes(options.get(key))


def _filters(options):
    """Portal filters -> the picker's own shape.

    Wire form is a(sa(us)): a name, then rules typed 0 (shell glob, matched
    against the filename) or 1 (MIME type). Both kinds arrive in the wild —
    Chromium sends globs for `accept=".png"`, GTK applications send MIME types
    — so both are carried through rather than picking a winner here.
    """
    out = []
    for entry in options.get('filters') or []:
        try:
            name = str(entry[0])
            globs, mimes = [], []
            for rule in entry[1]:
                kind, value = int(rule[0]), str(rule[1])
                (mimes if kind == 1 else globs).append(value)
            out.append({'name': name, 'globs': globs, 'mimes': mimes})
        except (IndexError, TypeError, ValueError):
            continue
    return out


def _current_filter_index(options, filters):
    """Which entry of the dropdown starts selected."""
    cur = options.get('current_filter')
    if cur is None:
        return 0
    try:
        name = str(cur[0])
    except (IndexError, TypeError):
        return 0
    for i, f in enumerate(filters):
        if f['name'] == name:
            return i
    # A current_filter that is not IN the list is legal: the caller is naming a
    # filter it did not offer. Prepending it keeps the dialog honest about what
    # is being filtered rather than silently applying something invisible.
    parsed = _filters({'filters': [cur]})
    if parsed:
        filters.insert(0, parsed[0])
    return 0


class PickCancelled(Exception):
    """The user closed the picker, or it died. Response 1."""


class PickUnavailable(Exception):
    """LiqExplorer could not be shown at all — proxy to GTK instead."""


class Picker:
    """One dialog: a listening socket, a launched window, and one JSON answer.

    The socket is ours and we listen on it; LiqExplorer connects back. That is
    deliberately the opposite of the obvious arrangement, because the app takes
    a single-instance lock: the process we spawn usually forwards its argv to an
    already-running LiqExplorer and exits within milliseconds, so its exit code
    and its stdout tell us nothing. The connection is held by whichever instance
    actually owns the window, so losing it means the picker really is gone.
    """

    def __init__(self, request):
        self.request = request
        # XDG_RUNTIME_DIR, not /tmp: it is the correct home for a per-session
        # socket, it is tmpfs-backed, and it is not swept by anything while the
        # session is alive. /tmp is only the fallback for a session without one.
        runtime = os.environ.get('XDG_RUNTIME_DIR')
        parent = os.path.join(runtime, 'liqexplorer') if runtime else None
        if parent:
            os.makedirs(parent, mode=0o700, exist_ok=True)
        self.dir = tempfile.mkdtemp(prefix='pick-', dir=parent)
        self.sock_path = os.path.join(self.dir, 's')
        self.req_path = os.path.join(self.dir, 'request.json')
        self.server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.server.bind(self.sock_path)
        self.server.listen(1)
        self.conn = None
        self._closed = False
        #: which filter was selected when the user accepted; None if unknown
        self.filter_index = None

    def run(self):
        """Block until the user answers. Returns a list of paths."""
        self.request['socket'] = self.sock_path
        with open(self.req_path, 'w') as fh:
            json.dump(self.request, fh)

        try:
            # --pick=<file>, never "--pick <file>": Chromium rebuilds argv as
            # [program, switches..., args...], so a separated value ends up
            # behind the app directory and the request is silently lost. See
            # parsePickArgs in src/main/pick.ts.
            subprocess.Popen(
                ['/bin/bash', RUN_SH, f'--pick={self.req_path}'],
                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                stdin=subprocess.DEVNULL, start_new_session=True)
        except OSError as exc:
            raise PickUnavailable(f'cannot launch {RUN_SH}: {exc}')

        self.server.settimeout(STARTUP_TIMEOUT)
        try:
            self.conn, _ = self.server.accept()
        except socket.timeout:
            raise PickUnavailable('LiqExplorer did not open the picker in time')
        except OSError as exc:
            if self._closed:
                raise PickCancelled()
            raise PickUnavailable(f'socket error: {exc}')

        # No timeout from here on: the user is allowed to browse for an hour.
        self.conn.settimeout(None)
        chunks = []
        while True:
            try:
                data = self.conn.recv(65536)
            except OSError:
                data = b''
            if not data:
                break
            chunks.append(data)
            if b'\n' in data:
                break
        if self._closed:
            raise PickCancelled()
        raw = b''.join(chunks).split(b'\n', 1)[0]
        if not raw:
            # Connection closed with nothing said: window shut, or app crashed.
            raise PickCancelled()
        try:
            result = json.loads(raw.decode('utf-8'))
        except ValueError:
            raise PickCancelled()
        if not result.get('ok'):
            raise PickCancelled()
        paths = [p for p in result.get('paths') or [] if isinstance(p, str) and p]
        if not paths:
            raise PickCancelled()
        self.filter_index = result.get('filterIndex')
        return paths

    def close(self):
        """Withdraw the dialog — called from Request.Close on another thread."""
        self._closed = True
        for s in (self.conn, self.server):
            try:
                if s:
                    s.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass
            try:
                if s:
                    s.close()
            except OSError:
                pass

    def cleanup(self):
        for s in (self.conn, self.server):
            try:
                if s:
                    s.close()
            except OSError:
                pass
        for p in (self.sock_path, self.req_path):
            try:
                os.unlink(p)
            except OSError:
                pass
        try:
            os.rmdir(self.dir)
        except OSError:
            pass


class RequestObject(dbus.service.Object):
    """The o-handle the frontend gives us, so it can withdraw the dialog."""

    def __init__(self, bus, path, picker):
        super().__init__(bus, path)
        self._picker = picker

    @dbus.service.method(REQUEST_IFACE, in_signature='', out_signature='')
    def Close(self):
        self._picker.close()


class FileChooser(dbus.service.Object):
    def __init__(self, bus, loop):
        super().__init__(bus, OBJ_PATH)
        # `bus` is a BusName (which is what exports an object), NOT a
        # connection: it has no get_object, so the GTK proxy needs the
        # connection underneath it. Keeping both is cheaper than remembering
        # which one each dbus-python call wants.
        self._bus = bus
        self._conn = bus.get_bus() if isinstance(bus, dbus.service.BusName) else bus
        self._loop = loop
        self._live = 0
        self._idle = None
        self._arm_idle()

    # ---- lifetime -------------------------------------------------------
    def _arm_idle(self):
        if self._idle is not None:
            GLib.source_remove(self._idle)
        self._idle = GLib.timeout_add_seconds(IDLE_EXIT_SECONDS, self._maybe_quit)

    def _maybe_quit(self):
        self._idle = None
        if self._live == 0:
            self._loop.quit()
        else:
            self._arm_idle()
        return False

    # ---- the safety net -------------------------------------------------
    #
    # DO NOT RENAME THIS TO _fallback. dbus.service.Object.__init__ assigns
    # `self._fallback = False` — it is python-dbus's own flag for an object
    # registered as a path SUBTREE handler — so a method of that name is
    # silently replaced on every instance, and the first call raises
    # "'bool' object is not callable" from inside a worker thread, where it
    # only ever surfaces on the failure path this method exists to serve.
    def _ask_gtk(self, method, handle, app_id, parent, title, options, ok_cb):
        """Hand the call to xdg-desktop-portal-gtk and pass ITS answer on.

        This is what makes installing this backend safe. Every failure that
        could otherwise leave an application with no file dialog at all ends up
        here, and the user sees the dialog they had before.

        CALL THIS ON THE MAIN LOOP, and note that it is asynchronous. The
        blocking form was tried and is wrong twice over: a blocking call takes
        as long as the user takes to pick, so on the shared connection it stops
        this service dispatching anything at all — including the Request.Close
        that withdraws the dialog — and the private connection that avoids
        that has to be closed afterwards, which dropped the service off the bus
        mid-reply ("Message recipient disconnected without replying", and the
        caller got response 2 instead of the GTK dialog's own answer).

        reply_handler/error_handler has neither problem: the call returns
        immediately, the loop keeps running, and the answer arrives on it.
        """
        def failed(exc):
            log(f'{method}: GTK fallback failed too: {exc}')
            ok_cb(dbus.UInt32(2), {})

        try:
            gtk = dbus.Interface(self._conn.get_object(GTK_BUS_NAME, OBJ_PATH), IFACE)
            log(f'{method}: falling back to xdg-desktop-portal-gtk')
            getattr(gtk, method)(
                handle, app_id, parent, title, options,
                reply_handler=lambda response, results: ok_cb(response, results),
                error_handler=failed,
                # dbus-python timeouts are seconds; the ceiling is INT32_MAX ms.
                timeout=2147483.0)
        except dbus.DBusException as exc:
            failed(exc)

    # ---- request construction -------------------------------------------
    @staticmethod
    def _build(mode, parent, title, options, filters):
        request = {
            'mode': mode,
            'title': str(title or ''),
            'acceptLabel': str(options.get('accept_label') or ''),
            'multiple': bool(options.get('multiple', False)),
            'modal': bool(options.get('modal', True)),
            'parentWindow': str(parent or ''),
            'filters': filters,
            'currentFilter': _current_filter_index(options, filters),
        }
        folder = _bytes_option(options, 'current_folder')
        if folder:
            request['currentFolder'] = folder
        current_file = _bytes_option(options, 'current_file')
        if current_file:
            request['currentFile'] = current_file
        name = options.get('current_name')
        if name:
            request['currentName'] = str(name)
        return request

    @staticmethod
    def _results(paths, filter_index, filters):
        results = {
            'uris': dbus.Array([path_to_uri(p) for p in paths], signature='s'),
            'writable': dbus.Boolean(True),
        }
        if isinstance(filter_index, int) and 0 <= filter_index < len(filters):
            f = filters[filter_index]
            rules = [(dbus.UInt32(0), g) for g in f['globs']] + \
                    [(dbus.UInt32(1), m) for m in f['mimes']]
            results['current_filter'] = dbus.Struct(
                (f['name'], dbus.Array(rules, signature='(us)')), signature='sa(us)')
        return results

    @staticmethod
    def _save_files_results(folder, options):
        """SaveFiles: the user picks a folder, the CALLER supplied the names."""
        base = folder.rstrip('/')
        uris = []
        for raw in options.get('files') or []:
            name = _decode_bytes(raw)
            if name:
                uris.append(path_to_uri(f'{base}/{os.path.basename(name)}'))
        return {'uris': dbus.Array(uris, signature='s')}

    # ---- the interface --------------------------------------------------
    @dbus.service.method(IFACE, in_signature='osssa{sv}', out_signature='ua{sv}',
                         async_callbacks=('ok_cb', 'err_cb'))
    def OpenFile(self, handle, app_id, parent, title, options, ok_cb, err_cb):
        # `directory` is how a folder picker arrives — same method, one flag.
        mode = 'folder' if options.get('directory') else 'open'
        self._start('OpenFile', mode, handle, app_id, parent, title, options, ok_cb)

    @dbus.service.method(IFACE, in_signature='osssa{sv}', out_signature='ua{sv}',
                         async_callbacks=('ok_cb', 'err_cb'))
    def SaveFile(self, handle, app_id, parent, title, options, ok_cb, err_cb):
        self._start('SaveFile', 'save', handle, app_id, parent, title, options, ok_cb)

    @dbus.service.method(IFACE, in_signature='osssa{sv}', out_signature='ua{sv}',
                         async_callbacks=('ok_cb', 'err_cb'))
    def SaveFiles(self, handle, app_id, parent, title, options, ok_cb, err_cb):
        """Save several already-named files into one folder the user chooses."""
        self._start('SaveFiles', 'folder', handle, app_id, parent, title, options, ok_cb)

    # ---- dispatch --------------------------------------------------------
    def _start(self, method, mode, handle, app_id, parent, title, options, ok_cb):
        """Put the dialog on a worker thread and reply when it answers.

        async_callbacks is what makes this legal: the D-Bus method returns
        immediately and the reply is sent later, so the GLib loop stays free to
        dispatch Request.Close — and to run a SECOND dialog for a different
        application at the same time. Blocking here would deadlock the first of
        those and make the second wait for it.

        The worker thread ONLY ever talks to a UNIX socket. Everything that
        touches the D-Bus connection — exporting the Request object, delegating
        to GTK, sending the reply — happens on the main loop.
        """
        filters = _filters(options)
        request = self._build(mode, parent, title, options, filters)
        # SaveFiles asks for one destination folder, never several.
        if method == 'SaveFiles':
            request['multiple'] = False
        try:
            picker = Picker(request)
        except OSError as exc:
            log(f'{method}: cannot create picker socket: {exc}')
            self._ask_gtk(method, handle, app_id, parent, title, options, ok_cb)
            return

        obj = RequestObject(self._bus, handle, picker)
        self._live += 1

        def done(outcome, payload):
            """Back on the main loop: clean up and answer exactly once."""
            self._live -= 1
            self._arm_idle()
            try:
                obj.remove_from_connection()
            except Exception:
                pass
            picker.cleanup()
            if outcome == 'ok':
                ok_cb(dbus.UInt32(0), payload)
            elif outcome == 'cancelled':
                ok_cb(dbus.UInt32(1), {})
            else:
                # Our Request object is gone by now on purpose: from here the
                # GTK backend owns this handle, and it exports its own object at
                # the same path so Request.Close still withdraws the dialog.
                self._ask_gtk(method, handle, app_id, parent, title, options, ok_cb)
            return False

        def work():
            try:
                paths = picker.run()
            except PickCancelled:
                GLib.idle_add(done, 'cancelled', None)
                return
            except Exception as exc:
                # PickUnavailable and anything unforeseen: the user must still
                # get a file dialog, so hand this one to GTK — on the main loop,
                # which is the only place the bus connection may be touched.
                log(f'{method}: {exc}' if isinstance(exc, PickUnavailable)
                    else f'{method}: unexpected {exc!r}')
                GLib.idle_add(done, 'fallback', None)
                return
            payload = (self._save_files_results(paths[0], options)
                       if method == 'SaveFiles'
                       else self._results(paths, picker.filter_index, filters))
            GLib.idle_add(done, 'ok', payload)

        threading.Thread(target=work, daemon=True).start()


def main():
    # The dialog runs on a worker thread and answers through GLib.idle_add, so
    # the only code touching the D-Bus connection is on the main loop. PyGObject
    # has initialised threads implicitly since 3.11, so nothing else is needed.
    dbus.mainloop.glib.DBusGMainLoop(set_as_default=True)
    bus = dbus.SessionBus()
    if bus.request_name(BUS_NAME, dbus.bus.NAME_FLAG_DO_NOT_QUEUE) != \
            dbus.bus.REQUEST_NAME_REPLY_PRIMARY_OWNER:
        log(f'{BUS_NAME} is already owned; exiting')
        return 1
    loop = GLib.MainLoop()
    FileChooser(dbus.service.BusName(BUS_NAME, bus), loop)
    log('ready')
    loop.run()
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
