# LiqExplorer

Windows 11–style File Explorer for Linux.

Tabs, command bar, breadcrumb address bar, navigation tree, details/icon/preview views with sort & group, Explorer-style context menus, file ops with progress/conflict/undo, archive browsing, media viewer/previews, and desktop-compatible trash, clipboard, and thumbnails (via GIO/gvfs).

> **Status: early development (v0.1).** Core shell is usable for trying out, but this is not a daily driver yet. Best on **X11** (Cinnamon/GNOME/XFCE/MATE/KDE). Wayland works for browsing with limited clipboard interop.


## Screenshots

Captured from a disposable demo profile (generic folders and stock-style photos only — no personal files or drives).

![Home](docs/screenshots/home.png)

![Pictures — large icons](docs/screenshots/pictures.png)

![Folder browsing](docs/screenshots/folders.png)

![Projects](docs/screenshots/projects.png)

![Context menu](docs/screenshots/context-menu.png)


## Requirements

- Linux x86_64 (Arch, Fedora, Debian/Ubuntu/Mint, openSUSE, …)
- **Node.js 20 or 22 LTS** recommended (Node 25+ / bleeding-edge may work but is less tested)
- **Required for full features:** `gio` (glib/gvfs), `python3` + GTK3 PyGObject, `ripgrep` (`rg`), `7z` (p7zip / 7-Zip)
- Optional: `unrar` / `unar` (better RAR support), `udisksctl` (eject/power-off)

### Distro packages

**Arch / Manjaro / EndeavourOS**
```bash
sudo pacman -S git nodejs npm gvfs gtk3 python-gobject ripgrep p7zip unzip curl
# optional: unrar unarchiver udisks2 fuse2
```
`unzip` + `curl` are required so Electron can be downloaded when npm’s install script skips it (common on npm 12).

**Fedora**
```bash
sudo dnf install nodejs npm gvfs gtk3 python3-gobject ripgrep p7zip p7zip-plugins
# optional: unrar unar udisks2
```

**Debian / Ubuntu / Mint**
```bash
sudo apt install nodejs npm gvfs libgtk-3-0 python3-gi python3-gi-cairo \
  gir1.2-gtk-3.0 ripgrep p7zip-full
# optional: unrar unar udisks2
```

Missing tools soft-fail (status bar warning + console log) instead of crashing — e.g. no `rg` disables content search only.

## Try it (build from source)

Needs **internet once** (Electron binary download). Use a fresh clone of `main`.

```bash
git clone https://github.com/L1QUIFIER/liqexplorer.git
cd liqexplorer
bash bin/setup.sh
npm start
```

`bin/setup.sh` runs `npm install`, approves Electron/esbuild install scripts on modern npm (11.16+ / 12 — common on Arch), downloads Electron (curl+unzip fallback if needed), then builds.


Manual equivalent:

```bash
npm install
# If npm warns that electron/esbuild install scripts were blocked:
npm approve-scripts electron esbuild --no-allow-scripts-pin
npm install
bash bin/stage.sh
npm run build
npm start
```

Install a menu entry / desktop icon (does **not** change your default file manager):

```bash
bash bin/install-app.sh
```

Opt in as the default folder handler (reversible — restores your previous handler):

```bash
bash bin/install-default.sh
# undo:
bash bin/install-default.sh --undo
```

### Troubleshooting

| Symptom | Fix |
|---|---|
| `Missing script: "dist:appimage"` | Your clone is outdated — run `git pull origin main` (or re-clone). You do **not** need AppImage to try the app; use `npm start`. |
| `install scripts blocked` for `electron` / `esbuild` | Run `bash bin/setup.sh` (or approve scripts as above), then `npm start`. |
| Window never opens / sandbox errors | From-source launches already pass `--no-sandbox`. Re-run `bash bin/stage.sh && npm start` and check the terminal for errors. |
| `electron` binary missing | `bash bin/stage.sh` (needs network once to download Electron into `~/.cache/electron`). |
| Very new Node (25+) behaves oddly | Install Node 20 or 22 LTS and retry. |

## AppImage (optional packaging)

Only after setup/build works with `npm start`:

```bash
npm run dist:appimage
```

Output lands in `release/`. Needs `electron-builder` (already a devDependency) and usually `fuse2`/`fuse` on the build host for local AppImage runs.

## Develop

```bash
bash bin/setup.sh
npm start
# or rebuild + start:
npm run dev
```

Scratch profile (does not touch your normal settings):

```bash
LIQEXPLORER_TEST=1 npm start
```

If the checkout lives on a CIFS/SMB share where binaries are not executable:

```bash
npm install --no-bin-links --ignore-scripts
bash bin/stage.sh
bash bin/build.sh
bash bin/run.sh
```

## Layout

| Path | What it is |
|---|---|
| `src/main/` | Electron main: windows, IPC, filesystem, file-ops engine, platform integration |
| `src/renderer/` | Vanilla TypeScript UI: chrome, views, nav pane, menus, dialogs |
| `src/shared/` | Shared IPC contracts and types |
| `helpers/` | Out-of-process helpers (X11 clipboard owner) |
| `docs/PARITY.md` | Win11 parity backlog and status |

## Portability notes

- **Terminal:** `xdg-terminal-exec` → `$TERMINAL` → Cinnamon/GNOME settings → common terminals → `xterm`
- **Theme:** XApp portal → GNOME `color-scheme` → Electron `nativeTheme`
- **Clipboard:** full interop needs X11 + python3-gi; otherwise in-app paste still works
- **Default handler undo:** restores the previous `xdg-mime` handler (Nemo/Nautilus/Dolphin/…)
- **From-source Electron:** uses a staged copy under `~/.cache/liq-run/liqexplorer/` with `--no-sandbox` so Arch/Fedora/etc. can launch without setuid chrome-sandbox

## Roadmap

See [`docs/PARITY.md`](docs/PARITY.md) for the feature backlog. Broader Wayland clipboard/DnD and polished store packages come next.

## License

License not chosen yet — treat as source-available for now. Do not redistribute as your own product.
