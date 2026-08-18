# LiqExplorer as the system file dialog

Every "attach", "upload", "open" and "save as" in Chrome, Electron applications,
Firefox and flatpaks becomes a real LiqExplorer window — tabs, columns, sort,
group, search, the nav tree, pinned places, dual pane — with an accept/cancel
bar along the bottom.

```
bin/install-portal.sh            # switch over
bin/install-portal.sh --status   # what is registered, and who answers
bin/install-portal.sh --undo     # hand it back to GTK
```

## Why there is anything to install

Applications on Linux do not draw their own file picker. They ask the desktop
for one over D-Bus:

```
app  ──OpenFile──▶  org.freedesktop.portal.Desktop        (xdg-desktop-portal, the "frontend")
                        │
                        ▼  routes to the configured backend
                    org.freedesktop.impl.portal.FileChooser
```

On a stock Mint/Cinnamon box exactly one thing implements that backend
interface — `xdg-desktop-portal-gtk` — and its dialog has no columns, no useful
search, none of the places this file manager knows about, and no configuration
of any kind. The frontend, however, will route to *any* backend named in
`portals.conf`. That is the whole trick.

## The three files the installer writes

| File | Why | Needs root |
|---|---|---|
| `/usr/share/xdg-desktop-portal/portals/liqexplorer.portal` | declares "this bus name implements FileChooser" | yes — backends are read from that one directory and there is no per-user equivalent |
| `~/.local/share/dbus-1/services/org.freedesktop.impl.portal.desktop.liqexplorer.service` | how to start the helper; D-Bus activates it on the first dialog and it exits when idle | no |
| `~/.config/xdg-desktop-portal/<desktop>-portals.conf` | "prefer liqexplorer for FileChooser" — first in the search order, so it beats the distro default without touching `/usr` | no |

`default=` is left exactly as the distro had it, so only the file chooser moves.
Screenshots, settings, inhibit and the rest keep answering as before.

The frontend reads all of this **once, at startup**, so the installer restarts
`xdg-desktop-portal`. Applications that were already running keep talking to the
old backend until they are restarted.

## How a dialog actually runs

```
helper (python)                     LiqExplorer (electron)
  │ mkdtemp in $XDG_RUNTIME_DIR
  │ write request.json
  │ listen on a unix socket
  │ spawn: run.sh --pick=request.json
  │                                   │ (usually a SECOND instance: forwards
  │                                   │  argv to the running one and exits)
  │                                   ▼
  │                                 openPicker() connects the socket FIRST,
  │◀────────────────────────────────  then opens the window
  │ accept()  (25s budget)
  │                                 user browses, picks, presses Open
  │◀──── {"ok":true,"paths":[...]} ── one JSON line, then close
  ▼
 reply (0, {uris: [...]}) to the frontend
```

Two design points that are not obvious:

- **The helper listens; LiqExplorer connects back.** The obvious arrangement is
  the other way round, and it does not work: the app takes a single-instance
  lock, so the process the helper spawns normally forwards its argv to an
  already-running LiqExplorer and exits within milliseconds. Its exit code and
  its stdout say nothing about the dialog. The socket is held by whichever
  instance actually owns the window, so losing it means the picker really is
  gone — and "connection closed with no line" is therefore the same as Cancel,
  which makes a crash indistinguishable from cancelling. That is the behaviour
  the caller wants.

- **`--pick=<file>`, one token, never `--pick <file>`.** Chromium re-orders
  argv: it splits the command line into switches and positional arguments and
  rebuilds it as `[program, ...switches, ...args]`. The separated form arrives
  at `second-instance` as `[electron, --pick, /path/to/LiqExplorer, …json]` —
  the switch has jumped in front of the app directory, so reading "the token
  after `--pick`" fails with EISDIR and the request silently degrades into an
  ordinary window opened on the folder that holds `request.json`. That is
  exactly what it looks like when it goes wrong, and it looks like nothing else.

## It never fails closed

A file dialog that does not appear is far worse than an ugly one: the
application is left unable to open anything at all. So every path that cannot
produce a LiqExplorer window — app not built, launcher broken, window never
appeared, crash, socket refused — **proxies the call to
`xdg-desktop-portal-gtk`** and the user gets the old dialog instead of nothing.
`gtk` is also still listed as the fallback backend in `portals.conf`, which
covers the helper being missing entirely.

The proxy call is asynchronous (`reply_handler`/`error_handler`) and on the
shared connection. Both matter, and both were learned the hard way:

- A **blocking** call takes as long as the user takes to pick, so on the shared
  connection it stops the service dispatching anything — including the
  `Request.Close` that withdraws the dialog.
- The **private connection** that avoids that has to be closed afterwards, and
  closing it dropped the service off the bus mid-reply
  (`Message recipient disconnected without replying`), so the caller got
  response 2 instead of the GTK dialog's own answer.

## Landmines

- **Never name a method `_fallback` on a `dbus.service.Object`.** python-dbus
  assigns `self._fallback = False` in `__init__` — it is its own flag for an
  object registered as a path subtree handler — so the method is silently
  replaced on every instance and the first call raises `'bool' object is not
  callable`, from a worker thread, on the failure path.
- **`self._bus` is a `BusName`, not a connection.** It has no `get_object`;
  `FileChooser` keeps `self._conn` for that.
- The helper is D-Bus activated, so **its output goes to the journal**:
  `journalctl --user -f | grep liqexplorer-portal`.

## What is covered

| Portal method | Mode | Status |
|---|---|---|
| `OpenFile` | one or more existing files | tested against Chrome, incl. `accept=` filters and multi-select |
| `OpenFile` + `directory` | folder picker | tested |
| `SaveFile` | destination path, with overwrite confirmation | tested |
| `SaveFiles` | one folder, caller supplies the names | implemented, not yet seen in the wild |

Filters carry both halves of the portal's format — shell globs (what Chromium
sends for `accept=".png"`) and MIME types (what GTK applications send) — and
glob matching is case-insensitive, so `*.jpg` also matches the `.JPG` a camera
wrote.
