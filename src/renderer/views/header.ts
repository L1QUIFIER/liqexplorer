// Details-view sticky column header: sort toggle with glyph, drag-reorder
// (Name pinned first), divider drag-resize (min 60, persisted), double-click
// fit-to-visible-content, right-click column checklist, master checkbox in
// item-check-boxes mode.
import { showMenu } from '../menus/menu'
import type { MenuItem } from '../menus/menu-types'
import type { ColumnSpec, SortKey, FileEntry } from '../../shared/types'
import type { Tab } from '../core/app'
import { COLUMN_LABELS, cellText, type DetailCol } from './items'
import { sortKeysFor } from '../../shared/sort'

export const HEADER_H = 32
const PAD_LEFT = 12
const MIN_W = 60
const MAX_FIT_W = 600
const SEARCH_COL_W = 240

/** Name pinned first, exactly once. */
export function normalizedColumns(cols: ColumnSpec[]): ColumnSpec[] {
  const name = cols.find(c => c.key === 'name') ?? { key: 'name' as SortKey, width: 300 }
  return [name, ...cols.filter(c => c.key !== 'name')]
}

export function detailsTotalWidth(cols: DetailCol[]): number {
  let w = PAD_LEFT + 8
  for (const c of cols) w += c.width
  return w
}

const DEFAULT_W: Partial<Record<SortKey, number>> = {
  name: 300, mtime: 160, ctime: 160, atime: 160, type: 140, size: 100, ext: 90,
  origPath: 260, deletedAt: 160,
}

export interface HeaderHost {
  tab(): Tab | null
  checkboxes(): boolean
  searchMode(): boolean
  showExt(): boolean
  /** currently painted entries (fit-to-visible-content measures these) */
  sampleEntries(): FileEntry[]
  /** live re-layout during a divider drag (no persistence) */
  layoutChanged(): void
}

export interface DetailsHeader {
  el: HTMLElement
  refresh(): void
  syncCheck(): void
}

export function createDetailsHeader(host: HeaderHost): DetailsHeader {
  const el = document.createElement('div')
  el.className = 'vh-header'
  el.hidden = true

  let meas: CanvasRenderingContext2D | null = null
  function measure(text: string, small: boolean): number {
    if (!meas) meas = document.createElement('canvas').getContext('2d')
    if (!meas) return text.length * 8
    const cs = getComputedStyle(document.body)
    meas.font = `${small ? '12px' : cs.fontSize} ${cs.fontFamily}`
    return meas.measureText(text).width
  }

  function fitColumns(keys: SortKey[]): void {
    const t = host.tab()
    if (!t) return
    const entries = host.sampleEntries()
    const cols = normalizedColumns(t.viewState.columns).map(c => ({ ...c }))
    for (const key of keys) {
      const col = cols.find(c => c.key === key)
      if (!col) continue
      let w = measure(COLUMN_LABELS[key] ?? key, true) + 28
      const extra = key === 'name' ? 44 + (host.checkboxes() ? 24 : 0) : 20
      for (const e of entries) {
        w = Math.max(w, measure(cellText(e, key, host.showExt()), key !== 'name') + extra)
      }
      col.width = Math.max(MIN_W, Math.min(MAX_FIT_W, Math.ceil(w)))
    }
    t.setViewState({ columns: cols })
  }

  function refresh(): void {
    const t = host.tab()
    if (!t) return
    const vs = t.viewState
    const cols = normalizedColumns(vs.columns)
    el.innerHTML = ''
    let total = PAD_LEFT + 8
    cols.forEach((c, ci) => {
      const cell = document.createElement('div')
      cell.className = 'vh-hcell'
      cell.dataset.key = c.key
      cell.style.width = c.width + 'px'
      total += c.width
      if (ci === 0 && host.checkboxes()) {
        const mc = document.createElement('span')
        mc.className = 'vh-check vh-master'
        cell.appendChild(mc)
      }
      if (vs.sortKey === c.key) {
        const g = document.createElement('span')
        g.className = 'vh-hsort'
        g.textContent = vs.sortDir === 'asc' ? '▲' : '▼'
        cell.appendChild(g)
      }
      const lb = document.createElement('span')
      lb.className = 'vh-htext'
      lb.textContent = COLUMN_LABELS[c.key] ?? c.key
      cell.appendChild(lb)
      const dv = document.createElement('div')
      dv.className = 'vh-hdiv'
      dv.dataset.key = c.key
      cell.appendChild(dv)
      el.appendChild(cell)
      if (ci === 0 && host.searchMode()) {
        const sc = document.createElement('div')
        sc.className = 'vh-hcell vh-hsyn'
        sc.style.width = SEARCH_COL_W + 'px'
        sc.innerHTML = '<span class="vh-htext">Folder path</span>'
        el.appendChild(sc)
        total += SEARCH_COL_W
      }
    })
    el.style.width = total + 'px'
    syncCheck()
  }

  function syncCheck(): void {
    const t = host.tab()
    const mc = el.querySelector('.vh-master')
    if (!t || !mc) return
    mc.classList.toggle('checked', t.rows.length > 0 && t.selection.size === t.rows.length)
  }

  function startResize(key: SortKey, e0: MouseEvent): void {
    const t = host.tab()
    if (!t) return
    const cols = normalizedColumns(t.viewState.columns)
    const col = cols.find(c => c.key === key)
    if (!col) return
    const startW = col.width
    // keep the resize cursor while the pointer drifts off the 8px divider
    document.body.classList.add('is-colresizing')
    let raf = 0
    const move = (ev: MouseEvent) => {
      col.width = Math.max(MIN_W, startW + (ev.clientX - e0.clientX))
      const cell = el.querySelector(`.vh-hcell[data-key="${key}"]`) as HTMLElement | null
      if (cell) cell.style.width = col.width + 'px'
      if (!raf) raf = requestAnimationFrame(() => { raf = 0; host.layoutChanged() })
    }
    const up = () => {
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
      document.body.classList.remove('is-colresizing')
      t.setViewState({ columns: cols.map(c => ({ ...c })) })
    }
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
  }

  function trackCellPress(key: SortKey, e0: MouseEvent): void {
    const t = host.tab()
    if (!t) return
    let dragging = false
    let ghost: HTMLElement | null = null
    let marker: HTMLElement | null = null
    let insertAt = -1
    const cells = () => Array.from(el.querySelectorAll<HTMLElement>('.vh-hcell:not(.vh-hsyn)'))
    const move = (ev: MouseEvent) => {
      if (!dragging) {
        if (key === 'name') return
        if (Math.abs(ev.clientX - e0.clientX) < 5) return
        dragging = true
        ghost = document.createElement('div')
        ghost.className = 'vh-hghost'
        ghost.textContent = COLUMN_LABELS[key] ?? key
        document.body.appendChild(ghost)
        marker = document.createElement('div')
        marker.className = 'vh-hins'
        el.appendChild(marker)
      }
      ghost!.style.left = ev.clientX + 10 + 'px'
      ghost!.style.top = ev.clientY + 10 + 'px'
      const cs = cells()
      insertAt = cs.length
      for (let i = 1; i < cs.length; i++) {
        const r = cs[i].getBoundingClientRect()
        if (ev.clientX < r.left + r.width / 2) { insertAt = i; break }
      }
      const anchor = cs[Math.min(insertAt, cs.length - 1)]
      const x = insertAt >= cs.length ? anchor.offsetLeft + anchor.offsetWidth : anchor.offsetLeft
      marker!.style.left = x + 'px'
    }
    const up = () => {
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
      ghost?.remove()
      marker?.remove()
      if (!dragging) {
        // plain click = sort toggle
        const vs = t.viewState
        t.setViewState(vs.sortKey === key
          ? { sortDir: vs.sortDir === 'asc' ? 'desc' : 'asc' }
          : { sortKey: key, sortDir: 'asc' })
        return
      }
      if (insertAt < 1) return
      const cols = normalizedColumns(t.viewState.columns).map(c => ({ ...c }))
      const from = cols.findIndex(c => c.key === key)
      if (from < 0) return
      const [c] = cols.splice(from, 1)
      let at = insertAt
      if (from < at) at--
      at = Math.max(1, Math.min(cols.length, at))
      cols.splice(at, 0, c)
      t.setViewState({ columns: cols })
    }
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
  }

  el.addEventListener('mousedown', (e) => {
    e.stopPropagation() // keep the view's selection/rubber-band handlers out
    if (e.button !== 0) return
    const t = host.tab()
    if (!t) return
    const target = e.target as HTMLElement
    if (target.closest('.vh-master')) {
      if (t.rows.length && t.selection.size === t.rows.length) t.selectNone()
      else t.selectAll()
      return
    }
    const div = target.closest('.vh-hdiv') as HTMLElement | null
    if (div) { startResize(div.dataset.key as SortKey, e); return }
    const cell = target.closest('.vh-hcell') as HTMLElement | null
    if (!cell || cell.classList.contains('vh-hsyn')) return
    trackCellPress(cell.dataset.key as SortKey, e)
  })

  el.addEventListener('dblclick', (e) => {
    e.stopPropagation()
    const div = (e.target as HTMLElement).closest('.vh-hdiv') as HTMLElement | null
    if (div) fitColumns([div.dataset.key as SortKey])
  })

  el.addEventListener('contextmenu', (e) => {
    e.preventDefault()
    e.stopPropagation()
    const t = host.tab()
    if (!t) return
    const cols = normalizedColumns(t.viewState.columns)
    const items: MenuItem[] = sortKeysFor(t.path).map(({ key: k }) => ({
      label: COLUMN_LABELS[k] ?? k,
      checked: cols.some(c => c.key === k),
      disabled: k === 'name',
      onClick: () => {
        const has = cols.some(c => c.key === k)
        const next = has
          ? cols.filter(c => c.key !== k)
          : [...cols, { key: k, width: DEFAULT_W[k] ?? 120 }]
        t.setViewState({ columns: normalizedColumns(next).map(c => ({ ...c })) })
      },
    }))
    items.push(
      { separator: true },
      { label: 'Size all columns to fit', onClick: () => fitColumns(cols.map(c => c.key)) },
    )
    showMenu(items, { x: e.clientX, y: e.clientY })
  })

  return { el, refresh, syncCheck }
}
