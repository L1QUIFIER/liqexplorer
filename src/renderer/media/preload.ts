// Decode the next photo before the user asks for it, then hand over the actual
// decoded element.
//
// The obvious design — construct an Image() to warm Chromium's URL cache, then
// let the viewer build its own <img> with the same URL — was built first and
// measured, and it does almost nothing. On this share, opening a 12 MP JPEG:
//
//     cold                                42 ms
//     warmed by a held Image() (fetch)     36 ms
//     warmed by a held Image() + decode()  34 ms
//     the preloaded ELEMENT itself          1 ms
//
// The reason is that the fetch was never the expensive part. A cold read of a
// 1.7 MB photo off this CIFS mount is ~10 ms; the rest is decode, and a fresh
// <img> re-decodes even when the bytes are cached. So warming a cache moves
// almost nothing, and the only way to actually skip the work is to not do it
// twice: preload into a real element, keep it, and give that element to the
// viewer when the user arrives (see takePreloaded / render.ts).
//
// Videos are never preloaded: the neighbours of a 2 GB film are 2 GB films, and
// warming those would saturate the same share the current one is streaming from.
// classifyPreview rather than render.ts's viewKindFor, which is the same answer
// one layer up: render.ts imports THIS module to adopt elements, and importing
// it back would make the pair circular.
import { classifyPreview, previewURL } from '../../shared/preview'
import type { MediaItem } from './render'

/** how far ahead / behind to warm. Forward-weighted: next is pressed far more
 *  often than previous, and every extra slot is another decoded bitmap in RAM */
let AHEAD = 2
let BEHIND = 1

/** Set from the settings. 0 disables warming entirely, which is the right
 *  choice on a slow share where the extra reads compete with the photo the
 *  user is actually looking at. */
export function setPreloadDepth(ahead: number): void {
  AHEAD = Math.max(0, Math.min(4, Math.floor(ahead) || 0))
  BEHIND = AHEAD > 0 ? 1 : 0
}

/** above this a single preload would monopolise the share for seconds and make
 *  the photo the user is ACTUALLY looking at slower to load. Panoramas and
 *  layered TIFFs live up here; ordinary camera JPEGs are 3-12 MB. */
const MAX_PRELOAD_BYTES = 64 * 1024 * 1024

/** A decoded bitmap costs width*height*4 bytes no matter how small the file
 *  compressed to — a 6000x6000 PNG is 144 MB decoded. Holding three of those
 *  to save 60 ms is a bad trade, so oversized ones are dropped after load
 *  rather than held. 40 MP ~= 160 MB, which comfortably covers real cameras. */
const MAX_HELD_PIXELS = 40_000_000

/** path -> the preloaded element, still ours until someone takes it */
const held = new Map<string, HTMLImageElement>()

export function thumbURL(path: string, size = 'x-large'): string {
  return `liqthumb://?path=${encodeURIComponent(path)}&size=${size}`
}

function eligible(item: MediaItem | undefined): item is MediaItem {
  if (!item || item.isDir || !item.path.startsWith('/')) return false
  if (classifyPreview({ isDir: false, ext: item.ext, mime: item.mime, name: item.name }) !== 'image') return false
  return item.size > 0 && item.size <= MAX_PRELOAD_BYTES
}

/** stop an in-flight request and let the bitmap go */
function release(img: HTMLImageElement): void {
  img.src = ''
}

/**
 * Warm the neighbours of `index`. Safe to call on every navigation — it is
 * idempotent per path, and paths that fell outside the window are released so
 * a long browse does not pin every photo in the folder into memory.
 */
export function preloadAround(items: MediaItem[], index: number): void {
  if (items.length < 2) return
  const n = items.length
  const want = new Set<string>()

  for (let d = -BEHIND; d <= AHEAD; d++) {
    if (d === 0) continue
    // wrap, because the viewer's own prev/next wrap
    const item = items[((index + d) % n + n) % n]
    if (!eligible(item)) continue
    want.add(item.path)
  }

  for (const [path, img] of held) {
    if (want.has(path)) continue
    release(img)
    held.delete(path)
  }

  for (const path of want) {
    if (held.has(path)) continue
    const item = items.find(i => i.path === path)!
    const img = new Image()
    // 'async' keeps the decode off the main thread, so warming a 40-megapixel
    // neighbour cannot stutter the zoom/pan of the photo on screen
    img.decoding = 'async'
    img.draggable = false
    img.alt = ''
    held.set(path, img)
    img.src = previewURL(path, { type: item.mime })
    void img.decode().then(() => {
      // decoding is the whole point, but a huge bitmap is not worth keeping
      if (held.get(path) === img && img.naturalWidth * img.naturalHeight > MAX_HELD_PIXELS) {
        release(img)
        held.delete(path)
      }
    }).catch(() => {
      // a broken or unsupported image: drop it and let the viewer show its own
      // error when the user actually navigates there
      if (held.get(path) === img) { held.delete(path) }
    })
  }
}

/**
 * Take ownership of a preloaded element, or null if we never had one.
 *
 * The caller becomes responsible for it — that is the point, and it is also why
 * the entry is removed from `held` rather than shared. If it stayed in the map,
 * the next preloadAround() would treat the element the user is looking at as an
 * evictable neighbour and blank its src.
 *
 * The element may still be loading. Adopting it anyway is strictly better than
 * building a new one: the request is already in flight, so the caller just
 * listens for the same load it would have waited for regardless.
 */
export function takePreloaded(path: string): HTMLImageElement | null {
  const img = held.get(path)
  if (!img) return null
  held.delete(path)
  return img
}

/** Viewer teardown: stop any in-flight neighbour reads. */
export function clearPreload(): void {
  for (const img of held.values()) release(img)
  held.clear()
}

/** How many neighbours are currently held. Test hook. */
export function preloadCount(): number { return held.size }
