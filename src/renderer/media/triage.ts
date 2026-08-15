// Rapid triage: go through a folder of photos deciding, without touching the
// mouse. Rate it, throw it in a bin, bin it entirely — and move on.
//
// The deck is a slim translucent strip glued to the BOTTOM EDGE OF THE PICTURE,
// not to the window and not over the filename. That is deliberate and it is the
// same reason the star overlay came off the grid tiles: controls that sit on top
// of the thing they describe make the thing harder to read, and the filename is
// the one piece of text the user is actually reading while triaging.
//
// This module owns no app state. Everything it can do arrives as `TriageHooks`,
// because media/viewer.ts must not import core/app — the pop-out window renders
// the same viewer without ever booting the file manager. The host that CAN see
// the app (media/overlay.ts) passes the hooks in.
//
// KEY CONFLICT, RESOLVED HONESTLY. Ratings want 0-5. The image viewer already
// uses 0 for fit-to-window and 1 for actual-size, and those are not negotiable
// either. So triage is a MODE, toggled with T, and the deck being visible is
// what tells you which meaning the digits have right now. Zoom stays reachable
// throughout on +/-/the zoom bar; only 0 and 1 change hands, and only while the
// deck is up.
import type { MediaItem } from './render'

export interface TriageBin {
  id: string
  label: string
  /** the letter that files into this bin; assigned by the host, shown on the chip */
  hotkey: string
}

export interface TriageHooks {
  ratingOf(item: MediaItem): number
  setRating(item: MediaItem, rating: number): void
  bins(): TriageBin[]
  toBin(item: MediaItem, binId: string): void
  recycle(item: MediaItem): void
  /** the app's own named undo — "Undo Delete IMG_2044.jpg" */
  undoLabel(): string | null
  undo(): void
  /** re-render when the app's undo state changes underneath us */
  onUndoChanged(fn: () => void): () => void
}

export interface TriageDeck {
  el: HTMLElement
  /** the item the deck is acting on; null hides it */
  setItem(item: MediaItem | null): void
  /** true when the key was consumed */
  handleKey(e: KeyboardEvent): boolean
  isOn(): boolean
  toggle(on?: boolean): void
  destroy(): void
}

/** letters the viewer already owns (mute, fullscreen, triage, strip, grid, loop); a bin may
 *  not take one of these, or its hotkey would shadow a control the user cannot
 *  then reach while the deck is up */
const RESERVED = new Set(['m', 'f', 't', 's', 'g', 'l'])

const STAR = '<path d="M8 1.6l1.9 4 4.4.6-3.2 3.1.8 4.4L8 11.6l-3.9 2.1.8-4.4L1.7 6.2l4.4-.6z"/>'
const TRASH = '<path d="M3 4.4h10M6.4 4.4V3h3.2v1.4M4.3 4.4l.6 9h6.2l.6-9" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/>'
const UNDO = '<path d="M4 7h5.2a3 3 0 1 1 0 6H6.2M4 7l2.4-2.4M4 7l2.4 2.4" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/>'

function svg(path: string): string {
  return `<svg viewBox="0 0 16 16" aria-hidden="true">${path}</svg>`
}

/**
 * Give each bin a letter, preferring one that appears in its own label so the
 * mapping is guessable rather than arbitrary. Bins whose every letter is taken
 * get no hotkey at all and stay click-only — better than silently stealing a
 * key the user has already learned somewhere else.
 */
export function assignHotkeys(labels: { id: string; label: string }[]): TriageBin[] {
  const taken = new Set(RESERVED)
  const out: TriageBin[] = []
  for (const b of labels) {
    let hotkey = ''
    for (const ch of b.label.toLowerCase()) {
      if (ch < 'a' || ch > 'z' || taken.has(ch)) continue
      hotkey = ch
      taken.add(ch)
      break
    }
    out.push({ id: b.id, label: b.label, hotkey })
  }
  return out
}

export function createTriage(
  hooks: TriageHooks,
  onAdvance: () => void,
  /** the item is gone from disk; the host must drop it from the playlist */
  onRemoved: (item: MediaItem) => void,
): TriageDeck {
  let on = false
  let item: MediaItem | null = null
  let binList: TriageBin[] = []

  const el = document.createElement('div')
  el.className = 'mv-triage'
  el.hidden = true

  const stars = document.createElement('div')
  stars.className = 'mv-tri-stars'
  const starBtns: HTMLButtonElement[] = []
  for (let n = 1; n <= 5; n++) {
    const b = document.createElement('button')
    b.className = 'mv-tri-star'
    b.innerHTML = svg(STAR)
    b.title = `Rate ${n} (press ${n})`
    b.addEventListener('click', () => { rate(n) })
    stars.appendChild(b)
    starBtns.push(b)
  }
  const clearBtn = document.createElement('button')
  clearBtn.className = 'mv-tri-clear'
  clearBtn.textContent = 'Clear'
  clearBtn.title = 'Remove the rating (press 0)'
  clearBtn.addEventListener('click', () => { rate(0) })
  stars.appendChild(clearBtn)

  const binRow = document.createElement('div')
  binRow.className = 'mv-tri-bins'

  const right = document.createElement('div')
  right.className = 'mv-tri-right'
  const delBtn = document.createElement('button')
  delBtn.className = 'mv-tri-del'
  delBtn.innerHTML = svg(TRASH) + '<span>Recycle</span>'
  delBtn.title = 'Move to the recycle bin (Delete)'
  delBtn.addEventListener('click', () => { recycle() })
  const undoBtn = document.createElement('button')
  undoBtn.className = 'mv-tri-undo'
  undoBtn.hidden = true
  undoBtn.addEventListener('click', () => { hooks.undo() })
  right.append(undoBtn, delBtn)

  el.append(stars, binRow, right)

  // the app's undo stack changes from elsewhere too (the grid, the context menu)
  const offUndo = hooks.onUndoChanged(() => { paintUndo() })

  function paintUndo(): void {
    const label = hooks.undoLabel()
    undoBtn.hidden = !label
    if (label) {
      undoBtn.innerHTML = svg(UNDO) + `<span></span>`
      // textContent, never innerHTML: the label contains a FILENAME
      undoBtn.querySelector('span')!.textContent = label
      undoBtn.title = `${label} (Ctrl+Z)`
    }
  }

  function paintBins(): void {
    const next = hooks.bins()
    const sig = next.map(b => `${b.id}:${b.label}:${b.hotkey}`).join('|')
    if (sig === binRow.dataset.sig) return
    binRow.dataset.sig = sig
    binRow.textContent = ''
    binList = next
    for (const b of next) {
      const chip = document.createElement('button')
      chip.className = 'mv-tri-bin'
      const name = document.createElement('span')
      name.className = 'mv-tri-binlabel'
      name.textContent = b.label
      chip.appendChild(name)
      if (b.hotkey) {
        const key = document.createElement('kbd')
        key.textContent = b.hotkey.toUpperCase()
        chip.appendChild(key)
      }
      chip.title = b.hotkey ? `Send to "${b.label}" (press ${b.hotkey.toUpperCase()})` : `Send to "${b.label}"`
      chip.addEventListener('click', () => { toBin(b.id) })
      binRow.appendChild(chip)
    }
  }

  function paintStars(): void {
    const r = item ? hooks.ratingOf(item) : 0
    for (let i = 0; i < starBtns.length; i++) starBtns[i].classList.toggle('is-lit', i < r)
    clearBtn.disabled = r === 0
  }

  // ------------------------------------------------------------------ actions
  //
  // Each of these ends in onAdvance(), which is the entire point of triage: the
  // decision and the move to the next item are one keystroke, not two.

  function rate(n: number): void {
    if (!item) return
    hooks.setRating(item, n)
    paintStars()
    onAdvance()
  }

  function toBin(id: string): void {
    if (!item) return
    hooks.toBin(item, id)
    onAdvance()
  }

  function recycle(): void {
    if (!item) return
    const gone = item
    hooks.recycle(gone)
    // Not onAdvance: the item is going AWAY, so advancing past it would leave a
    // dead entry in the playlist that the user walks back into. The host drops
    // it and decides what takes its place, which for the last item means
    // stepping backwards rather than forwards.
    onRemoved(gone)
  }

  function setItem(next: MediaItem | null): void {
    item = next
    if (!on) return
    el.hidden = !item
    paintStars()
    paintBins()
    paintUndo()
  }

  function toggle(force?: boolean): void {
    on = force ?? !on
    el.hidden = !on || !item
    if (on) { paintStars(); paintBins(); paintUndo() }
  }

  function handleKey(e: KeyboardEvent): boolean {
    if (e.ctrlKey || e.metaKey || e.altKey) return false
    const k = e.key
    if (k === 't' || k === 'T') { toggle(); return true }
    if (!on || !item) return false
    if (k === 'Delete') { recycle(); return true }
    if (k >= '0' && k <= '5') { rate(Number(k)); return true }
    const lower = k.toLowerCase()
    if (lower.length === 1 && lower >= 'a' && lower <= 'z') {
      const bin = binList.find(b => b.hotkey === lower)
      if (bin) { toBin(bin.id); return true }
    }
    return false
  }

  return {
    el,
    setItem,
    handleKey,
    isOn: () => on,
    toggle,
    destroy(): void { offUndo(); el.remove() },
  }
}
