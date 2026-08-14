// View host: virtualized Explorer item views (details / list / small icons /
// content / tiles / icon grids) with the full 3-state selection engine
// (anchor / focus / selection), grouping with collapsible headers, inline
// rename, type-ahead, rubber-band selection, drag & drop and context-menu
// hooks. All modes virtualize: outer scroll container + inner spacer of total
// height + absolutely-positioned recycled item elements (visible + overscan).
import { app, Tab } from '../core/app'
import { actions } from '../core/actions'
import { showMenu } from '../menus/menu'
import type { FileEntry } from '../../shared/types'
import type { Group } from '../../shared/sort'
import { MODE_ORDER, buildLayout, metricsFor, type Layout, type LayoutItem } from './layout'
import {
  renderEntry, renderGroupHeader, escapeHtml, COLUMN_LABELS,
  type RenderCtx, type DetailCol,
} from './items'
import { createDetailsHeader, HEADER_H, normalizedColumns, detailsTotalWidth } from './header'
import { Renamer } from './rename'
import { wireDnD } from './dnd'

const OVERSCAN = 10
const POOL_MAX = 120
const EDGE_BAND = 12

const SPINNER =
  '<svg class="vh-spinner" viewBox="0 0 48 48"><circle cx="24" cy="24" r="20"/></svg>'

export function mountViewHost(root: HTMLElement): void {
  root.innerHTML = ''
  root.classList.add('vh-root')

  const scroller = document.createElement('div')
  scroller.className = 'vh-scroll'
  scroller.tabIndex = 0
  const canvas = document.createElement('div')
  canvas.className = 'vh-canvas'
  const band = document.createElement('div')
  band.className = 'vh-band'
  band.hidden = true
  canvas.appendChild(band)
  const stateEl = document.createElement('div')
  stateEl.className = 'vh-state'
  stateEl.hidden = true
  root.appendChild(scroller)
  root.appendChild(stateEl)

  // ---------- state ----------
  let layout: Layout | null = null
  let ctx: RenderCtx = {
    mode: 'details', icon: 16, showExt: true, checkboxes: false, searchMode: false,
  }
  let detailCols: DetailCol[] = []
  const rendered = new Map<number, HTMLElement>()
  const pool: HTMLElement[] = []
  let paintQueued = false
  let lastPaintRange: [number, number] = [0, 0]
  const scrollPos = new Map<number, number>()
  /** last known path per tab id — distinguishes a real navigation from the
   * 'tab-navigated' that activateTab/closeTab emit for an unchanged path */
  const lastPath = new Map<number, string>()
  let pendingScroll: number | null = null
  let pendingReveal: string | null = null
  let rebuildQueued = false
  let lastRebuild = 0
  let cutSet = new Set<string>()
  let toastTimer = 0

  const tab = (): Tab | null => app.activeTab ?? null

  // ---------- details header ----------
  const header = createDetailsHeader({
    tab: () => tab(),
    checkboxes: () => app.settings.checkboxes,
    searchMode: () => (tab()?.searchQuery ?? null) !== null,
    showExt: () => app.settings.showExtensions,
    sampleEntries: () => {
      const L = layout
      if (!L) return []
      const out: FileEntry[] = []
      for (let i = lastPaintRange[0]; i < lastPaintRange[1]; i++) {
        const it = L.items[i]
        if (it && it.kind === 'entry') out.push(it.entry!)
      }
      return out
    },
    layoutChanged: () => rebuild(),
  })
  scroller.appendChild(header.el)
  scroller.appendChild(canvas)

  // ---------- rename ----------
  const renamer = new Renamer({
    canvas,
    entryFor: (p) => {
      const i = layout?.byPath.get(p)
      return i === undefined ? null : layout!.items[i].entry ?? null
    },
    labelRectFor: (p) => {
      const L = layout
      if (!L) return null
      const i = L.byPath.get(p)
      if (i === undefined) return null
      const el = rendered.get(i)
      const label = el?.querySelector('.vh-label') as HTMLElement | null
      if (label) {
        const cr = canvas.getBoundingClientRect()
        const lr = label.getBoundingClientRect()
        return { left: lr.left - cr.left, top: lr.top - cr.top, width: lr.width, height: lr.height }
      }
      const it = L.items[i]
      return { left: it.left + 8, top: it.top + 4, width: Math.min(200, it.width - 16), height: 20 }
    },
    neighborOf: (p, dir) => {
      const L = layout
      if (!L) return null
      const i = L.byPath.get(p)
      if (i === undefined) return null
      const v = (L.items[i].vIndex ?? -1) + dir
      if (v < 0 || v >= L.visible.length) return null
      return L.visible[v].path
    },
    gridMode: () => {
      const m = tab()?.viewState.mode
      return m === 'extra-large' || m === 'large' || m === 'medium'
    },
    itemWidth: () => (layout && layout.metrics.kind === 'grid' ? layout.metrics.itemW : 200),
    loading: () => tab()?.loading ?? false,
    onCommitted: (_oldPath, newPath, chained) => {
      const t = tab()
      if (!t) return
      if (!chained) pendingReveal = newPath
      void t.refresh()
    },
    toast: (msg) => showToast(msg),
  })

  function showToast(msg: string): void {
    let el = root.querySelector('.vh-toast') as HTMLElement | null
    if (!el) {
      el = document.createElement('div')
      el.className = 'vh-toast'
      root.appendChild(el)
    }
    el.textContent = msg
    if (toastTimer) clearTimeout(toastTimer)
    toastTimer = window.setTimeout(() => {
      root.querySelector('.vh-toast')?.remove()
      toastTimer = 0
    }, 2600)
  }

  // ---------- layout / paint ----------
  function computeCtx(t: Tab): void {
    const vs = t.viewState
    const m = metricsFor(vs.mode, app.settings.compactView)
    const searchMode = t.searchQuery !== null
    detailCols = []
    if (vs.mode === 'details') {
      const cols = normalizedColumns(vs.columns)
      detailCols = cols.map(c => ({
        key: c.key, width: c.width,
        label: COLUMN_LABELS[c.key] ?? c.key,
        right: c.key === 'size',
      }))
      if (searchMode) detailCols.splice(1, 0, { key: 'folderPath', width: 240, label: 'Folder path' })
    }
    ctx = {
      mode: vs.mode, icon: m.icon,
      showExt: app.settings.showExtensions,
      checkboxes: app.settings.checkboxes,
      searchMode,
      cols: detailCols,
    }
  }

  function rebuild(): void {
    const t = tab()
    if (!t) return
    computeCtx(t)
    const vs = t.viewState
    const isDetails = vs.mode === 'details'
    scroller.classList.toggle('vh-checkboxes', app.settings.checkboxes)
    header.el.hidden = !isDetails || !!t.error
    if (!header.el.hidden) header.refresh()
    const viewportW = scroller.clientWidth || root.clientWidth || 800
    layout = buildLayout({
      rows: t.rows,
      groups: t.groups,
      collapsed: t.collapsedGroups,
      vs,
      viewportW,
      compact: app.settings.compactView,
      detailsTotalW: isDetails ? detailsTotalWidth(detailCols) : undefined,
    })
    canvas.style.height = layout.totalH + 'px'
    canvas.style.width = isDetails ? layout.totalW + 'px' : ''
    for (const [, el] of rendered) recycle(el)
    rendered.clear()
    if (pendingScroll !== null) {
      scroller.scrollTop = pendingScroll
      pendingScroll = null
    }
    paint()
    renamer.reposition()
    updateState()
    if (pendingReveal && !t.loading) {
      const p = pendingReveal
      pendingReveal = null
      selectAndReveal(p)
    }
    if (pendingRename) {
      if (Date.now() > pendingRename.until) { pendingRename = null }
      else {
        const idx = layout.byPath.get(pendingRename.path)
        if (idx !== undefined) {
          const p = pendingRename.path
          pendingRename = null
          revealIndex(idx)
          renamer.begin(p)
        }
      }
    }
  }

  function scheduleRebuild(): void {
    if (rebuildQueued) return
    rebuildQueued = true
    const t = tab()
    const streaming = !!t && t.loading
    const since = performance.now() - lastRebuild
    const delay = streaming && since < 120 ? Math.max(0, 120 - since) : 0
    setTimeout(() => {
      rebuildQueued = false
      lastRebuild = performance.now()
      rebuild()
    }, delay)
  }

  function headerOffset(): number {
    return header.el.hidden ? 0 : HEADER_H
  }

  function paint(): void {
    const L = layout
    if (!L) return
    const hOff = headerOffset()
    const minY = scroller.scrollTop - hOff
    const maxY = minY + scroller.clientHeight
    let lo = 0
    let hi = L.items.length
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      const it = L.items[mid]
      if (it.top + it.height <= minY) lo = mid + 1
      else hi = mid
    }
    let end = lo
    while (end < L.items.length && L.items[end].top < maxY) end++
    const start = Math.max(0, lo - OVERSCAN)
    end = Math.min(L.items.length, end + OVERSCAN)
    lastPaintRange = [start, end]
    for (const [i, el] of [...rendered]) {
      if (i < start || i >= end) {
        rendered.delete(i)
        recycle(el)
      }
    }
    for (let i = start; i < end; i++) {
      if (!rendered.has(i)) rendered.set(i, materialize(i))
    }
  }

  function materialize(i: number): HTMLElement {
    const it = layout!.items[i]
    const el = pool.pop() ?? document.createElement('div')
    el.dataset.idx = String(i)
    el.style.cssText =
      `position:absolute;top:0;left:0;transform:translate(${it.left}px,${it.top}px);` +
      `width:${it.width}px;height:${it.height}px`
    if (it.kind === 'header') {
      el.draggable = false
      renderGroupHeader(el, it.group!, !!it.collapsed)
    } else {
      el.draggable = true
      renderEntry(el, it.entry!, ctx)
      applyItemState(el, it.entry!)
    }
    canvas.appendChild(el)
    return el
  }

  function recycle(el: HTMLElement): void {
    el.remove()
    if (pool.length < POOL_MAX) {
      el.className = ''
      el.innerHTML = ''
      pool.push(el)
    }
  }

  function applyItemState(el: HTMLElement, e: FileEntry): void {
    const t = tab()
    if (!t) return
    el.classList.toggle('selected', t.selection.has(e.path))
    el.classList.toggle('focused', t.focusPath === e.path)
    el.classList.toggle('cut', cutSet.has(e.path))
  }

  function syncSelection(): void {
    const L = layout
    if (!L) return
    for (const [i, el] of rendered) {
      const it = L.items[i]
      if (it.kind === 'entry') applyItemState(el, it.entry!)
    }
    header.syncCheck()
  }

  function updateCutSet(): void {
    const c = app.clipboard
    cutSet = c && c.op === 'cut' ? new Set(c.paths) : new Set()
  }

  function updateState(): void {
    const t = tab()
    if (!t) { stateEl.hidden = true; return }
    if (t.error) {
      const denied = /EACCES|denied|permission/i.test(t.error)
      stateEl.innerHTML = `<div class="vh-error">${denied
        ? "You don't currently have permission to access this folder."
        : escapeHtml(t.error)}</div>`
      stateEl.hidden = false
    } else if (t.loading && t.rows.length === 0) {
      stateEl.innerHTML = SPINNER
      stateEl.hidden = false
    } else if (!t.loading && t.rows.length === 0) {
      stateEl.innerHTML = `<div class="vh-empty">${t.searchQuery !== null
        ? 'No items match your search.'
        : 'This folder is empty.'}</div>`
      stateEl.hidden = false
    } else {
      stateEl.hidden = true
    }
  }

  // ---------- selection helpers ----------
  function visIndexOf(path: string | null): number {
    if (!path || !layout) return -1
    const idx = layout.byPath.get(path)
    if (idx === undefined) return -1
    return layout.items[idx].vIndex ?? -1
  }

  function rangePaths(a: number, b: number): string[] {
    const L = layout!
    const lo = Math.min(a, b)
    const hi = Math.max(a, b)
    const out: string[] = []
    for (let i = lo; i <= hi; i++) out.push(L.visible[i].path)
    return out
  }

  function revealIndex(idx: number): void {
    const L = layout
    if (!L) return
    const it = L.items[idx]
    const hOff = headerOffset()
    const contentTop = it.top + hOff
    if (it.top < scroller.scrollTop) {
      scroller.scrollTop = it.top
    } else if (contentTop + it.height > scroller.scrollTop + scroller.clientHeight) {
      scroller.scrollTop = contentTop + it.height - scroller.clientHeight
    }
    paint()
  }

  function selectAndReveal(path: string): void {
    const t = tab()
    const L = layout
    if (!t || !L) return
    const idx = L.byPath.get(path)
    if (idx === undefined) return
    t.anchorPath = path
    t.setSelection([path], path)
    revealIndex(idx)
  }

  /** move selection/focus to visible index i honoring Ctrl (focus-only) and Shift (extend) */
  function selectVis(i: number, mods: { ctrl?: boolean; shift?: boolean }): void {
    const t = tab()
    const L = layout
    if (!t || !L || i < 0 || i >= L.visible.length) return
    const path = L.visible[i].path
    if (mods.shift) {
      let aV = visIndexOf(t.anchorPath)
      if (aV < 0) { aV = i; t.anchorPath = path }
      const range = rangePaths(aV, i)
      t.setSelection(mods.ctrl ? new Set([...t.selection, ...range]) : range, path)
    } else if (mods.ctrl) {
      t.setSelection([...t.selection], path) // focus travels, selection untouched
    } else {
      t.anchorPath = path
      t.setSelection([path], path)
    }
    revealIndex(L.itemOfVisible[i])
  }

  // ---------- groups ----------
  function setCollapsed(label: string, collapsed: boolean): void {
    const t = tab()
    if (!t) return
    if (collapsed) t.collapsedGroups.add(label)
    else t.collapsedGroups.delete(label)
    rebuild()
  }

  function groupLabelOfItem(idx: number): string | null {
    const L = layout
    if (!L) return null
    for (let i = idx; i >= 0; i--) {
      const it = L.items[i]
      if (it.kind === 'header') return it.group!.label
    }
    return null
  }

  function groupHeaderMenu(g: Group, x: number, y: number): void {
    const t = tab()
    if (!t) return
    const collapsed = t.collapsedGroups.has(g.label)
    showMenu([
      {
        label: collapsed ? 'Expand group' : 'Collapse group',
        onClick: () => setCollapsed(g.label, !collapsed),
      },
      { separator: true },
      {
        label: 'Collapse all groups',
        onClick: () => { for (const gr of t.groups) t.collapsedGroups.add(gr.label); rebuild() },
      },
      {
        label: 'Expand all groups',
        onClick: () => { t.collapsedGroups.clear(); rebuild() },
      },
    ], { x, y })
  }

  // ---------- hit testing ----------
  function itemDataFromTarget(target: EventTarget | null): { el: HTMLElement; item: LayoutItem; idx: number } | null {
    const el = (target as HTMLElement | null)?.closest?.('[data-idx]') as HTMLElement | null
    if (!el || !layout) return null
    const idx = Number(el.dataset.idx)
    const item = layout.items[idx]
    if (!item) return null
    return { el, item, idx }
  }

  // ---------- slow-second-click rename ----------
  let renameTimer = 0
  let renameCandidate: string | null = null

  function scheduleSlowRename(path: string): void {
    cancelSlowRename()
    renameCandidate = path
    renameTimer = window.setTimeout(() => {
      if (renameCandidate === path) beginRename(path)
      renameCandidate = null
      renameTimer = 0
    }, 550)
  }

  function cancelSlowRename(): void {
    if (renameTimer) { clearTimeout(renameTimer); renameTimer = 0 }
    renameCandidate = null
  }

  let pendingRename: { path: string; until: number } | null = null

  function beginRename(path: string): void {
    const t = tab()
    if (!t || !layout) return
    const idx = layout.byPath.get(path)
    if (idx === undefined) {
      // just-created entry (New folder / template): the watcher hasn't listed it yet
      pendingRename = { path, until: Date.now() + 4000 }
      return
    }
    pendingRename = null
    revealIndex(idx)
    renamer.begin(path)
  }

  // ---------- rubber band ----------
  let bandActive = false
  let bandStart: { x: number; y: number } | null = null
  let bandBase = new Set<string>()
  let bandToggle = false // Ctrl+band XORs against bandBase (Explorer); Shift+band unions
  let bandLast: { x: number; y: number } | null = null
  let bandRAF = 0

  function canvasPointFromClient(cx: number, cy: number): { x: number; y: number } {
    const r = canvas.getBoundingClientRect()
    return { x: cx - r.left, y: cy - r.top }
  }

  function setsEqual(a: Set<string>, b: Set<string>): boolean {
    if (a.size !== b.size) return false
    for (const x of a) if (!b.has(x)) return false
    return true
  }

  function updateBandFromClient(cx: number, cy: number): void {
    const t = tab()
    const L = layout
    if (!t || !L || !bandStart) return
    const p = canvasPointFromClient(cx, cy)
    const x1 = Math.min(bandStart.x, p.x)
    const x2 = Math.max(bandStart.x, p.x)
    const y1 = Math.min(bandStart.y, p.y)
    const y2 = Math.max(bandStart.y, p.y)
    band.style.transform = `translate(${x1}px, ${y1}px)`
    band.style.width = (x2 - x1) + 'px'
    band.style.height = (y2 - y1) + 'px'
    // hit-test against layout geometry (not the DOM) so off-screen items select too
    const next = new Set(bandBase)
    let lo = 0
    let hi = L.items.length
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      const it = L.items[mid]
      if (it.top + it.height <= y1) lo = mid + 1
      else hi = mid
    }
    for (let i = lo; i < L.items.length; i++) {
      const it = L.items[i]
      if (it.top > y2) break
      if (it.kind !== 'entry') continue
      if (it.left < x2 && it.left + it.width > x1) {
        const p = it.entry!.path
        if (bandToggle && bandBase.has(p)) next.delete(p)
        else next.add(p)
      }
    }
    if (!setsEqual(next, t.selection)) t.setSelection(next)
  }

  function bandLoop(): void {
    if (!bandActive || !bandLast) { bandRAF = 0; return }
    const r = scroller.getBoundingClientRect()
    const y = bandLast.y
    let dy = 0
    if (y < r.top + EDGE_BAND) dy = -(4 + Math.min(56, (r.top + EDGE_BAND - y) * 1.2))
    else if (y > r.bottom - EDGE_BAND) dy = 4 + Math.min(56, (y - (r.bottom - EDGE_BAND)) * 1.2)
    if (dy) {
      scroller.scrollTop += dy
      updateBandFromClient(bandLast.x, bandLast.y)
    }
    bandRAF = requestAnimationFrame(bandLoop)
  }

  function cancelBand(): void {
    bandActive = false
    bandStart = null
    bandLast = null
    band.hidden = true
    if (bandRAF) { cancelAnimationFrame(bandRAF); bandRAF = 0 }
  }

  function startBand(e: MouseEvent): void {
    const t = tab()
    if (!t) return
    bandStart = canvasPointFromClient(e.clientX, e.clientY)
    const preserve = e.ctrlKey || e.shiftKey
    bandBase = preserve ? new Set(t.selection) : new Set()
    bandToggle = e.ctrlKey
    if (!preserve && t.selection.size) t.setSelection([])
    bandActive = false
    const move = (ev: MouseEvent) => {
      bandLast = { x: ev.clientX, y: ev.clientY }
      if (!bandActive) {
        const p = canvasPointFromClient(ev.clientX, ev.clientY)
        if (!bandStart || (Math.abs(p.x - bandStart.x) < 4 && Math.abs(p.y - bandStart.y) < 4)) return
        bandActive = true
        band.hidden = false
        if (!bandRAF) bandRAF = requestAnimationFrame(bandLoop)
      }
      updateBandFromClient(ev.clientX, ev.clientY)
    }
    const up = () => {
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
      cancelBand()
    }
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
  }

  // ---------- mouse ----------
  let deferred: { path: string; labelHit: boolean; x: number; y: number } | null = null

  scroller.addEventListener('mousedown', (e) => {
    const t = tab()
    if (!t || !layout) return
    if (e.button === 1) return
    scroller.focus()
    // ignore clicks on the scrollbars
    if (e.target === scroller &&
        (e.offsetX >= scroller.clientWidth || e.offsetY >= scroller.clientHeight)) return

    const hit = itemDataFromTarget(e.target)
    if (hit && hit.item.kind === 'header') {
      if (e.button !== 0) return
      const g = hit.item.group!
      if ((e.target as HTMLElement).closest('.vh-group-chev')) {
        setCollapsed(g.label, !t.collapsedGroups.has(g.label))
        return
      }
      const members = t.rows.slice(g.start, g.start + g.count).map(x => x.path)
      if (e.ctrlKey) t.setSelection(new Set([...t.selection, ...members]), members[0] ?? null)
      else {
        t.anchorPath = members[0] ?? null
        t.setSelection(members, members[0] ?? null)
      }
      return
    }

    if (hit && hit.item.kind === 'entry') {
      const path = hit.item.entry!.path
      const checkEl = (e.target as HTMLElement).closest?.('.vh-check')
      if (checkEl && ctx.checkboxes && e.button === 0) {
        // checkbox click toggles without clearing the rest
        const sel = new Set(t.selection)
        if (sel.has(path)) sel.delete(path); else sel.add(path)
        t.anchorPath = path
        t.setSelection(sel, path)
        e.preventDefault()
        return
      }
      if (e.button === 0) {
        cancelSlowRename()
        if (e.shiftKey) {
          let aV = visIndexOf(t.anchorPath)
          const iV = hit.item.vIndex ?? 0
          if (aV < 0) { aV = iV; t.anchorPath = path }
          const range = rangePaths(aV, iV)
          t.setSelection(e.ctrlKey ? new Set([...t.selection, ...range]) : range, path)
        } else if (e.ctrlKey) {
          const sel = new Set(t.selection)
          if (sel.has(path)) sel.delete(path); else sel.add(path)
          t.anchorPath = path // Ctrl+click moves the pivot (Explorer)
          t.setSelection(sel, path)
        } else if (t.selection.has(path)) {
          // defer: may become a drag of the whole selection, or a slow-rename click
          deferred = {
            path,
            labelHit: !!(e.target as HTMLElement).closest?.('.vh-label'),
            x: e.clientX,
            y: e.clientY,
          }
          if (t.focusPath !== path) t.setSelection([...t.selection], path)
        } else {
          t.anchorPath = path
          t.setSelection([path], path)
        }
      }
      return
    }

    // empty area
    if (e.button === 0) {
      cancelSlowRename()
      startBand(e)
    } else if (e.button === 2) {
      if (t.selection.size) t.selectNone()
    }
  })

  scroller.addEventListener('mouseup', (e) => {
    if (e.button !== 0 || !deferred) return
    const d = deferred
    deferred = null
    const t = tab()
    if (!t) return
    if (Math.abs(e.clientX - d.x) > 4 || Math.abs(e.clientY - d.y) > 4) return
    if (e.ctrlKey || e.shiftKey) return
    if (t.selection.size > 1) {
      // plain click on one of several selected items collapses to it
      t.anchorPath = d.path
      t.setSelection([d.path], d.path)
      return
    }
    if (d.labelHit) scheduleSlowRename(d.path)
  })

  scroller.addEventListener('dblclick', (e) => {
    cancelSlowRename()
    const t = tab()
    if (!t) return
    const hit = itemDataFromTarget(e.target)
    if (!hit) return
    if (hit.item.kind === 'header') {
      const g = hit.item.group!
      setCollapsed(g.label, !t.collapsedGroups.has(g.label))
      return
    }
    const path = hit.item.entry!.path
    if (!t.selection.has(path) || t.selection.size !== 1) {
      t.anchorPath = path
      t.setSelection([path], path)
    }
    void actions.open()
  })

  scroller.addEventListener('auxclick', (e) => {
    if (e.button !== 1) return
    const hit = itemDataFromTarget(e.target)
    if (hit?.item.kind === 'entry' && hit.item.entry!.isDir) {
      e.preventDefault()
      void app.newTab(hit.item.entry!.path, true)
    }
  })

  scroller.addEventListener('contextmenu', (e) => {
    e.preventDefault()
    const t = tab()
    if (!t) return
    const hit = itemDataFromTarget(e.target)
    if (hit && hit.item.kind === 'header') {
      groupHeaderMenu(hit.item.group!, e.clientX, e.clientY)
      return
    }
    if (hit && hit.item.kind === 'entry') {
      const path = hit.item.entry!.path
      if (!t.selection.has(path)) {
        t.anchorPath = path
        t.setSelection([path], path)
      }
      app.emit('item-context', { x: e.clientX, y: e.clientY, entries: t.selectedEntries() })
    } else {
      app.emit('background-context', { x: e.clientX, y: e.clientY })
    }
  })

  // cancel deferred plain-click handling once a drag actually starts
  canvas.addEventListener('dragstart', () => {
    deferred = null
    cancelSlowRename()
  })

  // ---------- Ctrl+wheel view-mode zoom ----------
  scroller.addEventListener('wheel', (e) => {
    if (!e.ctrlKey) return
    e.preventDefault()
    const t = tab()
    if (!t) return
    const i = MODE_ORDER.indexOf(t.viewState.mode)
    const j = Math.min(MODE_ORDER.length - 1, Math.max(0, i + (e.deltaY < 0 ? 1 : -1)))
    if (j !== i) t.setViewState({ mode: MODE_ORDER[j] })
  }, { passive: false })

  // ---------- keyboard ----------
  let taBuf = ''
  let taLast = 0

  function typeAhead(ch: string): void {
    const t = tab()
    const L = layout
    if (!t || !L) return
    const n = L.visible.length
    if (!n) return
    const now = Date.now()
    if (now - taLast > 1000) taBuf = ''
    taLast = now
    const c = ch.toLowerCase()
    const focusV = visIndexOf(t.focusPath)
    let prefix: string
    let start: number
    if (taBuf.length > 0 && taBuf.split('').every(x => x === c)) {
      // repeated same letter cycles through matches
      taBuf = c
      prefix = c
      start = focusV + 1
    } else if (taBuf === '') {
      taBuf = c
      prefix = c
      start = focusV + 1
    } else {
      taBuf += c
      prefix = taBuf
      start = Math.max(0, focusV)
    }
    for (let k = 0; k < n; k++) {
      const i = ((start + k) % n + n) % n
      const e = L.visible[i]
      if (e.name.toLowerCase().startsWith(prefix)) {
        t.anchorPath = e.path
        t.setSelection([e.path], e.path)
        revealIndex(L.itemOfVisible[i])
        return
      }
    }
  }

  function pageRows(): number {
    const m = layout!.metrics
    const rh = m.kind === 'grid' ? m.itemH : m.rowH
    return Math.max(1, Math.floor(scroller.clientHeight / Math.max(1, rh)))
  }

  scroller.addEventListener('keydown', (e) => {
    const t = tab()
    const L = layout
    if (!t || !L) return
    if ((e.target as HTMLElement).tagName === 'INPUT') return
    const n = L.visible.length
    const focusV = visIndexOf(t.focusPath)
    const mods = { ctrl: e.ctrlKey, shift: e.shiftKey }
    const handled = () => { e.preventDefault(); e.stopPropagation() }

    const rowNav = (delta: number): number => {
      if (focusV < 0) return delta > 0 ? 0 : n - 1
      const pos = L.posOf[focusV]
      const r2 = pos.row + delta
      if (r2 < 0) return 0
      if (r2 >= L.navRows.length) return n - 1
      const row = L.navRows[r2]
      return row[Math.min(pos.col, row.length - 1)]
    }
    const move = (target: number) => {
      if (n) selectVis(Math.max(0, Math.min(n - 1, target)), mods)
      handled()
    }

    switch (e.key) {
      case 'ArrowDown': move(rowNav(1)); return
      case 'ArrowUp': move(rowNav(-1)); return
      case 'ArrowRight':
        if (L.metrics.kind === 'grid') { move(focusV < 0 ? 0 : focusV + 1); return }
        if (t.viewState.groupKey !== 'none' && focusV >= 0) {
          const label = groupLabelOfItem(L.itemOfVisible[focusV])
          if (label) setCollapsed(label, false)
          handled()
        }
        return
      case 'ArrowLeft':
        if (L.metrics.kind === 'grid') { move(focusV < 0 ? 0 : focusV - 1); return }
        if (t.viewState.groupKey !== 'none' && focusV >= 0) {
          const label = groupLabelOfItem(L.itemOfVisible[focusV])
          if (label) setCollapsed(label, true)
          handled()
        }
        return
      case 'Home': if (n) move(0); else handled(); return
      case 'End': if (n) move(n - 1); else handled(); return
      case 'PageUp': if (n) move(rowNav(-pageRows())); else handled(); return
      case 'PageDown': if (n) move(rowNav(pageRows())); else handled(); return
      case ' ': {
        if (focusV >= 0) {
          const p = L.visible[focusV].path
          const sel = new Set(t.selection)
          if (e.ctrlKey) {
            if (sel.has(p)) sel.delete(p); else sel.add(p)
          } else {
            sel.add(p)
          }
          t.anchorPath = p // Space (with or without Ctrl) moves the pivot
          t.setSelection(sel, p)
        }
        handled()
        return
      }
      case 'Enter':
        // modified Enter (Alt+Enter properties etc.) belongs to the global keyboard map
        if (e.altKey || e.ctrlKey || e.metaKey) return
        if (t.selection.size) {
          void actions.open()
          handled()
        }
        return
      case 'Escape':
        cancelBand()
        return
      default:
        break
    }
    if (e.key.length === 1 && !e.ctrlKey && !e.altKey && !e.metaKey) {
      typeAhead(e.key)
      handled()
    }
  })

  // ---------- context-menu key (Shift+F10 / Menu key) ----------
  const onCtxKey = (): void => {
    const t = tab()
    if (!t || !layout) return
    const fV = visIndexOf(t.focusPath)
    if (fV >= 0) {
      const idx = layout.itemOfVisible[fV]
      revealIndex(idx)
      const p = layout.visible[fV].path
      if (!t.selection.has(p)) {
        t.anchorPath = p
        t.setSelection([p], p)
      }
      const el = rendered.get(idx)
      const r = (el ?? scroller).getBoundingClientRect()
      app.emit('item-context', {
        x: r.left + Math.min(80, r.width / 2),
        y: r.bottom - 4,
        entries: t.selectedEntries(),
      })
    } else {
      const r = scroller.getBoundingClientRect()
      app.emit('background-context', { x: r.left + 8, y: r.top + 8 })
    }
  }
  window.addEventListener('context-menu-key', onCtxKey)
  app.on('context-menu-key', onCtxKey)

  // ---------- scrolling / resize ----------
  scroller.addEventListener('scroll', () => {
    const t = tab()
    if (t) scrollPos.set(t.id, scroller.scrollTop)
    if (!paintQueued) {
      paintQueued = true
      requestAnimationFrame(() => {
        paintQueued = false
        paint()
      })
    }
  })

  const ro = new ResizeObserver(() => scheduleRebuild())
  ro.observe(scroller)

  // ---------- drag & drop ----------
  wireDnD({
    scroller,
    canvas,
    tab: () => tab(),
    entryFromEvent: (target) => {
      const hit = itemDataFromTarget(target)
      return hit && hit.item.kind === 'entry' ? hit.item.entry! : null
    },
    elForPath: (p) => {
      const i = layout?.byPath.get(p)
      return i === undefined ? null : rendered.get(i) ?? null
    },
  })

  // ---------- app events ----------
  app.on('tab-listing', (t: Tab) => { if (t === app.activeTab) scheduleRebuild() })
  app.on('tab-viewstate', (t: Tab) => { if (t === app.activeTab) scheduleRebuild() })
  app.on('tab-selection', (t: Tab) => { if (t === app.activeTab) syncSelection() })
  app.on('tab-loading', (t: Tab) => { if (t === app.activeTab) updateState() })
  app.on('tabs-changed', () => {
    cancelBand()
    renamer.cancel()
    cancelSlowRename()
    const t = tab()
    if (t) lastPath.set(t.id, t.path)
    pendingScroll = t ? scrollPos.get(t.id) ?? 0 : 0
    scheduleRebuild()
  })
  app.on('tab-navigated', (t: Tab) => {
    if (t !== app.activeTab) return
    renamer.cancel()
    cancelBand()
    cancelSlowRename()
    if (lastPath.get(t.id) !== t.path) {
      scrollPos.set(t.id, 0)
      pendingScroll = 0
    }
    lastPath.set(t.id, t.path)
    scheduleRebuild()
  })
  app.on('settings-changed', () => scheduleRebuild())
  app.on('clipboard-changed', () => { updateCutSet(); syncSelection() })
  app.on('start-rename', (path: string) => beginRename(path))

  updateCutSet()
  rebuild()
}
