// WALL — an equal grid of muted, looping tiles.
//
// Lifted from BulkMediaManager's mini-wall (app/quick_multiview.py), whose
// interaction model is the part worth stealing and is reproduced here:
//
//   click          solo this tile's audio (click again to silence everything)
//   ctrl-click     ADD this tile to the mix — several can sound at once
//   double-click   spotlight it to fill the wall; again to restore
//   pin            a pinned tile keeps its clip; paging moves only the unpinned
//   hover          a strip with ⏮ / ⏭ that walks THAT tile through the folder
//
// The two ideas that make it feel good are the audio mixer and pinning. Muting
// everything is what makes a grid of ten videos bearable at all; letting one —
// or a chosen few — through on click is what makes it useful. Pinning is what
// turns it from a screensaver into a comparison tool: hold the two you care
// about, page the rest past them.
//
// EQUAL TILES, always. BMM forces uniform stretch and ignores natural sizes,
// because a grid of mismatched panes reads as broken; the same is done here
// with a CSS grid of equal fractions and object-fit on the media.
import { isViewable, renderMedia, type MediaHandle, type MediaItem } from './render'

export interface WallOptions {
  /** the same playlist the single viewer walks */
  items: MediaItem[]
  /** first item to place, top-left */
  index: number
  /** open one item in the normal viewer (double-click a spotlit tile) */
  onOpen(index: number): void
  /** right-click a tile — the host owns the menu */
  onMenu?(index: number, x: number, y: number): void
}

export interface WallHandle {
  el: HTMLElement
  /** move the unpinned tiles by whole pages */
  page(delta: number): void
  cycleGrid(): void
  handleKey(e: KeyboardEvent): boolean
  /** index of the tile the pointer/keyboard last acted on */
  current(): number
  destroy(): void
}

/** grid sizes cycled by G, in columns; rows follow from the aspect */
const GRIDS = [2, 3, 4]
/** hard cap: every tile is a decoder, and a 5x5 wall of 4K video is not a
 *  feature, it is a way to wedge the machine */
const MAX_TILES = 16

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const n = document.createElement(tag)
  if (cls) n.className = cls
  if (text !== undefined) n.textContent = text
  return n
}

interface Tile {
  box: HTMLElement
  host: HTMLElement
  cap: HTMLElement
  handle: MediaHandle | null
  /** index into `items` */
  idx: number
  pinned: boolean
  /** this tile is currently audible */
  live: boolean
}

export function createWall(opts: WallOptions): WallHandle {
  // only things that can be shown: a wall of "no preview" boxes is worse than
  // a smaller wall
  const items = opts.items.filter(isViewable)
  const startAt = Math.max(0, items.findIndex(i => i.path === opts.items[opts.index]?.path))

  const root = el('div', 'mv-wall')
  let cols = 3
  let tiles: Tile[] = []
  let spotlight = -1          // position in `tiles`, not an item index
  let focused = 0
  let cursor = startAt < 0 ? 0 : startAt

  // ---------------------------------------------------------------- tiles

  function tileCount(): number {
    const rows = Math.max(1, Math.round(cols * 0.62))
    return Math.min(MAX_TILES, cols * rows)
  }

  function disposeTile(t: Tile): void {
    t.handle?.dispose()
    t.handle = null
  }

  function fill(t: Tile, idx: number): void {
    disposeTile(t)
    t.idx = ((idx % items.length) + items.length) % items.length
    const item = items[t.idx]
    t.cap.textContent = item.name
    t.host.textContent = ''
    t.handle = renderMedia(t.host, item, {
      muted: true,
      // A wall is a glance, not a commitment. Converting every clip on it in
      // the background would queue hours of encoding for files nobody chose to
      // watch — the rule render.ts states for hosts that merely SHOW a file.
      backgroundConvert: false,
      maxHeight: Math.max(180, Math.round(root.clientHeight / Math.max(1, Math.round(cols * 0.62)))),
      onReady: (h) => {
        if (h.media) {
          h.media.loop = true
          h.media.muted = !t.live
          void h.media.play().catch(() => { /* autoplay refused; the tile stays a poster */ })
        }
      },
    })
  }

  function makeTile(): Tile {
    const box = el('div', 'mv-wt')
    const host = el('div', 'mv-wt-host')
    const cap = el('div', 'mv-wt-cap')
    const bar = el('div', 'mv-wt-bar')

    const t: Tile = { box, host, cap, handle: null, idx: 0, pinned: false, live: false }

    const mk = (label: string, title: string, fn: () => void): HTMLButtonElement => {
      const b = el('button', 'mv-wt-btn', label)
      b.type = 'button'
      b.title = title
      b.addEventListener('click', (e) => { e.stopPropagation(); fn() })
      bar.appendChild(b)
      return b
    }
    mk('⏮', 'Previous clip in this tile', () => { fill(t, t.idx - 1) })
    mk('⏭', 'Next clip in this tile', () => { fill(t, t.idx + 1) })
    const pin = mk('📌', 'Pin: paging leaves this tile alone', () => {
      t.pinned = !t.pinned
      box.classList.toggle('is-pinned', t.pinned)
      pin.classList.toggle('is-on', t.pinned)
    })

    box.append(host, bar, cap)

    box.addEventListener('click', (e) => {
      focused = tiles.indexOf(t)
      // ctrl-click adds to the mix; a plain click solos, and soloing the tile
      // that is already alone silences everything (BMM's toggle)
      if (e.ctrlKey || e.metaKey) setAudio(t, !t.live, true)
      else if (t.live && tiles.filter(x => x.live).length === 1) setAudio(t, false, true)
      else solo(t)
    })
    box.addEventListener('dblclick', (e) => {
      e.preventDefault()
      const i = tiles.indexOf(t)
      if (spotlight === i) { spotlight = -1; paintSpotlight() } else { spotlight = i; paintSpotlight() }
    })
    box.addEventListener('contextmenu', (e) => {
      e.preventDefault()
      e.stopPropagation()
      opts.onMenu?.(t.idx, e.clientX, e.clientY)
    })
    return t
  }

  // ---------------------------------------------------------------- audio

  function setAudio(t: Tile, on: boolean, keepOthers: boolean): void {
    if (!keepOthers) for (const other of tiles) if (other !== t) applyAudio(other, false)
    applyAudio(t, on)
  }

  function applyAudio(t: Tile, on: boolean): void {
    t.live = on
    t.box.classList.toggle('is-live', on)
    const m = t.handle?.media
    if (m) {
      m.muted = !on
      // a tile that was never allowed to autoplay starts here, on a click,
      // which is a gesture the browser does accept
      if (on && m.paused) void m.play().catch(() => {})
    }
  }

  function solo(t: Tile): void { setAudio(t, true, false) }

  // ---------------------------------------------------------------- layout

  function paintSpotlight(): void {
    root.classList.toggle('is-spot', spotlight >= 0)
    tiles.forEach((t, i) => t.box.classList.toggle('is-spot', i === spotlight))
  }

  function build(): void {
    for (const t of tiles) disposeTile(t)
    tiles = []
    root.textContent = ''
    const n = tileCount()
    root.style.setProperty('--wall-cols', String(cols))
    for (let i = 0; i < n; i++) {
      const t = makeTile()
      tiles.push(t)
      root.appendChild(t.box)
      fill(t, cursor + i)
    }
    spotlight = -1
    paintSpotlight()
    if (tiles.length) focused = Math.min(focused, tiles.length - 1)
  }

  // --------------------------------------------------------------- paging

  /**
   * Advance the wall by a page, leaving pinned tiles alone.
   *
   * The step is the number of tiles that actually moved, not the tile count —
   * with two of six pinned, paging must advance by four or the same clips come
   * back around out of step with the ones being held.
   */
  function page(delta: number): void {
    const movable = tiles.filter(t => !t.pinned)
    if (!movable.length) return
    cursor += delta * movable.length
    let k = 0
    for (const t of tiles) {
      if (t.pinned) continue
      fill(t, cursor + k)
      k++
    }
  }

  function cycleGrid(): void {
    cols = GRIDS[(GRIDS.indexOf(cols) + 1) % GRIDS.length]
    build()
  }

  function handleKey(e: KeyboardEvent): boolean {
    switch (e.key) {
      case 'PageDown': case 'ArrowRight': page(1); return true
      case 'PageUp': case 'ArrowLeft': page(-1); return true
      case 'g': case 'G': cycleGrid(); return true
      case 'p': case 'P': {
        const t = tiles[focused]
        if (!t) return false
        t.pinned = !t.pinned
        t.box.classList.toggle('is-pinned', t.pinned)
        return true
      }
      case 'Enter': {
        const t = tiles[focused]
        if (t) opts.onOpen(t.idx)
        return true
      }
      default: return false
    }
  }

  build()

  return {
    el: root,
    page,
    cycleGrid,
    handleKey,
    current: () => tiles[focused]?.idx ?? cursor,
    destroy(): void {
      for (const t of tiles) disposeTile(t)
      tiles = []
      root.remove()
    },
  }
}
