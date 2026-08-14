// Options dialog — Explorer's "Folder Options" (General tab) plus the Search
// tab that Windows keeps in Control Panel > Indexing Options. Opened from the
// command bar's "…" menu via app.emit('show-options').
//
// Everything applies immediately through app.setSettings() (same path the View
// menu uses), so there is no OK/Apply/Cancel dance to keep in sync.
import type { IndexStatus } from '../../shared/types'
import { PUSH } from '../../shared/ipc'
import { app, liq } from '../core/app'
import { formatSize, formatDate } from '../../shared/sort'
import { openModal, el, closeX } from './dialogs'

/** minutes; 0 = only when the user asks */
const REFRESH_CHOICES: [number, string][] = [
  [0, 'Manually'],
  [15, 'Every 15 minutes'],
  [30, 'Every 30 minutes'],
  [60, 'Every hour'],
  [240, 'Every 4 hours'],
  [1440, 'Once a day'],
]

let openCount = 0

export function mountOptions(): void {
  app.on('show-options', (tab?: 'general' | 'search') => { void show(tab) })
}

async function show(initialTab: 'general' | 'search' = 'general'): Promise<void> {
  if (openCount) return                   // one Options window, like Explorer
  openCount++

  let offStatus: (() => void) | null = null
  // no onEnter: Enter belongs to the path/exclusion inputs (the modal's Enter
  // handler fires first, on document capture, and would close the dialog)
  const modal = openModal({
    width: 520,
    className: 'dlg-options',
    onDismiss: () => close(),
  })
  const close = (): void => {
    offStatus?.()
    offStatus = null
    openCount = 0
    modal.close()
  }

  const titleRow = el('div', 'dlg-title')
  titleRow.appendChild(el('span', 'dlg-title-text', 'Options'))
  titleRow.appendChild(closeX(close))

  const tabs = el('div', 'dlg-tabs')
  const body = el('div', 'dlg-body opt-body')
  const general = el('div', 'opt-panel')
  const search = el('div', 'opt-panel')
  body.append(general, search)

  const panels: [string, HTMLElement][] = [['General', general], ['Search', search]]
  const tabBtns = panels.map(([label]) => el('button', 'dlg-tab', label))
  const select = (i: number): void => {
    tabBtns.forEach((b, k) => b.classList.toggle('active', k === i))
    panels.forEach(([, p], k) => { p.hidden = k !== i })
  }
  tabBtns.forEach((b, i) => { b.addEventListener('click', () => select(i)); tabs.appendChild(b) })

  buildGeneral(general)
  offStatus = buildSearch(search, () => modal.closed)
  select(initialTab === 'search' ? 1 : 0)

  const buttons = el('div', 'dlg-buttons')
  const closeBtn = el('button', 'btn btn-primary', 'Close')
  closeBtn.addEventListener('click', close)
  buttons.appendChild(closeBtn)

  modal.dlg.append(titleRow, tabs, body, buttons)
}

// ---------------------------------------------------------------- widgets

function group(parent: HTMLElement, heading: string): HTMLDivElement {
  const g = el('div', 'opt-group')
  g.appendChild(el('div', 'opt-heading', heading))
  parent.appendChild(g)
  return g
}

function check(
  parent: HTMLElement, label: string, checked: boolean,
  onChange: (v: boolean) => void, hint?: string,
): HTMLInputElement {
  const wrap = el('label', 'opt-check')
  const box = el('input')
  box.type = 'checkbox'
  box.checked = checked
  box.addEventListener('change', () => onChange(box.checked))
  wrap.append(box, el('span', '', label))
  if (hint) wrap.title = hint
  parent.appendChild(wrap)
  return box
}

function radio(
  parent: HTMLElement, name: string, label: string, checked: boolean, onPick: () => void,
): void {
  const wrap = el('label', 'opt-check')
  const b = el('input')
  b.type = 'radio'
  b.name = name
  b.checked = checked
  b.addEventListener('change', () => { if (b.checked) onPick() })
  wrap.append(b, el('span', '', label))
  parent.appendChild(wrap)
}

function dropdown(
  parent: HTMLElement, options: [string, string][], value: string, onPick: (v: string) => void,
): HTMLSelectElement {
  const sel = el('select', 'opt-select')
  for (const [v, label] of options) {
    const o = document.createElement('option')
    o.value = v
    o.textContent = label
    sel.appendChild(o)
  }
  sel.value = value
  sel.addEventListener('change', () => onPick(sel.value))
  parent.appendChild(sel)
  return sel
}

/** editable list of paths/patterns with a ✕ on every row */
function pathList(
  parent: HTMLElement, empty: string, get: () => string[], set: (v: string[]) => void,
): () => void {
  const list = el('div', 'opt-list')
  parent.appendChild(list)
  const render = (): void => {
    list.textContent = ''
    const items = get()
    if (!items.length) { list.appendChild(el('div', 'opt-list-empty', empty)); return }
    for (const item of items) {
      const row = el('div', 'opt-list-row')
      row.appendChild(el('span', 'opt-list-text', item))
      const x = el('button', 'opt-list-x', '✕')
      x.title = `Remove ${item}`
      x.setAttribute('aria-label', `Remove ${item}`)
      x.addEventListener('click', () => { set(get().filter(i => i !== item)); render() })
      row.appendChild(x)
      list.appendChild(row)
    }
  }
  render()
  return render
}

// ---------------------------------------------------------------- General tab

function buildGeneral(root: HTMLElement): void {
  const s = app.settings

  const open = group(root, 'Open File Explorer to')
  const openOptions: [string, string][] = [
    ['home', 'Home'],
    ['homeFolder', 'Home folder'],
    ['lastSession', 'Last session'],
  ]
  const custom = !['home', 'homeFolder', 'lastSession'].includes(s.openTo)
  if (custom) openOptions.push([s.openTo, s.openTo])
  openOptions.push(['__pick', 'Choose folder…'])
  const openSel = dropdown(open, openOptions, s.openTo, (v) => {
    if (v !== '__pick') { void app.setSettings({ openTo: v }); return }
    void (async () => {
      const picked: string | null = await liq.invoke('pickFolder', app.homePath).catch(() => null)
      if (!picked) { openSel.value = app.settings.openTo; return }
      const o = document.createElement('option')
      o.value = picked
      o.textContent = picked
      openSel.insertBefore(o, openSel.options[openSel.options.length - 1])
      openSel.value = picked
      void app.setSettings({ openTo: picked })
    })()
  })

  const click = group(root, 'Click items as follows')
  radio(click, 'opt-click', 'Single-click to open an item', s.singleClickOpen,
    () => { void app.setSettings({ singleClickOpen: true }) })
  radio(click, 'opt-click', 'Double-click to open an item', !s.singleClickOpen,
    () => { void app.setSettings({ singleClickOpen: false }) })

  const adv = group(root, 'Advanced settings')
  check(adv, 'Show hidden files, folders and drives', s.showHidden,
    v => { void app.setSettings({ showHidden: v }) })
  check(adv, 'Show file name extensions', s.showExtensions,
    v => { void app.setSettings({ showExtensions: v }) })
  check(adv, 'Ask for confirmation before permanently deleting', s.confirmDelete,
    v => { void app.setSettings({ confirmDelete: v }) })
}

// ---------------------------------------------------------------- Search tab

function buildSearch(root: HTMLElement, closed: () => boolean): () => void {
  const s = app.settings
  let roots = [...s.indexRoots]
  let excludes = [...s.indexExcludes]

  /** save + let the indexer re-read the settings it schedules from */
  const patch = (p: Record<string, unknown>): Promise<unknown> =>
    app.setSettings(p)
      .then(() => liq.invoke('indexApplySettings'))
      .catch(() => { /* main not ready / settings write failed: keep the UI alive */ })

  // -- index status (live on PUSH.indexStatus)
  const st = group(root, 'Index')
  const statusLine = el('div', 'opt-status', 'Checking…')
  const rootsLine = el('div', 'opt-note', '')
  st.append(statusLine, rootsLine)

  // turning it on with nothing built yet starts the first scan straight away —
  // an empty index would silently keep every search on the slow path
  const enableBox = check(st, 'Keep an index of file names in these folders', s.indexEnabled,
    v => {
      void patch({ indexEnabled: v }).then(() => {
        if (v && !cur?.lastBuilt) return liq.invoke('buildIndex').then(paint)
        return paint(cur)
      })
    })

  // -- indexed folders
  const folders = group(root, 'Indexed folders')
  folders.appendChild(el('div', 'opt-note',
    'Empty means your home folder. Network shares are never covered by the system '
    + 'index (updatedb skips cifs/smb mounts), so add them here to search them quickly.'))
  const renderRoots = pathList(folders, 'Home folder (default)', () => roots, (v) => {
    roots = v
    patch({ indexRoots: roots })
  })
  const rootRow = el('div', 'opt-row')
  const rootInput = el('input', 'opt-input')
  rootInput.type = 'text'
  rootInput.placeholder = '/path/to/folder'
  rootInput.spellcheck = false
  const addRoot = async (p: string): Promise<void> => {
    const val = p.trim()
    if (!val) return
    const exists: boolean = await liq.pathExists(val).catch(() => false)
    if (!exists) { rootInput.classList.add('bad'); rootInput.title = 'That folder does not exist'; return }
    rootInput.classList.remove('bad')
    rootInput.title = ''
    if (!roots.includes(val)) { roots = [...roots, val]; patch({ indexRoots: roots }); renderRoots() }
    rootInput.value = ''
  }
  const addBtn = el('button', 'btn btn-small', 'Add')
  addBtn.addEventListener('click', () => { void addRoot(rootInput.value) })
  rootInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); void addRoot(rootInput.value) }
  })
  const browseBtn = el('button', 'btn btn-small', 'Browse…')
  browseBtn.addEventListener('click', () => {
    void (async () => {
      const picked: string | null = await liq.invoke('pickFolder', app.activeTab?.path).catch(() => null)
      if (picked) await addRoot(picked)
    })()
  })
  rootRow.append(rootInput, addBtn, browseBtn)
  folders.appendChild(rootRow)

  // -- exclusions
  const skip = group(root, 'Skip anything whose path contains')
  const renderSkips = pathList(skip, 'Nothing excluded', () => excludes, (v) => {
    excludes = v
    patch({ indexExcludes: excludes })
  })
  skip.appendChild(el('div', 'opt-note',
    'Adding or removing a folder re-scans straight away; exclusions and the '
    + 'hidden-files setting take effect the next time the index is built.'))
  const skipRow = el('div', 'opt-row')
  const skipInput = el('input', 'opt-input')
  skipInput.type = 'text'
  skipInput.placeholder = '/node_modules/'
  skipInput.spellcheck = false
  const addSkip = (): void => {
    const val = skipInput.value.trim()
    if (!val || excludes.includes(val)) { skipInput.value = ''; return }
    excludes = [...excludes, val]
    patch({ indexExcludes: excludes })
    renderSkips()
    skipInput.value = ''
  }
  const skipAdd = el('button', 'btn btn-small', 'Add')
  skipAdd.addEventListener('click', addSkip)
  skipInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); addSkip() }
  })
  skipRow.append(skipInput, skipAdd)
  skip.appendChild(skipRow)

  // -- behaviour
  const beh = group(root, 'Searching')
  check(beh, 'Use the index when the folder being searched is covered', s.searchUseIndex,
    v => patch({ searchUseIndex: v }),
    'Uncovered folders always fall back to a live walk of the folder tree')
  check(beh, 'Include hidden files and folders in the index', s.indexHidden,
    v => patch({ indexHidden: v }))
  const refreshRow = el('div', 'opt-row')
  refreshRow.appendChild(el('span', 'opt-inline-label', 'Refresh the index:'))
  dropdown(refreshRow,
    REFRESH_CHOICES.map(([v, label]) => [String(v), label] as [string, string]),
    String(s.indexRefreshMins),
    v => patch({ indexRefreshMins: Number(v) }))
  beh.appendChild(refreshRow)

  // -- actions
  const actions = el('div', 'opt-row opt-actions')
  const rebuild = el('button', 'btn btn-small', 'Rebuild now')
  const cancel = el('button', 'btn btn-small', 'Cancel')
  const clear = el('button', 'btn btn-small', 'Clear index')
  rebuild.addEventListener('click', () => { void liq.invoke('buildIndex').then(paint) })
  cancel.addEventListener('click', () => { void liq.invoke('cancelIndex').then(paint) })
  clear.addEventListener('click', () => { void liq.invoke('clearIndex').then(paint) })
  actions.append(rebuild, cancel, clear)
  root.appendChild(actions)

  // -- live status wiring
  let cur: IndexStatus | null = null
  function paint(status: IndexStatus | null): void {
    if (closed() || !status) return
    cur = status
    statusLine.textContent = describe(status)
    statusLine.classList.toggle('err', status.state === 'error')
    const here = app.activeTab?.path ?? ''
    const covered = !!here && !here.includes('://')
      && status.roots.some(r => here === r || here.startsWith(r.replace(/\/+$/, '') + '/'))
    rootsLine.textContent = status.state === 'ready' && here && !covered
      ? `Searches in ${here} are not indexed and run a live walk of the folder — add it below to speed them up.`
      : status.roots.length
        ? `Covers: ${status.roots.join(', ')}`
        : ''
    const scanning = status.state === 'scanning'
    rebuild.disabled = scanning || status.state === 'off'
    cancel.disabled = !scanning
    clear.disabled = scanning || (!status.files && !status.dirs)
    enableBox.checked = app.settings.indexEnabled
  }

  void liq.invoke('getIndexStatus').then(paint).catch(() => paint(null))
  return liq.on(PUSH.indexStatus, (st2: IndexStatus) => paint(st2))
}

function describe(s: IndexStatus): string {
  const n = (v: number): string => v.toLocaleString('en-US')
  switch (s.state) {
    case 'off': return 'Indexing is off — every search walks the folder tree live.'
    case 'idle': return 'No index yet — use Rebuild now to build one.'
    case 'scanning': return `Scanning ${s.scanning?.root ?? ''} — ${n(s.scanning?.seen ?? 0)} items found…`
    case 'error': return `Index error: ${s.error ?? 'unknown'}`
    default:
      return `Ready — ${n(s.files)} files, ${n(s.dirs)} folders · built ${formatDate(s.lastBuilt)} · ${formatSize(s.dbBytes)}`
  }
}
