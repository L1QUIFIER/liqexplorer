// Auto-scroll while dragging: hold a drag near an edge and the list scrolls.
//
// Two things were wrong with the version this replaces, and the second is the
// one that made it feel broken.
//
// 1. IT ONLY EXISTED IN ONE PLACE. views/dnd.ts scrolled the file list on
//    `dragover`, so it worked for a left drag in the item view and nowhere
//    else — not in the navigation tree, and not for a right-button drag, which
//    cannot use HTML5 drag-and-drop at all (Chromium starts native drags for
//    the left button only) and therefore never fires `dragover`.
//
// 2. IT ONLY SCROLLED WHEN THE POINTER MOVED. `dragover` fires on movement, so
//    a scroll driven from that handler advances one step per mouse event and
//    then stops. Holding the pointer at the bottom edge — which is exactly what
//    someone does when they want the list to keep going — produced no events
//    and no scrolling, and the only way to make progress was to jiggle the
//    mouse. A drag that has to be wiggled to work reads as a drag that does not
//    work.
//
// So the scroll is driven by a TIMER while the pointer sits in the edge zone,
// at a speed set by how far into that zone it is, and the target is whatever
// scrollable thing is under the pointer — which makes it work in any list
// without each one wiring it up.
//
// A timer rather than requestAnimationFrame on purpose: rAF does not run while
// the page is hidden, which is the normal state under the headless display this
// project is tested on, and a feature that cannot be tested is a feature that
// quietly rots.

/** distance from an edge at which scrolling starts */
const EDGE_PX = 40
/** px per tick at the very edge; the zone ramps up to this */
const MAX_STEP = 24
const TICK_MS = 16

let timer = 0
let target: HTMLElement | null = null
let stepX = 0
let stepY = 0

/** can this element actually scroll on the given axis right now? */
function scrolls(el: HTMLElement, axis: 'x' | 'y'): boolean {
  const cs = getComputedStyle(el)
  const o = axis === 'y' ? cs.overflowY : cs.overflowX
  if (o !== 'auto' && o !== 'scroll' && o !== 'overlay') return false
  return axis === 'y'
    ? el.scrollHeight > el.clientHeight + 1
    : el.scrollWidth > el.clientWidth + 1
}

/**
 * The nearest scrollable ancestor of whatever is under the pointer.
 *
 * Walking up from the pointer rather than being told which element to scroll is
 * what lets this work everywhere at once: the file list, the navigation tree, a
 * long dialog. Nothing has to register.
 */
function scrollableUnder(x: number, y: number): HTMLElement | null {
  let n = document.elementFromPoint(x, y) as HTMLElement | null
  for (; n && n !== document.body; n = n.parentElement) {
    if (scrolls(n, 'y') || scrolls(n, 'x')) return n
  }
  return null
}

/** how fast to scroll for a pointer this far past an edge (0 when inside) */
function speed(distIntoZone: number): number {
  if (distIntoZone <= 0) return 0
  // ramp, then clamp: at the very edge it is fast, a hair inside it crawls, and
  // dragging PAST the edge (a common way to ask for "more") stays at full speed
  const t = Math.min(1, distIntoZone / EDGE_PX)
  return Math.max(2, Math.round(MAX_STEP * t))
}

function tick(): void {
  if (!target || !target.isConnected || (!stepX && !stepY)) { stop(); return }
  if (stepY) target.scrollTop += stepY
  if (stepX) target.scrollLeft += stepX
}

function stop(): void {
  if (timer) { window.clearInterval(timer); timer = 0 }
  target = null
  stepX = stepY = 0
}

/**
 * Report the pointer during a drag. Safe to call on every move; also safe to
 * stop calling — the timer keeps the scroll going until told otherwise.
 */
export function autoScrollAt(clientX: number, clientY: number): void {
  const el = scrollableUnder(clientX, clientY)
  if (!el) { stop(); return }
  const r = el.getBoundingClientRect()

  let sy = 0
  if (scrolls(el, 'y')) {
    if (clientY < r.top + EDGE_PX) sy = -speed(r.top + EDGE_PX - clientY)
    else if (clientY > r.bottom - EDGE_PX) sy = speed(clientY - (r.bottom - EDGE_PX))
  }
  let sx = 0
  if (scrolls(el, 'x')) {
    if (clientX < r.left + EDGE_PX) sx = -speed(r.left + EDGE_PX - clientX)
    else if (clientX > r.right - EDGE_PX) sx = speed(clientX - (r.right - EDGE_PX))
  }

  if (!sx && !sy) { stop(); return }
  target = el
  stepX = sx
  stepY = sy
  if (!timer) timer = window.setInterval(tick, TICK_MS)
}

/** the drag ended, wherever and however */
export function autoScrollStop(): void { stop() }

// ONE listener for every HTML5 drag in the window, in the capture phase.
//
// The alternative is each scrollable surface calling autoScrollAt from its own
// dragover handler, and that is how the previous version ended up working in
// the file list and nowhere else — the navigation tree has its own drag
// handling and simply never called it. A capture-phase listener on the window
// sees every drag before any of them, so a list only has to be scrollable to
// get this, not to know about it.
//
// (A right-button drag still calls autoScrollAt directly from
// views/rightdrag.ts: it produces no dragover at all, which is the whole reason
// that gesture had no auto-scroll before.)
window.addEventListener('dragover', (e) => autoScrollAt(e.clientX, e.clientY), true)

// A drag can end in ways the gesture code does not always see. None of them
// should leave a list scrolling by itself.
window.addEventListener('dragend', stop, true)
window.addEventListener('drop', stop, true)
window.addEventListener('mouseup', stop, true)
window.addEventListener('blur', stop, true)
