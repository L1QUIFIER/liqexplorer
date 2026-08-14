# LiqExplorer — build & run rules (read before touching anything)

Windows 11 File Explorer replica for Linux (Mint/Cinnamon first-class; portable
fallbacks for GNOME/KDE/XFCE/Arch/Fedora). Electron + vanilla TypeScript renderer,
esbuild bundling, **no native npm modules** (OS-level via CLI helpers: `gio`,
`gsettings`, `xdg-mime`, `rg`, `7z`, plus `helpers/clipboard-owner.py` for X11
clipboard interop).

Feature backlog: `docs/PARITY.md`. Portability probes live in
`src/main/platform/capabilities.ts` (soft-fail missing tools).

## CIFS / noexec share constraints (optional)

If the checkout lives on a CIFS/SMB share where binaries are not executable:

- `npm install` MUST be `npm install --no-bin-links --ignore-scripts`.
- Nothing under `node_modules/` is executable. Staged runtime copies live in
  `~/.cache/liq-run/liqexplorer/` (electron dist, esbuild binary). `bin/stage.sh` maintains
  them; `bin/*.sh` call it automatically. `ESBUILD_BINARY_PATH` points at the staged copy.
- Electron's dist is downloaded by `node node_modules/electron/install.js` (cache
  `~/.cache/electron`), then staged off-share. Never try to run electron from node_modules.
- Build output `dist/` is plain JS (nothing needs +x). Never commit it.

On a normal local disk, plain `npm install` + `npm run build` + `npm start` is fine.

## Testing — never hijack the user's display

GUI testing should use Xvfb (e.g. `DISPLAY=:99`), driven with `xdotool`, screenshots with
`import -window`. A scratch profile is forced by `--user-data-dir` in `bin/run.sh` when
`LIQEXPLORER_TEST=1`.

## Integration decisions already made (do not re-litigate silently)

- nemo-desktop stays (desktop icons + FileManager1 remain Nemo's for now — planned flip
  later). Do NOT export org.freedesktop.FileManager1 yet, and never disable
  org.nemo.desktop show-desktop-icons unless the maintainer asks.
- Becoming default handler = `xdg-mime default liqexplorer.desktop inode/directory` — only
  as an explicit opt-in (`bin/install-default.sh`); testing never requires it.
- Trash via `gio trash` / `gio list trash:///` (full Nemo interop). Thumbnails read/write
  the freedesktop cache (`~/.cache/thumbnails`) with GIO-exact URI encoding.
- Clipboard cut/copy must own targets `x-special/gnome-copied-files` + `text/uri-list` +
  `text/plain` (+ kde/mate variants) — done by `helpers/clipboard-owner.py` (python3-gi).
- Per-folder view state: JSON LRU store in `~/.local/state/liqexplorer/` (local, not on a share).
- CIFS/SMB dirs get 2s mtime polling, never inotify assumptions (remote changes are invisible).
