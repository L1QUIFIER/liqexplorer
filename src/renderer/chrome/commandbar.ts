// Win11 command bar: New menu, cut/copy/paste/rename/share/delete icon buttons,
// Sort/View dropdowns, See-more (...) menu; swaps to Recycle Bin commands on trash://.
import { app, liq, Tab } from '../core/app'
import { actions } from '../core/actions'
import type { SortKey, ViewMode } from '../../shared/types'
import { showMenu } from '../menus/menu'
import type { MenuItem } from '../menus/menu-types'

const S = (d: string) => `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`
const SVG_NEW = S('<path d="M8 2.5v11M2.5 8h11"/>')
const SVG_CHEV = '<svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"><path d="M2.5 4.5 6 8l3.5-3.5"/></svg>'
const SVG_CUT = S('<circle cx="4" cy="12" r="1.8"/><circle cx="12" cy="12" r="1.8"/><path d="M5.3 10.6 12.5 2M10.7 10.6 3.5 2"/>')
const SVG_COPY = S('<rect x="5.5" y="5.5" width="8" height="8" rx="1.5"/><path d="M10.5 3.5v-.5a1.5 1.5 0 0 0-1.5-1.5H4A1.5 1.5 0 0 0 2.5 3v5A1.5 1.5 0 0 0 4 9.5h.5" transform="translate(0 1)"/>')
const SVG_PASTE = S('<rect x="2.5" y="3" width="8.5" height="11" rx="1.5"/><path d="M4.5 3v-.5h4.5V3"/><rect x="7.5" y="7" width="6" height="7" rx="1.5"/>')
const SVG_RENAME = S('<path d="M9.5 3.5 12.5 6.5M2.5 13.5l.7-2.9 7.4-7.4a1.4 1.4 0 0 1 2 0l.2.2a1.4 1.4 0 0 1 0 2l-7.4 7.4-2.9.7z"/>')
const SVG_SHARE = S('<path d="M8 10V2.5M5.5 4.5 8 2l2.5 2.5M4.5 7.5H4a1.5 1.5 0 0 0-1.5 1.5v3A1.5 1.5 0 0 0 4 13.5h8a1.5 1.5 0 0 0 1.5-1.5V9A1.5 1.5 0 0 0 12 7.5h-.5"/>')
const SVG_DELETE = S('<path d="M2.5 4h11M6.5 2h3M4 4l.6 9.1a1 1 0 0 0 1 .9h4.8a1 1 0 0 0 1-.9L12 4M6.5 7v4M9.5 7v4"/>')
const SVG_SORT = S('<path d="M4.5 3v10M2 10.5 4.5 13 7 10.5M11.5 13V3M9 5.5 11.5 3 14 5.5"/>')
const SVG_VIEW = S('<rect x="2" y="2" width="5" height="5" rx="1"/><rect x="9" y="2" width="5" height="5" rx="1"/><rect x="2" y="9" width="5" height="5" rx="1"/><rect x="9" y="9" width="5" height="5" rx="1"/>')
const SVG_MORE = '<svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><circle cx="3" cy="8" r="1.3"/><circle cx="8" cy="8" r="1.3"/><circle cx="13" cy="8" r="1.3"/></svg>'
const SVG_PANE = S('<rect x="1.5" y="3" width="13" height="10" rx="1.5"/><path d="M9.5 3v10"/>')
const SVG_RESTORE = S('<path d="M8 12.5V5M5 7.5 8 4.5l3 3M3 14h10"/>')

const SORT_KEYS: [string, SortKey][] = [
  ['Name', 'name'], ['Date modified', 'mtime'], ['Type', 'type'], ['Size', 'size'],
]
const VIEW_MODES: [string, ViewMode, string][] = [
  ['Extra large icons', 'extra-large', 'Ctrl+Shift+1'],
  ['Large icons', 'large', 'Ctrl+Shift+2'],
  ['Medium icons', 'medium', 'Ctrl+Shift+3'],
  ['Small icons', 'small', 'Ctrl+Shift+4'],
  ['List', 'list', 'Ctrl+Shift+5'],
  ['Details', 'details', 'Ctrl+Shift+6'],
  ['Tiles', 'tiles', 'Ctrl+Shift+7'],
  ['Content', 'content', 'Ctrl+Shift+8'],
]

const stripExt = (name: string) => name.replace(/\.[^.\s]+$/, '')

export function mountCommandBar(root: HTMLElement): void {
  root.innerHTML = `
    <div class="cb-cluster cb-normal">
      <button class="cb-drop cb-new">${SVG_NEW}<span>New</span>${SVG_CHEV}</button>
      <div class="cb-sep"></div>
      <button class="cb-icon" data-cmd="cut" title="Cut (Ctrl+X)" aria-label="Cut">${SVG_CUT}</button>
      <button class="cb-icon" data-cmd="copy" title="Copy (Ctrl+C)" aria-label="Copy">${SVG_COPY}</button>
      <button class="cb-icon" data-cmd="paste" title="Paste (Ctrl+V)" aria-label="Paste">${SVG_PASTE}</button>
      <button class="cb-icon" data-cmd="rename" title="Rename (F2)" aria-label="Rename">${SVG_RENAME}</button>
      <button class="cb-icon cb-share" disabled title="Coming soon" aria-label="Share">${SVG_SHARE}</button>
      <button class="cb-icon" data-cmd="delete" title="Delete (Del)" aria-label="Delete">${SVG_DELETE}</button>
    </div>
    <div class="cb-cluster cb-trash" hidden>
      <button class="cb-drop cb-empty-trash">${SVG_DELETE}<span>Empty Recycle Bin</span></button>
      <button class="cb-drop cb-restore-all">${SVG_RESTORE}<span>Restore all items</span></button>
      <button class="cb-drop cb-restore-sel">${SVG_RESTORE}<span>Restore selected</span></button>
    </div>
    <div class="cb-sep"></div>
    <button class="cb-drop cb-sort">${SVG_SORT}<span>Sort</span>${SVG_CHEV}</button>
    <button class="cb-drop cb-view">${SVG_VIEW}<span>View</span>${SVG_CHEV}</button>
    <div class="cb-sep"></div>
    <button class="cb-icon cb-more" title="See more" aria-label="See more">${SVG_MORE}</button>
    <div class="cb-spacer"></div>
    <button class="cb-icon cb-preview" disabled title="Preview pane (coming soon)" aria-label="Preview pane">${SVG_PANE}</button>`

  const q = <T extends HTMLElement>(sel: string) => root.querySelector(sel) as T
  const normalCluster = q<HTMLElement>('.cb-normal')
  const trashCluster = q<HTMLElement>('.cb-trash')
  const newBtn = q<HTMLButtonElement>('.cb-new')
  const sortBtn = q<HTMLButtonElement>('.cb-sort')
  const viewBtn = q<HTMLButtonElement>('.cb-view')
  const moreBtn = q<HTMLButtonElement>('.cb-more')
  const cmdBtn = (cmd: string) => root.querySelector(`[data-cmd="${cmd}"]`) as HTMLButtonElement
  const emptyTrashBtn = q<HTMLButtonElement>('.cb-empty-trash')
  const restoreAllBtn = q<HTMLButtonElement>('.cb-restore-all')
  const restoreSelBtn = q<HTMLButtonElement>('.cb-restore-sel')

  // ---- simple command buttons ----
  cmdBtn('cut').addEventListener('click', () => { void actions.cut() })
  cmdBtn('copy').addEventListener('click', () => { void actions.copy() })
  cmdBtn('paste').addEventListener('click', () => { void actions.paste() })
  cmdBtn('rename').addEventListener('click', () => actions.rename())
  cmdBtn('delete').addEventListener('click', () => { void actions.delete() })

  // ---- trash commands ----
  emptyTrashBtn.addEventListener('click', () => {
    const n = app.activeTab.rows.length
    app.emit('show-confirm', {
      title: 'Empty Recycle Bin',
      message: n === 1
        ? 'Are you sure you want to permanently delete this item?'
        : `Are you sure you want to permanently delete these ${n} items?`,
      onOk: async () => { await liq.emptyTrash(); app.activeTab.refresh() },
    })
  })
  restoreAllBtn.addEventListener('click', async () => {
    const paths = app.activeTab.rows.map(r => r.path)
    if (paths.length) { await liq.restoreTrash(paths); app.activeTab.refresh() }
  })
  restoreSelBtn.addEventListener('click', async () => {
    const paths = [...app.activeTab.selection]
    if (paths.length) { await liq.restoreTrash(paths); app.activeTab.refresh() }
  })

  // ---- New menu ----
  const newFromFile = (template?: string) => {
    void actions.newFile(undefined, template).then(p => { if (p) app.emit('start-rename', p) })
  }
  newBtn.addEventListener('click', async () => {
    let templates: string[] = []
    try {
      const r = await liq.invoke('templatesList')
      if (Array.isArray(r)) {
        templates = r.map((x: unknown) => typeof x === 'string' ? x : (x as { name?: string })?.name ?? '').filter(Boolean)
      }
    } catch { /* helper not wired yet */ }
    const items: MenuItem[] = [
      {
        label: 'Folder', icon: 'folder', shortcut: 'Ctrl+Shift+N',
        onClick: () => { void actions.newFolder().then(p => { if (p) app.emit('start-rename', p) }) },
      },
      { separator: true },
      { label: 'Text Document', icon: 'text-x-generic,text-plain', onClick: () => newFromFile() },
      ...templates.map((name): MenuItem => ({
        label: stripExt(name), icon: 'text-x-generic',
        onClick: () => newFromFile(name),
      })),
    ]
    showMenu(items, { x: 0, y: 0, anchorEl: newBtn, minWidth: 240 })
  })

  // ---- Sort menu ----
  sortBtn.addEventListener('click', () => {
    const t = app.activeTab
    const vs = t.viewState
    const items: MenuItem[] = [
      ...SORT_KEYS.map(([lb, k]): MenuItem => ({
        label: lb, radio: true, checked: vs.sortKey === k,
        onClick: () => t.setViewState({ sortKey: k }),
      })),
      { separator: true },
      { label: 'Ascending', radio: true, checked: vs.sortDir === 'asc', onClick: () => t.setViewState({ sortDir: 'asc' }) },
      { label: 'Descending', radio: true, checked: vs.sortDir === 'desc', onClick: () => t.setViewState({ sortDir: 'desc' }) },
      { separator: true },
      {
        label: 'Group by',
        submenu: [
          { label: '(None)', radio: true, checked: vs.groupKey === 'none', onClick: () => t.setViewState({ groupKey: 'none' }) },
          ...SORT_KEYS.map(([lb, k]): MenuItem => ({
            label: lb, radio: true, checked: vs.groupKey === k,
            onClick: () => t.setViewState({ groupKey: k }),
          })),
          { separator: true },
          { label: 'Ascending', radio: true, checked: vs.groupDir === 'asc', disabled: vs.groupKey === 'none', onClick: () => t.setViewState({ groupDir: 'asc' }) },
          { label: 'Descending', radio: true, checked: vs.groupDir === 'desc', disabled: vs.groupKey === 'none', onClick: () => t.setViewState({ groupDir: 'desc' }) },
        ],
      },
    ]
    showMenu(items, { x: 0, y: 0, anchorEl: sortBtn, minWidth: 200 })
  })

  // ---- View menu ----
  viewBtn.addEventListener('click', () => {
    const t = app.activeTab
    const s = app.settings
    const toggle = (key: 'showNavPane' | 'showHidden' | 'showExtensions' | 'checkboxes') =>
      () => { void app.setSettings({ [key]: !s[key] }) }
    const items: MenuItem[] = [
      ...VIEW_MODES.map(([lb, m, sc]): MenuItem => ({
        label: lb, shortcut: sc, radio: true, checked: t.viewState.mode === m,
        onClick: () => t.setViewState({ mode: m }),
      })),
      { separator: true },
      { label: 'Compact view', checked: s.compactView, onClick: () => { void app.setSettings({ compactView: !s.compactView }) } },
      {
        label: 'Show',
        submenu: [
          { label: 'Navigation pane', checked: s.showNavPane, onClick: toggle('showNavPane') },
          { label: 'Hidden items', checked: s.showHidden, onClick: toggle('showHidden') },
          { label: 'File name extensions', checked: s.showExtensions, onClick: toggle('showExtensions') },
          { label: 'Item check boxes', checked: s.checkboxes, onClick: toggle('checkboxes') },
        ],
      },
    ]
    showMenu(items, { x: 0, y: 0, anchorEl: viewBtn, minWidth: 220 })
  })

  // ---- See more (...) menu ----
  moreBtn.addEventListener('click', () => {
    const t = app.activeTab
    const u = app.undoInfo
    const hasSel = t.selection.size > 0
    const items: MenuItem[] = [
      { label: u.undoLabel ?? 'Undo', shortcut: 'Ctrl+Z', disabled: !u.undoLabel, onClick: () => { void actions.undo() } },
      { label: u.redoLabel ?? 'Redo', shortcut: 'Ctrl+Y', disabled: !u.redoLabel, onClick: () => { void actions.redo() } },
      { separator: true },
      { label: 'Select all', shortcut: 'Ctrl+A', onClick: () => actions.selectAll() },
      { label: 'Select none', onClick: () => actions.selectNone() },
      { label: 'Invert selection', onClick: () => actions.invertSelection() },
      { separator: true },
      { label: 'Compress to ZIP file', disabled: !hasSel, onClick: () => { void actions.compress() } },
      { label: 'Copy path', shortcut: 'Ctrl+Shift+C', onClick: () => { void actions.copyPath() } },
      { separator: true },
      { label: 'Properties', shortcut: 'Alt+Enter', onClick: () => { void actions.properties() } },
    ]
    showMenu(items, { x: 0, y: 0, anchorEl: moreBtn, minWidth: 240 })
  })

  // ---- enable/disable + trash swap ----
  const update = () => {
    const t = app.activeTab
    if (!t) return
    const isTrash = t.path === 'trash://'
    normalCluster.hidden = isTrash
    trashCluster.hidden = !isTrash
    const hasSel = t.selection.size > 0
    // rows on computer:// are live drive mountpoints — cut/rename/delete them
    // would move/trash whole drives, so grey all edits like Explorer does
    const noEdit = isTrash || t.path === 'computer://'
    cmdBtn('cut').disabled = !hasSel || noEdit
    cmdBtn('copy').disabled = !hasSel || t.path === 'computer://'
    cmdBtn('paste').disabled = !(app.clipboard && app.clipboard.paths.length) || t.isVirtual
    cmdBtn('rename').disabled = !hasSel || noEdit
    cmdBtn('delete').disabled = !hasSel || noEdit
    newBtn.disabled = t.isVirtual
    emptyTrashBtn.disabled = t.rows.length === 0
    restoreAllBtn.disabled = t.rows.length === 0
    restoreSelBtn.disabled = !hasSel
  }

  app.on('tabs-changed', update)
  app.on('tab-navigated', (t: Tab) => { if (t === app.activeTab) update() })
  app.on('tab-listing', (t: Tab) => { if (t === app.activeTab) update() })
  app.on('tab-selection', (t: Tab) => { if (t === app.activeTab) update() })
  app.on('clipboard-changed', update)
  app.on('undo-changed', update)
  update()
}
