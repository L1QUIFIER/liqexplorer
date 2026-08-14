# LiqExplorer

Windows 11–style File Explorer for Linux (Mint / Cinnamon / X11).

Tabs, command bar, breadcrumb address bar, navigation tree, details/icon views with sort & group, Explorer-style context menus, file ops with progress/conflict/undo, and Nemo-compatible trash, clipboard, and thumbnails.

> **Status: early development (v0.1).** Core shell is usable for trying out, but this is not a daily driver yet and is not the system default file manager. Built and tested on Linux Mint 22.3 / Cinnamon / X11.

## Requirements

- Linux with X11 (Wayland support is incomplete)
- Node.js 20+
- System tools: `gio`, `file-roller`, `ripgrep` (`rg`), `python3` + `python3-gi` (clipboard interop)

## Try it (build from source)

```bash
git clone https://github.com/L1QUIFIER/liqexplorer.git
cd liqexplorer
npm install
npm run build
npm start
```

Nemo stays your default folder handler unless you opt in:

```bash
bash bin/install-default.sh
```

That writes a user `.desktop` file and sets `xdg-mime` defaults. Revert with:

```bash
xdg-mime default nemo.desktop inode/directory application/x-gnome-saved-search
```

## Develop

```bash
npm install
npm run build
npm start
```

Scratch profile (does not touch your normal settings):

```bash
LIQEXPLORER_TEST=1 npm start
```

If the project lives on a CIFS/SMB share where binaries are not executable, use the CIFS-safe install and staging scripts documented in `CLAUDE.md`:

```bash
npm install --no-bin-links --ignore-scripts
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

## Roadmap

See [`docs/PARITY.md`](docs/PARITY.md) for the feature backlog. Packaging (AppImage / `.deb`) and GitHub Releases come after a usable v1.

## License

License not chosen yet — treat as source-available for now. Do not redistribute as your own product.
