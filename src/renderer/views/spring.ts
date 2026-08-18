// Spring loading: hold a drag still over something and it opens.
//
// There are TWO drag gestures in this app and they share no machinery. A
// left-drag is HTML5 drag-and-drop, so it speaks `dragover`/`dragleave`; a
// right-drag cannot be — Chromium only starts native drags for the left button
// — so views/rightdrag.ts drives its own with mouse events and
// `document.elementFromPoint`. Neither one can see the other's events.
//
// That is exactly how a feature ends up working on one mouse button and not the
// other, which is what happened here: tabs sprang open under a left-drag and sat
// there under a right-drag. So the rule lives in one place and both gestures
// report hover to it, rather than each growing its own timer.
//
// The DELAY is the point of the whole thing. Anything spring-loaded is also
// something a drag crosses on its way somewhere else, so opening on contact
// would make the window hostile. Holding still is the signal — nobody rests a
// drag on a tab by accident.
export const SPRING_LOAD_MS = 800

type SpringAction = () => void

/** WeakMap: an element that leaves the DOM takes its registration with it,
 *  which matters because the tab strip rebuilds every element on every render */
const actions = new WeakMap<Element, SpringAction>()

let timer = 0
let armedEl: Element | null = null

/** Mark an element as spring-loadable and say what opening it means. */
export function registerSpring(el: Element, action: SpringAction): void {
  actions.set(el, action)
}

function springTargetFor(el: Element | null): Element | null {
  for (let n: Element | null = el; n; n = n.parentElement) {
    if (actions.has(n)) return n
  }
  return null
}

/**
 * Report where the drag currently is. Safe to call on every mouse move.
 *
 * Re-arming only when the target CHANGES is what makes this usable: a drag
 * held over one tab fires a stream of move events, and restarting the timer on
 * each of them would mean it never elapsed and the tab never opened.
 */
export function springHover(el: Element | null): void {
  const target = springTargetFor(el)
  if (target === armedEl) return
  springCancel()
  if (!target) return
  armedEl = target
  target.classList.add('spring')
  timer = window.setTimeout(() => {
    timer = 0
    const t = armedEl
    armedEl = null
    t?.classList.remove('spring')
    // the DOM may have been rebuilt while the timer ran; opening something that
    // is no longer on screen is at best surprising
    if (t?.isConnected) actions.get(t)?.()
  }, SPRING_LOAD_MS)
}

/** Drag ended, moved away, or was cancelled — nothing should still be primed. */
export function springCancel(): void {
  if (timer) { window.clearTimeout(timer); timer = 0 }
  armedEl?.classList.remove('spring')
  armedEl = null
}

// A drag can end in ways the gesture code does not always see (dropped on
// another window, cancelled with Escape, the window losing focus). None of them
// should leave something primed to open later.
window.addEventListener('dragend', springCancel, true)
window.addEventListener('drop', springCancel, true)
window.addEventListener('mouseup', springCancel, true)
window.addEventListener('blur', springCancel, true)
