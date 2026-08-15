// The thumbnail strip along the bottom of the viewer: where you are in the
// folder, and one click to anywhere else in it.
//
// Two things make this cheap enough to leave switched on.
//
// It reuses liqthumb://, so every cell is a thumbnail the grid has already
// generated and Chromium has probably already cached — the strip costs almost
// nothing in a folder you were just looking at, which is every folder you open
// the viewer from.
//
// And it only ever sets .src on cells that are actually on screen. A folder of
// four thousand photos builds four thousand empty cells (cheap, fixed size, no
// layout thrash) and loads the twenty you can see. Cells keep their box when
// they scroll away, so the strip never reflows and the scrollbar never jumps.
//
// NO IntersectionObserver, deliberately. Under Xvfb `document.hidden` is true,
// which suspends the whole rendering lifecycle — rAF, ResizeObserver AND
// IntersectionObserver all stop firing — so an IO-driven strip loads exactly
// zero thumbnails on the test display. getBoundingClientRect forces layout and
// answers in any state, which makes this testable as well as correct.
import type { MediaItem } from './render'

/** cell box; the strip's height follows from it */
const CELL_W = 84
const CELL_H = 58
const GAP = 4
/** load this far outside the visible run, so a scroll lands on painted cells */
const OVERSCAN_PX = 240

export interface FilmstripHandle {
  el: HTMLElement
  /** rebuild for a new playlist */
  setItems(items: MediaItem[]): void
  /** highlight and scroll to `index` */
  setIndex(index: number): void
  isOn(): boolean
  toggle(on?: boolean): void
  /** re-measure after the host resized */
  refresh(): void
  destroy(): void
}

function thumbURL(path: string): string {
  return `liqthumb://?path=${encodeURIComponent(path)}&size=normal`
}

export function createFilmstrip(onPick: (index: number) => void): FilmstripHandle {
  let items: MediaItem[] = []
  let current = -1
  let on = false

  const el = document.createElement('div')
  el.className = 'mv-strip'
  el.hidden = true
  const track = document.createElement('div')
  track.className = 'mv-strip-track'
  el.appendChild(track)

  const cells: HTMLElement[] = []

  el.addEventListener('scroll', () => { loadVisible() }, { passive: true })

  // one delegated listener rather than one per cell: a 4000-photo folder would
  // otherwise attach 4000 handlers to build a strip the user may never scroll
  el.addEventListener('click', (e) => {
    const cell = (e.target as HTMLElement).closest('.mv-strip-cell') as HTMLElement | null
    if (!cell) return
    const i = Number(cell.dataset.i)
    if (Number.isFinite(i)) onPick(i)
  })

  function build(): void {
    track.textContent = ''
    cells.length = 0
    for (let i = 0; i < items.length; i++) {
      const cell = document.createElement('div')
      cell.className = 'mv-strip-cell'
      cell.dataset.i = String(i)
      cell.title = items[i].name
      const img = document.createElement('img')
      img.alt = ''
      img.draggable = false
      // the URL waits in a data attribute until the cell is actually on screen
      img.dataset.src = thumbURL(items[i].path)
      cell.appendChild(img)
      track.appendChild(cell)
      cells.push(cell)
    }
    paintCurrent()
    loadVisible()
  }

  function loadVisible(): void {
    if (!on || !cells.length) return
    const box = el.getBoundingClientRect()
    if (box.width === 0) return
    const left = box.left - OVERSCAN_PX
    const right = box.right + OVERSCAN_PX
    // the cells are a uniform width, so the visible run can be computed rather
    // than found by measuring every one of them
    const stride = CELL_W + GAP
    const first = Math.max(0, Math.floor((left - track.getBoundingClientRect().left) / stride))
    const last = Math.min(cells.length - 1, Math.ceil((right - track.getBoundingClientRect().left) / stride))
    for (let i = first; i <= last; i++) {
      const img = cells[i]?.firstElementChild as HTMLImageElement | undefined
      if (!img?.dataset.src) continue
      img.src = img.dataset.src
      delete img.dataset.src
    }
  }

  function paintCurrent(): void {
    for (const c of cells) c.classList.remove('is-current')
    const cell = cells[current]
    if (!cell) return
    cell.classList.add('is-current')
    if (!on) return
    // keep the current cell in view without yanking the strip on every step
    const box = el.getBoundingClientRect()
    const cb = cell.getBoundingClientRect()
    if (cb.left < box.left + CELL_W || cb.right > box.right - CELL_W) {
      el.scrollLeft += cb.left - box.left - (box.width - CELL_W) / 2
    }
  }

  return {
    el,
    setItems(next: MediaItem[]): void {
      items = next
      current = -1
      build()
    },
    setIndex(index: number): void {
      current = index
      paintCurrent()
      loadVisible()
    },
    isOn: () => on,
    toggle(force?: boolean): void {
      on = force ?? !on
      el.hidden = !on || items.length < 2
      if (on) { paintCurrent(); loadVisible() }
    },
    refresh(): void { loadVisible() },
    destroy(): void { el.remove() },
  }
}

export const FILMSTRIP_METRICS = { CELL_W, CELL_H, GAP }
