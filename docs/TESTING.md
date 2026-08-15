# Testing LiqExplorer

GUI testing runs **headless on Xvfb `:99`**, never on the user's real display `:0`
(`:0` is the user's interactive session — driving it with xdotool fights them for the pointer).
The app is driven over the Chrome DevTools Protocol with `tools/cdp.py`.

## Start a test instance

```bash
# once per machine boot — verify, do not assume it started
setsid nohup Xvfb :99 -screen 0 1920x1080x24 -nolisten tcp >/tmp/xvfb.log 2>&1 </dev/null &
sleep 3 && DISPLAY=:99 xdpyinfo >/dev/null && echo up

# optional: a window manager, so window activation/maximize behave
DISPLAY=:99 setsid nohup openbox >/dev/null 2>&1 </dev/null &

cd /path/to/LiqExplorer
bash bin/build.sh
bash bin/test-restart.sh 9223          # <- use this, not a hand-rolled launch
```

**Use `bin/test-restart.sh`.** Launching by hand has bitten this project twice in one
session, both times leaving a *stale* app that still answers CDP — so tests passed against
code that was never built:

1. **The obvious pid is the wrapper.** `dbus-run-session` / `run.sh` sit in front of the real
   electron main process. Killing the wrapper leaves the app running.
2. **The single-instance lock is per user-data-dir.** With the old instance still alive, your
   launch exits immediately and silently while the old one keeps the debugging port. You then
   drive the old build and conclude your change did nothing (or, worse, that it works).

`test-restart.sh` kills by user-data-dir, waits for the process to actually go, refuses to
launch while one is alive, and passes `--remote-allow-origins='*'`.

**When several people (or agents) test at once, give each one its own profile.** Otherwise
they fight over that same lock, and they also overwrite each other's `settings.json` and
`session.json`:

```bash
export LIQEXPLORER_TEST_DIR=/tmp/claude-1000/my-test
bash bin/test-restart.sh 9401
```

`LIQEXPLORER_TEST_DIR` moves both the Electron profile and `STATE_DIR`. Note the second half:
a restart-persistence test must use the **same** dir, or it will look like the data was lost.

**Always confirm you are driving your own build**, whatever launch route you took:

```bash
ps -eo pid,lstart,args | grep -F -- "--user-data-dir=$LIQEXPLORER_TEST_DIR/profile" | grep -v -- '--type='
stat -c '%y' dist/main/index.js
```

If the process is older than the bundle, you are testing stale code.

`LIQEXPLORER_TEST=1` uses a scratch profile (`~/.cache/liqexplorer-test/profile`, or
`$LIQEXPLORER_TEST_DIR/profile`), so a test run never mutates real settings. This matters more
than it sounds: a test instance once wrote the user's real GTK bookmarks file and destroyed
three entries. `dbus-run-session` keeps portal dialogs (file pickers) off
`:0`. `--remote-allow-origins` is required or the CDP websocket 403s.

A test instance and a normal user instance coexist: Electron's single-instance lock is keyed
to the user-data dir, so the scratch profile gets its own lock. **Verify** the interactive `:0` window count is unchanged after launching.

## Drive it

```bash
python3 tools/cdp.py                      # usage
python3 tools/cdp.py eval 'app.tabs[0].path'
python3 tools/cdp.py shot /tmp/shot.png   # X `import` renders BLACK here; always use this
python3 tools/cdp.py click 600 190 [right|dbl] [ctrl|shift|alt]
python3 tools/cdp.py press/release X Y [right] [ctrl|shift|alt]
python3 tools/cdp.py move X Y [left|right]        # button name = keep held (drag)
python3 tools/cdp.py key z ctrl
python3 tools/cdp.py console 3            # console + uncaught exceptions
```

The renderer exposes `window.app` (tabs, settings, places, `emit`) and `window.liq` (the IPC
API), which is how most state assertions are made.

### Gotchas learned the hard way

- **Screenshots:** `import -window` produces an all-black PNG (software GL under Xvfb).
  Use `cdp.py shot`.
- **Dialogs need ~1s to settle** before a screenshot — the entry animation otherwise reads
  as a "dimmed, broken-looking" dialog.
- **`location.reload()` can wedge CDP input**: evals keep working while dispatched mouse
  events stop arriving. Restart the instance instead of reloading when testing input.
- **Never `pkill -f`/`pgrep -f` a pattern that also matches your own command line** — it kills
  the shell running it (exit 144). Capture pids in one call, kill in a second, launch in a third.
  Prefer closing the test instance over CDP: `POST /json/close/<targetId>`.
- Main-process changes need a **relaunch**; renderer-only changes can reload (see caveat above).

## Regression checklist

Selection (Explorer's 3-state model: anchor, focus, selection)

- [ ] Drag from a row's **whitespace** (Date/Type/Size area) draws a marquee and selects live
- [ ] Drag from the **icon or name** drags the file instead
- [ ] Click on row whitespace without moving still selects that row
- [ ] Shift+click extends a range; Ctrl+click toggles and moves the pivot
- [ ] Ctrl+drag band XORs against the existing selection; Shift+drag adds
- [ ] Click empty space clears; band auto-scrolls at the viewport edge
- [ ] Type-ahead jumps to a name; Ctrl+A selects all

File operations (data safety — these have bitten before)

- [ ] Copy shows a progress card; conflict dialog offers Replace/Skip/Keep both + apply-to-all
- [ ] "Keep both" produces Explorer names (`big (2).bin`)
- [ ] **Undo a merge copy deletes only what the copy created**, never the pre-existing folder
- [ ] A failed/cancelled **replace leaves the original destination intact** (temp + rename)
- [ ] Case-only rename (`README.md` → `readme.md`) does not destroy a distinct existing file
- [ ] Delete → Ctrl+Z restores from trash (test on a CIFS/SMB mount too — separate trash dir)
- [ ] Shift+Delete asks for confirmation first
- [ ] Right-drag → Copy/Move/Create shortcuts here, default bolded (move same volume, copy across)

Navigation and chrome

- [ ] Nav tree auto-expands along the ancestor chain and highlights the current folder
- [ ] `computer://` lists drives + network mounts; breadcrumb reads "This PC"
- [ ] Recycle Bin lists, restores, and empties
- [ ] Tabs: Ctrl+T, middle-click close, right-click menu, Ctrl+Tab
- [ ] Sort by / Group by offer every key; Group by Size uses Windows buckets
- [ ] Ctrl+Shift+1..8 switch view modes without a blank viewport

Peek popover (views/peek.ts)

- [ ] Resting the pointer on a folder opens a grid of its contents after the View > Peek delay
- [ ] Space peeks the focused item instantly and does NOT also add it to the selection
      (Ctrl+Space still toggles selection)
- [ ] Files peek per type: image large, text first 100 lines, PDF page 1, video with
      working transport, archive member list, folder-in-a-zip as a grid
- [ ] Esc, a click elsewhere, and leaving both the item and the popover all dismiss it;
      crossing the gap into the popover does not
- [ ] Arrows move inside a folder peek, Enter/double-click opens for real
- [ ] A folder with 20 000 entries paints in well under a second and asks for only the
      thumbnails on screen

**Timer-driven UI needs a visible window.** With no WM (or another test instance mapped on
top) the page goes `document.hidden` and Chromium throttles `setTimeout` — measured
`setTimeout(1400)` taking 2337 ms, and longer as the page stays hidden, which makes any
hover-dwell test fail for reasons that have nothing to do with the code. Run openbox on `:99`
and check `document.hidden === false` before trusting a dwell measurement.

Health

- [ ] `cdp.py console 3` is silent after exercising the app
- [ ] No watcher/child-process leaks after opening and closing many folders
