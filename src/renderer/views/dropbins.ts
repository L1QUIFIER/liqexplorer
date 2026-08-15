// DROP BINS — a dock of drag targets in the bottom-right corner of the file view.
//
// Two things live here, and the second is the one drag & drop cannot do on its
// own (macOS Dropzone / Yoink solve exactly this):
//   * ACTION BINS  — drop files on a tile and the action runs on them at once.
//   * THE STACK    — drop files from as many different folders as you like to
//                    accumulate them, then pick ONE action for the whole pile.
//                    Nothing else in a file manager lets you collect from five
//                    folders and then act; a normal drag has to complete before
//                    you can navigate away.
//
// Interaction model: the dock is a 40px pill at rest, and the tray OPENS BY
// ITSELF the moment a drag starts anywhere in the app — which is the only
// moment it is useful — then closes shortly after the drag ends. Clicking the
// pill pins it open, and the pinned state is persisted. Clicking a tile runs
// that bin on the current selection, so the whole feature also works without
// dragging at all.
//
// SELF-MOUNTING: this module builds its own container, appends it to
// document.body and injects its own <link> for styles/dropbins.css, so neither
// index.html nor index.ts needs a line for the UI. It only has to be imported
// once (see the one-line hook in core/scrollhover.ts).
import { app, liq } from '../core/app'
import type { FileEntry } from '../../shared/types'
import { showMenu } from '../menus/menu'
import { iconImg } from '../dialogs/dialogs'
import { openBinSettings } from '../dialogs/binsettings'
import type { BinConfig } from '../../shared/bins'
import {
  bins, clearStack, dragHasPaths, loadBins, onBinsChanged, patchBins, readDropPaths,
  removeFromStack, setToastHost, targetLabel, toast,
} from './binstore'
import { binSubtitle, runBin } from './binrun'

const ICONS: Record<string, string> = {
  stack: '<path d="M8 2 2 5l6 3 6-3-6-3Z"/><path d="M2.4 8.2 8 11l5.6-2.8"/><path d="M2.4 11.2 8 14l5.6-2.8"/>',
  copy: '<rect x="5.5" y="5.5" width="8" height="8" rx="1.6"/><path d="M10.5 3.6A1.6 1.6 0 0 0 8.9 2H4.1a1.6 1.6 0 0 0-1.6 1.6v4.8A1.6 1.6 0 0 0 4.1 10"/>',
  move: '<path d="M2 12.4V4.2c0-.6.5-1.1 1.1-1.1h2.8l1.3 1.6h5.7c.6 0 1.1.5 1.1 1.1v6.6c0 .6-.5 1.1-1.1 1.1H3.1A1.1 1.1 0 0 1 2 12.4Z"/><path d="M5.9 8.7h4.3M8.4 7l1.8 1.7-1.8 1.8"/>',
  symlink: '<path d="M6.6 9.4a2.6 2.6 0 0 0 3.9.3l2-2a2.6 2.6 0 0 0-3.7-3.7l-1.1 1.1"/><path d="M9.4 6.6a2.6 2.6 0 0 0-3.9-.3l-2 2a2.6 2.6 0 0 0 3.7 3.7l1.1-1.1"/>',
  trash: '<path d="M2.8 4.3h10.4M6.3 4.3V3.2c0-.5.4-.9.9-.9h1.6c.5 0 .9.4.9.9v1.1M4.3 4.3l.6 8.2c0 .7.6 1.3 1.3 1.3h3.6c.7 0 1.3-.6 1.3-1.3l.6-8.2"/>',
  compress: '<rect x="2.5" y="5.6" width="11" height="7.9" rx="1.2"/><path d="M5.4 5.6V3.3c0-.4.3-.8.8-.8h3.6c.5 0 .8.4.8.8v2.3"/><path d="M8 7.6v3.3M6.5 9.4 8 10.9l1.5-1.5"/>',
  extract: '<rect x="2.5" y="5.6" width="11" height="7.9" rx="1.2"/><path d="M5.4 5.6V3.3c0-.4.3-.8.8-.8h3.6c.5 0 .8.4.8.8v2.3"/><path d="M8 11.2V7.9M6.5 9.4 8 7.9l1.5 1.5"/>',
  favorites: '<path d="m8 2.3 1.8 3.6 4 .6-2.9 2.8.7 4L8 11.4l-3.6 1.9.7-4-2.9-2.8 4-.6z"/>',
  bulkRename: '<path d="M11.1 2.9a1.8 1.8 0 0 1 2.5 2.5l-7.3 7.3-3.3.8.8-3.3z"/><path d="m9.8 4.2 2.5 2.5"/>',
  convert: '<rect x="2.5" y="3.6" width="11" height="8.8" rx="1.4"/><circle cx="6" cy="6.7" r="1"/><path d="m2.9 11.3 3.1-2.8 2.2 2 2-1.7 3 2.6"/>',
  checksums: '<path d="M5.7 2.6 4.5 13.4M11.6 2.6l-1.2 10.8M2.8 5.9h10.4M2.3 10.1h10.4"/>',
}
const PILL_ICON =
  '<path d="M2.5 9.4h3.2l.9 1.8h2.8l.9-1.8h3.2"/><path d="M4.2 3.4h7.6l2.2 6v3.1c0 .5-.4.9-.9.9H2.9a.9.9 0 0 1-.9-.9V9.4z"/>'

/** How long the tray stays open after a drag ends. Long enough not to snap shut
 *  between two drags, short enough not to sit on the file view. */
const COLLAPSE_MS = 900
/** A drag that ended outside the window fires no dragend here, so the open
 *  state is also released when no dragover has been seen for this long. */
const DRAG_IDLE_MS = 700

let root: HTMLElement | null = null
let tray: HTMLElement | null = null
let tilesHost: HTMLElement | null = null
let pill: HTMLButtonElement | null = null
let pillBadge: HTMLElement | null = null
let pinBtn: HTMLButtonElement | null = null
let stackPanel: HTMLElement | null = null

let dragging = false
let lastDragAt = 0
let idleTimer = 0
let collapseTimer = 0
let open = false
let hovered = false
/** a pointer drag of the dock itself is in progress */
let dockDragging = false

function svg(paths: string): string {
  return `<svg viewBox="0 0 16 16">${paths}</svg>`
}

// ------------------------------------------------------------------ open state

function setOpen(next: boolean): void {
  if (open === next) return
  open = next
  if (!root || !tray) return
  root.dataset.open = String(open)
  tray.hidden = !open
  if (open) renderTiles()
  else closeStackPanel()
  // opening grows the dock by ~550px. Free-floating, a position that was fine
  // for the collapsed pill can put the open tray off the bottom of the window,
  // so re-clamp against the size it has NOW.
  layout()
}

function scheduleCollapse(): void {
  window.clearTimeout(collapseTimer)
  collapseTimer = window.setTimeout(() => {
    // dockDragging: the pointer leaves the dock constantly while moving it
    if (bins().pinned || dragging || hovered || stackPanel || dockDragging) return
    setOpen(false)
  }, COLLAPSE_MS)
}

function setDragging(next: boolean): void {
  if (dragging === next) return
  dragging = next
  if (dragging) {
    window.clearTimeout(collapseTimer)
    setOpen(true)
    if (!idleTimer) {
      idleTimer = window.setInterval(() => {
        if (dragging && Date.now() - lastDragAt > DRAG_IDLE_MS) setDragging(false)
      }, 250)
    }
  } else {
    window.clearInterval(idleTimer)
    idleTimer = 0
    if (!bins().pinned) scheduleCollapse()
  }
}

// -------------------------------------------------------------------- layout
//
// Two modes. DOCKED is the original: bottom-right, riding above the status bar
// and stepping up over the ops card. FREE is wherever the user dragged it.
//
// Free position lives in localStorage, not in dropbins.json: sanitize() in
// main/state/bins.ts rebuilds that object field by field, so a new top-level
// key is dropped on the next save — and the config is broadcast to every
// window, which would make two windows fight over one dock position. Every
// other geometry in this app (mv-geom, sidepane-w, navpane-w) is localStorage
// for the same reason.

const POS_KEY = 'db-dock-pos'
/** dropped this close to the home corner = snap back to docked */
const SNAP_PX = 48

interface DockPos { x: number; y: number }

let freePos: DockPos | null = null
/** suppresses the click that ends a drag (the pill's click also toggles pinned) */
let consumedClick = false

function loadPos(): DockPos | null {
  try {
    const raw = localStorage.getItem(POS_KEY)
    if (!raw) return null
    const p = JSON.parse(raw) as DockPos
    return Number.isFinite(p?.x) && Number.isFinite(p?.y) ? p : null
  } catch { return null }
}

function savePos(p: DockPos | null): void {
  try {
    if (p) localStorage.setItem(POS_KEY, JSON.stringify(p))
    else localStorage.removeItem(POS_KEY)
  } catch { /* storage full or disabled */ }
}

/** keep the dock on screen — the window may be smaller than when it was left */
function clampPos(p: DockPos): DockPos {
  if (!root) return p
  const r = root.getBoundingClientRect()
  const w = r.width || 56
  const h = r.height || 56
  return {
    x: Math.max(0, Math.min(window.innerWidth - w, p.x)),
    y: Math.max(0, Math.min(window.innerHeight - h, p.y)),
  }
}

/** Ride above the status bar, and step up over the ops flyout while a copy is
 *  running so the two cards never sit on top of each other. Free-floating, the
 *  user's position wins — but the promise not to sit on the ops card is kept
 *  with a transient nudge that is never written back. */
function layout(): void {
  if (!root) return
  const flyout = document.getElementById('ops-flyout')
  const fH = flyout && flyout.childElementCount ? flyout.getBoundingClientRect().height : 0

  if (freePos) {
    const p = clampPos(freePos)
    root.style.left = `${p.x}px`
    root.style.top = `${p.y}px`
    // grow the tray the right way round for whichever corner it is nearest
    const r = root.getBoundingClientRect()
    root.classList.toggle('db-flip-y', p.y + r.height / 2 < window.innerHeight / 2)
    root.classList.toggle('db-flip-x', p.x + r.width / 2 < window.innerWidth / 2)
    // only nudge when it would actually overlap the ops card's corner
    const overlaps = !!fH && p.x + r.width > window.innerWidth - 360
      && p.y + r.height > window.innerHeight - fH - 60
    root.style.transform = overlaps ? `translateY(${-(fH + 8)}px)` : ''
    return
  }

  root.style.left = root.style.top = root.style.transform = ''
  root.classList.remove('db-flip-x', 'db-flip-y')
  const sb = document.getElementById('statusbar')
  const sbH = sb && sb.offsetParent !== null ? sb.offsetHeight : 0
  root.style.setProperty('--db-bottom', `${sbH + 16 + (fH ? fH + 8 : 0)}px`)
}

function setFree(p: DockPos | null): void {
  freePos = p
  savePos(p)
  root?.classList.toggle('db-free', !!p)
  layout()
}

/**
 * Drag the whole dock. Handles are the tray's title strip and the pill —
 * never the tiles, which are drop targets that also run on click, so a 3px
 * wobble on one would be ambiguous.
 */
function startDockDrag(e: PointerEvent, handle: HTMLElement): void {
  if (e.button !== 0 || !root) return
  if ((e.target as HTMLElement).closest('button') && handle !== e.currentTarget) return
  const start = root.getBoundingClientRect()
  const dx = e.clientX - start.left
  const dy = e.clientY - start.top
  const ox = e.clientX
  const oy = e.clientY
  let armed = false

  const move = (ev: PointerEvent): void => {
    if (!armed) {
      // a 4px threshold: below it this is a click, and the pill's click both
      // toggles the tray and writes `pinned`
      if (Math.abs(ev.clientX - ox) < 4 && Math.abs(ev.clientY - oy) < 4) return
      armed = true
      dockDragging = true
      root?.classList.add('db-moving')
      handle.setPointerCapture?.(e.pointerId)
    }
    setFree(clampPos({ x: ev.clientX - dx, y: ev.clientY - dy }))
  }

  const up = (): void => {
    window.removeEventListener('pointermove', move)
    window.removeEventListener('pointerup', up)
    if (!armed) return
    dockDragging = false
    consumedClick = true
    root?.classList.remove('db-moving')
    // dropped back in its home corner: return to docked, so the ops-card
    // stepping and the status-bar tracking come back exactly as before
    const r = root!.getBoundingClientRect()
    const home = Math.abs(window.innerWidth - r.right) < SNAP_PX
      && Math.abs(window.innerHeight - r.bottom) < SNAP_PX + 44
    if (home) setFree(null)
    if (!bins().pinned) scheduleCollapse()
  }

  window.addEventListener('pointermove', move)
  window.addEventListener('pointerup', up)
}

// --------------------------------------------------------------------- tiles

function effectFor(bin: BinConfig, dt: DataTransfer | null): 'copy' | 'move' {
  // 'link' is never offered: views/dnd.ts starts internal drags with
  // effectAllowed='copyMove', and an effect outside that set makes Chromium
  // refuse the drop outright.
  const internal = !!dt && Array.from(dt.types).includes('application/x-liq-paths')
  if (!internal) return 'copy'
  return bin.action === 'move' || bin.action === 'trash' ? 'move' : 'copy'
}

function flash(tile: HTMLElement): void {
  tile.classList.remove('db-flash')
  void tile.offsetWidth        // restart the animation
  tile.classList.add('db-flash')
}

function selectionPaths(): string[] {
  const t = app.activeTab
  if (!t) return []
  return [...t.selection].filter(p => p.startsWith('/') && !p.includes('://'))
}

function tileMenu(bin: BinConfig, x: number, y: number): void {
  showMenu([
    {
      label: 'Use on selection',
      disabled: !selectionPaths().length,
      onClick: () => { void runBin(bin, selectionPaths()) },
    },
    { separator: true },
    { label: 'Configure…', onClick: () => openBinSettings(bin.id) },
    {
      label: 'Remove bin',
      danger: true,
      onClick: () => patchBins({ bins: bins().bins.filter(b => b.id !== bin.id) }),
    },
    { separator: true },
    { label: 'Manage bins…', onClick: () => openBinSettings() },
  ], { x, y, minWidth: 180 })
}

function buildTile(bin: BinConfig): HTMLElement {
  const tile = document.createElement('button')
  tile.className = 'db-tile' + (bin.action === 'trash' ? ' db-danger' : '')
  tile.dataset.bin = bin.id

  const ico = document.createElement('span')
  ico.className = 'db-ico'
  ico.innerHTML = svg(ICONS[bin.action] ?? ICONS.copy)

  const text = document.createElement('span')
  text.className = 'db-text'
  const label = document.createElement('span')
  label.className = 'db-label'
  label.textContent = bin.label
  const sub = document.createElement('span')
  sub.className = 'db-sub'
  sub.textContent = binSubtitle(bin, targetLabel(bin))
  text.append(label, sub)

  tile.append(ico, text)

  if (bin.action === 'stack') {
    const badge = document.createElement('span')
    badge.className = 'db-badge'
    badge.textContent = String(bins().stack.length)
    badge.hidden = !bins().stack.length
    tile.appendChild(badge)
  }

  tile.addEventListener('dragover', (e) => {
    if (!dragHasPaths(e.dataTransfer)) return
    e.preventDefault()
    e.stopPropagation()
    if (e.dataTransfer) e.dataTransfer.dropEffect = effectFor(bin, e.dataTransfer)
    tile.classList.add('db-over')
  })
  tile.addEventListener('dragleave', () => tile.classList.remove('db-over'))
  tile.addEventListener('drop', (e) => {
    e.preventDefault()
    e.stopPropagation()
    tile.classList.remove('db-over')
    const paths = readDropPaths(e.dataTransfer)
    setDragging(false)
    if (!paths.length) {
      toast({ text: 'Nothing usable was dropped here.', bad: true })
      return
    }
    flash(tile)
    void runBin(bin, paths)
  })

  tile.addEventListener('click', () => {
    if (bin.action === 'stack') { toggleStackPanel(); return }
    const sel = selectionPaths()
    if (!sel.length) {
      toast({ text: `Drag files onto "${bin.label}".`, sub: 'Or select some first, then click the bin.' })
      return
    }
    flash(tile)
    void runBin(bin, sel)
  })
  tile.addEventListener('contextmenu', (e) => {
    e.preventDefault()
    e.stopPropagation()
    tileMenu(bin, e.clientX, e.clientY)
  })
  return tile
}

function renderTiles(): void {
  if (!tilesHost) return
  tilesHost.innerHTML = ''
  const list = bins().bins.filter(b => !b.hidden)
  if (!list.length) {
    const empty = document.createElement('div')
    empty.className = 'db-empty'
    empty.textContent = 'Every bin is hidden. Use the gear to bring some back.'
    tilesHost.appendChild(empty)
    return
  }
  for (const b of list) tilesHost.appendChild(buildTile(b))
  const openId = stackPanel ? bins().bins.find(b => b.action === 'stack')?.id : null
  if (openId) tilesHost.querySelector(`[data-bin="${CSS.escape(openId)}"]`)?.classList.add('db-open')
}

/** Counts and toggle states change constantly (every item added to the Stack);
 *  updating them in place keeps the drop-confirmation flash on the tile that
 *  was just used instead of rebuilding it out from under the animation. */
function syncBadges(): void {
  const n = bins().stack.length
  if (pillBadge) {
    pillBadge.textContent = String(n)
    pillBadge.hidden = !n
  }
  pinBtn?.classList.toggle('on', bins().pinned)
  const stackId = bins().bins.find(b => b.action === 'stack')?.id
  if (stackId && tilesHost) {
    const badge = tilesHost.querySelector<HTMLElement>(`[data-bin="${CSS.escape(stackId)}"] .db-badge`)
    if (badge) {
      badge.textContent = String(n)
      badge.hidden = !n
    }
  }
}

/** identity of the tray layout: rebuild the tiles only when this changes */
function binsSignature(): string {
  return JSON.stringify(bins().bins)
}

// ---------------------------------------------------------------- stack panel

function closeStackPanel(): void {
  stackPanel?.remove()
  stackPanel = null
  tilesHost?.querySelector('.db-open')?.classList.remove('db-open')
}

function toggleStackPanel(): void {
  if (stackPanel) { closeStackPanel(); return }
  if (!root || !tray) return
  const panel = document.createElement('div')
  panel.className = 'db-stack'
  stackPanel = panel
  root.insertBefore(panel, tray)
  renderStackPanel()
  renderTiles()
}

function renderStackPanel(): void {
  const panel = stackPanel
  if (!panel) return
  const paths = bins().stack
  panel.innerHTML = ''

  const head = document.createElement('div')
  head.className = 'db-head'
  const title = document.createElement('span')
  title.className = 'db-head-title'
  title.textContent = paths.length ? `Stack — ${paths.length} item${paths.length === 1 ? '' : 's'}` : 'Stack'
  head.appendChild(title)
  const closeBtn = document.createElement('button')
  closeBtn.className = 'db-ibtn'
  closeBtn.title = 'Close'
  closeBtn.innerHTML = '<svg width="10" height="10" viewBox="0 0 10 10"><path d="M1 1l8 8M9 1l-8 8" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" fill="none"/></svg>'
  closeBtn.addEventListener('click', closeStackPanel)
  head.appendChild(closeBtn)
  panel.appendChild(head)

  const list = document.createElement('div')
  list.className = 'db-stack-list'
  panel.appendChild(list)

  if (!paths.length) {
    const empty = document.createElement('div')
    empty.className = 'db-empty'
    empty.textContent = 'Drop files here from any folder. They pile up until you pick an action — that is the point.'
    list.appendChild(empty)
  } else {
    // one stat round trip for icons + "is it still there"; the Stack itself is
    // never validated on load, because a dead network mount would hang startup
    void liq.statEntries(paths).then((stats: (FileEntry | null)[]) => {
      if (stackPanel !== panel) return
      list.innerHTML = ''
      paths.forEach((p, i) => list.appendChild(stackRow(p, stats[i] ?? null, true)))
    }).catch(() => { /* rows already rendered below */ })
    for (const p of paths) list.appendChild(stackRow(p, null, false))
  }

  const foot = document.createElement('div')
  foot.className = 'db-foot'
  const use = document.createElement('button')
  use.className = 'btn btn-small btn-primary'
  use.textContent = 'Use with…'
  use.disabled = !paths.length
  use.addEventListener('click', () => {
    const r = use.getBoundingClientRect()
    showMenu(
      bins().bins.filter(b => b.action !== 'stack' && !b.hidden).map(b => ({
        label: b.label,
        onClick: () => { void runBin(b, bins().stack, { fromStack: true }) },
      })),
      { x: r.left, y: r.top, minWidth: 190 },
    )
  })
  const dragOut = document.createElement('button')
  dragOut.className = 'btn btn-small'
  dragOut.textContent = 'Copy'
  dragOut.title = 'Put the whole Stack on the clipboard'
  dragOut.disabled = !paths.length
  dragOut.addEventListener('click', () => {
    void liq.clipboardSet({ op: 'copy', paths: bins().stack })
    toast({ text: `${bins().stack.length} items copied — paste anywhere.` })
  })
  const clear = document.createElement('button')
  clear.className = 'btn btn-small'
  clear.textContent = 'Clear'
  clear.disabled = !paths.length
  clear.addEventListener('click', () => clearStack())
  const spacer = document.createElement('div')
  spacer.className = 'db-foot-spacer'
  foot.append(use, dragOut, spacer, clear)
  panel.appendChild(foot)
}

/** `stated` distinguishes "not looked up yet" from "looked up and gone", so a
 *  file deleted behind the app's back is struck through instead of vanishing. */
function stackRow(p: string, st: FileEntry | null, stated: boolean): HTMLElement {
  const row = document.createElement('div')
  row.className = 'db-srow' + (stated && !st ? ' db-missing' : '')
  row.draggable = true
  const img = iconImg(st?.icons ?? ['text-x-generic'], 16)
  const text = document.createElement('div')
  text.className = 'db-srow-text'
  const name = document.createElement('span')
  name.className = 'db-srow-name'
  name.textContent = p.split('/').pop() || p
  const dir = document.createElement('span')
  dir.className = 'db-srow-dir'
  dir.textContent = p.slice(0, p.lastIndexOf('/')) || '/'
  text.append(name, dir)
  const x = document.createElement('button')
  x.className = 'db-srow-x'
  x.title = 'Remove from Stack'
  x.innerHTML = '<svg width="9" height="9" viewBox="0 0 10 10"><path d="M1 1l8 8M9 1l-8 8" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" fill="none"/></svg>'
  x.addEventListener('click', (e) => { e.stopPropagation(); removeFromStack([p]) })
  row.append(img, text, x)
  row.title = p

  // dragging out of the Stack speaks the app's own drag language, so it can be
  // dropped straight into a folder in the view or onto the nav pane
  row.addEventListener('dragstart', (e) => {
    if (!e.dataTransfer) return
    e.dataTransfer.setData('application/x-liq-paths', JSON.stringify([p]))
    e.dataTransfer.setData('text/uri-list', 'file://' + p.split('/').map(encodeURIComponent).join('/'))
    e.dataTransfer.effectAllowed = 'copyMove'
  })
  row.addEventListener('dblclick', () => {
    if (st?.isDir) void app.activeTab?.navigate(p)
    else void liq.openPath(p)
  })
  return row
}

// ---------------------------------------------------------------------- mount

export function mountDropBins(): void {
  if (document.getElementById('db-dock')) return
  if (!document.body) {
    document.addEventListener('DOMContentLoaded', () => mountDropBins(), { once: true })
    return
  }

  // own stylesheet, so index.html needs no <link> (CSP allows same-origin css)
  if (!document.querySelector('link[data-db-style]')) {
    const link = document.createElement('link')
    link.rel = 'stylesheet'
    link.href = 'styles/dropbins.css'
    link.setAttribute('data-db-style', '1')
    document.head.appendChild(link)
  }

  root = document.createElement('div')
  root.id = 'db-dock'
  root.dataset.open = 'false'

  const toasts = document.createElement('div')
  toasts.className = 'db-toasts'
  setToastHost(toasts)

  tray = document.createElement('div')
  tray.className = 'db-tray'
  tray.hidden = true

  const head = document.createElement('div')
  head.className = 'db-head'
  const title = document.createElement('span')
  title.className = 'db-head-title'
  title.textContent = 'DROP BINS'
  const pin = document.createElement('button')
  pinBtn = pin
  pin.className = 'db-ibtn'
  pin.title = 'Keep open'
  pin.innerHTML = '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"><path d="M9.6 2.3 13.7 6.4M11 4.9 8.2 7.7l-.5 3-4.4-4.4 3-.5z"/><path d="m5.6 10.4-3 3"/></svg>'
  const gear = document.createElement('button')
  gear.className = 'db-ibtn'
  gear.title = 'Manage bins…'
  gear.innerHTML = '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3"><circle cx="8" cy="8" r="2.1"/><path d="M8 1.8v1.6M8 12.6v1.6M2.6 8H1M15 8h-1.6M4.2 4.2 3 3M13 13l-1.2-1.2M4.2 11.8 3 13M13 3l-1.2 1.2"/></svg>'
  gear.addEventListener('click', () => openBinSettings())
  pin.addEventListener('click', () => {
    patchBins({ pinned: !bins().pinned })
    if (bins().pinned) { window.clearTimeout(collapseTimer); setOpen(true) } else scheduleCollapse()
  })
  head.append(title, pin, gear)
  // the title strip is the drag handle; its two buttons keep their own clicks
  head.addEventListener('pointerdown', (e) => {
    if ((e.target as HTMLElement).closest('button')) return
    startDockDrag(e, head)
  })

  tilesHost = document.createElement('div')
  tilesHost.className = 'db-tiles'
  tray.append(head, tilesHost)

  pill = document.createElement('button')
  pill.className = 'db-pill'
  pill.title = 'Drop Bins — drag files here'
  pill.innerHTML = `<svg viewBox="0 0 16 16" width="18" height="18" fill="none" stroke="currentColor"
    stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round">${PILL_ICON}</svg>`
  const pillText = document.createElement('span')
  pillText.className = 'db-pill-text'
  pillText.textContent = 'Bins'
  pillBadge = document.createElement('span')
  pillBadge.className = 'db-badge'
  pillBadge.hidden = true
  pill.append(pillText, pillBadge)
  pill.addEventListener('click', () => {
    // a drag that ended on the pill must not also toggle and pin it
    if (consumedClick) { consumedClick = false; return }
    // clicking is an explicit choice, so it also pins: a tray you opened on
    // purpose must not evaporate the moment the pointer leaves it
    const next = !open
    patchBins({ pinned: next })
    setOpen(next)
  })
  const pillEl = pill
  pillEl.addEventListener('pointerdown', (e) => startDockDrag(e, pillEl))
  pill.addEventListener('contextmenu', (e) => {
    e.preventDefault()
    showMenu([
      { label: 'Keep open', checked: bins().pinned, onClick: () => { patchBins({ pinned: !bins().pinned }); if (bins().pinned) setOpen(true) } },
      // dragging it somewhere unreachable (or onto a monitor that has since
      // gone away) needs a way back that is not "find it first"
      { label: 'Reset position', disabled: !freePos, onClick: () => setFree(null) },
      { separator: true },
      { label: 'Manage bins…', onClick: () => openBinSettings() },
    ], { x: e.clientX, y: e.clientY, minWidth: 170 })
  })
  // a drag straight onto the collapsed pill opens the tray under the pointer
  pill.addEventListener('dragover', (e) => {
    if (!dragHasPaths(e.dataTransfer)) return
    e.preventDefault()
    e.stopPropagation()
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'
    setDragging(true)
  })

  root.append(toasts, tray, pill)
  document.body.appendChild(root)

  root.addEventListener('mouseenter', () => { hovered = true })
  root.addEventListener('mouseleave', () => { hovered = false; if (!dragging && !bins().pinned && !stackPanel) scheduleCollapse() })

  // --- drag detection -----------------------------------------------------
  // dragstart covers drags that begin in this window; dragover covers drags
  // arriving from another application, which never fire dragstart here.
  //
  // dragstart is taken in the BUBBLE phase on purpose: views/dnd.ts fills the
  // DataTransfer in its own handler on the item canvas, so a capture-phase
  // listener here would run first and see an empty payload — and the tray would
  // then also pop open for a text drag out of the inline rename box.
  document.addEventListener('dragstart', (e) => {
    lastDragAt = Date.now()
    if (dragHasPaths(e.dataTransfer)) setDragging(true)
  })
  document.addEventListener('dragover', (e) => {
    lastDragAt = Date.now()
    if (!dragging && dragHasPaths(e.dataTransfer)) setDragging(true)
  }, true)
  document.addEventListener('dragend', () => setDragging(false), true)
  document.addEventListener('drop', () => setDragging(false), true)

  // --- keep it out of the way ---------------------------------------------
  layout()
  window.addEventListener('resize', layout)
  const flyout = document.getElementById('ops-flyout')
  if (flyout) {
    new MutationObserver(layout).observe(flyout, { childList: true })
    new ResizeObserver(layout).observe(flyout)
  }
  const sb = document.getElementById('statusbar')
  if (sb) new ResizeObserver(layout).observe(sb)
  app.on('settings-changed', () => layout())

  let sig = binsSignature()
  onBinsChanged(() => {
    const next = binsSignature()
    const layoutChanged = next !== sig
    sig = next
    if (layoutChanged && open) renderTiles()
    syncBadges()
    if (stackPanel) renderStackPanel()
  })

  // restore where the user left it, clamped in case the window is smaller now
  const savedPos = loadPos()
  if (savedPos) setFree(savedPos)

  void loadBins().then(() => {
    sig = binsSignature()
    if (bins().pinned) setOpen(true)
    syncBadges()
  })
}

mountDropBins()
