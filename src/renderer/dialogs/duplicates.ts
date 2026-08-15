// "Find duplicate files…" — scan one or more folders, show every set of
// byte-identical files biggest-waste-first, let the user pick which copies to
// lose, and hand those to the ops engine.
//
// Opened with app.emit('show-duplicates', { root } | { roots }).
//
// THE SAFETY RULE, which is the whole point of a duplicate finder: a group can
// never have all of its files ticked. The last unticked file's checkbox is
// disabled, so "delete every copy of my only photo" is not a mistake the UI
// can be talked into — not by a quick selector, not by clicking fast.
//
// Nothing here touches the filesystem itself: Recycle Bin / Delete / Move all
// go through liq.startOp(), so they get the normal progress cards, conflict
// handling and Ctrl+Z, exactly like a drag-and-drop would.
import type {
  DupFile, DupGroup, DupPrefs, DupProgress, DupScanResult,
} from '../../shared/duplicates'
import { DEFAULT_DUP_PREFS, DUP_PUSH, totalDuplicates, totalWasted } from '../../shared/duplicates'
import { formatDate, formatSize } from '../../shared/sort'
import { app, liq } from '../core/app'
import { openModal, el, closeX, midEllipsize } from './dialogs'
import { showConfirm } from './confirm'

/** detail for app.emit('show-duplicates', …) */
export interface DuplicatesRequest {
  root?: string
  roots?: string[]
}

/** groups rendered per batch — a 5000-group result must not build 5000 blocks */
const PAGE = 100

const KEEP_MSG = 'Every group has to keep at least one file.'

/** extensions worth asking the thumbnailer about (mirrors views/items.ts) */
const THUMBABLE = new Set([
  'jpg', 'jpeg', 'png', 'gif', 'bmp', 'webp', 'tif', 'tiff', 'heic', 'heif', 'avif', 'ico', 'svg',
  'mp4', 'mkv', 'avi', 'mov', 'webm', 'wmv', 'm4v', 'mpg', 'mpeg', '3gp',
  'pdf',
])

const ICON_BY_EXT: Record<string, string> = {
  jpg: 'image-x-generic', jpeg: 'image-x-generic', png: 'image-x-generic',
  gif: 'image-x-generic', bmp: 'image-x-generic', webp: 'image-x-generic',
  tif: 'image-x-generic', tiff: 'image-x-generic', heic: 'image-x-generic',
  heif: 'image-x-generic', avif: 'image-x-generic', ico: 'image-x-generic',
  svg: 'image-x-generic',
  mp4: 'video-x-generic', mkv: 'video-x-generic', avi: 'video-x-generic',
  mov: 'video-x-generic', webm: 'video-x-generic', wmv: 'video-x-generic',
  m4v: 'video-x-generic', mpg: 'video-x-generic', mpeg: 'video-x-generic',
  '3gp': 'video-x-generic',
  mp3: 'audio-x-generic', flac: 'audio-x-generic', ogg: 'audio-x-generic',
  wav: 'audio-x-generic', m4a: 'audio-x-generic', aac: 'audio-x-generic',
  opus: 'audio-x-generic',
  pdf: 'application-pdf',
  zip: 'package-x-generic', rar: 'package-x-generic', '7z': 'package-x-generic',
  gz: 'package-x-generic', xz: 'package-x-generic', bz2: 'package-x-generic',
  tar: 'package-x-generic', deb: 'package-x-generic',
  txt: 'text-x-generic', md: 'text-x-generic', log: 'text-x-generic',
  csv: 'text-x-generic', json: 'text-x-generic', xml: 'text-x-generic',
  html: 'text-html', htm: 'text-html',
  ts: 'text-x-script', js: 'text-x-script', sh: 'text-x-script', py: 'text-x-script',
  doc: 'x-office-document', docx: 'x-office-document', odt: 'x-office-document',
  xls: 'x-office-spreadsheet', xlsx: 'x-office-spreadsheet', ods: 'x-office-spreadsheet',
  ppt: 'x-office-presentation', pptx: 'x-office-presentation', odp: 'x-office-presentation',
}

let openCount = 0

export function mountDuplicates(): void {
  app.on('show-duplicates', (req: DuplicatesRequest) => { void show(req ?? {}) })
}

// ---------------------------------------------------------------- model

interface Row {
  file: DupFile
  /** checked = "get rid of this copy" */
  checked: boolean
  node: HTMLDivElement | null
  box: HTMLInputElement | null
}

interface GroupUI {
  group: DupGroup
  rows: Row[]
  node: HTMLDivElement | null
}

// ---------------------------------------------------------------- dialog

async function show(req: DuplicatesRequest): Promise<void> {
  if (openCount) return                       // one finder at a time, like Options
  openCount++

  const wanted = (req.roots?.length ? req.roots : [req.root ?? app.activeTab?.path ?? app.homePath])
    .filter((p): p is string => !!p && !p.includes('://'))
  let roots: string[] = wanted.length ? [...new Set(wanted)] : [app.homePath]

  let prefs: DupPrefs = { ...DEFAULT_DUP_PREFS }
  try { prefs = { ...prefs, ...(await liq.invoke('getDupPrefs') as DupPrefs) } } catch { /* defaults */ }

  let scanId = 0
  let scanning = false
  /** the dialog is gone: a scan that reports in after this must be stopped */
  let dismissed = false
  let offPush: (() => void) | null = null

  const modal = openModal({
    width: 820,
    className: 'dlg-duplicates',
    onDismiss: () => close(),
  })
  const close = (): void => {
    dismissed = true
    if (scanning && scanId) void liq.invoke('cancelDupScan', scanId).catch(() => {})
    scanning = false
    offPush?.()
    offPush = null
    openCount = 0
    modal.close()
  }

  const titleRow = el('div', 'dlg-title')
  const titleText = el('span', 'dlg-title-text', 'Find duplicate files')
  titleRow.append(titleText, closeX(close))
  const body = el('div', 'dlg-body dup-body')
  const buttons = el('div', 'dlg-buttons')
  modal.dlg.append(titleRow, body, buttons)

  const reset = (): void => { body.textContent = ''; buttons.textContent = '' }

  // ------------------------------------------------------------ options page

  function showOptions(message?: string): void {
    reset()
    titleText.textContent = 'Find duplicate files'
    if (message) body.appendChild(el('div', 'dup-note', message))

    const where = section(body, 'Look in')
    const list = el('div', 'dup-roots')
    where.appendChild(list)
    const paintRoots = (): void => {
      list.textContent = ''
      for (const r of roots) {
        const row = el('div', 'dup-root-row')
        const text = el('span', 'dup-root-text', r)
        text.title = r
        row.appendChild(text)
        if (roots.length > 1) {
          const x = el('button', 'dup-root-x', '✕')
          x.title = `Remove ${r}`
          x.setAttribute('aria-label', `Remove ${r}`)
          x.addEventListener('click', () => { roots = roots.filter(p => p !== r); paintRoots() })
          row.appendChild(x)
        }
        list.appendChild(row)
      }
    }
    paintRoots()
    const addRow = el('div', 'dup-row')
    const addBtn = el('button', 'btn btn-small', 'Add folder…')
    addBtn.addEventListener('click', () => {
      void (async () => {
        const picked = await liq.invoke('pickFolder', roots[0]).catch(() => null) as string | null
        if (picked && !roots.includes(picked)) { roots = [...roots, picked]; paintRoots() }
      })()
    })
    addRow.append(addBtn, el('span', 'dup-hint',
      'Add a second folder to compare two places against each other.'))
    where.appendChild(addRow)

    const how = section(body, 'Look for')
    const subBox = checkbox(how, 'Include subfolders', prefs.subfolders,
      v => { prefs.subfolders = v })
    const hidBox = checkbox(how, 'Include hidden files', prefs.includeHidden,
      v => { prefs.includeHidden = v })
    const sizeRow = el('div', 'dup-row')
    sizeRow.appendChild(el('span', 'dup-inline-label', 'Ignore files smaller than'))
    const sizeInput = el('input', 'dup-input dup-num')
    sizeInput.type = 'number'
    sizeInput.min = '0'
    sizeInput.step = '1'
    const unit = el('select', 'dup-select')
    for (const [v, label] of [['1', 'bytes'], ['1024', 'KB'], ['1048576', 'MB']] as [string, string][]) {
      const o = document.createElement('option')
      o.value = v
      o.textContent = label
      unit.appendChild(o)
    }
    // show the stored byte count in the largest unit that divides it exactly
    const mul = prefs.minSize && prefs.minSize % 1048576 === 0 ? 1048576
      : prefs.minSize && prefs.minSize % 1024 === 0 ? 1024 : 1
    unit.value = String(mul)
    sizeInput.value = String(Math.round(prefs.minSize / mul))
    sizeRow.append(sizeInput, unit)
    how.appendChild(sizeRow)
    how.appendChild(el('div', 'dup-hint',
      'Files are matched by content, not by name: same size, then the first 64 KB, '
      + 'then the rest. Hard links to one file and symbolic links are never reported.'))

    const startBtn = el('button', 'btn btn-primary', 'Start')
    startBtn.addEventListener('click', () => {
      prefs = {
        subfolders: subBox.checked,
        includeHidden: hidBox.checked,
        minSize: Math.max(0, Math.round(Number(sizeInput.value) || 0) * Number(unit.value)),
      }
      void liq.invoke('setDupPrefs', prefs).catch(() => { /* prefs are a nicety */ })
      void startScan()
    })
    const cancelBtn = el('button', 'btn', 'Cancel')
    cancelBtn.addEventListener('click', close)
    buttons.append(startBtn, cancelBtn)
    startBtn.focus()
  }

  // ------------------------------------------------------------ scanning page

  async function startScan(): Promise<void> {
    reset()
    titleText.textContent = 'Find duplicate files'
    const status = el('div', 'dup-status', 'Starting…')
    const bar = el('div', 'dup-bar')
    const fill = el('div', 'dup-bar-fill')
    bar.appendChild(fill)
    const detail = el('div', 'dup-hint', '')
    const current = el('div', 'dup-current', '')
    body.append(status, bar, detail, current)

    // a scan can finish (or be cancelled) before startDupScan has even resolved,
    // so the id is applied through these two flags rather than assumed
    let wantCancel = false
    const cancelBtn = el('button', 'btn btn-primary', 'Cancel')
    cancelBtn.addEventListener('click', () => {
      cancelBtn.disabled = true
      cancelBtn.textContent = 'Cancelling…'
      wantCancel = true
      if (scanId) void liq.invoke('cancelDupScan', scanId).catch(() => {})
    })
    buttons.appendChild(cancelBtn)
    cancelBtn.focus()

    const paint = (p: DupProgress): void => {
      status.textContent = stageLine(p)
      const pct = p.stageTotal > 0 ? Math.min(100, Math.round(p.stageDone / p.stageTotal * 100)) : 0
      bar.classList.toggle('indeterminate', p.stageTotal <= 0)
      fill.style.width = pct + '%'
      detail.textContent = p.stage === 'walking'
        ? `${p.dirsSeen.toLocaleString('en-US')} folders · ${p.filesSeen.toLocaleString('en-US')} files`
        : `${p.candidates.toLocaleString('en-US')} possible duplicates · `
          + `${formatSize(p.bytesHashed)} read`
      current.textContent = p.current ? midEllipsize(p.current, 90) : ''
      current.title = p.current
    }

    // subscribe BEFORE starting, so the first push cannot be missed
    scanning = true
    offPush = liq.on(DUP_PUSH, (p: DupProgress) => {
      if (scanId && p.scanId !== scanId) return       // another window's scan
      if (!scanning) return
      if (p.done && p.result) {
        scanning = false
        offPush?.()
        offPush = null
        showResults(p.result)
        return
      }
      paint(p)
    })

    try {
      const id = await liq.invoke('startDupScan', {
        roots,
        subfolders: prefs.subfolders,
        minSize: prefs.minSize,
        includeHidden: prefs.includeHidden,
      }) as number
      // closed or cancelled while the call was in flight: stop the scan now
      // rather than leave it reading a network share for nobody
      if (dismissed || wantCancel) { void liq.invoke('cancelDupScan', id).catch(() => {}); return }
      if (!scanning) return                           // already finished
      scanId = id
    } catch (e) {
      scanning = false
      offPush?.()
      offPush = null
      showOptions(`The scan could not be started: ${String((e as Error)?.message ?? e)}`)
    }
  }

  // ------------------------------------------------------------ results page

  function showResults(res: DupScanResult): void {
    reset()
    scanId = 0
    const gus: GroupUI[] = res.groups.map(g => ({
      group: g,
      rows: g.files.map(f => ({ file: f, checked: false, node: null, box: null })),
      node: null,
    }))
    const dupFiles = totalDuplicates(res.groups)
    const wasted = totalWasted(res.groups)
    titleText.textContent = res.cancelled ? 'Duplicate files (scan cancelled)' : 'Duplicate files'

    if (!gus.length) {
      body.appendChild(el('div', 'dup-status', res.cancelled
        ? 'The scan was cancelled before it finished.'
        : 'No duplicate files were found.'))
      body.appendChild(footnotes(res))
      const againBtn = el('button', 'btn', 'Scan again')
      againBtn.addEventListener('click', () => showOptions())
      const closeBtn = el('button', 'btn btn-primary', 'Close')
      closeBtn.addEventListener('click', close)
      buttons.append(closeBtn, againBtn)
      closeBtn.focus()
      return
    }

    const summary = el('div', 'dup-summary', '')
    body.appendChild(summary)
    body.appendChild(el('div', 'dup-hint',
      'Tick the copies you want to get rid of. The unticked file in each group is the one '
      + 'that stays — a group can never have all of its files ticked.'))

    // -- quick selectors. Each one picks ONE keeper per group and ticks the
    //    rest, so they can never produce an all-ticked group.
    const tools = el('div', 'dup-tools')
    const toolBtn = (label: string, title: string, fn: () => void): void => {
      const b = el('button', 'btn btn-small', label)
      b.title = title
      b.addEventListener('click', () => { fn(); sync() })
      tools.appendChild(b)
    }
    toolBtn('Keep newest', 'Tick every copy except the most recently modified one',
      () => keepBy(gus, g => pickBy(g, (a, b) => b.file.mtime - a.file.mtime)))
    toolBtn('Keep oldest', 'Tick every copy except the oldest one — usually the original',
      () => keepBy(gus, g => pickBy(g, (a, b) => a.file.mtime - b.file.mtime)))
    // one per scanned folder: with two roots this is how you say "this is the
    // library, that is the dumping ground"
    for (const root of res.roots.slice(0, 3)) {
      toolBtn(`Keep in ${shortName(root)}`,
        `Keep the copy inside ${root} and tick copies anywhere else `
        + '(a group with no copy there keeps its newest file)',
        () => keepBy(gus, g => {
          const inRoot = g.rows.find(r => under(r.file.path, root))
          return inRoot ?? pickBy(g, (a, b) => b.file.mtime - a.file.mtime)
        }))
    }
    toolBtn('Select none', 'Clear every tick', () => {
      for (const g of gus) for (const r of g.rows) r.checked = false
    })
    body.appendChild(tools)

    const list = el('div', 'dup-list')
    body.appendChild(list)
    let shown = 0
    const more = el('button', 'btn btn-small dup-more', '')
    more.addEventListener('click', () => { renderMore(); sync() })

    function renderMore(): void {
      const end = Math.min(gus.length, shown + PAGE)
      for (; shown < end; shown++) list.appendChild(buildGroup(gus[shown]))
      more.textContent = `Show more (${(gus.length - shown).toLocaleString('en-US')} groups left)`
      more.hidden = shown >= gus.length
    }
    renderMore()
    body.append(more, footnotes(res))

    // -- actions
    const trashBtn = el('button', 'btn btn-primary', 'Move to Recycle Bin')
    trashBtn.title = 'Sends the ticked copies to the Recycle Bin — undoable with Ctrl+Z'
    const delBtn = el('button', 'btn btn-danger', 'Delete permanently')
    const moveBtn = el('button', 'btn', 'Move to folder…')
    const closeBtn = el('button', 'btn', 'Close')
    closeBtn.addEventListener('click', close)
    buttons.append(trashBtn, delBtn, moveBtn, el('div', 'dlg-buttons-spacer'), closeBtn)

    const selected = (): string[] => {
      const out: string[] = []
      for (const g of gus) for (const r of g.rows) if (r.checked) out.push(r.file.path)
      return out
    }

    trashBtn.addEventListener('click', () => {
      const sources = selected()
      if (!sources.length) return
      void liq.startOp({ kind: 'trash', sources })
      close()
    })
    delBtn.addEventListener('click', () => {
      const sources = selected()
      if (!sources.length) return
      showConfirm({
        title: 'Delete files permanently',
        message: `${sources.length === 1 ? 'This file' : `These ${sources.length} files`} will be `
          + 'deleted permanently, not moved to the Recycle Bin. This cannot be undone.',
        okLabel: 'Delete',
        danger: true,
        onOk: () => { void liq.startOp({ kind: 'delete', sources }); close() },
      })
    })
    moveBtn.addEventListener('click', () => {
      const sources = selected()
      if (!sources.length) return
      void (async () => {
        const dest = await liq.invoke('pickFolder', res.roots[0]).catch(() => null) as string | null
        if (!dest) return
        void liq.startOp({ kind: 'move', sources, dest })
        close()
      })()
    })

    function buildGroup(gu: GroupUI): HTMLDivElement {
      const node = el('div', 'dup-group')
      const head = el('div', 'dup-group-head')
      head.append(
        el('span', 'dup-group-waste', formatSize(gu.group.wasted) + ' recoverable'),
        el('span', 'dup-group-meta',
          `${gu.rows.length} identical files · ${formatSize(gu.group.size)} each`),
      )
      node.appendChild(head)
      for (const r of gu.rows) node.appendChild(buildRow(gu, r))
      gu.node = node
      return node
    }

    function buildRow(gu: GroupUI, r: Row): HTMLDivElement {
      const row = el('div', 'dup-file')
      const box = el('input', 'dup-check')
      box.type = 'checkbox'
      box.checked = r.checked
      box.addEventListener('change', () => {
        // the enforcement is the disabled state below; this is the belt to its
        // braces — a programmatic tick can never empty a group either
        if (box.checked && gu.rows.every(o => o === r || o.checked)) {
          box.checked = false
          return
        }
        r.checked = box.checked
        sync()
      })
      const thumb = thumbFor(r.file)
      const meta = el('div', 'dup-meta')
      const nameEl = el('div', 'dup-name', baseName(r.file.path))
      const dirEl = el('div', 'dup-path', midEllipsize(dirName(r.file.path), 96))
      dirEl.title = r.file.path
      meta.append(nameEl, dirEl)
      const side = el('div', 'dup-side')
      side.append(
        el('span', 'dup-size', formatSize(r.file.size)),
        el('span', 'dup-date', formatDate(r.file.mtime)),
      )
      row.append(box, thumb, meta, side)
      r.node = row
      r.box = box
      return row
    }

    function sync(): void {
      let selFiles = 0
      let selBytes = 0
      for (const gu of gus) {
        let unchecked = 0
        let lastUnchecked: Row | null = null
        for (const r of gu.rows) {
          if (r.checked) { selFiles++; selBytes += gu.group.size }
          else { unchecked++; lastUnchecked = r }
        }
        for (const r of gu.rows) {
          if (!r.box || !r.node) continue
          r.box.checked = r.checked
          // the sole survivor cannot be ticked: that is the safety rule, made
          // physical rather than explained in a warning nobody reads
          const locked = unchecked === 1 && r === lastUnchecked
          r.box.disabled = locked
          r.box.title = locked ? KEEP_MSG : ''
          r.node.classList.toggle('is-keeper', !r.checked)
          r.node.classList.toggle('is-locked', locked)
        }
        gu.node?.classList.toggle('is-armed', unchecked < gu.rows.length)
      }
      summary.textContent =
        `${gus.length.toLocaleString('en-US')} group${gus.length === 1 ? '' : 's'} · `
        + `${selFiles.toLocaleString('en-US')} of ${dupFiles.toLocaleString('en-US')} `
        + `duplicate files selected · ${formatSize(selBytes)} of ${formatSize(wasted)} recoverable`
      trashBtn.disabled = selFiles === 0
      delBtn.disabled = selFiles === 0
      moveBtn.disabled = selFiles === 0
    }

    sync()
    trashBtn.focus()
  }

  showOptions()
}

// ---------------------------------------------------------------- helpers

function section(parent: HTMLElement, heading: string): HTMLDivElement {
  const g = el('div', 'dup-section')
  g.appendChild(el('div', 'dup-heading', heading))
  parent.appendChild(g)
  return g
}

function checkbox(
  parent: HTMLElement, label: string, checked: boolean, onChange: (v: boolean) => void,
): HTMLInputElement {
  const wrap = el('label', 'dup-checkline')
  const box = el('input')
  box.type = 'checkbox'
  box.checked = checked
  box.addEventListener('change', () => onChange(box.checked))
  wrap.append(box, el('span', '', label))
  parent.appendChild(wrap)
  return box
}

/** tick everything in each group except the row `choose` returns */
function keepBy(gus: GroupUI[], choose: (g: GroupUI) => Row): void {
  for (const g of gus) {
    const keeper = choose(g) ?? g.rows[0]
    for (const r of g.rows) r.checked = r !== keeper
  }
}

function pickBy(g: GroupUI, cmp: (a: Row, b: Row) => number): Row {
  return [...g.rows].sort(cmp)[0]
}

function under(p: string, root: string): boolean {
  return p === root || p.startsWith(root === '/' ? '/' : root + '/')
}

function baseName(p: string): string {
  const i = p.lastIndexOf('/')
  return i < 0 ? p : p.slice(i + 1)
}

function dirName(p: string): string {
  const i = p.lastIndexOf('/')
  return i <= 0 ? '/' : p.slice(0, i)
}

function shortName(p: string): string {
  return baseName(p.replace(/\/+$/, '')) || p
}

function extOf(p: string): string {
  const base = baseName(p)
  const i = base.lastIndexOf('.')
  return i <= 0 ? '' : base.slice(i + 1).toLowerCase()
}

/**
 * A real thumbnail where it is cheap (images are what people actually have
 * duplicates of, and two files with the same name tell you nothing while two
 * identical previews tell you everything). Falls back to the type icon, then to
 * nothing at all if even that is missing.
 */
function thumbFor(f: DupFile): HTMLElement {
  const wrap = el('div', 'dup-thumb')
  const ext = extOf(f.path)
  const icon = `liqicon://${ICON_BY_EXT[ext] ?? 'application-x-generic'}?size=32`
  const img = document.createElement('img')
  img.draggable = false
  img.alt = ''
  img.width = 40
  img.height = 40
  if (THUMBABLE.has(ext)) {
    img.onerror = () => {
      img.onerror = () => { img.style.visibility = 'hidden' }
      img.src = icon
    }
    img.src = `liqthumb://?path=${encodeURIComponent(f.path)}&size=normal`
  } else {
    img.onerror = () => { img.style.visibility = 'hidden' }
    img.src = icon
  }
  wrap.appendChild(img)
  return wrap
}

function stageLine(p: DupProgress): string {
  const n = (v: number): string => v.toLocaleString('en-US')
  switch (p.stage) {
    case 'walking': return 'Looking through folders…'
    case 'grouping': return 'Comparing file sizes…'
    case 'head': return `Checking the first 64 KB — ${n(p.stageDone)} of ${n(p.stageTotal)} files`
    case 'full': return `Comparing file contents — ${n(p.stageDone)} of ${n(p.stageTotal)} files`
    case 'cancelled': return 'Cancelled.'
    default: return 'Finishing…'
  }
}

/** what the scan could not do, said plainly */
function footnotes(res: DupScanResult): HTMLDivElement {
  const box = el('div', 'dup-notes')
  const line = (t: string, cls = ''): void => {
    box.appendChild(el('div', 'dup-note-line' + (cls ? ' ' + cls : ''), t))
  }
  line(`Scanned ${res.filesScanned.toLocaleString('en-US')} files in `
    + `${(res.elapsedMs / 1000).toFixed(1)}s · read ${formatSize(res.bytesHashed)} to compare contents.`)
  if (res.remote) {
    line('One of these folders is on a network share, so every comparison had to be read '
      + 'over the network. Deleting there does not always use the Recycle Bin.')
  }
  if (res.hardLinks) {
    line(`${res.hardLinks} extra name${res.hardLinks === 1 ? '' : 's'} for a file that is already `
      + 'listed here were ignored — hard links share one copy on disk, so removing them frees nothing.')
  }
  if (res.truncated) {
    line('The scan hit its size limit, so this is only the first part of the results — '
      + 'scan a smaller folder, or raise the minimum file size, to see the rest.')
  }
  if (res.cancelled) line('The scan was cancelled, so some duplicates may be missing.')
  if (res.unreadable) {
    line(`${res.unreadable.toLocaleString('en-US')} item${res.unreadable === 1 ? '' : 's'} could not be read:`, 'err')
    for (const e of res.errors.slice(0, 5)) line(`${e.path}: ${e.error}`, 'err')
    if (res.errors.length > 5) line(`…and ${res.errors.length - 5} more.`, 'err')
  }
  return box
}
