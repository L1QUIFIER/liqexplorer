// Win11 scrollbars widen as soon as the pointer enters the scrolling region,
// not only when it is on the bar itself. CSS cannot express that: Chromium
// never applies an ancestor/self :hover to ::-webkit-scrollbar-* parts (proved
// on :99 — a red hover rule painted nothing until the pointer was on the thumb),
// and scrollbar GEOMETRY is frozen when the scrollbar is created, so hover
// cannot change widths at all. So the rail is painted with a gradient and this
// toggles .sb-hot on whichever scrollable element the pointer is over.
//
// One document-level listener, no per-element bookkeeping: elements are created
// and recycled constantly by the virtualized views.

function scrollableUnder(el: Element | null): HTMLElement | null {
  for (let n = el as HTMLElement | null; n && n !== document.body; n = n.parentElement) {
    const s = getComputedStyle(n)
    const scrolls = /auto|scroll/.test(s.overflowY) || /auto|scroll/.test(s.overflowX)
    if (scrolls && (n.scrollHeight > n.clientHeight || n.scrollWidth > n.clientWidth)) return n
  }
  return null
}

export function mountScrollHover(): void {
  let hot: HTMLElement | null = null

  const setHot = (el: HTMLElement | null): void => {
    if (el === hot) return
    hot?.classList.remove('sb-hot')
    hot = el
    hot?.classList.add('sb-hot')
  }

  document.addEventListener('pointermove', (e) => {
    setHot(scrollableUnder(e.target as Element))
  }, { passive: true })

  // leaving the window entirely must not leave a rail stuck open
  document.addEventListener('pointerleave', () => setHot(null))
  window.addEventListener('blur', () => setHot(null))
}
