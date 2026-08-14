# Win11 Explorer parity backlog

Status legend: [x] built · [~] partial · [ ] planned.
Version targets: **v1** = first testable build, **v1.x** = fast follows,
**v2** = bigger subsystems.

## Window chrome
- [~] v1 Tab bar: tabs, +, middle-click close, reorder, context menu (Duplicate/Close/others/right)
- [ ] v1.x Tab tear-off to new window; drag files over tab switches to it; Ctrl+Shift+T reopen
- [~] v1 Command bar: New / cut-copy-paste-rename-delete / Sort / View / ⋯ overflow
- [ ] v1.x Filter dropdown in search results; Share (needs a target — maybe Warpinator)
- [~] v1 Address bar: breadcrumbs + chevron dropdowns + edit mode + autocomplete
- [ ] v1.x Address history MRU (F4 dropdown), typed-path history, env-var expansion
- [~] v1 Search box (name + optional content search); [ ] v2 saved searches, query syntax (kind:/size:)
- [~] v1 Status bar; [ ] v1.x details/preview panes (side pane exists, content TBD)
- [x] v1 Dark/light theme following Cinnamon portal key; no white flash

## Views & sorting 
- [~] v1 All 8 view modes; compact toggle; Ctrl+wheel cycling; Ctrl+Shift+1..8
- [~] v1 Details columns: add/remove/reorder/resize/fit; [ ] v1.x metadata columns (Dimensions, Duration, bit rate via ffprobe/gexiv2), [ ] v1.x Shift+click secondary sort
- [~] v1 Sorting all keys asc/desc, natural sort, folders-first option
- [~] v1 Grouping with date/size/name buckets, collapse; [ ] v1.x collapse-all persistence
- [~] v1 Per-folder view memory (JSON LRU); [ ] v1.x Apply-to-folders/Reset per template; folder templates auto-detect
- [ ] v1.x Column header filter dropdowns (checkbox filtering ala Explorer)
- [ ] v2 Icon-size slider continuum; folder content peek thumbnails

## Context menus 
- [~] v1 Background + item + multi + trash + navpane + tab menus with icon rows
- [x] v1 Right-drag menu (Copy/Move/Create shortcuts here, default bolded, volume-aware)
- [ ] v1.x Send to submenu; Open file location (search results)
- [ ] v1.x .nemo_action loader (keeps mintstick/warpinator/etc. actions) — big interop win
- [ ] v2 New submenu from ~/Templates registry parity; image verbs (Set as background, Rotate)

## File operations 
- [~] v1 Queued engine: progress dialog + speed graph, pause/cancel, conflicts (Replace/Skip/KeepBoth/Merge + apply-all), undo/redo multi-level, failures list
- [~] v1 Trash via gio (full Nemo interop incl. share .Trash-1000); restore; empty
- [~] v1 Compress to ZIP / Extract via file-roller; [ ] v2 in-process libarchive + zip-as-folder browsing
- [ ] v1.x Retry-as-admin via gvfs admin:// on EACCES; in-use detection
- [ ] v1.x Drag out to other apps (webContents.startDrag) + XDS target for Chromium drags
- [ ] v2 Op journal + crash resume (.partial + rename), per-file verify option

## Navigation pane (nav pane)
- [~] v1 Home/pinned/This PC drives/Network/Trash + auto-expanding tree following navigation
- [ ] v1.x Capacity bars everywhere, gvfs mount/unmount actions, Map network drive dialog
- [ ] v2 network:// browsing (needs GIO helper or gvfs fuse walk)

## Search 
- [~] v1 Recursive name search + ripgrep content option, streaming results w/ path column
- [ ] v1.x Date/kind/size filter menu; non-indexed banner; [ ] v2 own index for the CIFS share (plocate side-db)

## Properties & drives 
- [~] v1 General tab (+ live dir size), multi-select, drive capacity
- [ ] v1.x Details tab (EXIF/ID3/video via gexiv2/taglib/ffprobe CLIs); Open With change; permissions editor
- [ ] v2 Security tab (ACLs), drive tools (fsck/TRIM via udisks), Format dialog, Sharing (usershares)

## OS integration 
- [x] v1 Trash/thumbnails/recent/bookmark file formats shared with Nemo
- [~] v1 Thumbnails: freedesktop cache read+generate w/ system thumbnailers
- [~] v1 Clipboard interop (x-special/gnome-copied-files owner helper)
- [ ] SWITCH-DEFAULT (explicit opt-in): xdg-mime default liqexplorer.desktop inode/directory + desktop file install — see bin/install-default.sh
- [ ] LATER FLIP: own org.freedesktop.FileManager1 (requires disabling nemo-desktop) + own desktop icons layer
- [ ] v1.x Single-instance + `liqexplorer <path>` CLI + autostart daemon (-n) for instant open
- [ ] v1.x XApp favorites sync; recent:// view; GtkRecentManager writes on open
- [ ] v2 MTP/AFC portable devices via gvfs; smbc_notify live share refresh; admin://
- [ ] v2 org.nemo.Preview (spacebar preview) or own preview pane

## Deliberately out (decided)
- OneDrive/cloud blocks, Cast to Device, Burn to disc, BitLocker, Libraries (hidden default), Gallery (v3 maybe)

## Gaps observed in first smoke test (2026-08-13)
- [ ] v1.x Breadcrumb + search placeholder for virtual paths: `computer://` should render as
 "This PC" crumb (breadcrumb currently shows the raw URI; trash:// already maps correctly)
- [ ] v1.x This PC layout: Win11 groups Folders / Devices and drives / Network locations;
 we list alphabetically in one block (entries synthesized in app.ts computerEntries)
- [ ] v1.x Recycle Bin details columns: Original location + Date deleted (data already on
 FileEntry.trashOrigPath/trashDeletedAt; needs trash-specific column set in details view)
- [ ] v1.x Duplicate tab should insert next to source tab (menus impl appends at end; the
 adjacency-preserving variant lived in titlebar and was removed with the dead inline menu)
- [ ] v1.x Extract All… destination-picker wizard (currently same as Extract here)
- [ ] v1.x Search result "results truncated" indicator when the 10k cap hits (needs a flag on
 SearchChunk)

## Added 2026-08-13 (icons, menus, sorting, right-drag)
- [x] App icon (SVG + 8 PNG sizes, Liq family style); `bin/install-app.sh` installs the icon
      and menu entry WITHOUT changing the default file manager
- [x] Sort by / Group by expose every supported key (Name, Date modified, Date created,
      Date accessed, Type, Size, File extension; Recycle Bin: Original location, Date deleted),
      from one shared list also used by the details column chooser
- [x] Right-drag menu; left-drag modifiers (Ctrl copy / Shift move / Alt shortcut) and
      volume-aware default effect
- [x] Nav-pane empty-area menu (Expand to open folder, Show hidden items, Hide navigation pane)
- [ ] v1.x Friendly "Type" names from shared-mime-info comments ("PNG image" rather than
      "PNG File") — Group by Type currently buckets by extension-derived labels
- [ ] v1.x Right-drag onto the *desktop* / other apps (X11 XDND right-button drags are
      not deliverable from Chromium; would need a native drag helper)
- [ ] v1.x "More..." (Choose Details) dialog for the full column set
- KNOWN: Electron does not populate _NET_WM_ICON on X11 (verified with xprop for both the
      BrowserWindow icon option and win.setIcon), so alt-tab/window-list icons come from the
      installed .desktop entry matched on WM_CLASS=liqexplorer
