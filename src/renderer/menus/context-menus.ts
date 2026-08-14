// Every context menu in the app, built for Win11 Explorer chrome parity
// (Win11 modern-menu item lists, in exact order). mountMenus() listens on app
// events emitted by the views/nav/titlebar components:
//   'background-context' { x, y }                       folder background
//   'item-context'       { x, y, entries: FileEntry[] } selected item(s)
//   'navpane-context'    { x, y, place? | entry? | path? }  nav pane node
//   'tab-context'        { x, y, index }                titlebar tab
// Destructive verbs route through app.emit('show-confirm', ...) (dialogs.ts).

import type { AppCandidate, FileEntry, Place, ViewMode } from '../../shared/types'
import { sortKeysFor } from '../../shared/sort'
import { isArchiveName, archiveStem } from '../../shared/archive'
import { app, liq, Tab } from '../core/app'
import { actions } from '../core/actions'
import { showMenu } from './menu'
import type { MenuAction, MenuItem } from './menu-types'

// ---------- payloads ----------

interface Pt { x: number; y: number }
interface ItemCtx extends Pt { entries: FileEntry[] }
interface NavCtx extends Pt { place?: Place; entry?: FileEntry; path?: string }
interface TabCtx extends Pt { index: number }
interface TemplateInfo { name: string; path: string; icons?: string[] }

export function mountMenus(): void {
  app.on('background-context', (d: Pt) => { void showBackgroundMenu(d) })
  app.on('item-context', (d: ItemCtx) => { void showItemMenu(d) })
  app.on('navpane-context', (d: NavCtx) => showNavpaneMenu(d))
  app.on('navpane-empty-context', (d: Pt) => showNavpaneEmptyMenu(d))
  app.on('tab-context', (d: TabCtx) => showTabMenu(d))
}

// ---------- icon row glyphs (Win11-style monochrome, currentColor) ----------

const svg = (paths: string): string =>
  `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round">${paths}</svg>`

const I = {
  cut: svg('<circle cx="4.2" cy="11.8" r="1.9"/><circle cx="11.8" cy="11.8" r="1.9"/><path d="M5.7 10.4 12.5 2M10.3 10.4 3.5 2"/>'),
  copy: svg('<rect x="5.5" y="5.5" width="8" height="8" rx="1.6"/><path d="M10.5 3.6A1.6 1.6 0 0 0 8.9 2H4.1a1.6 1.6 0 0 0-1.6 1.6v4.8A1.6 1.6 0 0 0 4.1 10h-.1"/>'),
  paste: svg('<rect x="3" y="3" width="10" height="11" rx="1.6"/><path d="M5.8 3a2.2 2.2 0 0 1 4.4 0"/><path d="M5.5 7h5M5.5 9.3h5M5.5 11.6h3"/>'),
  rename: svg('<path d="M11.1 2.9a1.8 1.8 0 0 1 2.5 2.5l-7.3 7.3-3.3.8.8-3.3z"/><path d="M9.8 4.2l2.5 2.5"/>'),
  del: svg('<path d="M2.8 4.3h10.4M6.3 4.3V3.2c0-.5.4-.9.9-.9h1.6c.5 0 .9.4.9.9v1.1M4.3 4.3l.6 8.2c0 .7.6 1.3 1.3 1.3h3.6c.7 0 1.3-.6 1.3-1.3l.6-8.2"/><path d="M6.7 7v3.9M9.3 7v3.9"/>'),
}

// ---------- shared helpers ----------

/** "Extract All..." — Explorer asks where to put it; default is <archive>/ */
async function extractAll(tab: Tab, entry: FileEntry): Promise<void> {
  const suggested = `${tab.path}/${archiveStem(entry.name)}`
  const dest = await liq.invoke('pickFolder', suggested) as string | null
  if (dest) await actions.extract(tab, 'to', dest)
}

const VIEW_MODES: { mode: ViewMode; label: string; shortcut: string }[] = [
  { mode: 'extra-large', label: 'Extra large icons', shortcut: 'Ctrl+Shift+1' },
  { mode: 'large', label: 'Large icons', shortcut: 'Ctrl+Shift+2' },
  { mode: 'medium', label: 'Medium icons', shortcut: 'Ctrl+Shift+3' },
  { mode: 'small', label: 'Small icons', shortcut: 'Ctrl+Shift+4' },
  { mode: 'list', label: 'List', shortcut: 'Ctrl+Shift+5' },
  { mode: 'details', label: 'Details', shortcut: 'Ctrl+Shift+6' },
  { mode: 'tiles', label: 'Tiles', shortcut: 'Ctrl+Shift+7' },
  { mode: 'content', label: 'Content', shortcut: 'Ctrl+Shift+8' },
]

// key list comes from shared/sort.ts so Sort by, Group by, the command bar and
// the details column chooser always offer the same keys

interface ConfirmOpts { title: string; message: string; okLabel: string; danger?: boolean; onOk: () => void }
function showConfirm(o: ConfirmOpts): void { app.emit('show-confirm', o) }

/** favorites live in main (favorites.json); the menu asks per open, like templates */
async function isFavorite(path: string): Promise<boolean> {
  try {
    const list = await liq.invoke('listFavorites') as { path: string }[]
    return Array.isArray(list) && list.some(f => f.path === path)
  } catch { return false }        // favorites unavailable: just offer to add
}

function isPinned(path: string): boolean {
  return app.places.some(p => p.path === path && (p.pinned === true || p.kind === 'pinned'))
}

async function fetchTemplates(): Promise<TemplateInfo[]> {
  try {
    const r = await liq.invoke('templatesList')
    return Array.isArray(r) ? (r as TemplateInfo[]) : []
  } catch { return [] }
}

async function pasteInto(destDir: string): Promise<void> {
  const clip = await liq.clipboardGet()
  if (!clip?.paths?.length) return
  await liq.startOp({ kind: clip.op === 'cut' ? 'move' : 'copy', sources: clip.paths, dest: destDir })
  if (clip.op === 'cut') await liq.clipboardClear()
}

async function createAndRename(create: () => Promise<string | null>): Promise<void> {
  const p = await create()
  if (p) app.emit('start-rename', p)
}

async function confirmEmptyTrash(count?: number): Promise<void> {
  let n = count
  if (n === undefined) {
    try { n = await liq.trashItemCount() } catch { n = 0 }
  }
  const what = !n ? 'all items' : n === 1 ? 'this 1 item' : `these ${n} items`
  showConfirm({
    title: 'Empty Recycle Bin',
    message: `Are you sure you want to permanently delete ${what}?`,
    okLabel: 'Yes',
    danger: true,
    onOk: () => {
      void liq.emptyTrash().then(() => {
        const t = app.activeTab
        if (t?.path === 'trash://') t.refresh()
      })
    },
  })
}

function confirmPermanentDelete(entries: FileEntry[]): void {
  const n = entries.length
  const what = n === 1 ? `'${entries[0].name}'` : `these ${n} items`
  showConfirm({
    title: n === 1 ? (entries[0].isDir ? 'Delete Folder' : 'Delete File') : 'Delete Multiple Items',
    message: `Are you sure you want to permanently delete ${what}?`,
    okLabel: 'Yes',
    danger: true,
    onOk: () => { void liq.startOp({ kind: 'delete', sources: entries.map(e => e.path) }) },
  })
}

/** Delete the given entries; permanent (w/ confirm) in trash, else to trash. */
function deleteEntries(tab: Tab, entries: FileEntry[]): void {
  if (!entries.length) return
  if (tab.path === 'trash://') { confirmPermanentDelete(entries); return }
  const doTrash = (): void => { void liq.startOp({ kind: 'trash', sources: entries.map(e => e.path) }) }
  if (app.settings.confirmTrash) {
    const n = entries.length
    const what = n === 1 ? `'${entries[0].name}'` : `these ${n} items`
    showConfirm({
      title: 'Delete',
      message: `Are you sure you want to move ${what} to the Recycle Bin?`,
      okLabel: 'Yes',
      onOk: doTrash,
    })
  } else {
    doTrash()
  }
}

// ---------- View / Sort by / Group by submenus ----------

function viewSubmenu(tab: Tab): MenuItem[] {
  const vs = tab.viewState
  const items: MenuItem[] = VIEW_MODES.map(m => ({
    label: m.label, shortcut: m.shortcut, radio: true, checked: vs.mode === m.mode,
    onClick: () => tab.setViewState({ mode: m.mode }),
  }))
  items.push({ separator: true })
  items.push({
    label: 'Compact view', checked: app.settings.compactView,
    onClick: () => { void app.setSettings({ compactView: !app.settings.compactView }) },
  })
  return items
}

function sortSubmenu(tab: Tab): MenuItem[] {
  const vs = tab.viewState
  const items: MenuItem[] = sortKeysFor(tab.path).map(k => ({
    label: k.label, radio: true, checked: vs.sortKey === k.key,
    onClick: () => tab.setViewState({ sortKey: k.key }),
  }))
  items.push({ separator: true })
  items.push({ label: 'Ascending', radio: true, checked: vs.sortDir === 'asc', onClick: () => tab.setViewState({ sortDir: 'asc' }) })
  items.push({ label: 'Descending', radio: true, checked: vs.sortDir === 'desc', onClick: () => tab.setViewState({ sortDir: 'desc' }) })
  return items
}

function groupSubmenu(tab: Tab): MenuItem[] {
  const vs = tab.viewState
  return [
    { label: '(None)', radio: true, checked: vs.groupKey === 'none', onClick: () => tab.setViewState({ groupKey: 'none' }) },
    ...sortKeysFor(tab.path).map<MenuItem>(k => ({
      label: k.label, radio: true, checked: vs.groupKey === k.key,
      onClick: () => tab.setViewState({ groupKey: k.key }),
    })),
    { separator: true },
    { label: 'Ascending', radio: true, checked: vs.groupDir === 'asc', disabled: vs.groupKey === 'none', onClick: () => tab.setViewState({ groupDir: 'asc' }) },
    { label: 'Descending', radio: true, checked: vs.groupDir === 'desc', disabled: vs.groupKey === 'none', onClick: () => tab.setViewState({ groupDir: 'desc' }) },
  ]
}

function newSubmenu(tab: Tab, templates: TemplateInfo[]): MenuItem[] {
  const items: MenuItem[] = [
    {
      label: 'Folder', icon: 'folder', shortcut: 'Ctrl+Shift+N',
      onClick: () => { void createAndRename(() => actions.newFolder(tab)) },
    },
    { separator: true },
    {
      label: 'Text Document', icon: 'text-x-generic',
      onClick: () => { void createAndRename(() => actions.newFile(tab)) },
    },
  ]
  for (const t of templates) {
    items.push({
      label: t.name,
      icon: t.icons?.length ? t.icons.join(',') : 'text-x-generic',
      onClick: () => { void createAndRename(() => actions.newFile(tab, t.path)) },
    })
  }
  return items
}

// ---------- background menu ----------

async function showBackgroundMenu(d: Pt): Promise<void> {
  const tab = app.activeTab
  if (!tab) return

  if (tab.path === 'trash://') {
    const n = tab.entries.length
    showMenu([
      { label: 'Empty Recycle Bin', disabled: !n, onClick: () => { void confirmEmptyTrash(n) } },
      {
        label: 'Restore all items', disabled: !n,
        onClick: () => { void liq.restoreTrash(tab.entries.map(e => e.path)).then(() => tab.refresh()) },
      },
      { label: 'Refresh', onClick: () => actions.refresh(tab) },
      { label: 'Properties', shortcut: 'Alt+Enter', onClick: () => app.emit('show-properties', ['trash://']) },
    ], { x: d.x, y: d.y })
    return
  }

  const templates = await fetchTemplates()
  const clip = app.clipboard
  const virtual = tab.isVirtual

  const iconRow: MenuAction[] = [{
    id: 'paste', icon: I.paste, tooltip: 'Paste (Ctrl+V)',
    disabled: !clip?.paths?.length || virtual,
    onClick: () => { void actions.paste(tab) },
  }]

  const items: MenuItem[] = [
    { label: 'View', submenu: viewSubmenu(tab) },
    { label: 'Sort by', submenu: sortSubmenu(tab) },
    { label: 'Group by', submenu: groupSubmenu(tab) },
    { label: 'Refresh', onClick: () => actions.refresh(tab) },
    { separator: true },
    {
      label: app.undoInfo.undoLabel ?? 'Undo', shortcut: 'Ctrl+Z',
      disabled: !app.undoInfo.undoLabel, onClick: () => { void actions.undo() },
    },
    {
      label: app.undoInfo.redoLabel ?? 'Redo', shortcut: 'Ctrl+Y',
      disabled: !app.undoInfo.redoLabel, onClick: () => { void actions.redo() },
    },
    { separator: true },
    { label: 'New', disabled: virtual, submenu: newSubmenu(tab, templates) },
    { separator: true },
    {
      label: 'Open in Terminal', icon: 'utilities-terminal', disabled: virtual,
      onClick: () => { void actions.openTerminal(tab) },
    },
    { label: 'Properties', shortcut: 'Alt+Enter', onClick: () => app.emit('show-properties', [tab.path]) },
  ]
  showMenu(items, { x: d.x, y: d.y, iconRow })
}

// ---------- item menu ----------

async function showItemMenu(d: ItemCtx): Promise<void> {
  const tab = app.activeTab
  if (!tab || !d.entries?.length) return
  const entries = d.entries
  const paths = entries.map(e => e.path)

  // Right-click selects: make sure the tab selection matches what was clicked,
  // so actions.* (which read tab.selection) operate on these entries.
  if (tab.selection.size !== paths.length || !paths.every(p => tab.selection.has(p))) {
    tab.setSelection(paths, paths[0])
  }

  // Recycle Bin items
  if (tab.path === 'trash://') {
    showMenu([
      { label: 'Restore', onClick: () => { void liq.restoreTrash(paths).then(() => tab.refresh()) } },
      { separator: true },
      { label: 'Delete permanently', danger: true, onClick: () => confirmPermanentDelete(entries) },
      { separator: true },
      { label: 'Properties', shortcut: 'Alt+Enter', onClick: () => { void actions.properties(tab) } },
    ], { x: d.x, y: d.y })
    return
  }

  const single = entries.length === 1 ? entries[0] : null
  const clip = app.clipboard

  const iconRow: MenuAction[] = [
    { id: 'cut', icon: I.cut, tooltip: 'Cut (Ctrl+X)', onClick: () => { void actions.cut(tab) } },
    { id: 'copy', icon: I.copy, tooltip: 'Copy (Ctrl+C)', onClick: () => { void actions.copy(tab) } },
  ]
  if (single?.isDir && clip?.paths?.length) {
    iconRow.push({
      id: 'paste-into', icon: I.paste, tooltip: 'Paste into folder',
      onClick: () => { void pasteInto(single.path) },
    })
  }
  if (single) {
    iconRow.push({ id: 'rename', icon: I.rename, tooltip: 'Rename (F2)', onClick: () => actions.rename(tab) })
  }
  iconRow.push({ id: 'delete', icon: I.del, tooltip: 'Delete (Del)', onClick: () => deleteEntries(tab, entries) })

  let items: MenuItem[]
  if (single && !single.isDir) {
    // -- single file --
    let apps: AppCandidate[] = []
    try { apps = await liq.listAppsFor(single.mime) } catch { /* menu still works without */ }
    const isArchive = isArchiveName(single.name)
    const fav = await isFavorite(single.path)
    items = [
      { label: 'Open', onClick: () => { void actions.open(tab) } },
      { label: 'Open with', submenu: openWithSubmenu(single, apps) },
      { separator: true },
      fav
        ? { label: 'Remove from Favorites', onClick: () => app.emit('remove-from-favorites', [single.path]) }
        : { label: 'Add to Favorites', onClick: () => app.emit('add-to-favorites', [single.path]) },
      { separator: true },
      ...(isArchive ? [
        { label: 'Extract All...', onClick: () => { void extractAll(tab, single) } },
        { label: 'Extract here', onClick: () => { void actions.extract(tab, 'auto') } },
        {
          label: `Extract to ${archiveStem(single.name)}\\`,
          onClick: () => { void actions.extract(tab, 'named') },
        },
        { label: 'Test archive', onClick: () => { void liq.invoke('testArchive', single.path) } },
      ] : []),
      { label: 'Compress to ZIP file', onClick: () => { void actions.compress(tab) } },
      { separator: true },
      { label: 'Copy as path', shortcut: 'Ctrl+Shift+C', onClick: () => { void actions.copyPath(tab) } },
      { separator: true },
      { label: 'Properties', shortcut: 'Alt+Enter', onClick: () => { void actions.properties(tab) } },
    ]
  } else if (single) {
    // -- single folder --
    const pinned = isPinned(single.path)
    items = [
      { label: 'Open', onClick: () => { void tab.navigate(single.path) } },
      { label: 'Open in new tab', onClick: () => { void app.newTab(single.path, true) } },
      { label: 'Open in new window', onClick: () => { void liq.newWindow(single.path) } },
      { separator: true },
      pinned
        ? { label: 'Unpin from Quick access', onClick: () => { void liq.unpinPlace(single.path) } }
        : { label: 'Pin to Quick access', onClick: () => { void liq.pinPlace(single.path) } },
      { label: 'Compress to ZIP file', onClick: () => { void actions.compress(tab) } },
      { label: 'Copy as path', shortcut: 'Ctrl+Shift+C', onClick: () => { void actions.copyPath(tab) } },
      { separator: true },
      { label: 'Open in Terminal', icon: 'utilities-terminal', onClick: () => { void liq.openTerminalAt(single.path) } },
      { label: 'Properties', shortcut: 'Alt+Enter', onClick: () => { void actions.properties(tab) } },
    ]
  } else {
    // -- multi-selection --
    const allDirs = entries.every(e => e.isDir)
    items = [
      { label: allDirs ? 'Open all in tabs' : 'Open', onClick: () => { void actions.open(tab) } },
      { separator: true },
      { label: 'Compress to ZIP file', onClick: () => { void actions.compress(tab) } },
      { label: 'Copy as path', shortcut: 'Ctrl+Shift+C', onClick: () => { void actions.copyPath(tab) } },
      { separator: true },
      { label: 'Properties', shortcut: 'Alt+Enter', onClick: () => { void actions.properties(tab) } },
    ]
  }
  showMenu(items, { x: d.x, y: d.y, iconRow })
}

function openWithSubmenu(entry: FileEntry, apps: AppCandidate[]): MenuItem[] {
  const items: MenuItem[] = apps.map(a => ({
    label: a.name,
    icon: a.icons?.length ? a.icons.join(',') : 'application-x-executable',
    onClick: () => { void liq.openWith(entry.path, a.id) },
  }))
  if (items.length) items.push({ separator: true })
  items.push({ label: 'Choose another app', onClick: () => app.emit('show-openwith', entry) })
  return items
}

// ---------- nav pane menu ----------

/** Explorer's nav-pane empty-space menu: the pane's own display options. */
function showNavpaneEmptyMenu(d: Pt): void {
  const s = app.settings
  showMenu([
    {
      label: 'Expand to open folder', checked: s.navExpandToCurrent,
      onClick: () => { void app.setSettings({ navExpandToCurrent: !s.navExpandToCurrent }) },
    },
    {
      label: 'Show hidden items', checked: s.showHidden,
      onClick: () => { void app.setSettings({ showHidden: !s.showHidden }) },
    },
    { separator: true },
    {
      label: 'Hide navigation pane',
      onClick: () => { void app.setSettings({ showNavPane: false }) },
    },
  ], { x: d.x, y: d.y })
}

function showNavpaneMenu(d: NavCtx): void {
  const place = d.place
  const path = place?.path ?? d.entry?.path ?? d.path
  if (!path) return

  if (place?.kind === 'trash' || path === 'trash://') {
    showMenu([
      { label: 'Open', onClick: () => { void app.activeTab?.navigate('trash://') } },
      { label: 'Empty Recycle Bin', onClick: () => { void confirmEmptyTrash() } },
    ], { x: d.x, y: d.y })
    return
  }

  const pinned = place ? (place.pinned === true || place.kind === 'pinned') : isPinned(path)
  const items: MenuItem[] = [
    { label: 'Open', onClick: () => { void app.activeTab?.navigate(path) } },
    { label: 'Open in new tab', onClick: () => { void app.newTab(path, true) } },
    { separator: true },
    pinned
      ? { label: 'Unpin from Quick access', onClick: () => { void liq.unpinPlace(path) } }
      : { label: 'Pin to Quick access', onClick: () => { void liq.pinPlace(path) } },
  ]
  if (place?.ejectable) {
    items.push({
      label: 'Eject', icon: 'media-eject',
      onClick: () => {
        void liq.ejectDrive(place.id).then((r: { ok: boolean; error?: string } | undefined) => {
          if (r && !r.ok) console.warn('[LiqExplorer] eject failed:', r.error)
        })
      },
    })
  }
  items.push(
    { separator: true },
    { label: 'Copy as path', onClick: () => { void liq.copyTextToClipboard(`"${path}"`) } },
    { label: 'Properties', shortcut: 'Alt+Enter', onClick: () => app.emit('show-properties', [path]) },
  )
  showMenu(items, { x: d.x, y: d.y })
}

// ---------- tab bar menu ----------

function showTabMenu(d: TabCtx): void {
  const i = d.index
  const t = app.tabs[i]
  if (!t) return
  showMenu([
    {
      label: 'Duplicate tab',
      // Explorer puts the copy immediately right of its source, not at the end
      onClick: () => {
        void app.newTab(t.path, true).then(nt => {
          const from = app.tabs.indexOf(nt)
          if (from < 0 || from === i + 1) return
          const active = app.tabs[app.activeTabIndex]
          app.tabs.splice(from, 1)
          app.tabs.splice(i + 1, 0, nt)
          app.activeTabIndex = app.tabs.indexOf(active)
          app.emit('tabs-changed')
        })
      },
    },
    { separator: true },
    { label: 'Close tab', shortcut: 'Ctrl+W', onClick: () => app.closeTab(i) },
    {
      label: 'Close other tabs', disabled: app.tabs.length < 2,
      onClick: () => { for (let j = app.tabs.length - 1; j >= 0; j--) if (j !== i) app.closeTab(j) },
    },
    {
      label: 'Close tabs to the right', disabled: i >= app.tabs.length - 1,
      onClick: () => { for (let j = app.tabs.length - 1; j > i; j--) app.closeTab(j) },
    },
  ], { x: d.x, y: d.y })
}
