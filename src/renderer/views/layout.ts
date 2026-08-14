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
    case 'extra-large': return { kind: 'grid', rowH: 0, itemW: 280, itemH: 300, icon: 256 }
    case 'large': return { kind: 'grid', rowH: 0, itemW: 120, itemH: 140, icon: 96 }
    case 'medium': return { kind: 'grid', rowH: 0, itemW: 80, itemH: 100, icon: 48 }
    case 'tiles': return { kind: 'grid', rowH: 0, itemW: 260, itemH: 64, icon: 48 }
    case 'small': return { kind: 'rows', rowH: 26, itemW: 0, itemH: 0, icon: 16 }
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

  let y = PAD_TOP
  let navRow = -1

  const layoutRun = (entries: FileEntry[]): void => {
    if (m.kind === 'rows') {
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

  if (a.vs.groupKey !== 'none' && a.groups.length) {
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
    totalH: y + 8, totalW: rowW, cols, metrics: m,
  }
}
