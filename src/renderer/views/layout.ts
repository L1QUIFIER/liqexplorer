// Pure layout math for the virtualized item views.
// Given the tab's sorted rows + groups + view mode + viewport width, produces a
// flat list of absolutely-positioned layout items (group headers + entries),
// monotonically increasing in `top` so the paint pass can binary-search the
// visible range. Collapsed groups' entries are skipped entirely.
import type { FileEntry, FolderViewState, ViewMode } from '../../shared/types'
import type { Group } from '../../shared/sort'

/** Ctrl+mouse-wheel zoom order (index 0 = most zoomed out). */
export const MODE_ORDER: ViewMode[] = [
  'content', 'tiles', 'details', 'list', 'small', 'medium', 'large', 'extra-large',
]

export const GROUP_H = 36
export const PAD_X = 12
export const PAD_TOP = 4

// ---------- 'list' column flow ----------
// Explorer's List view is the only mode that flows TOP TO BOTTOM: items fill the
// viewport height, then wrap into the next column, and the view scrolls
// HORIZONTALLY. Columns are as wide as the longest name (clamped).
const LIST_COL_MIN = 140
const LIST_COL_MAX = 400
/** row padding + icon + gap + trailing padding, from .vh-row/.vh-listrow */
const LIST_COL_CHROME = 12 + 16 + 6 + 12
const LIST_HSCROLL_H = 14
const LIST_BOTTOM_PAD = 8

let measureCtx: CanvasRenderingContext2D | null | undefined

/** widest of `names` in CSS pixels, in the view's own font */
function textWidth(names: string[]): number {
  if (measureCtx === undefined) {
    measureCtx = typeof document === 'undefined'
      ? null
      : document.createElement('canvas').getContext('2d')
    if (measureCtx && typeof getComputedStyle === 'function') {
      const cs = getComputedStyle(document.body)
      measureCtx.font = `${cs.fontSize} ${cs.fontFamily}`
    }
  }
  let max = 0
  for (const n of names) {
    max = Math.max(max, measureCtx ? measureCtx.measureText(n).width : n.length * 7)
  }
  return max
}

function listColumnWidth(rows: FileEntry[]): number {
  if (!rows.length) return LIST_COL_MIN
  // measuring every name would be one canvas call per row on a 10k folder; the
  // widest few by character count always contain the widest by pixels
  const longest: string[] = []
  for (const r of rows) {
    if (longest.length < 8) { longest.push(r.name); continue }
    let min = 0
    for (let i = 1; i < longest.length; i++) if (longest[i].length < longest[min].length) min = i
    if (r.name.length > longest[min].length) longest[min] = r.name
  }
  const w = Math.ceil(textWidth(longest)) + LIST_COL_CHROME
  return Math.max(LIST_COL_MIN, Math.min(LIST_COL_MAX, w))
}

/** offsetHeight, not clientHeight: it does not shrink when the horizontal
 *  scrollbar this very layout is about to create appears, so the column count
 *  cannot end up depending on the previous pass. */
function liveViewportH(): number {
  if (typeof document === 'undefined') return 600
  const el = document.querySelector('.vh-scroll') as HTMLElement | null
  return el?.offsetHeight || 600
}

function listRowsPerCol(viewH: number, rowH: number, count: number): number {
  const usable = viewH - PAD_TOP - LIST_BOTTOM_PAD
  const full = Math.max(1, Math.floor(usable / rowH))
  if (count <= full) return full
  // more than one column: leave room for the horizontal scrollbar so the last
  // row of every column stays visible
  return Math.max(1, Math.floor((usable - LIST_HSCROLL_H) / rowH))
}

export interface ModeMetrics {
  kind: 'rows' | 'grid'
  /** rows modes: fixed row height */
  rowH: number
  /** grid modes: cell size */
  itemW: number
  itemH: number
  /** base icon size for the mode */
  icon: number
}

export function metricsFor(mode: ViewMode, compact: boolean): ModeMetrics {
  switch (mode) {
    case 'extra-large': return { kind: 'grid', rowH: 0, itemW: 280, itemH: 308, icon: 256 }
    case 'large': return { kind: 'grid', rowH: 0, itemW: 120, itemH: 148, icon: 96 }
    case 'medium': return { kind: 'grid', rowH: 0, itemW: 80, itemH: 100, icon: 48 }
    case 'tiles': return { kind: 'grid', rowH: 0, itemW: 260, itemH: 64, icon: 48 }
    case 'small': return { kind: 'rows', rowH: 26, itemW: 0, itemH: 0, icon: 16 }
    // same row chrome as Small icons, but buildLayout flows it into columns
    case 'list': return { kind: 'rows', rowH: 26, itemW: 0, itemH: 0, icon: 16 }
    case 'content': return { kind: 'rows', rowH: 44, itemW: 0, itemH: 0, icon: 32 }
    case 'details':
    default: return { kind: 'rows', rowH: compact ? 24 : 34, itemW: 0, itemH: 0, icon: 16 }
  }
}

export interface LayoutItem {
  kind: 'entry' | 'header'
  top: number
  left: number
  width: number
  height: number
  entry?: FileEntry
  group?: Group
  collapsed?: boolean
  /** entries: index into Layout.visible */
  vIndex?: number
}

export interface Layout {
  items: LayoutItem[]
  /** non-collapsed entries in visual order */
  visible: FileEntry[]
  /** layout item index per visible entry */
  itemOfVisible: number[]
  /** visual rows of visible-entry indices (keyboard grid navigation) */
  navRows: number[][]
  /** row/col of each visible entry */
  posOf: { row: number; col: number }[]
  /** entry path -> layout item index */
  byPath: Map<string, number>
  totalH: number
  totalW: number
  cols: number
  metrics: ModeMetrics
}

export interface BuildArgs {
  rows: FileEntry[]
  groups: Group[]
  collapsed: Set<string>
  vs: FolderViewState
  viewportW: number
  compact: boolean
  /** details mode: total width of all columns (canvas min-width) */
  detailsTotalW?: number
  /** 'list' mode: viewport height its columns are filled to. Read off the live
   *  scroller when the caller does not supply it. */
  viewportH?: number
}

export function buildLayout(a: BuildArgs): Layout {
  const m = metricsFor(a.vs.mode, a.compact)
  const items: LayoutItem[] = []
  const visible: FileEntry[] = []
  const itemOfVisible: number[] = []
  const navRows: number[][] = []
  const posOf: { row: number; col: number }[] = []
  const byPath = new Map<string, number>()
  const gridW = Math.max(60, a.viewportW - PAD_X * 2)
  const cols = m.kind === 'grid' ? Math.max(1, Math.floor(gridW / m.itemW)) : 1
  const rowW = a.vs.mode === 'details'
    ? Math.max(a.detailsTotalW ?? a.viewportW, a.viewportW)
    : a.viewportW

  const isList = a.vs.mode === 'list'
  const listColW = isList ? listColumnWidth(a.rows) : 0
  const listRPC = isList
    ? listRowsPerCol(a.viewportH ?? liveViewportH(), m.rowH, a.rows.length)
    : 1
  let listCols = 0

  let y = PAD_TOP
  let navRow = -1

  /**
   * Column flow for 'list'. The items array is emitted ROW-major even though
   * the visual/selection order is column-major, because view-host binary
   * searches this array by `top` (for the paint window and for rubber-band hit
   * testing) and that requires `top` to keep increasing. The vIndex /
   * itemOfVisible / navRows indirections carry the real flow order, so Shift
   * ranges and type-ahead still run top-to-bottom-then-next-column.
   */
  const layoutListRun = (entries: FileEntry[]): void => {
    const n = entries.length
    if (!n) return
    const usedRows = Math.min(listRPC, n)
    const nCols = Math.ceil(n / listRPC)
    listCols = Math.max(listCols, nCols)
    const base = visible.length
    for (const e of entries) visible.push(e)
    const navBase = navRows.length
    for (let r = 0; r < usedRows; r++) navRows.push([])
    for (let r = 0; r < usedRows; r++) {
      for (let c = 0; c < nCols; c++) {
        const k = c * listRPC + r
        if (k >= n) continue                 // short last column
        const v = base + k
        const li = items.length
        items.push({
          kind: 'entry',
          top: y + r * m.rowH,
          left: PAD_X + c * listColW,
          width: listColW,
          height: m.rowH,
          entry: entries[k],
          vIndex: v,
        })
        byPath.set(entries[k].path, li)
        itemOfVisible[v] = li
        posOf[v] = { row: navBase + r, col: c }
        navRows[navBase + r].push(v)
      }
    }
    navRow = navRows.length - 1
    y += usedRows * m.rowH
  }

  const layoutRun = (entries: FileEntry[]): void => {
    if (isList) {
      layoutListRun(entries)
    } else if (m.kind === 'rows') {
      for (const e of entries) {
        const li = items.length
        items.push({ kind: 'entry', top: y, left: 0, width: rowW, height: m.rowH, entry: e, vIndex: visible.length })
        byPath.set(e.path, li)
        navRow++
        navRows.push([visible.length])
        posOf.push({ row: navRow, col: 0 })
        itemOfVisible.push(li)
        visible.push(e)
        y += m.rowH
      }
    } else {
      const n = entries.length
      for (let i = 0; i < n; i++) {
        const col = i % cols
        if (col === 0) { navRow++; navRows.push([]) }
        const e = entries[i]
        const li = items.length
        items.push({
          kind: 'entry',
          top: y + Math.floor(i / cols) * m.itemH,
          left: PAD_X + col * m.itemW,
          width: m.itemW,
          height: m.itemH,
          entry: e,
          vIndex: visible.length,
        })
        byPath.set(e.path, li)
        navRows[navRow].push(visible.length)
        posOf.push({ row: navRow, col })
        itemOfVisible.push(li)
        visible.push(e)
      }
      y += Math.ceil(n / cols) * m.itemH
    }
  }

  // computer:// groups by its own sections whatever groupKey says (This PC is
  // always sectioned in Explorer), so the gate is "are there groups", not "did
  // the user ask for grouping"
  if (a.groups.length && (a.vs.groupKey !== 'none' || a.groups.some(g => g.label))) {
    for (const g of a.groups) {
      const isCollapsed = a.collapsed.has(g.label)
      items.push({ kind: 'header', top: y, left: 0, width: rowW, height: GROUP_H, group: g, collapsed: isCollapsed })
      y += GROUP_H
      if (isCollapsed) continue
      layoutRun(a.rows.slice(g.start, g.start + g.count))
    }
  } else {
    layoutRun(a.rows)
  }

  return {
    items, visible, itemOfVisible, navRows, posOf, byPath,
    totalH: y + LIST_BOTTOM_PAD,
    totalW: isList ? Math.max(rowW, PAD_X * 2 + listCols * listColW) : rowW,
    cols: isList ? Math.max(1, listCols) : cols,
    metrics: m,
  }
}
