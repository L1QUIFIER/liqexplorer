// Win11 command bar: New menu, cut/copy/paste/rename/share/delete icon buttons,
// Sort/View dropdowns, See-more (...) menu; swaps to Recycle Bin commands on trash://.
import { app, liq, Tab } from '../core/app'
import { actions } from '../core/actions'
import type { ViewMode } from '../../shared/types'
import { sortKeysFor } from '../../shared/sort'
import { showMenu } from '../menus/menu'
import type { MenuItem } from '../menus/menu-types'
import { ratingFilterSubmenu } from '../views/ratings'
import { openConvertDialog, runChecksums } from '../dialogs/bindialogs'
import type { ToolboxResult } from '../../shared/toolbox'
import { toast } from '../views/binstore'

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
// dual pane: two equal boxes, distinct from the preview pane's one-plus-strip
const SVG_DUAL = S('<rect x="1.5" y="3" width="5.5" height="10" rx="1.5"/><rect x="9" y="3" width="5.5" height="10" rx="1.5"/>')

// sort/group keys come from shared/sort.ts (sortKeysFor) — same list the
// right-click menus and the column chooser use
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
    <button class="cb-icon cb-dual" title="Dual pane (F3)" aria-label="Dual pane" aria-pressed="false">${SVG_DUAL}</button>
    <button class="cb-icon cb-preview" disabled title="Preview pane (coming soon)" aria-label="Preview pane">${SVG_PANE}</button>`

  const q = <T extends HTMLElement>(sel: string) => root.querySelector(sel) as T
  const normalCluster = q<HTMLElement>('.cb-normal')
  const trashCluster = q<HTMLElement>('.cb-trash')
  const newBtn = q<HTMLButtonElement>('.cb-new')
  const sortBtn = q<HTMLButtonElement>('.cb-sort')
  const viewBtn = q<HTMLButtonElement>('.cb-view')
  const moreBtn = q<HTMLButtonElement>('.cb-more')
  const dualBtn = q<HTMLButtonElement>('.cb-dual')
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
  dualBtn.addEventListener('click', () => app.emit('toggle-dual-pane'))

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
    // keep the whole TemplateInfo: newFile() only copies the template's bytes
    // when it gets an ABSOLUTE path — handing it the bare name writes a
    // zero-byte file with the right name instead (the right-click New menu
    // passes t.path, which is why only this one produced empty documents)
    let templates: { name: string; path: string; icons?: string[] }[] = []
    try {
      const r = await liq.invoke('templatesList')
      if (Array.isArray(r)) {
        templates = (r as { name?: unknown; path?: unknown; icons?: unknown }[])
          .filter(x => typeof x?.name === 'string' && typeof x?.path === 'string')
          .map(x => ({
            name: x.name as string,
            path: x.path as string,
            icons: Array.isArray(x.icons) ? x.icons as string[] : undefined,
          }))
      }
    } catch { /* helper not wired yet */ }
    const items: MenuItem[] = [
      {
        label: 'Folder', icon: 'folder', shortcut: 'Ctrl+Shift+N',
        onClick: () => { void actions.newFolder().then(p => { if (p) app.emit('start-rename', p) }) },
      },
      { separator: true },
      { label: 'Text Document', icon: 'text-x-generic,text-plain', onClick: () => newFromFile() },
      ...templates.map((t): MenuItem => ({
        label: stripExt(t.name),
        icon: t.icons?.length ? t.icons.join(',') : 'text-x-generic',
        onClick: () => newFromFile(t.path),
      })),
    ]
    newBtn.classList.add('open')   // keep the button lit while its flyout is up
    showMenu(items, { x: 0, y: 0, anchorEl: newBtn, minWidth: 240,
      onClose: () => newBtn.classList.remove('open') })
  })

  // ---- Sort menu ----
  sortBtn.addEventListener('click', () => {
    const t = app.activeTab
    const vs = t.viewState
    const items: MenuItem[] = [
      ...sortKeysFor(t.path).map(({ key: k, label: lb }): MenuItem => ({
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
          ...sortKeysFor(t.path).map(({ key: k, label: lb }): MenuItem => ({
            label: lb, radio: true, checked: vs.groupKey === k,
            onClick: () => t.setViewState({ groupKey: k }),
          })),
          { separator: true },
          { label: 'Ascending', radio: true, checked: vs.groupDir === 'asc', disabled: vs.groupKey === 'none', onClick: () => t.setViewState({ groupDir: 'asc' }) },
          { label: 'Descending', radio: true, checked: vs.groupDir === 'desc', disabled: vs.groupKey === 'none', onClick: () => t.setViewState({ groupDir: 'desc' }) },
        ],
      },
      { label: 'Filter by rating', submenu: ratingFilterSubmenu(t) },
    ]
    sortBtn.classList.add('open')   // keep the button lit while its flyout is up
    showMenu(items, { x: 0, y: 0, anchorEl: sortBtn, minWidth: 200,
      onClose: () => sortBtn.classList.remove('open') })
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
        // the full set of knobs lives in Options > View; this is the one people
        // actually reach for (turn it off when a folder is being scrolled hard)
        label: 'Live previews',
        submenu: ([
          ['off', 'Never'],
          ['hover', 'When I point at one'],
          ['always', 'All of them, while visible'],
        ] as const).map(([v, lb]): MenuItem => ({
          label: lb, radio: true, checked: (s.liveMedia ?? 'hover') === v,
          onClick: () => { void app.setSettings({ liveMedia: v }) },
        })),
      },
      { separator: true },
      // --- dual pane (views/panes.ts owns the panes; this only emits) ---
      {
        label: 'Dual pane', shortcut: 'F3', checked: app.isSplit,
        onClick: () => app.emit('toggle-dual-pane'),
      },
      {
        label: 'Pane layout',
        disabled: !app.isSplit,
        submenu: [
          {
            label: 'Side by side', radio: true, checked: app.activePrimary?.splitDir !== 'v',
            onClick: () => app.emit('set-pane-layout', 'h'),
          },
          {
            label: 'Top and bottom', radio: true, checked: app.activePrimary?.splitDir === 'v',
            onClick: () => app.emit('set-pane-layout', 'v'),
          },
          { separator: true },
          { label: 'Swap panes', shortcut: 'Ctrl+U', onClick: () => app.emit('swap-panes') },
        ],
      },
      { separator: true },
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
    viewBtn.classList.add('open')   // keep the button lit while its flyout is up
    showMenu(items, { x: 0, y: 0, anchorEl: viewBtn, minWidth: 220,
      onClose: () => viewBtn.classList.remove('open') })
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
      // same reason as the icon buttons below: no real destination folder
      { label: 'Compress to ZIP file', disabled: !hasSel || t.isVirtual, onClick: () => { void actions.compress() } },
      { label: 'Copy path', shortcut: 'Ctrl+Shift+C', onClick: () => { void actions.copyPath() } },
      { separator: true },
      { label: 'Properties', shortcut: 'Alt+Enter', onClick: () => { void actions.properties() } },
      { separator: true },
      { label: 'Tools', submenu: toolsMenu(t) },
      { label: 'Activity history', onClick: () => app.emit('show-history') },
      { label: 'Options', onClick: () => app.emit('show-options') },
    ]
    moreBtn.classList.add('open')   // keep the button lit while its flyout is up
    showMenu(items, { x: 0, y: 0, anchorEl: moreBtn, minWidth: 240,
      onClose: () => moreBtn.classList.remove('open') })
  })

  /**
   * Everything that is a TOOL rather than a file operation, in one place.
   *
   * These were all built and all reachable, but only from wherever they
   * happened to be wired: "Find duplicates" from the … menu and three context
   * menus, "Fix names" from a folder's context menu alone, and Checksums and
   * Convert images ONLY by dragging files onto a drop bin — which means you had
   * to already know they existed to find them. A tool nobody can find is a tool
   * nobody has.
   *
   * Enablement is per tool rather than blanket-disabling the menu: seeing that
   * "Convert images…" exists but needs pictures selected teaches you the app,
   * where a missing entry teaches nothing.
   */
  function toolsMenu(t: Tab): MenuItem[] {
    const sel = [...t.selection].filter(p => p.startsWith('/'))
    const files = t.selectedEntries().filter(e => !e.isDir)
    const images = files.filter(e => (e.mime || '').startsWith('image/'))
    const videos = files.filter(e => (e.mime || '').startsWith('video/'))
    const pdfs = files.filter(e => e.ext === 'pdf')
    const archives = files.filter(e => /^(zip|7z|rar|tar|gz|bz2|xz|tgz|tbz)$/.test(e.ext))
    const here = !t.isVirtual && t.path.startsWith('/')
    return [
      {
        label: 'Disk usage…', disabled: !here,
        onClick: () => app.emit('show-diskusage', t.path),
      },
      {
        label: 'Find duplicate files (identical bytes)…', disabled: !here,
        onClick: () => app.emit('show-duplicates', sel.length > 1 ? { roots: sel } : { root: t.path }),
      },
      {
        label: 'Fix file names…', disabled: !here,
        onClick: () => app.emit('show-fixnames', sel.length ? { paths: sel } : { root: t.path }),
      },
      { separator: true },
      {
        label: `Bulk rename${sel.length ? ` (${sel.length})` : ''}…`, disabled: !sel.length,
        onClick: () => app.emit('show-bulk-rename', sel),
      },
      {
        label: `Convert images${images.length ? ` (${images.length})` : ''}…`, disabled: !images.length,
        onClick: () => {
          void openConvertDialog(images.map(e => e.path), {
            id: 'tools-convert', action: 'convert', label: 'Convert images',
            convert: { format: 'jpg', maxDim: 0, quality: 88 },
          })
        },
      },
      {
        label: `Checksums${files.length ? ` (${files.length})` : ''}…`, disabled: !files.length,
        onClick: () => { void runChecksums(files.map(e => e.path), 'sha256') },
      },
      {
        // The one tool here that reaches the network, so it says so before it is clicked rather
        // than after — and it is enabled only on pictures, because that is all it can do.
        //
        // "on the web" vs "on this PC" below is not padding. These two tools run the SAME
        // perceptual fingerprint and were told apart only by the words "better" and "similar",
        // which is no distinction at all. What actually differs is WHAT EACH ONE COMPARES AGAINST:
        // this one asks the internet for a bigger copy, that one asks your own disk for repeats.
        label: `Find a better version on the web${images.length ? ` (${images.length})` : ''}…`,
        disabled: !images.length,
        // One picture is a conversation — look, compare, decide. Many is a PLAN: scan them all,
        // then review a table and tick what to keep. Stepping through forty pictures one modal at
        // a time would be the same work with none of the overview.
        onClick: () => app.emit(
          images.length > 1 ? 'show-better-batch' : 'show-better-image',
          images.map(e => e.path)),
      },
      {
        label: sel.length > 1
          ? `Find repeated pictures on this PC (in ${sel.length} selected)…`
          : 'Find repeated pictures on this PC…',
        disabled: !here,
        onClick: () => app.emit('show-similar',
          sel.length > 1 ? { root: t.path, paths: sel } : { root: t.path }),
      },
      {
        label: 'Empty folders & broken links…', disabled: !here,
        onClick: () => app.emit('show-cleanup', t.path),
      },
      { separator: true },
      {
        label: `Extract audio${videos.length ? ` (${videos.length})` : ''}…`, disabled: !videos.length,
        onClick: () => runToolbox('extractAudio', videos.map(e => e.path), 'Extracted audio from'),
      },
      {
        label: `Repack as MP4${videos.length ? ` (${videos.length})` : ''}…`, disabled: !videos.length,
        onClick: () => runToolbox('remuxToMp4', videos.map(e => e.path), 'Repacked'),
      },
      {
        label: `Pictures to PDF${images.length ? ` (${images.length})` : ''}…`, disabled: !images.length,
        onClick: () => runToolbox('imagesToPdf', images.map(e => e.path), 'Made'),
      },
      {
        label: `PDF to pictures${pdfs.length ? ` (${pdfs.length})` : ''}…`, disabled: !pdfs.length,
        onClick: () => runToolbox('pdfToImages', pdfs.map(e => e.path), 'Unpacked'),
      },
      {
        label: `Set dates from EXIF${images.length ? ` (${images.length})` : ''}…`, disabled: !images.length,
        onClick: () => runToolbox('datesFromExif', images.map(e => e.path), 'Dated'),
      },
      {
        label: `Test archives${archives.length ? ` (${archives.length})` : ''}…`, disabled: !archives.length,
        onClick: () => runToolbox('testArchives', archives.map(e => e.path), 'Passed'),
      },
      { separator: true },
      {
        label: 'Media health…', disabled: !here,
        onClick: () => app.emit('show-mediahealth', t.path),
      },
      {
        label: 'Compare with another folder…', disabled: !here,
        onClick: () => app.emit('show-compare'),
      },
      {
        label: 'Verify checksums…',
        // only a checksum file can be verified, so the entry says so by being
        // off rather than by explaining itself after you click it
        disabled: !sel.some(p => /SUMS(\s*\(\d+\))?$/i.test(p.split('/').pop() ?? '')),
        onClick: () => app.emit('show-verify', sel.find(p => /SUMS/i.test(p))),
      },
      { separator: true },
      { label: 'Extensions…', onClick: () => app.emit('show-options', 'extensions') },
      { label: 'System check…', onClick: () => app.emit('show-options', 'system') },
    ]
  }

  /**
   * Run one of the small tools and say what happened.
   *
   * They all return the same shape, so they all report the same way: a toast
   * naming what was produced, or the first real error. Nothing here writes over
   * an original, so the failure case costs nothing but the message.
   */
  function runToolbox(verb: string, paths: string[], verb2: string): void {
    if (!paths.length) return
    void (async () => {
      const r = await liq.invoke(verb, paths).catch(
        (e: Error) => ({ ok: false, done: [], failed: [], error: String(e?.message ?? e) })) as ToolboxResult
      if (!r.ok) {
        toast({ text: r.error ?? r.failed[0]?.error ?? 'That did not work.', bad: true })
        return
      }
      const first = r.done[0]?.split('/').pop() ?? ''
      toast({
        text: `${verb2} ${r.done.length === 1 ? first : `${r.done.length} items`}.`,
        sub: r.failed.length ? `${r.failed.length} failed: ${r.failed[0].error}` : undefined,
      })
      void app.activeTab?.refresh()
    })()
  }

  // ---- enable/disable + trash swap ----
  const update = () => {
    const t = app.activeTab
    if (!t) return
    const isTrash = t.path === 'trash://'
    normalCluster.hidden = isTrash
    trashCluster.hidden = !isTrash
    const hasSel = t.selection.size > 0
    // rows on computer:// are live drive mountpoints — cut/rename/delete them
    // would move/trash whole drives, so grey all edits like Explorer does;
    // archive:// rows are members inside a zip, which the engine cannot touch
    const noEdit = isTrash || t.isVirtual
    cmdBtn('cut').disabled = !hasSel || noEdit
    cmdBtn('copy').disabled = !hasSel || t.path === 'computer://'
    cmdBtn('paste').disabled = !(app.clipboard && app.clipboard.paths.length) || t.isVirtual
    cmdBtn('rename').disabled = !hasSel || noEdit
    cmdBtn('delete').disabled = !hasSel || noEdit
    newBtn.disabled = t.isVirtual
    emptyTrashBtn.disabled = t.rows.length === 0
    restoreAllBtn.disabled = t.rows.length === 0
    restoreSelBtn.disabled = !hasSel
    dualBtn.classList.toggle('on', app.isSplit)
    dualBtn.setAttribute('aria-pressed', String(app.isSplit))
    dualBtn.title = app.isSplit ? 'Close dual pane (F3)' : 'Dual pane (F3)'
  }

  app.on('tabs-changed', update)
  app.on('panes-changed', update)
  app.on('tab-navigated', (t: Tab) => { if (t === app.activeTab) update() })
  app.on('tab-listing', (t: Tab) => { if (t === app.activeTab) update() })
  app.on('tab-selection', (t: Tab) => { if (t === app.activeTab) update() })
  app.on('clipboard-changed', update)
  app.on('undo-changed', update)
  update()
}
