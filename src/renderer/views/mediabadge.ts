// Running time in the corner of a video thumbnail.
//
// Nothing in the app knew a video's duration: `duration` has existed as a
// declared SortKey with no code populating it. Rather than join a probe into
// the listing — which would put an ffprobe in front of every folder open — the
// badge is filled in AFTER the tiles are on screen, for the ones actually
// visible, and only ever from a cache after the first time.
//
// The pattern is deliberately the same as the ratings backfill in ratings.ts:
// mark tiles as they render, coalesce, ask once per sweep for what is still
// unknown, patch what comes back. That module's constants were tuned against
// this share and there is no reason to invent different ones.
import { liq } from '../core/app'
import type { FileEntry } from '../../shared/types'

/** debounce: a scroll should ask once when it stops, not once per frame */
const SWEEP_MS = 700
/** never ask for more than one screenful-and-then-some in a single sweep */
const MAX_PER_SWEEP = 120
/** below this the badge covers the picture rather than annotating it — medium
 *  icons are 48px, and the same threshold livemedia uses to stop scrubbing */
const MIN_THUMB_PX = 64

/** path -> formatted "1:23:45"; '' means asked and there is no answer */
const known = new Map<string, string>()
const asked = new Set<string>()
const wanted = new Set<string>()
/** every tile currently on screen that could carry a badge */
const live = new Map<HTMLElement, string>()

let sweepTimer = 0
/** amortize the prune scan over this many marks; roughly a screenful */
const PRUNE_EVERY = 200
let sincePrune = 0

function paint(wrap: HTMLElement, path: string): void {
  const text = known.get(path)
  const existing = wrap.querySelector('.vh-dur')
  if (!text) { existing?.remove(); return }
  if (existing) { existing.textContent = text; return }
  const b = document.createElement('span')
  b.className = 'vh-dur'
  b.textContent = text
  wrap.appendChild(b)
}

function sweep(): void {
  sweepTimer = 0
  const batch: string[] = []
  for (const p of wanted) {
    if (asked.has(p)) continue
    batch.push(p)
    if (batch.length >= MAX_PER_SWEEP) break
  }
  wanted.clear()
  if (!batch.length) return
  for (const p of batch) asked.add(p)

  void liq.invoke('mediaDurations', batch).then((map: Record<string, string>) => {
    for (const p of batch) known.set(p, map?.[p] ?? '')
    // repaint only the tiles still on screen: by the time this lands the user
    // may have scrolled a thousand rows, and those elements are recycled
    for (const [wrap, path] of live) {
      if (batch.includes(path)) paint(wrap, path)
    }
    prune()
  }).catch(() => {
    // leave them in `asked` — a failing probe should not be retried per scroll
  })
}

/**
 * Called from items.ts for every rendered tile. Cheap and synchronous: a
 * cached answer paints immediately, an unknown one joins the next sweep.
 */
export function markDuration(wrap: HTMLElement, e: FileEntry, thumbPx: number): void {
  live.delete(wrap)
  wrap.querySelector('.vh-dur')?.remove()
  if (e.isDir || !e.path.startsWith('/')) return
  if (!e.mime.startsWith('video/') && !e.mime.startsWith('audio/')) return
  if (thumbPx < MIN_THUMB_PX) return

  live.set(wrap, e.path)
  if (++sincePrune >= PRUNE_EVERY) { sincePrune = 0; prune() }
  if (known.has(e.path)) { paint(wrap, e.path); return }
  wanted.add(e.path)
  if (!sweepTimer) sweepTimer = window.setTimeout(sweep, SWEEP_MS)
}

/**
 * Views recycle elements constantly, so `live` accumulates detached nodes and
 * would pin them out of GC reach. Sweeping is not enough on its own: in a
 * folder where every duration is already cached no sweep is ever scheduled, so
 * the map would grow for as long as the user scrolls. Hence the amortized call
 * from markDuration as well.
 */
function prune(): void {
  for (const wrap of [...live.keys()]) if (!wrap.isConnected) live.delete(wrap)
}
