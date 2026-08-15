// PEEK — look inside an item without opening it.
//
// Two ways in, one popover:
//   * rest the pointer on an item for the hover delay (View > Peek, default
//     1.4 s, off-able) — the glance you get for free while browsing;
//   * press Space on the focused item (macOS Quick Look muscle memory) — the
//     power-user path, instant, no dwell, and it works with hover peek off.
//
// What it shows: a FOLDER becomes a scrollable grid of its contents, thumbnails
// and all; a FILE goes through views/previewrender.ts, the same per-type
// rendering the preview pane uses (image large, text first 100 lines, PDF page
// 1, video with a scrubbable transport, archive member list). Enter opens what
// is highlighted for real — navigating the tab for folders — so a peek can end
// in the place you wanted without ever being a detour.
//
// SELF-MOUNTING: importing this module installs the layer, the stylesheet and
// the document-level keyboard/dismissal listeners. Item views call attachPeek()
// to register their scroller (view-host.ts, one line); everything else here is
// global and needs no wiring.
//
// Three hazards this code exists to survive
// -----------------------------------------
// 1. RECYCLING. view-host.ts pools item elements and re-renders them as you
//    scroll, so the element the hover timer was armed on may belong to another
//    file by the time it fires. The timer therefore re-reads the item under the
//    pointer with elementFromPoint() and drops the peek unless the path still
//    matches — the same identity check the archive-thumbnail path in items.ts
//    makes with img.dataset.for.
// 2. SLOW MOUNTS. The user's files live on a hard-mounted CIFS share. The
//    folder read is bounded and cancellable main-side (fs/peek.ts): moving the
//    pointer away cancels the token, and any result that arrives late is
//    dropped by generation, never painted over whatever is on screen now.
// 3. THE GAP. The popover is offset from the pointer, so travelling into it
//    crosses ground that belongs to neither it nor the item. Leaving both only
//    arms a PEEK.closeGraceMs timer, which entering either one cancels.
import { app, liq } from '../core/app'
import type { Tab } from '../core/app'
import type { FileEntry } from '../../shared/types'
import { formatDate, formatSize, typeLabelFor } from '../../shared/sort'
import { PEEK, peekDelay, type PeekDirResult } from '../../shared/peek'
import { placeFlyout } from '../menus/menu'
import { archiveUri, isArchiveName, isArchiveUri } from '../../shared/archive'
import { archiveMemberPath, displayName, iconURL, wantsThumb } from './items'
import { clearPreviewBody, el, note, renderPreview, type PreviewHost } from './previewrender'
import { isLivePreviewing } from './livemedia'

export interface PeekSource {
  /** the view's scrolling element — hover is tracked on this */
  scroller: HTMLElement
  /** the Tab this view renders (a pane accessor, not app.activeTab) */
  tab: () => Tab | null
  /** view-host's own hit test: event target -> entry, or null off an item */
  entryFromEvent: (target: EventTarget | null) => FileEntry | null
  /** give this pane focus before anything reads app.activeTab */
  onActivate?: () => void
}

interface OpenState {
  entry: FileEntry
  source: PeekSource
  via: 'hover' | 'key'
  gen: number
  /** fs/peek.ts cancellation handle for the folder read */
  token: number
  pop: HTMLElement
  nameEl: HTMLElement
  metaEl: HTMLElement
  body: HTMLElement
  foot: HTMLElement
  /** folder peek: the grid's entries and tiles, parallel arrays */
  members: FileEntry[]
  tiles: HTMLElement[]
  active: number
  io: IntersectionObserver | null
  prevFocus: Element | null
  forced: Set<string>
}

const sources: PeekSource[] = []
let state: OpenState | null = null
let layer: HTMLElement | null = null
let gen = 0
let tokenSeq = 1

/** hover intent */
let hoverTimer = 0
let hoverPath: string | null = null
let pointer = { x: 0, y: 0 }
/** a drag is in progress: no peek may open until it ends */
let dragging = false
let closeTimer = 0

// ---------------------------------------------------------------- setup

function ensureLayer(): HTMLElement {
  if (layer) return layer
  // same self-contained arrangement as views/dropbins.ts: the module brings its
  // own container and stylesheet, so index.html needs no line for it
  if (!document.querySelector('link[data-pk-style]')) {
    const link = document.createElement('link')
    link.rel = 'stylesheet'
    link.href = 'styles/peek.css'
    link.setAttribute('data-pk-style', '1')
    document.head.appendChild(link)
  }
  const l = document.createElement('div')
  l.id = 'peek-layer'
  document.body.appendChild(l)
  layer = l
  return l
}

/** Register an item view. Safe to call once per mounted view host. */
export function attachPeek(src: PeekSource): void {
  sources.push(src)
  ensureLayer()

  src.scroller.addEventListener('mousemove', (e) => {
    pointer = { x: e.clientX, y: e.clientY }
    // A drag that ends outside the window delivers no dragend (the same hazard
    // views/dropbins.ts documents for its tray), and a `dragging` flag that
    // never clears would kill hover peek for the rest of the session. Any
    // button-free move means the drag is over, whatever the events said.
    if (dragging && !e.buttons) dragging = false
    if (e.buttons) { cancelHover(); return }     // a press is a drag or a band
    const entry = src.entryFromEvent(e.target)
    onPointerOverItem(src, entry)
  }, { passive: true })

  src.scroller.addEventListener('mouseleave', () => {
    cancelHover()
    if (state?.via === 'hover') closeSoon()
  })

  // a press anywhere in the view ends a hover peek: the user has decided to act
  src.scroller.addEventListener('mousedown', () => {
    cancelHover()
    if (state?.via === 'hover') closePeek()
  })

  // the anchor moves out from under the popover as soon as the list scrolls
  src.scroller.addEventListener('scroll', () => {
    cancelHover()
    if (state && state.source === src) closePeek()
  }, { passive: true })
}

// ---------------------------------------------------------------- hover intent

function hoverEnabled(): boolean {
  return app.settings?.hoverPeek !== false
}

function busy(): boolean {
  if (dragging) return true
  // a menu, a dialog or an inline rename owns the interaction
  if (document.getElementById('menu-layer')?.childElementCount) return true
  if (document.getElementById('dialog-layer')?.childElementCount) return true
  const a = document.activeElement
  return !!a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA' || (a as HTMLElement).isContentEditable)
}

function cancelHover(): void {
  if (hoverTimer) { clearTimeout(hoverTimer); hoverTimer = 0 }
  hoverPath = null
}

function onPointerOverItem(src: PeekSource, entry: FileEntry | null): void {
  const path = entry?.path ?? null
  if (state) {
    // the pointer is back on the item the popover belongs to: it stays
    if (path && path === state.entry.path) { cancelClose(); cancelHover(); return }
    if (state.via === 'hover') closeSoon()
  }
  // re-arm whenever no dwell is running for this item — not only when the item
  // CHANGES. A dwell that was dropped (a rebuild recycled the row under the
  // pointer, a scroll cancelled it, the app was busy) would otherwise never
  // come back while the pointer stays where it is; this way the next pixel of
  // movement starts it again.
  if (path === hoverPath && hoverTimer) return
  cancelHover()
  hoverPath = path
  if (!entry || !hoverEnabled() || busy()) return
  if (state && state.entry.path === entry.path) return
  hoverTimer = window.setTimeout(() => {
    hoverTimer = 0
    armedPeek(src, entry)
  }, peekDelay(app.settings?.peekDelayMs))
}

/**
 * The dwell elapsed. Re-read the item under the pointer before opening: item
 * elements are recycled, so `entry` may describe a file that has scrolled away
 * and been re-rendered as something else.
 */
function armedPeek(src: PeekSource, entry: FileEntry): void {
  if (busy() || !hoverEnabled()) return
  const under = document.elementFromPoint(pointer.x, pointer.y)
  if (!under || !src.scroller.contains(under)) return
  const now = src.entryFromEvent(under)
  if (!now || now.path !== entry.path) return
  // the tile is already playing its own live preview: covering it with a
  // second player of the same file helps nobody (Space still peeks it)
  if (isLivePreviewing(now.path)) return
  openPeek({ entry: now, source: src, via: 'hover', x: pointer.x, y: pointer.y })
}

// ---------------------------------------------------------------- open / close

function closeSoon(): void {
  if (closeTimer) return
  closeTimer = window.setTimeout(() => { closeTimer = 0; closePeek() }, PEEK.closeGraceMs)
}

function cancelClose(): void {
  if (closeTimer) { clearTimeout(closeTimer); closeTimer = 0 }
}

export function closePeek(): void {
  cancelClose()
  const s = state
  if (!s) return
  state = null
  gen++
  s.io?.disconnect()
  if (s.token) void liq.invoke('peekCancel', s.token).catch(() => { /* main is gone */ })
  // focus has to be read BEFORE the node leaves the document, or activeElement
  // is already <body> and the view never gets its focus back
  const hadFocus = s.pop.contains(document.activeElement)
  clearPreviewBody(s.body)                 // stops a playing video before detaching
  s.pop.remove()
  if (hadFocus && s.prevFocus instanceof HTMLElement && s.prevFocus.isConnected) {
    s.prevFocus.focus({ preventScroll: true })
  }
}

interface OpenArgs {
  entry: FileEntry
  source: PeekSource
  via: 'hover' | 'key'
  anchorEl?: HTMLElement | null
  x?: number
  y?: number
}

export function openPeek(args: OpenArgs): void {
  const { entry, source, via } = args
  closePeek()
  const l = ensureLayer()

  const pop = document.createElement('div')
  pop.className = 'pk' + (via === 'key' ? ' pk-key' : '')
  pop.tabIndex = -1
  pop.setAttribute('role', 'dialog')
  pop.setAttribute('aria-label', `Peek: ${entry.name}`)

  const head = document.createElement('div')
  head.className = 'pk-head'
  const icon = document.createElement('img')
  icon.className = 'pk-head-icon'
  icon.draggable = false
  icon.src = iconURL(entry, 16)
  icon.addEventListener('error', () => { icon.style.visibility = 'hidden' })
  const nameEl = el('div', 'pk-name', entry.name)
  const metaEl = el('div', 'pk-meta')
  head.append(icon, nameEl, metaEl)

  const body = el('div', 'pk-body')
  const foot = el('div', 'pk-foot')
  pop.append(head, body, foot)
  l.appendChild(pop)

  const s: OpenState = {
    entry, source, via, gen: ++gen, token: 0,
    pop, nameEl, metaEl, body, foot,
    members: [], tiles: [], active: -1, io: null,
    prevFocus: document.activeElement,
    forced: new Set(),
  }
  state = s

  // position BEFORE content: the box is a fixed size by CSS, so filling it in
  // never moves it — a popover that jumps as its thumbnails land is unusable
  placeFlyout(pop, {
    x: args.x ?? 0, y: args.y ?? 0,
    anchorEl: via === 'key' ? args.anchorEl ?? null : null,
    dx: 18, dy: 14, flipX: true,
  })

  pop.addEventListener('mouseenter', () => {
    cancelClose()
    // taking focus on entry is what makes the arrow keys work without stealing
    // them from the item view while the pointer is merely passing by
    if (!pop.contains(document.activeElement)) pop.focus({ preventScroll: true })
  })
  pop.addEventListener('mouseleave', () => { if (s.via === 'hover') closeSoon() })
  pop.addEventListener('contextmenu', (e) => e.preventDefault())

  if (via === 'key') pop.focus({ preventScroll: true })
  renderContent(s)
}

// ---------------------------------------------------------------- content

function setCaption(s: OpenState, name: string, parts: (string | undefined | false)[]): void {
  s.nameEl.textContent = name
  s.nameEl.title = name
  s.metaEl.textContent = parts.filter(Boolean).join('  ·  ')
}

function setHint(s: OpenState, text: string): void {
  s.foot.textContent = text
}

function renderContent(s: OpenState): void {
  const e = s.entry
  clearPreviewBody(s.body)
  s.body.classList.remove('pk-body-grid')
  s.members = []
  s.tiles = []
  s.active = -1
  s.io?.disconnect()
  s.io = null
  setCaption(s, e.name, [
    typeLabelFor(e),
    e.isDir ? undefined : formatSize(e.size),
    e.mtime ? formatDate(e.mtime) : undefined,
  ])
  setHint(s, e.isDir ? 'Enter opens · Esc closes' : '↑↓ next item · Enter opens · Esc closes')

  if (e.isDir && e.path.startsWith('/')) { renderFolder(s, e); return }
  if (e.isDir && isArchiveUri(e.path)) { renderArchiveFolder(s, e); return }
  if (isArchiveUri(e.path)) { renderMember(s, e); return }
  renderFile(s, e)
}

function renderFile(s: OpenState, e: FileEntry): void {
  const host: PreviewHost = {
    body: s.body,
    setCaption: (name, parts) => setCaption(s, name, parts),
    alive: () => state === s && s.gen === gen,
    rerender: () => { if (state === s) renderContent(s) },
    forced: s.forced,
    compact: true,
  }
  renderPreview(host, e)
}

/**
 * A file INSIDE an archive has no path on disk, so previewing it means
 * extracting it first. Small members go through the same batched extractor the
 * tile thumbnails use (items.ts, cached per archive mtime) and then preview for
 * real; anything bigger stays an icon rather than costing a 7z run and a
 * temp-file write for a glance.
 */
function renderMember(s: OpenState, e: FileEntry): void {
  if (e.size > PEEK.memberMaxBytes) { renderFile(s, e); return }
  const loading = note(s.body, 'Extracting…', 'pv-dim')
  void archiveMemberPath(e.path).then(local => {
    if (state !== s || s.gen !== gen) return
    loading.remove()
    // the extracted copy keeps the member's name and size; only the path moves
    renderFile(s, local ? { ...e, path: local } : e)
  }, () => {
    if (state !== s || s.gen !== gen) return
    loading.remove()
    renderFile(s, e)
  })
}

// ---- folder: bounded listing + lazy thumbnail grid --------------------------

function renderFolder(s: OpenState, e: FileEntry): void {
  const loading = note(s.body, 'Reading…', 'pv-dim')
  const token = tokenSeq++
  s.token = token
  const t0 = performance.now()
  void liq.invoke('peekDir', {
    path: e.path,
    showHidden: app.settings.showHidden,
    limit: PEEK.gridLimit,
    token,
  }).then((res: PeekDirResult) => {
    if (state !== s || s.gen !== gen) return          // the pointer moved on
    s.token = 0
    loading.remove()
    if (res.error) { note(s.body, res.error); return }
    if (res.timedOut) {
      note(s.body, 'This folder is taking too long to read.')
      return
    }
    setCaption(s, e.name, [
      'File folder',
      `${res.partialCount ? 'over ' : ''}${res.total.toLocaleString('en-US')} item${res.total === 1 ? '' : 's'}`,
      e.mtime ? formatDate(e.mtime) : undefined,
    ])
    if (!res.entries.length) { note(s.body, 'This folder is empty.'); return }
    buildGrid(s, res.entries)
    if (res.total > res.entries.length) {
      const more = res.total - res.entries.length
      note(s.body, `…and ${more.toLocaleString('en-US')} more`, 'pv-dim')
    }
    // how long the bounded read actually took — the number that matters on a
    // slow mount, and the one the peek budget is tuned against
    s.pop.dataset.ms = String(Math.round(performance.now() - t0))
  }, () => {
    if (state !== s) return
    s.token = 0
    loading.remove()
    note(s.body, 'This folder could not be read.')
  })
}

/** a folder INSIDE an archive: 7z lists it, nothing is extracted to look */
function renderArchiveFolder(s: OpenState, e: FileEntry): void {
  const loading = note(s.body, 'Reading archive…', 'pv-dim')
  void Promise.resolve(liq.archiveList(e.path)).then((entries: FileEntry[]) => {
    if (state !== s || s.gen !== gen) return
    loading.remove()
    const rows = [...entries].sort((a, b) =>
      (a.isDir === b.isDir ? 0 : a.isDir ? -1 : 1) ||
      a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }))
    setCaption(s, e.name, ['Folder in archive', `${rows.length} item${rows.length === 1 ? '' : 's'}`])
    if (!rows.length) { note(s.body, 'This folder is empty.'); return }
    buildGrid(s, rows.slice(0, PEEK.gridLimit))
  }, () => {
    if (state !== s) return
    loading.remove()
    note(s.body, 'This archive could not be read.')
  })
}

function buildGrid(s: OpenState, entries: FileEntry[]): void {
  const grid = el('div', 'pk-grid')
  s.body.classList.add('pk-body-grid')
  s.members = entries
  s.tiles = []

  // LAZY: a tile gets its icon and its thumbnail only when it scrolls into the
  // popover's own viewport. Peeking a folder of 200 videos must not fire 200
  // thumbnailer runs for the 12 tiles that are actually visible.
  const io = new IntersectionObserver((recs) => {
    for (const r of recs) {
      if (!r.isIntersecting) continue
      const img = r.target as HTMLImageElement
      io.unobserve(img)
      const src = img.dataset.src
      if (src) { img.src = src; delete img.dataset.src }
    }
  }, { root: s.body, rootMargin: '160px 0px' })
  s.io = io

  entries.forEach((e, i) => {
    const tile = el('div', 'pk-tile')
    tile.dataset.i = String(i)
    const box = el('div', 'pk-thumb')
    const img = document.createElement('img')
    img.draggable = false
    img.alt = ''
    const fallback = iconURL(e, 48)
    if (!isArchiveUri(e.path) && wantsThumb(e, 'large')) {
      img.dataset.src = `liqthumb://?path=${encodeURIComponent(e.path)}&size=large`
      img.addEventListener('error', () => {
        img.onerror = () => { img.style.visibility = 'hidden' }
        img.src = fallback
      }, { once: true })
    } else {
      img.dataset.src = fallback
      img.addEventListener('error', () => { img.style.visibility = 'hidden' })
    }
    box.appendChild(img)
    io.observe(img)
    const label = el('div', 'pk-tile-name', displayName(e, app.settings.showExtensions))
    label.title = e.name
    tile.append(box, label)
    tile.addEventListener('mouseenter', () => setActive(s, i, false))
    tile.addEventListener('dblclick', () => openEntry(s, e))
    grid.appendChild(tile)
    s.tiles.push(tile)
  })
  s.body.appendChild(grid)
}

function setActive(s: OpenState, i: number, scroll = true): void {
  if (i < 0 || i >= s.tiles.length) return
  if (s.active >= 0) s.tiles[s.active]?.classList.remove('is-active')
  s.active = i
  const t = s.tiles[i]
  t.classList.add('is-active')
  if (scroll) t.scrollIntoView({ block: 'nearest' })
  const e = s.members[i]
  if (e) {
    setCaption(s, e.name, [
      typeLabelFor(e), e.isDir ? undefined : formatSize(e.size),
      e.mtime ? formatDate(e.mtime) : undefined,
    ])
  }
}

// ---------------------------------------------------------------- opening

/** Explorer's open semantics, mirrored from core/actions.ts open(). */
function openEntry(s: OpenState, e: FileEntry): void {
  const tab = s.source.tab()
  closePeek()
  if (!tab) return
  s.source.onActivate?.()
  if (e.isDir) { void tab.navigate(e.path); return }
  if (isArchiveUri(e.path)) {
    void archiveMemberPath(e.path).then(local => { if (local) void liq.openPath(local) })
    return
  }
  if (isArchiveName(e.name)) { void tab.navigate(archiveUri(e.path)); return }
  void liq.openPath(e.path)
}

/** Space on a file peek walks the folder, like Quick Look's arrow keys. */
function stepEntry(s: OpenState, dir: 1 | -1): void {
  const tab = s.source.tab()
  if (!tab) return
  const rows = tab.rows
  const i = rows.findIndex(r => r.path === s.entry.path)
  const next = rows[(i < 0 ? 0 : i + dir)]
  if (!next) return
  tab.anchorPath = next.path
  tab.setSelection([next.path], next.path)
  s.entry = next
  s.gen = ++gen
  s.forced.clear()
  if (s.token) { void liq.invoke('peekCancel', s.token).catch(() => {}); s.token = 0 }
  s.pop.setAttribute('aria-label', `Peek: ${next.name}`)
  renderContent(s)
}

// ---------------------------------------------------------------- keyboard

/** the registered view whose scroller currently owns keyboard focus */
function focusedSource(): PeekSource | null {
  const a = document.activeElement
  if (!(a instanceof HTMLElement)) return null
  return sources.find(s => s.scroller === a || s.scroller.contains(a)) ?? null
}

function focusedEntry(tab: Tab): FileEntry | null {
  const p = tab.focusPath ?? [...tab.selection][0]
  if (!p) return null
  return tab.rows.find(r => r.path === p) ?? null
}

/** Space on the focused item, from the item view. */
function peekFocused(src: PeekSource): boolean {
  const tab = src.tab()
  if (!tab) return false
  const e = focusedEntry(tab)
  if (!e) return false
  // anchor on the focused row when it is rendered (it may be scrolled out of
  // the virtualized window), so the popover opens next to what it describes
  const anchor = src.scroller.querySelector('.vh-item.focused') as HTMLElement | null
  openPeek({ entry: e, source: src, via: 'key', anchorEl: anchor ?? src.scroller, x: 0, y: 0 })
  return true
}

function gridCols(s: OpenState): number {
  if (s.tiles.length < 2) return 1
  const top = s.tiles[0].offsetTop
  let n = 0
  for (const t of s.tiles) { if (t.offsetTop !== top) break; n++ }
  return Math.max(1, n)
}

function layerBusy(): boolean {
  return !!document.getElementById('menu-layer')?.childElementCount
    || !!document.getElementById('dialog-layer')?.childElementCount
}

function onKeyDown(e: KeyboardEvent): void {
  const s = state
  if (e.key === 'Escape' && s) {
    closePeek()
    // a menu or dialog opened over the peek owns Escape too — swallowing it
    // here would leave the thing on top open
    if (!layerBusy()) { e.preventDefault(); e.stopPropagation() }
    return
  }
  if (e.ctrlKey || e.altKey || e.metaKey) return

  // ---- inside the popover ----
  if (s && s.pop.contains(document.activeElement)) {
    const grid = s.tiles.length > 0
    const stop = (): void => { e.preventDefault(); e.stopPropagation() }
    switch (e.key) {
      case ' ':
        stop(); closePeek(); return
      case 'Enter':
        stop()
        openEntry(s, grid && s.active >= 0 ? s.members[s.active] : s.entry)
        return
      case 'ArrowRight':
        stop()
        if (grid) setActive(s, s.active < 0 ? 0 : s.active + 1)
        else stepEntry(s, 1)
        return
      case 'ArrowLeft':
        stop()
        if (grid) setActive(s, s.active < 0 ? 0 : s.active - 1)
        else stepEntry(s, -1)
        return
      case 'ArrowDown':
        stop()
        if (grid) setActive(s, s.active < 0 ? 0 : s.active + gridCols(s))
        else stepEntry(s, 1)
        return
      case 'ArrowUp':
        stop()
        if (grid) setActive(s, s.active < 0 ? 0 : s.active - gridCols(s))
        else stepEntry(s, -1)
        return
      case 'Home':
        if (grid) { stop(); setActive(s, 0) }
        return
      case 'End':
        if (grid) { stop(); setActive(s, s.tiles.length - 1) }
        return
      default:
        return
    }
  }

  // ---- Space from an item view: open (or close) the peek ----
  if (e.key !== ' ' || e.shiftKey) return
  if (busy()) return
  const src = focusedSource()
  if (!src) {
    if (s) { e.preventDefault(); e.stopPropagation(); closePeek() }
    return
  }
  cancelHover()
  // Space on the item a hover peek is already showing closes it; on any other
  // item the keyboard peek replaces it (and becomes sticky)
  const tab = src.tab()
  const want = tab ? focusedEntry(tab) : null
  if (s && (!want || want.path === s.entry.path)) {
    e.preventDefault(); e.stopPropagation()
    closePeek()
    return
  }
  if (peekFocused(src)) { e.preventDefault(); e.stopPropagation() }
}

// ---------------------------------------------------------------- global wiring

function install(): void {
  // capture phase: Space must be taken before view-host's own keydown adds the
  // focused item to the selection, and Escape before anything else closes
  document.addEventListener('keydown', onKeyDown, true)

  document.addEventListener('mousedown', (e) => {
    if (!state) return
    if (state.pop.contains(e.target as Node)) return
    closePeek()
  }, true)

  // a drag must never have a popover sitting in its path
  document.addEventListener('dragstart', () => { dragging = true; cancelHover(); closePeek() }, true)
  document.addEventListener('dragend', () => { dragging = false }, true)
  document.addEventListener('drop', () => { dragging = false }, true)

  window.addEventListener('blur', () => { cancelHover(); closePeek() })
  window.addEventListener('resize', () => closePeek())

  app.on('tab-navigated', () => closePeek())
  app.on('tabs-changed', () => closePeek())
  app.on('panes-changed', () => closePeek())
  // the verb, for anything that wants to offer Peek without knowing about this
  // module: a context-menu item, a command-bar button, another key binding
  app.on('peek-focused-item', () => {
    const src = focusedSource() ?? sources[0]
    if (src) peekFocused(src)
  })
}

install()
