// Navigation pane — Win11 Explorer left rail.
//
// Structure (top to bottom): Home · pinned Quick-access entries (user dirs +
// pinned places, pin glyph on hover) · ── · This PC (expandable; children are
// drives, each drive a lazy directory-tree root with optional capacity bar) ·
// ── · Network (network drives + gvfs places, also tree roots) · ── ·
// Recycle Bin.
//
// Flagship behavior: "Expand to open folder" — on every navigation of the
// active tab (when settings.navExpandToCurrent), the tree expands along the
// ancestor chain to the current folder, highlights it and scrolls it into
// view. The walk follows Thunar's model (docs/research/research-prior-art.md
// §8a): lazy per-branch loads that are awaited (not re-issued) while in
// flight, one forced re-list retry when a segment is missing, a 5 s total
// abort, and NO auto-collapsing ever — a user's manual collapse wins until
// the next navigation.
import type { AppSettings, FileEntry, Place } from '../../shared/types'
import { app, liq } from '../core/app'
import type { Tab } from '../core/app'

const MIN_W = 120
const MAX_W = 420
const INDENT_PX = 12          // indent per tree level
const BASE_PAD_PX = 13        // row left padding at depth 0
const HOVER_EXPAND_MS = 800   // spring-load delay during drag
const EXPAND_DEADLINE_MS = 5000

const CHEVRON_SVG =
  '<svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">' +
  '<path d="M4.5 2.5 8 6l-3.5 3.5" stroke="currentColor" stroke-width="1.3" ' +
  'stroke-linecap="round" stroke-linejoin="round"/></svg>'

const PIN_SVG =
  '<svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">' +
  '<path d="M9.6 1.7a1 1 0 0 1 1.42 0l3.28 3.28a1 1 0 0 1 0 1.42l-.9.9a1 1 0 0 1-.93.27l-.66-.15' +
  '-2.28 2.28.3 2.35a1 1 0 0 1-.28.83l-.33.33a1 1 0 0 1-1.41 0L5.6 11l-3.42 3.42a.6.6 0 0 1-.85-.85' +
  'L4.75 10.2 2.54 7.99a1 1 0 0 1 0-1.41l.33-.33a1 1 0 0 1 .83-.29l2.35.31L8.33 3.99l-.15-.66' +
  'a1 1 0 0 1 .27-.93l1.15-.7z"/></svg>'

type SectionId = 'thispc' | 'network'

interface TreeNode {
  path: string                       // normalized, no trailing slash (except '/')
  label: string
  depth: number
  isRoot: boolean                    // drive / network mount — keeps its chevron even when empty
  section?: SectionId
  place?: Place
  expandable: boolean
  expanded: boolean
  loading: boolean
  children: TreeNode[] | null        // null = never listed
  loadPromise: Promise<void> | null
  el: HTMLElement                    // .nav-node wrapper (row + children)
  rowEl: HTMLElement
  chevronEl: HTMLElement
  childrenEl: HTMLElement
}

interface Section {
  id: SectionId
  expanded: boolean
  el: HTMLElement
  childrenEl: HTMLElement
  setExpanded(v: boolean): void
}

export function mountNavPane(root: HTMLElement): void {
  const pane = root
  const splitter = document.getElementById('navpane-splitter')

  // right-click on empty pane space (rows stopPropagation, so only blank area
  // reaches here) — Explorer's nav-pane options menu
  pane.addEventListener('contextmenu', (e) => {
    e.preventDefault()
    app.emit('navpane-empty-context', { x: e.clientX, y: e.clientY })
  })

  // ---- state ----
  const treeRoots: TreeNode[] = []
  const flatRows: { path: string; row: HTMLElement }[] = []
  const sections = new Map<SectionId, Section>()
  /** every path the user (or auto-expand) wants open — survives rebuilds */
  const expandedPaths = new Set<string>()
  let currentPath = ''
  let expandGen = 0                  // cancels a stale auto-expand walk
  let lastShowHidden = app.settings.showHidden
  const sectionState: Record<string, boolean> = loadSectionState()

  // ---------------------------------------------------------------- helpers

  function normPath(p: string): string {
    if (!p || p.includes('://')) return p
    const s = p.replace(/\/+$/, '')
    return s === '' ? '/' : s
  }

  function joinPath(parent: string, seg: string): string {
    return parent === '/' ? '/' + seg : parent + '/' + seg
  }

  function navigate(path: string): void {
    void app.activeTab?.navigate(path)
  }

  function loadSectionState(): Record<string, boolean> {
    try {
      const raw = localStorage.getItem('navpane-sections')
      if (raw) return JSON.parse(raw) as Record<string, boolean>
    } catch { /* corrupted — fall through */ }
    return {}
  }

  function saveSectionState(): void {
    try { localStorage.setItem('navpane-sections', JSON.stringify(sectionState)) } catch { /* full */ }
  }

  function makeIcon(icons: string[]): HTMLImageElement {
    const img = document.createElement('img')
    img.className = 'icon'
    img.src = `liqicon://${(icons.length ? icons : ['folder']).join(',')}?size=16`
    img.addEventListener('error', () => {
      if (img.dataset.fb) { img.style.visibility = 'hidden'; return }
      img.dataset.fb = '1'
      img.src = 'liqicon://folder?size=16'
    })
    return img
  }

  function makeLabel(text: string): HTMLSpanElement {
    const lb = document.createElement('span')
    lb.className = 'nav-label'
    lb.textContent = text
    return lb
  }

  function wireRowNav(row: HTMLElement, path: string): void {
    row.addEventListener('click', () => navigate(path))
    // middle-click: background tab (mousedown preventDefault kills autoscroll)
    row.addEventListener('mousedown', (e) => { if (e.button === 1) e.preventDefault() })
    row.addEventListener('auxclick', (e) => {
      if (e.button === 1) { e.preventDefault(); void app.newTab(path, true) }
    })
  }

  function wireContextMenu(row: HTMLElement, path: string, place?: Place): void {
    row.addEventListener('contextmenu', (e) => {
      e.preventDefault()
      e.stopPropagation()
      app.emit('navpane-context', {
        x: e.clientX,
        y: e.clientY,
        path,
        place: place ?? null,
        pinned: place ? (place.pinned ?? (place.kind === 'pinned' || place.kind === 'user-dir')) : false,
        ejectable: !!place?.ejectable,
      })
    })
  }

  // ------------------------------------------------------------ drag & drop

  function dtHasFiles(dt: DataTransfer): boolean {
    for (const t of Array.from(dt.types)) {
      if (t === 'Files' || t === 'text/uri-list' || t === 'application/x-liq-paths') return true
    }
    return false
  }

  function pathsFromDrop(dt: DataTransfer): string[] {
    const custom = dt.getData('application/x-liq-paths')
    if (custom) {
      try {
        const arr = JSON.parse(custom)
        if (Array.isArray(arr)) {
          const ps = arr.filter((x): x is string => typeof x === 'string')
          if (ps.length) return ps
        }
      } catch { /* not ours */ }
    }
    const uris = dt.getData('text/uri-list')
    if (uris) {
      const out: string[] = []
      for (const line of uris.split(/\r?\n/)) {
        const s = line.trim()
        if (!s || s.startsWith('#') || !s.startsWith('file://')) continue
        try { out.push(decodeURIComponent(new URL(s).pathname)) } catch { /* bad uri */ }
      }
      if (out.length) return out
    }
    const files: string[] = []
    for (const f of Array.from(dt.files)) {
      try {
        const p = liq.pathForFile(f)
        if (p) files.push(p)
      } catch { /* not a fs file */ }
    }
    return files
  }

  function makeDropTarget(row: HTMLElement, dest: string, opts: { node?: TreeNode; trash?: boolean }): void {
    let hoverTimer = 0
    const clearHover = () => { if (hoverTimer) { clearTimeout(hoverTimer); hoverTimer = 0 } }
    row.addEventListener('dragover', (e) => {
      const dt = e.dataTransfer
      if (!dt || !dtHasFiles(dt)) return
      e.preventDefault()
      dt.dropEffect = opts.trash || !e.ctrlKey ? 'move' : 'copy'
      row.classList.add('drop-target')
      const n = opts.node
      if (n && n.expandable && !n.expanded && !hoverTimer) {
        hoverTimer = window.setTimeout(() => { hoverTimer = 0; void expandNode(n) }, HOVER_EXPAND_MS)
      }
    })
    row.addEventListener('dragleave', (e) => {
      if (e.relatedTarget && row.contains(e.relatedTarget as Node)) return
      row.classList.remove('drop-target')
      clearHover()
    })
    row.addEventListener('drop', (e) => {
      row.classList.remove('drop-target')
      clearHover()
      const dt = e.dataTransfer
      if (!dt || !dtHasFiles(dt)) return
      e.preventDefault()
      e.stopPropagation()
      const sources = pathsFromDrop(dt)
      if (!sources.length) return
      if (opts.trash) { void liq.startOp({ kind: 'trash', sources }); return }
      const destN = normPath(dest)
      const copy = e.ctrlKey
      const valid = sources.map(normPath).filter((s) => {
        if (s === destN) return false
        if (destN.startsWith(s + '/')) return false            // dest inside source
        const parent = s.slice(0, s.lastIndexOf('/')) || '/'
        if (parent === destN && !copy) return false            // move into own dir = no-op
        return true
      })
      if (!valid.length) return
      void liq.startOp({ kind: copy ? 'copy' : 'move', sources: valid, dest: destN })
    })
  }

  // ------------------------------------------------------------------ tree

  function updateChevron(node: TreeNode): void {
    const c = node.chevronEl
    c.classList.toggle('loading', node.loading)
    if (node.loading) { c.innerHTML = '<span class="nav-spinner"></span>'; c.classList.remove('empty'); return }
    if (!node.expandable) { c.innerHTML = ''; c.classList.add('empty'); return }
    c.classList.remove('empty')
    c.innerHTML = CHEVRON_SVG
  }

  function makeTreeNode(
    path: string, label: string, icons: string[], depth: number,
    extra: { place?: Place; isRoot?: boolean; section?: SectionId } = {},
  ): TreeNode {
    const el = document.createElement('div')
    el.className = 'nav-node'
    const row = document.createElement('div')
    row.className = 'nav-row nav-tree-row'
    row.style.paddingLeft = (BASE_PAD_PX + depth * INDENT_PX) + 'px'
    row.dataset.liqPath = path              // right-drag drop target
    row.dataset.liqLabel = label
    const chev = document.createElement('span')
    chev.className = 'nav-chevron'
    row.append(chev, makeIcon(icons))
    const cap = extra.place?.capacity
    if (cap && cap.total > 0) {
      row.classList.add('has-cap')
      const col = document.createElement('span')
      col.className = 'nav-labelcol'
      const bar = document.createElement('span')
      bar.className = 'nav-cap'
      const fill = document.createElement('span')
      fill.className = 'nav-cap-fill'
      const used = Math.min(1, Math.max(0, (cap.total - cap.free) / cap.total))
      fill.style.width = Math.round(used * 100) + '%'
      if (used >= 0.9) fill.classList.add('crit')
      bar.appendChild(fill)
      col.append(makeLabel(label), bar)
      row.appendChild(col)
      row.title = `${label} — ${Math.round(used * 100)}% used`
    } else {
      row.appendChild(makeLabel(label))
    }
    const childrenEl = document.createElement('div')
    childrenEl.className = 'nav-children'
    childrenEl.hidden = true
    el.append(row, childrenEl)
    const node: TreeNode = {
      path: normPath(path), label, depth,
      isRoot: !!extra.isRoot, section: extra.section, place: extra.place,
      expandable: true, expanded: false, loading: false,
      children: null, loadPromise: null,
      el, rowEl: row, chevronEl: chev, childrenEl,
    }
    updateChevron(node)
    // chevron expands/collapses WITHOUT navigating
    chev.addEventListener('click', (e) => {
      e.stopPropagation()
      if (node.loading || !node.expandable) return
      if (node.expanded) collapseNode(node)
      else void expandNode(node)
    })
    wireRowNav(row, node.path)
    wireContextMenu(row, node.path, extra.place)
    makeDropTarget(row, node.path, { node })
    return node
  }

  function expandNode(node: TreeNode): Promise<void> {
    expandedPaths.add(node.path)
    if (node.expanded) return node.loadPromise ?? Promise.resolve()
    node.expanded = true
    node.el.classList.add('expanded')
    node.childrenEl.hidden = false
    return reloadChildren(node)      // re-expanding always refreshes the listing
  }

  function collapseNode(node: TreeNode): void {
    expandedPaths.delete(node.path)
    node.expanded = false
    node.el.classList.remove('expanded')
    node.childrenEl.hidden = true
    // a manual collapse wins over any in-flight auto-expand until next navigation
    expandGen++
  }

  function reloadChildren(node: TreeNode): Promise<void> {
    if (node.loadPromise) return node.loadPromise
    node.loading = true
    updateChevron(node)
    const p = (async () => {
      try {
        let entries: FileEntry[] = []
        let failed = false
        try { entries = (await liq.listChildDirs(node.path, app.settings.showHidden)) ?? [] }
        catch { failed = true /* transient (CIFS/gvfs) failure — keep the chevron so the user can retry */ }
        node.children = []
        node.childrenEl.textContent = ''
        for (const e of entries) {
          const child = makeTreeNode(e.path, e.name, e.icons?.length ? e.icons : ['folder'], node.depth + 1)
          node.children.push(child)
          node.childrenEl.appendChild(child.el)
        }
        // only a SUCCESSFUL empty listing removes the chevron
        node.expandable = node.isRoot || entries.length > 0 || failed
        if (failed) {
          // show it collapsed so the next chevron click retries the listing;
          // path stays in expandedPaths so rebuilds retry automatically
          node.children = null
          node.expanded = false
          node.el.classList.remove('expanded')
          node.childrenEl.hidden = true
        } else if (!node.expandable) {
          // empty dir: lose the chevron after the first expand attempt
          node.expanded = false
          node.el.classList.remove('expanded')
          node.childrenEl.hidden = true
          expandedPaths.delete(node.path)
        }
        // restore nested expansion (preserved by path across reloads/rebuilds)
        for (const child of node.children ?? []) {
          if (expandedPaths.has(child.path)) void expandNode(child)
        }
      } finally {
        node.loading = false
        node.loadPromise = null
        updateChevron(node)
        applyCurrentHighlight()
      }
    })()
    node.loadPromise = p
    return p
  }

  // ----------------------------------------------------- current highlight

  function applyCurrentHighlight(): void {
    const cur = normPath(currentPath)
    pane.querySelectorAll('.nav-row.current').forEach((el) => el.classList.remove('current'))
    if (!cur) return
    for (const f of flatRows) {
      if (normPath(f.path) === cur) f.row.classList.add('current')
    }
    const walk = (n: TreeNode): void => {
      if (n.path === cur) n.rowEl.classList.add('current')
      n.children?.forEach(walk)
    }
    treeRoots.forEach(walk)
  }

  // ------------------------------------------------- auto-expand-to-current

  async function followNavigation(tab: Tab, force: boolean): Promise<void> {
    if (!tab || tab !== app.activeTab) return
    currentPath = tab.path
    applyCurrentHighlight()
    if (!force && !app.settings.navExpandToCurrent) return
    const target = normPath(currentPath)
    if (!target || target.includes('://')) return
    const gen = ++expandGen
    const deadline = Date.now() + EXPAND_DEADLINE_MS

    // best root = longest-prefix match among mountpoints; '/' always matches last
    let best: TreeNode | null = null
    let bestLen = -1
    for (const r of treeRoots) {
      const match = r.path === '/' ? true : target === r.path || target.startsWith(r.path + '/')
      const len = r.path === '/' ? 0 : r.path.length
      if (match && len > bestLen) { best = r; bestLen = len }
    }
    if (!best) return
    if (best.section) sections.get(best.section)?.setExpanded(true)

    const rel = target === best.path
      ? []
      : target.slice(best.path === '/' ? 1 : best.path.length + 1).split('/').filter(Boolean)

    let cur: TreeNode = best
    for (const seg of rel) {
      if (gen !== expandGen || Date.now() > deadline) return
      // ensure this ancestor is expanded and its children are loaded;
      // if a load is already in flight, wait on THAT promise (never re-issue)
      if (!cur.expanded) { try { await expandNode(cur) } catch { /* keep walking */ } }
      else if (cur.loadPromise) { try { await cur.loadPromise } catch { /* keep walking */ } }
      else if (cur.children === null) { try { await reloadChildren(cur) } catch { /* keep walking */ } }
      if (gen !== expandGen || Date.now() > deadline) return
      const want = joinPath(cur.path, seg)
      let child = (cur.children ?? []).find((c) => c.path === want)
      if (!child) {
        // segment missing (created since last list, or hidden): one fresh retry
        try { await reloadChildren(cur) } catch { /* give up below */ }
        if (gen !== expandGen || Date.now() > deadline) return
        child = (cur.children ?? []).find((c) => c.path === want)
      }
      if (!child) return
      cur = child
    }
    if (gen !== expandGen) return
    applyCurrentHighlight()
    cur.rowEl.scrollIntoView({ block: 'nearest' })
  }

  // ------------------------------------------------------------- sections

  function addSep(): void {
    const s = document.createElement('div')
    s.className = 'nav-sep'
    pane.appendChild(s)
  }

  function makeSection(id: SectionId, label: string, icons: string[], onNavigate: (() => void) | null): Section {
    const el = document.createElement('div')
    el.className = 'nav-node nav-section'
    const row = document.createElement('div')
    row.className = 'nav-row nav-section-header'
    row.style.paddingLeft = BASE_PAD_PX + 'px'
    const chev = document.createElement('span')
    chev.className = 'nav-chevron'
    chev.innerHTML = CHEVRON_SVG
    row.append(chev, makeIcon(icons), makeLabel(label))
    const childrenEl = document.createElement('div')
    childrenEl.className = 'nav-children'
    el.append(row, childrenEl)
    const sec: Section = {
      id,
      expanded: sectionState[id] !== false,   // default open
      el, childrenEl,
      setExpanded(v: boolean) {
        sec.expanded = v
        sectionState[id] = v
        saveSectionState()
        el.classList.toggle('expanded', v)
        childrenEl.hidden = !v
      },
    }
    sec.setExpanded(sec.expanded)
    chev.addEventListener('click', (e) => { e.stopPropagation(); sec.setExpanded(!sec.expanded) })
    if (onNavigate) row.addEventListener('click', onNavigate)
    else row.addEventListener('click', () => sec.setExpanded(!sec.expanded))
    pane.appendChild(el)
    sections.set(id, sec)
    return sec
  }

  function addFlatRow(place: Place, opts: { pin?: boolean; parent?: HTMLElement; depth?: number } = {}): void {
    const depth = opts.depth ?? 0
    const row = document.createElement('div')
    row.className = 'nav-row nav-flat'
    row.style.paddingLeft = (BASE_PAD_PX + depth * INDENT_PX) + 'px'
    row.dataset.liqPath = place.path         // right-drag drop target
    row.dataset.liqLabel = place.label
    const spacer = document.createElement('span')
    spacer.className = 'nav-chevron empty'
    row.append(spacer, makeIcon(place.icons), makeLabel(place.label))
    if (opts.pin) {
      const pin = document.createElement('span')
      pin.className = 'nav-pin'
      pin.title = 'Unpin from Quick access'
      pin.innerHTML = PIN_SVG
      pin.addEventListener('click', (e) => { e.stopPropagation(); void liq.unpinPlace(place.path) })
      row.appendChild(pin)
    }
    wireRowNav(row, place.path)
    wireContextMenu(row, place.path, place)
    if (place.path === 'trash://') makeDropTarget(row, place.path, { trash: true })
    else if (place.path && !place.path.includes('://')) makeDropTarget(row, place.path, {})
    flatRows.push({ path: place.path, row })
    ;(opts.parent ?? pane).appendChild(row)
  }

  function addRoot(place: Place, sec: Section, fallbackIcons: string[]): void {
    if (!place.path || place.path.includes('://')) {
      // no plain fs path (odd gvfs mount) — plain link row inside the section
      addFlatRow(place, { parent: sec.childrenEl, depth: 1 })
      return
    }
    const node = makeTreeNode(
      place.path, place.label,
      place.icons.length ? place.icons : fallbackIcons,
      1, { place, isRoot: true, section: sec.id },
    )
    treeRoots.push(node)
    sec.childrenEl.appendChild(node.el)
  }

  // --------------------------------------------------------------- build

  function build(): void {
    const scrollTop = pane.scrollTop
    pane.textContent = ''
    flatRows.length = 0
    treeRoots.length = 0
    sections.clear()
    const places: Place[] = app.places ?? []

    // Home
    const home: Place = places.find((p) => p.kind === 'home')
      ?? { id: 'home', kind: 'home', label: 'Home', path: app.homePath, icons: ['user-home', 'go-home', 'folder-home'] }
    addFlatRow(home)

    // pinned quick-access entries
    for (const p of places) {
      if (p.kind === 'user-dir' || p.kind === 'pinned') addFlatRow(p, { pin: true })
    }
    addSep()

    // This PC — children are drives only; each drive is a tree root
    const secPc = makeSection('thispc', 'This PC', ['computer', 'computer-laptop', 'video-display'],
      () => navigate('computer://'))
    for (const p of places) {
      if (p.kind === 'drive') addRoot(p, secPc, ['drive-harddisk', 'drive-removable-media'])
    }
    addSep()

    // Network — network drives + gvfs mounts (fuse paths are also tree roots)
    const secNet = makeSection('network', 'Network', ['network-workgroup', 'network-server', 'folder-remote'], null)
    for (const p of places) {
      if (p.kind === 'network-drive' || p.kind === 'gvfs' || p.kind === 'network') {
        addRoot(p, secNet, ['folder-remote', 'network-server'])
      }
    }
    addSep()

    // Recycle Bin
    const trash: Place = places.find((p) => p.kind === 'trash')
      ?? { id: 'trash', kind: 'trash', label: 'Recycle Bin', path: 'trash://', icons: ['user-trash'] }
    addFlatRow(trash)

    // restore tree expansion (by path) after a rebuild
    for (const r of treeRoots) {
      if (expandedPaths.has(r.path)) void expandNode(r)
    }
    applyCurrentHighlight()
    pane.scrollTop = scrollTop
  }

  // ------------------------------------------------------------- splitter

  function setPaneWidth(w: number): void {
    const clamped = Math.min(MAX_W, Math.max(MIN_W, Math.round(w)))
    document.documentElement.style.setProperty('--navpane-w', clamped + 'px')
  }

  function mountSplitter(): void {
    if (!splitter) return
    const saved = Number(localStorage.getItem('navpane-w'))
    if (Number.isFinite(saved) && saved >= MIN_W && saved <= MAX_W) setPaneWidth(saved)
    splitter.addEventListener('mousedown', (e) => {
      e.preventDefault()
      const startX = e.clientX
      const startW = pane.getBoundingClientRect().width
      splitter.classList.add('dragging')
      document.body.style.cursor = 'col-resize'
      const move = (ev: MouseEvent) => setPaneWidth(startW + ev.clientX - startX)
      const up = () => {
        window.removeEventListener('mousemove', move)
        window.removeEventListener('mouseup', up)
        splitter.classList.remove('dragging')
        document.body.style.cursor = ''
        try {
          localStorage.setItem('navpane-w', String(Math.round(pane.getBoundingClientRect().width)))
        } catch { /* full */ }
      }
      window.addEventListener('mousemove', move)
      window.addEventListener('mouseup', up)
    })
  }

  function applyVisibility(s: AppSettings): void {
    pane.hidden = !s.showNavPane
    if (splitter) splitter.hidden = !s.showNavPane
  }

  // --------------------------------------------------------------- mount

  mountSplitter()
  applyVisibility(app.settings)
  build()

  app.on('places-changed', () => build())
  app.on('tab-navigated', (t: Tab) => { void followNavigation(t, false) })
  // on-demand expand (Ctrl+Shift+E), works even with navExpandToCurrent off
  app.on('nav-expand-to-current', () => {
    const t = app.activeTab
    if (t) void followNavigation(t, true)
  })
  app.on('settings-changed', (s: AppSettings) => {
    applyVisibility(s)
    if (s.showHidden !== lastShowHidden) {
      lastShowHidden = s.showHidden
      for (const r of treeRoots) {
        if (r.expanded) void reloadChildren(r)   // cascades: reload re-expands by path
      }
    }
  })

  // app.init() finished before mount — pick up the tab that already navigated
  const t = app.activeTab
  if (t) { currentPath = t.path; void followNavigation(t, false) }
}
