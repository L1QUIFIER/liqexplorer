// Options dialog — Explorer's "Folder Options" (General tab) plus the Search
// tab that Windows keeps in Control Panel > Indexing Options. Opened from the
// command bar's "…" menu via app.emit('show-options').
//
// Everything applies immediately through app.setSettings() (same path the View
// menu uses), so there is no OK/Apply/Cancel dance to keep in sync.
import type { AppSettings, FolderKind, IndexStatus, MediaViewerKind, ViewMode } from '../../shared/types'
import { DEFAULT_SMART_RULES } from '../../shared/types'
import { PUSH } from '../../shared/ipc'
import { PEEK } from '../../shared/peek'
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
  app.on('show-options', (tab?: OptionsTab) => { void show(tab) })
}

type OptionsTab = 'general' | 'view' | 'search'

async function show(initialTab: OptionsTab = 'general'): Promise<void> {
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
  const view = el('div', 'opt-panel')
  const search = el('div', 'opt-panel')
  body.append(general, view, search)

  const panels: [string, HTMLElement][] = [['General', general], ['View', view], ['Search', search]]
  const tabBtns = panels.map(([label]) => el('button', 'dlg-tab', label))
  const select = (i: number): void => {
    tabBtns.forEach((b, k) => b.classList.toggle('active', k === i))
    panels.forEach(([, p], k) => { p.hidden = k !== i })
  }
  tabBtns.forEach((b, i) => { b.addEventListener('click', () => select(i)); tabs.appendChild(b) })

  buildGeneral(general)
  buildView(view)
  offStatus = buildSearch(search, () => modal.closed)
  select(initialTab === 'view' ? 1 : initialTab === 'search' ? 2 : 0)

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
  check(adv, 'Remember each folder’s view settings', s.rememberPerFolder,
    v => { void app.setSettings({ rememberPerFolder: v }) })

  // Windows asks before a permanent delete and nothing else, which is how files
  // get moved into the wrong folder by a stray drag. All off by default except
  // the permanent-delete one, so nothing nags unless the user opts in.
  const confirm = group(root, 'Ask me before')
  check(confirm, 'Permanently deleting an item', s.confirmDelete,
    v => { void app.setSettings({ confirmDelete: v }) })
  check(confirm, 'Moving an item to the Recycle Bin', s.confirmTrash,
    v => { void app.setSettings({ confirmTrash: v }) })
  check(confirm, 'Moving or copying items by drag and drop', s.confirmDrop,
    v => { void app.setSettings({ confirmDrop: v }) },
    'Shows what will be moved or copied, and where, before it happens')
  check(confirm, 'Moving items with Cut and Paste', s.confirmMove,
    v => { void app.setSettings({ confirmMove: v }) })

  // Safe mode is the confirmation that stays worth reading, because it only
  // appears for the handful of cases that are almost certainly a mistake.
  const safety = group(root, 'Safety')
  const safeBox = check(safety, 'Safe mode — check moves that look like a mistake', s.safeMode,
    v => { void app.setSettings({ safeMode: v }); syncSafe(v) },
    'Asks when a system folder, a whole drive, your home folder or a hidden '
    + 'settings folder is involved, or when an unusually large number of items '
    + 'would move at once')
  const bulkRow = el('label', 'opt-check opt-indent')
  bulkRow.title = 'Set to 0 to never ask on item count alone'
  bulkRow.appendChild(el('span', '', 'Also ask when moving more than'))
  const bulkInput = el('input', 'opt-num')
  bulkInput.type = 'number'
  bulkInput.min = '0'
  bulkInput.max = '100000'
  bulkInput.step = '10'
  bulkInput.value = String(s.safeModeBulk)
  bulkInput.addEventListener('change', () => {
    const n = Math.max(0, Math.min(100000, Math.round(Number(bulkInput.value) || 0)))
    bulkInput.value = String(n)
    void app.setSettings({ safeModeBulk: n })
  })
  bulkRow.appendChild(bulkInput)
  bulkRow.appendChild(el('span', '', 'items at once'))
  safety.appendChild(bulkRow)
  const syncSafe = (on: boolean): void => {
    bulkRow.classList.toggle('opt-disabled', !on)
    bulkInput.disabled = !on
  }
  syncSafe(safeBox.checked)

  // History is separate from safe mode: one prevents the accident, the other
  // lets you work out what happened after one slipped through.
  const hist = group(root, 'Activity history')
  check(hist, 'Keep a record of copies, moves, renames and deletes', s.historyEnabled,
    v => { void app.setSettings({ historyEnabled: v }) },
    'Stored on this computer only. Records what happened, never file contents.')
  const histBtn = el('button', 'btn opt-btn', 'View history…')
  histBtn.addEventListener('click', () => app.emit('show-history'))
  hist.appendChild(histBtn)
}

// ---------------------------------------------------------------- View tab

function buildView(root: HTMLElement): void {
  const s = app.settings

  const theme = group(root, 'Appearance')
  dropdown(theme, [['system', 'Follow system theme'], ['light', 'Light'], ['dark', 'Dark']],
    s.theme, v => { void app.setSettings({ theme: v as AppSettings['theme'] }) })

  const layout = group(root, 'Layout')
  check(layout, 'Navigation pane', s.showNavPane,
    v => { void app.setSettings({ showNavPane: v }) })
  check(layout, 'Preview pane (Alt+P)', s.showPreviewPane,
    v => { void app.setSettings({ showPreviewPane: v }) })
  check(layout, 'Status bar', s.showStatusBar,
    v => { void app.setSettings({ showStatusBar: v }) })
  check(layout, 'Compact view (tighter rows)', s.compactView,
    v => { void app.setSettings({ compactView: v }) })
  check(layout, 'Item check boxes', s.checkboxes,
    v => { void app.setSettings({ checkboxes: v }) })

  const listing = group(root, 'Files and folders')
  check(listing, 'Show folders before files', s.foldersFirst,
    v => { void app.setSettings({ foldersFirst: v }) })
  check(listing, 'Expand the navigation tree to the open folder', s.navExpandToCurrent,
    v => { void app.setSettings({ navExpandToCurrent: v }) })
  check(listing, 'Show thumbnails for files on network drives', s.thumbnailsRemote,
    v => { void app.setSettings({ thumbnailsRemote: v }) },
    'Off by default: thumbnailing a network share reads every file over the network')

  // ---- live media previews ----
  // Hover is the default because "all visible" on a folder of 200 clips is a
  // lot of decoders; the cap below is what keeps either mode honest.
  const live = group(root, 'Live previews')
  const liveRow = el('div', 'opt-inline')
  liveRow.appendChild(el('span', '', 'Play videos in the icon views'))
  dropdown(liveRow, [
    ['off', 'Never'],
    ['hover', 'When I point at one'],
    ['always', 'All of them, while visible'],
  ], s.liveMedia ?? 'hover', v => {
    void app.setSettings({ liveMedia: v as AppSettings['liveMedia'] })
    paintLive()
  })
  live.appendChild(liveRow)
  const liveOpts = el('div', 'opt-rules')
  live.appendChild(liveOpts)
  check(liveOpts, 'Scrub through the video by moving across it', s.liveMediaScrub,
    v => { void app.setSettings({ liveMediaScrub: v }) },
    'Like Plex or YouTube: the pointer’s position across the tile is a position '
    + 'in the video. Tiles narrower than 64px are too coarse to scrub.')
  check(liveOpts, 'Animate GIF and WebP images', s.liveMediaAnimated,
    v => { void app.setSettings({ liveMediaAnimated: v }) },
    'These animate as themselves — no decoder involved. The whole file has to be '
    + 'read, so large ones on a network drive are left as thumbnails.')
  check(liveOpts, 'Stop when the system asks to reduce motion', s.liveMediaReduceMotion,
    v => { void app.setSettings({ liveMediaReduceMotion: v }); paintLive() })
  const capRow = el('label', 'opt-check')
  capRow.appendChild(el('span', '', 'Play at most'))
  const capInput = el('input', 'opt-num')
  capInput.type = 'number'
  capInput.min = '1'
  capInput.max = '24'
  capInput.step = '1'
  capInput.value = String(s.liveMediaMax ?? 10)
  capInput.addEventListener('change', () => {
    const n = Math.max(1, Math.min(24, Math.round(Number(capInput.value) || 10)))
    capInput.value = String(n)
    void app.setSettings({ liveMediaMax: n })
  })
  capRow.appendChild(capInput)
  capRow.appendChild(el('span', '', 'videos at once'))
  liveOpts.appendChild(capRow)
  const liveNote = el('div', 'opt-note', '')
  live.appendChild(liveNote)
  function paintLive(): void {
    const off = app.settings.liveMedia === 'off'
    liveOpts.classList.toggle('is-off', off)
    const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches
    liveNote.textContent = reduced && app.settings.liveMediaReduceMotion
      ? 'Your desktop is currently asking for reduced motion, so live previews are off.'
      : ''
  }
  paintLive()

  // ---- smart view ----
  const smart = group(root, 'Choose the view automatically')
  check(smart, 'Set the view mode from what the folder contains', s.smartView,
    v => { void app.setSettings({ smartView: v }); paintSmart() },
    'A folder you have set by hand always keeps your choice')
  const thresholdRow = el('div', 'opt-inline')
  thresholdRow.appendChild(el('span', '', 'when at least'))
  dropdown(thresholdRow,
    [['0.5', 'half'], ['0.6', '60%'], ['0.75', '75%'], ['0.9', '90%']],
    String(s.smartViewThreshold ?? 0.6),
    v => { void app.setSettings({ smartViewThreshold: Number(v) }) })
  thresholdRow.appendChild(el('span', '', 'of the files match'))
  smart.appendChild(thresholdRow)

  const KINDS: [FolderKind, string][] = [
    ['images', 'Pictures'], ['video', 'Videos'], ['audio', 'Music'],
    ['documents', 'Documents'], ['code', 'Code and text'], ['archives', 'Archives'],
  ]
  const MODES: [string, string][] = [
    ['extra-large', 'Extra large icons'], ['large', 'Large icons'],
    ['medium', 'Medium icons'], ['small', 'Small icons'],
    ['list', 'List'], ['details', 'Details'], ['tiles', 'Tiles'], ['content', 'Content'],
  ]
  const rulesBox = el('div', 'opt-rules')
  smart.appendChild(rulesBox)
  for (const [kind, label] of KINDS) {
    const row = el('div', 'opt-inline')
    row.appendChild(el('span', 'opt-rule-label', label))
    const rule = () => app.settings.smartViewRules?.[kind] ?? DEFAULT_SMART_RULES[kind]
    dropdown(row, MODES, rule().mode, v => {
      void app.setSettings({
        smartViewRules: { ...app.settings.smartViewRules, [kind]: { ...rule(), mode: v as ViewMode } },
      })
    })
    check(row, 'with preview pane', !!rule().preview, v => {
      void app.setSettings({
        smartViewRules: { ...app.settings.smartViewRules, [kind]: { ...rule(), preview: v } },
      })
    })
    rulesBox.appendChild(row)
  }
  function paintSmart(): void {
    const on = app.settings.smartView
    thresholdRow.classList.toggle('is-off', !on)
    rulesBox.classList.toggle('is-off', !on)
  }
  paintSmart()

  // ---- floating media viewer ----
  // Off per kind rather than one switch: people want pictures and video in the
  // viewer but usually still want their editor for a .ts or a .conf.
  const media = group(root, 'Media viewer')
  check(media, 'Double-click opens media in a floating viewer', s.mediaViewer !== false,
    v => { void app.setSettings({ mediaViewer: v }); paintMedia() },
    'A translucent player that floats over the file list — you can keep clicking around behind it')
  const kindsRow = el('div', 'opt-inline')
  kindsRow.appendChild(el('span', 'opt-rule-label', 'Use it for'))
  const KIND_LABELS: [MediaViewerKind, string][] = [
    ['image', 'Pictures'], ['video', 'Video'], ['audio', 'Music'], ['pdf', 'PDF'], ['text', 'Text'],
  ]
  for (const [kind, label] of KIND_LABELS) {
    check(kindsRow, label, (app.settings.mediaViewerKinds ?? []).includes(kind), v => {
      const next = new Set<MediaViewerKind>(app.settings.mediaViewerKinds ?? [])
      if (v) next.add(kind); else next.delete(kind)
      void app.setSettings({ mediaViewerKinds: [...next] })
    })
  }
  media.appendChild(kindsRow)
  const kindsHint = el('div', 'opt-hint',
    'Anything the app cannot decode directly is converted as it plays, so all of '
    + 'these open here by default. Untick one to hand it back to its own '
    + 'application \u2014 right-click \u2192 "Open with" still works either way.')
  media.appendChild(kindsHint)

  const wheelRow = el('div', 'opt-inline')
  check(wheelRow, 'Mouse wheel moves between photos', s.mediaViewerWheelNav !== false,
    v => { void app.setSettings({ mediaViewerWheelNav: v }) },
    'Ctrl+wheel always zooms, and a zoomed-in picture keeps the wheel for zoom')
  check(wheelRow, 'Reverse wheel direction', !!s.mediaViewerWheelInvert,
    v => { void app.setSettings({ mediaViewerWheelInvert: v }) })
  media.appendChild(wheelRow)

  const autoRow = el('div', 'opt-inline')
  check(autoRow, 'Start playing straight away', s.mediaViewerAutoplay !== false,
    v => { void app.setSettings({ mediaViewerAutoplay: v }) })
  check(autoRow, 'Frosted translucent panel', s.mediaViewerTranslucent !== false,
    v => { void app.setSettings({ mediaViewerTranslucent: v }) },
    'Turn off if the blur feels sluggish — this machine has no GPU acceleration')
  media.appendChild(autoRow)

  // Formats Chromium cannot decode (MPEG-2 DVD rips, HEVC, AC3 soundtracks,
  // anything in an AVI/WMV/FLV) always play by streaming through ffmpeg. This
  // switch only governs whether a CONVERTED COPY is also kept, which is purely
  // a seeking-speed-for-disk trade — hence the size on the button.
  const cacheRow = el('div', 'opt-inline')
  check(cacheRow, 'Keep converted copies for instant seeking', s.mediaTranscodeCache !== false,
    v => { void app.setSettings({ mediaTranscodeCache: v }) },
    'Videos this app cannot play directly are converted in the background after '
    + 'the first viewing. Seeking then takes about 70 ms instead of 400 ms. '
    + 'Capped at 20 GB; files over 4 GB are never converted.')
  media.appendChild(cacheRow)

  const cacheBtnRow = el('div', 'opt-inline')
  const clearBtn = el('button', 'btn opt-btn', 'Clear converted videos')
  const cacheSize = el('span', 'opt-hint', '')
  const paintCacheSize = (): void => {
    void liq.invoke('mediaCacheSize').then((n: number) => {
      cacheSize.textContent = n > 0 ? `Using ${formatSize(n)}` : 'Nothing cached'
      clearBtn.disabled = !n
    }).catch(() => { cacheSize.textContent = '' })
  }
  clearBtn.addEventListener('click', () => {
    clearBtn.disabled = true
    void liq.invoke('mediaCacheClear').then(() => paintCacheSize()).catch(() => paintCacheSize())
  })
  cacheBtnRow.append(clearBtn, cacheSize)
  media.appendChild(cacheBtnRow)
  paintCacheSize()

  function paintMedia(): void {
    const on = app.settings.mediaViewer !== false
    kindsRow.classList.toggle('is-off', !on)
    kindsHint.classList.toggle('is-off', !on)
    wheelRow.classList.toggle('is-off', !on)
    autoRow.classList.toggle('is-off', !on)
    cacheRow.classList.toggle('is-off', !on)
    cacheBtnRow.classList.toggle('is-off', !on)
  }
  paintMedia()

  // ---- peek popover ----
  // Space is deliberately NOT switchable: it is the shortcut, and a shortcut
  // that can vanish is worse than one you never learn. Only the hover half,
  // which is the half that can get in the way, has a switch.
  const peek = group(root, 'Peek inside items')
  check(peek, 'Show a preview when the pointer rests on an item', s.hoverPeek !== false,
    v => { void app.setSettings({ hoverPeek: v }); paintPeek() },
    'Press Space to peek at the focused item at any time, whether this is on or off')
  const peekRow = el('div', 'opt-inline')
  peekRow.appendChild(el('span', '', 'after'))
  dropdown(peekRow,
    [['800', '0.8 seconds'], ['1200', '1.2 seconds'], ['1400', '1.4 seconds'],
      ['2000', '2 seconds'], ['3000', '3 seconds']],
    String(s.peekDelayMs ?? PEEK.defaultDelayMs),
    v => { void app.setSettings({ peekDelayMs: Number(v) }) })
  peek.appendChild(peekRow)
  function paintPeek(): void {
    peekRow.classList.toggle('is-off', app.settings.hoverPeek === false)
  }
  paintPeek()

  const home = group(root, 'Home page')
  check(home, 'Show recent files', s.showRecent,
    v => { void app.setSettings({ showRecent: v }) })
  check(home, 'Show frequently used folders in Quick access', s.showFrequent,
    v => { void app.setSettings({ showFrequent: v }) })
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

  buildFileFinder(root, closed)

  void liq.invoke('getIndexStatus').then(paint).catch(() => paint(null))
  return liq.on(PUSH.indexStatus, (st2: IndexStatus) => paint(st2))
}

interface FfShareRow {
  share: string; root: string; localRoot: string | null; files: number; ageHours?: number
}
interface FfHealth {
  enabled: boolean; url: string; status: unknown | null; shares: FfShareRow[]
}

function ageText(hours?: number): string {
  if (hours === undefined) return 'age unknown'
  if (hours < 1) return 'updated just now'
  if (hours < 48) return `updated ${Math.round(hours)}h ago`
  return `updated ${Math.round(hours / 24)}d ago`
}

/**
 * FileFinder — an index served by another machine. Separate group from the local
 * index because they are different things solving the same problem: this one
 * needs no scan here at all, but only helps someone who runs the server.
 */
function buildFileFinder(root: HTMLElement, closed: () => boolean): void {
  const s = app.settings
  const g = group(root, 'Server index (FileFinder)')
  g.appendChild(el('div', 'opt-note',
    'Answers name searches on network shares from an index kept by a server, instead of '
    + 'walking the share over SMB. Only affects folders the server actually indexes; '
    + 'everything else is unchanged.'))

  const statusLine = el('div', 'opt-status', '')
  const sharesLine = el('div', 'opt-note', '')

  const enable = check(g, 'Use a FileFinder server for searches on network shares', s.filefinderEnabled,
    v => { void app.setSettings({ filefinderEnabled: v }).then(() => refresh(true)) })

  const urlRow = el('div', 'opt-row')
  urlRow.appendChild(el('span', 'opt-inline-label', 'Server:'))
  const url = el('input', 'opt-input') as HTMLInputElement
  url.type = 'text'
  url.placeholder = 'http://host:8090'
  url.value = s.filefinderUrl
  url.addEventListener('change', () => {
    void app.setSettings({ filefinderUrl: url.value.trim() }).then(() => refresh(true))
  })
  urlRow.appendChild(url)
  g.appendChild(urlRow)
  g.append(statusLine, sharesLine)

  const actions = el('div', 'opt-row opt-actions')
  const test = el('button', 'btn btn-small', 'Test connection')
  test.addEventListener('click', () => { void refresh(true) })
  actions.append(test)
  g.appendChild(actions)

  async function refresh(force: boolean): Promise<void> {
    if (closed()) return
    enable.checked = app.settings.filefinderEnabled
    if (!app.settings.filefinderEnabled) {
      statusLine.textContent = 'Off — searches use the local index or a live walk.'
      statusLine.classList.remove('err')
      sharesLine.textContent = ''
      return
    }
    statusLine.textContent = 'Checking…'
    let h: FfHealth | null = null
    try { h = await liq.invoke(force ? 'ffReset' : 'ffHealth', true) as FfHealth } catch { h = null }
    if (closed()) return
    if (!h || !h.status) {
      statusLine.textContent = `Cannot reach ${app.settings.filefinderUrl} — searches fall back to a live walk.`
      statusLine.classList.add('err')
      sharesLine.textContent = ''
      return
    }
    statusLine.classList.remove('err')
    const total = h.shares.reduce((n, sh) => n + (sh.files || 0), 0)
    statusLine.textContent = `Connected — ${total.toLocaleString()} files indexed across ${h.shares.length} share(s).`
    // A share the server indexes but this machine has not mounted cannot be
    // used: its results would name local paths that do not exist.
    sharesLine.textContent = h.shares.length
      ? h.shares.map(sh => sh.localRoot
        ? `${sh.share} → ${sh.localRoot} (${ageText(sh.ageHours)})`
        : `${sh.share} → not mounted here, skipped`).join(' · ')
      : ''
  }

  void refresh(false)
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
