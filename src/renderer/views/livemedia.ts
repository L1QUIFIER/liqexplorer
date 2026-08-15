// LIVE MEDIA PREVIEWS — video tiles that animate while you browse, and GIF /
// WebP tiles that animate as themselves.
//
// The interesting half is SCRUB-BY-HOVER: moving the pointer left and right
// across a tile seeks through the whole video, the way Plex and YouTube do it.
// One sweep across a 256px tile tells you what a clip is far faster than any
// static frame can, and it is the reason the rest of this file exists.
//
// Shape of the thing
// ------------------
// A player is an OVERLAY appended into the tile's own .vh-thumbwrap, sitting
// exactly on top of the static thumbnail (same box, object-fit: contain, same
// aspect, no background) — so nothing moves when it starts or stops, and the
// thumbnail is the fallback for free. No layout is duplicated here: the tile
// geometry stays entirely in layout.ts / items.ts.
//
// SELF-MOUNTING: importing this module installs the whole feature — its own
// stylesheet and a handful of document-level listeners, with no per-element
// bookkeeping that has to be unwound. That is the only workable arrangement
// given that view-host.ts recycles item elements continuously (see below), and
// it means both panes are covered by one driver. The single hook it needs is
// markLive(), called from items.ts when a tile gets a thumbnail — that call is
// also what imports this file.
//
// Measured cost, software decode with no GPU, 96px tiles (typical desktop CPU):
// ~13% of one core per concurrently playing video, so the default cap of 10 is
// ~1.4 cores at the very worst; 16 was 2.4 cores, which is where a 4-core
// laptop would start to feel it. Hover mode plays exactly one.
//
// Recycling is the hazard
// -----------------------
// view-host.ts pools item <div>s and re-renders them with renderEntry(), which
// does `el.innerHTML = html` — so every render builds a BRAND NEW <img>, and
// any overlay we appended to the old subtree is silently detached. A detached
// <video> that still has a src keeps its range requests running until GC, so
// "is my element still connected?" is not a nicety, it is the leak. Every
// player is therefore re-validated on a reconcile pass driven by scroll, by a
// MutationObserver on each .vh-canvas, and by a 1s backstop while anything is
// playing. Identity is checked twice: the <img> must still be connected AND its
// data-for must still name the same file (the same guard the archive-thumbnail
// path in items.ts uses).
//
// Cost control — the user's media lives on a hard-mounted CIFS share
// -----------------------------------------------------------------
//   * preload="metadata" and seeking via currentTime. liqfile:// is registered
//     `standard: true` precisely so range requests work (see shared/preview.ts),
//     so a 4 GB file costs a moov read plus the slice being watched. Nothing
//     here may ever read a whole video.
//   * Only tiles whose rect actually intersects their scroller animate. The
//     view renders OVERSCAN=10 items beyond the viewport, so "is in the DOM" is
//     not "is on screen".
//   * Hard cap on concurrent <video> (settings.liveMediaMax) with a staggered
//     start, so 'always' on a folder of 200 clips opens ten sockets, not 200.
//   * A file Chromium cannot decode, errors on, or does not answer for is
//     remembered as failed and never retried this session.
import { app } from '../core/app'
import type { FileEntry } from '../../shared/types'
import {
  ANIMATED_IMAGE_EXT, PROBE_MIME, classifyPreview, likelyPlayable, previewURL,
} from '../../shared/preview'

/** Pointer must rest this long before anything loads. Sweeping the mouse across
 *  a folder crosses ~15 tiles a second; without a delay every one of them would
 *  open a socket for the ~60ms it stayed under the cursor. */
const HOVER_DELAY_MS = 400
/** Videos start here rather than at 0:00 — a title card, a fade-in or a plain
 *  black frame is the least representative part of almost any clip. */
const START_FRAC = 0.1
/** Length of the slice that loops. Long enough to read a scene, short enough
 *  that the pointer is never sitting on a file streaming megabytes. */
const LOOP_SEC = 5
/** Below this the whole video only gets a handful of pixels, so a pointer step
 *  jumps whole minutes — scrubbing a 48px medium-icon tile is just flicker. */
const SCRUB_MIN_W = 64
/** One seek per this while sweeping; each seek is a fresh range request. */
const SCRUB_MIN_MS = 90
/** Ignore sub-frame nudges (pointer jitter while the hand is still). */
const SCRUB_MIN_DELTA_SEC = 0.15
/** Metadata that never arrives means a slow or wedged mount, not a codec
 *  problem — but the tile cannot hold a decoder open waiting for it. */
const META_TIMEOUT_MS = 8000
/** Stagger between starts in 'always' mode, so ten players do not hit the share
 *  in the same tick. */
const STAGGER_MS = 120
/** An animated image is fetched WHOLE — there is no such thing as a range
 *  request for a GIF that has to animate. These are the ceilings at which that
 *  stops being a reasonable thing to do for a thumbnail. */
const ANIM_MAX_LOCAL = 24 * 1024 * 1024
const ANIM_MAX_REMOTE = 8 * 1024 * 1024
/** Backstop for teardown paths nothing else observes (a pane being hidden). */
const SWEEP_MS = 1000

type LiveKind = 'video' | 'anim'
type LiveMode = 'off' | 'hover' | 'always'

/** The entry behind a tagged tile. Keyed by the <img>, which renderEntry
 *  recreates on every render, so an entry can never outlive its element. */
const entryOf = new WeakMap<HTMLImageElement, FileEntry>()

/** Paths that will not animate this session: no codec, a decode error, or no
 *  metadata inside the deadline. Never retried — a tile that flickers into a
 *  black box once per hover is worse than one that simply stays a thumbnail. */
const failed = new Set<string>()

interface Player {
  video: HTMLVideoElement
  bar: HTMLElement | null
  img: HTMLImageElement
  wrap: HTMLElement
  path: string
  /** start of the looping slice; scrubbing moves it under the pointer */
  from: number
  ready: boolean
  metaTimer: number
  seekTimer: number
  seekTo: number
  lastSeek: number
}

interface Anim {
  overlay: HTMLImageElement
  img: HTMLImageElement
  path: string
}

const players = new Map<HTMLImageElement, Player>()

/**
 * Is this file currently showing a live preview?
 *
 * Peek asks before its hover dwell fires. A tile already playing its own
 * preview has answered "what is in this video" better than a popover can, and
 * sliding a second player over the first one — of the same file — is just two
 * things happening at once. Space-peek is unaffected: that is an explicit
 * request, not an accident of where the pointer stopped.
 */
export function isLivePreviewing(path: string): boolean {
  for (const p of players.values()) if (p.path === path) return true
  for (const a of anims.values()) if (a.path === path) return true
  return false
}
const anims = new Map<HTMLImageElement, Anim>()

/** Hover is tracked by PATH, not by element: a background refresh (the CIFS
 *  mtime watcher) makes view-host rebuild every item, so the <img> under a
 *  stationary pointer is replaced by an identical one. Keying on the file means
 *  the preview survives that instead of dying until the mouse moves again. */
let hoverPath: string | null = null
let hoverImg: HTMLImageElement | null = null
/** the hover has survived HOVER_DELAY_MS */
let hoverReady = false
let hoverTimer = 0
let lastX = -1
let lastY = -1
/** a drag or a rubber-band press is in progress: start nothing new */
let suspended = false
/** Nobody is looking: the window is minimised, on another workspace, or simply
 *  not the focused one. Nothing may play while this is set.
 *
 *  It is driven by the visibilitychange and blur EVENTS and never by reading
 *  document.hidden on demand, because visibilityState is not trustworthy
 *  everywhere — measured under Xvfb with no window manager it sits at 'hidden'
 *  while the window is mapped and painting normally, which silently disabled
 *  the entire feature. Any real pointer or scroll input clears it again: input
 *  is proof somebody is looking at this window, whatever the visibility API
 *  claims, and it cannot arrive at all while the window really is hidden. That
 *  also makes the blur rule work under focus-follows-click, where you can point
 *  at a window you have not focused. */
let dormant = false
let reconcileQueued = false
let sweepTimer = 0
let lastStart = 0
let startTimer = 0
let reconciles = 0

const reduceMotion = typeof matchMedia === 'function'
  ? matchMedia('(prefers-reduced-motion: reduce)')
  : null

// ---------------------------------------------------------------------------
// classification
// ---------------------------------------------------------------------------

function liveKind(e: FileEntry): LiveKind | null {
  if (e.isDir || !e.path.startsWith('/')) return null      // archive:// / trash:// have no readable path
  if (ANIMATED_IMAGE_EXT.has(e.ext)) return 'anim'
  return classifyPreview(e) === 'video' ? 'video' : null
}

/**
 * Tag a thumbnail <img> as animatable. Called by items.ts for every tile that
 * gets a thumbnail; tiles that get a plain type icon are never tagged, which is
 * exactly the set of view modes where a live preview would be pointless.
 */
export function markLive(img: HTMLImageElement, e: FileEntry): void {
  const kind = liveKind(e)
  if (!kind) return
  img.dataset.live = kind
  entryOf.set(img, e)
}

// ---------------------------------------------------------------------------
// mode
// ---------------------------------------------------------------------------

function mode(): LiveMode {
  const s = app.settings
  // reduced motion is a hard override, not a default, so that a desktop that
  // asks for it is honoured on a profile that predates this setting
  if (s.liveMediaReduceMotion !== false && reduceMotion?.matches) return 'off'
  const m = s.liveMedia
  return m === 'off' || m === 'always' || m === 'hover' ? m : 'hover'
}

function videoCap(): number {
  const n = Math.round(app.settings.liveMediaMax ?? 10)
  return Math.max(1, Math.min(24, Number.isFinite(n) ? n : 10))
}

// ---------------------------------------------------------------------------
// geometry
// ---------------------------------------------------------------------------

/** In the DOM is not on screen: the view keeps OVERSCAN rows materialized on
 *  both sides of the viewport, and a hidden pane keeps its whole canvas. */
function onScreen(el: Element, rect?: DOMRect): boolean {
  const r = rect ?? el.getBoundingClientRect()
  if (r.width <= 0 || r.height <= 0) return false
  const sc = el.closest('.vh-scroll')
  if (!sc) return false
  const c = sc.getBoundingClientRect()
  if (c.width <= 0 || c.height <= 0) return false
  return r.bottom > c.top && r.top < c.bottom && r.right > c.left && r.left < c.right
}

/** Tagged tiles that are really visible, top-left first. Document order is NOT
 *  visual order here — recycled item <div>s keep whatever DOM slot they had. */
function visibleTiles(): HTMLImageElement[] {
  const out: { img: HTMLImageElement; top: number; left: number }[] = []
  for (const img of document.querySelectorAll<HTMLImageElement>('.vh-canvas img.vh-thumbimg[data-live]')) {
    const r = img.getBoundingClientRect()
    if (onScreen(img, r)) out.push({ img, top: r.top, left: r.left })
  }
  out.sort((a, b) => (a.top - b.top) || (a.left - b.left))
  return out.map(x => x.img)
}

/** Still the same file in the same place? Both halves matter: the element may
 *  have been recycled onto another entry, or detached entirely. */
function stillValid(img: HTMLImageElement, path: string): boolean {
  return img.isConnected && img.dataset.for === path && onScreen(img)
}

// ---------------------------------------------------------------------------
// video players
// ---------------------------------------------------------------------------

/** @returns true when a player was actually created */
function startVideo(img: HTMLImageElement): boolean {
  const e = entryOf.get(img)
  if (!e || failed.has(e.path) || e.size === 0) return false
  const probe = PROBE_MIME[e.ext] ?? e.mime
  // canPlayType is a MIME allowlist and under-reports Matroska, which this
  // machine's library is full of — see likelyPlayable(). Files it wrongly
  // refused here never animated at all. A genuine failure still lands in
  // `failed` via the element's error event, so being optimistic costs one
  // decode attempt, once, per file per session.
  if (!likelyPlayable(e.ext, probe, 'video')) {
    // AVI/WMV/FLV and H.265: no demuxer or no decoder, so this would be a
    // permanent black box. Remember, never ask again.
    failed.add(e.path)
    return false
  }
  const wrap = img.closest('.vh-thumbwrap') as HTMLElement | null
  if (!wrap) return false

  const video = document.createElement('video')
  video.className = 'vh-live'
  video.muted = true
  video.defaultMuted = true                 // set BEFORE src or autoplay is refused
  video.playsInline = true
  video.preload = 'metadata'
  video.disablePictureInPicture = true
  video.draggable = false
  video.tabIndex = -1

  const wide = wrap.getBoundingClientRect().width >= SCRUB_MIN_W
  let bar: HTMLElement | null = null
  if (wide) {
    bar = document.createElement('span')
    bar.className = 'vh-live-bar'
    bar.appendChild(document.createElement('i'))
  }

  const p: Player = {
    video, bar, img, wrap, path: e.path,
    from: 0, ready: false, metaTimer: 0, seekTimer: 0, seekTo: 0, lastSeek: 0,
  }
  players.set(img, p)

  p.metaTimer = window.setTimeout(() => {
    p.metaTimer = 0
    failed.add(p.path)
    stopVideo(img)
  }, META_TIMEOUT_MS)

  video.addEventListener('loadedmetadata', () => {
    if (players.get(img) !== p) return
    if (p.metaTimer) { clearTimeout(p.metaTimer); p.metaTimer = 0 }
    p.ready = true
    const d = video.duration
    if (!Number.isFinite(d) || d <= 0) {
      // a single-frame clip reports duration 0 or Infinity; there is nothing to
      // loop, and the one frame it does have is the whole preview
      p.from = 0
    } else if (d <= LOOP_SEC + 1) {
      video.loop = true                     // short enough to be its own loop
      p.from = 0
    } else {
      p.from = d * START_FRAC
      video.currentTime = p.from
    }
    void video.play().catch(() => { /* muted autoplay is always permitted */ })
  })

  video.addEventListener('timeupdate', () => {
    if (players.get(img) !== p || video.loop) return
    const d = video.duration
    if (!Number.isFinite(d) || d <= 0) return
    if (bar) (bar.firstElementChild as HTMLElement).style.width =
      `${Math.max(0, Math.min(100, (video.currentTime / d) * 100))}%`
    const end = Math.min(d - 0.05, p.from + LOOP_SEC)
    if (video.currentTime >= end || video.currentTime < p.from - 0.5) video.currentTime = p.from
  })

  video.addEventListener('ended', () => {
    if (players.get(img) !== p) return
    video.currentTime = p.from
    void video.play().catch(() => { /* torn down mid-flight */ })
  })

  video.addEventListener('error', () => {
    if (players.get(img) !== p) return
    failed.add(p.path)                      // corrupt file, unsupported codec inside a supported box
    stopVideo(img)
  }, { once: true })

  video.src = previewURL(e.path, { type: probe })
  wrap.appendChild(video)
  if (bar) wrap.appendChild(bar)
  return true
}

function stopVideo(img: HTMLImageElement): void {
  const p = players.get(img)
  if (!p) return
  players.delete(img)
  if (p.metaTimer) clearTimeout(p.metaTimer)
  if (p.seekTimer) clearTimeout(p.seekTimer)
  const v = p.video
  try { v.pause() } catch { /* already detached */ }
  // removeAttribute + load() is what actually cancels the in-flight range
  // request; pause() alone leaves Chromium buffering (same dance as preview.ts)
  v.removeAttribute('src')
  try { v.load() } catch { /* detached */ }
  v.remove()
  p.bar?.remove()
}

// ---------------------------------------------------------------------------
// animated images (GIF / WebP / APNG) — a second <img>, never a swapped src
// ---------------------------------------------------------------------------
//
// Overlaying rather than re-pointing the tile's own <img> keeps the failure
// mode harmless: items.ts installs an onerror that falls the thumbnail back to
// a generic type icon, so a full-size fetch that 404s on the tile's own element
// would COST the user their thumbnail. The overlay just removes itself.

function startAnim(img: HTMLImageElement): void {
  const e = entryOf.get(img)
  if (!e || failed.has(e.path) || e.size === 0) return
  if (e.size > (e.remote ? ANIM_MAX_REMOTE : ANIM_MAX_LOCAL)) { failed.add(e.path); return }
  const wrap = img.closest('.vh-thumbwrap') as HTMLElement | null
  if (!wrap) return

  const overlay = document.createElement('img')
  overlay.className = 'vh-live'
  overlay.draggable = false
  overlay.alt = ''
  const a: Anim = { overlay, img, path: e.path }
  anims.set(img, a)
  overlay.addEventListener('error', () => {
    if (anims.get(img) !== a) return
    failed.add(a.path)
    stopAnim(img)
  }, { once: true })
  overlay.src = previewURL(e.path, { type: e.mime })
  wrap.appendChild(overlay)
}

function stopAnim(img: HTMLImageElement): void {
  const a = anims.get(img)
  if (!a) return
  anims.delete(img)
  a.overlay.removeAttribute('src')
  a.overlay.remove()
}

function stopAll(): void {
  for (const img of [...players.keys()]) stopVideo(img)
  for (const img of [...anims.keys()]) stopAnim(img)
}

// ---------------------------------------------------------------------------
// scrub
// ---------------------------------------------------------------------------

function applyScrub(clientX: number): void {
  if (!app.settings.liveMediaScrub || !hoverImg) return
  const p = players.get(hoverImg)
  if (!p || !p.ready || !p.video.isConnected) return
  const d = p.video.duration
  if (!Number.isFinite(d) || d < 2) return
  const r = p.wrap.getBoundingClientRect()
  if (r.width < SCRUB_MIN_W) return
  const f = Math.min(1, Math.max(0, (clientX - r.left) / r.width))
  // never the extreme ends: the first and last moments of most files are a
  // black frame or a credit roll, which is the least useful thing to land on
  p.seekTo = (0.02 + f * 0.94) * d
  const now = performance.now()
  if (now - p.lastSeek < SCRUB_MIN_MS || Math.abs(p.seekTo - p.video.currentTime) < SCRUB_MIN_DELTA_SEC) {
    // coalesce: a sweep produces one mousemove per frame, and each seek is a
    // fresh HTTP range request over the share
    if (!p.seekTimer) p.seekTimer = window.setTimeout(() => { p.seekTimer = 0; flushSeek(p) }, SCRUB_MIN_MS)
    return
  }
  flushSeek(p)
}

function flushSeek(p: Player): void {
  if (!p.video.isConnected || !p.ready) return
  p.lastSeek = performance.now()
  // the loop window follows the pointer, so letting go where you scrubbed to
  // keeps playing THERE instead of snapping back to the 10% mark
  p.from = p.seekTo
  p.video.loop = false
  p.video.currentTime = p.seekTo
  if (p.video.paused) void p.video.play().catch(() => { /* torn down */ })
}

// ---------------------------------------------------------------------------
// reconcile — the single place that decides what is allowed to be playing
// ---------------------------------------------------------------------------

function schedule(): void {
  if (reconcileQueued) return
  reconcileQueued = true
  // setTimeout, NOT requestAnimationFrame. rAF only runs while the page is
  // producing frames, and a page Chromium considers hidden (or simply idle,
  // with nothing moving in it) produces none — measured: in 'always' mode with
  // the pointer parked outside the view, the rAF callback was still queued 3 s
  // after the folder had finished listing and not one player had started. The
  // triggers that matter here (a listing landing, a setting changing) are
  // exactly the ones that paint nothing. A timer is driven by the event loop.
  setTimeout(() => { reconcileQueued = false; reconcile() }, 16)
}

function reconcile(): void {
  reconciles++
  observeCanvases()
  const m = mode()
  if (m === 'off' || dormant) { stopAll(); syncSweep(); return }
  refreshHover()

  // 1. drop anything recycled, scrolled away, or navigated out from under us
  for (const [img, p] of [...players]) if (!stillValid(img, p.path)) stopVideo(img)
  for (const [img, a] of [...anims]) if (!stillValid(img, a.path)) stopAnim(img)

  // 2. what SHOULD be playing
  let wantVideo: HTMLImageElement[] = []
  let wantAnim: HTMLImageElement[] = []
  if (!suspended) {
    if (m === 'always') {
      for (const img of visibleTiles()) {
        if (failed.has(img.dataset.for ?? '')) continue
        if (img.dataset.live === 'anim') wantAnim.push(img)
        else wantVideo.push(img)
      }
    } else if (hoverReady && hoverImg && hoverPath && !failed.has(hoverPath)
               && stillValid(hoverImg, hoverPath)) {
      if (hoverImg.dataset.live === 'anim') wantAnim = [hoverImg]
      else wantVideo = [hoverImg]
    }
  }
  if (!app.settings.liveMediaAnimated) wantAnim = []
  // animated images cost a decode, not a decoder — a looser budget than video
  wantVideo = wantVideo.slice(0, videoCap())
  wantAnim = wantAnim.slice(0, videoCap() * 2)

  // 3. stop what fell out of the set
  const keepV = new Set(wantVideo)
  const keepA = new Set(wantAnim)
  for (const img of [...players.keys()]) if (!keepV.has(img)) stopVideo(img)
  for (const img of [...anims.keys()]) if (!keepA.has(img)) stopAnim(img)

  // 4. start what is missing, staggered so a screenful does not open every
  //    socket in the same tick
  for (const img of wantAnim) if (!anims.has(img)) startAnim(img)
  const pending = wantVideo.filter(img => !players.has(img))
  if (pending.length) {
    const now = performance.now()
    const wait = Math.max(0, STAGGER_MS - (now - lastStart))
    if (wait) {
      armStagger(wait)
    } else {
      // Walk past the ones that cannot start at all (no codec for that
      // container) rather than stopping at the head of the queue: they cost a
      // canPlayType call and nothing else, and stopping meant ONE undecodable
      // file at the top of the screen held the stagger queue forever, so
      // nothing below it ever played.
      let started = false
      for (const img of pending) { if (startVideo(img)) { started = true; break } }
      if (started) {
        lastStart = now
        if (players.size < wantVideo.length) armStagger()
      }
    }
  }
  syncSweep()
}

function armStagger(wait = STAGGER_MS): void {
  if (startTimer) return
  startTimer = window.setTimeout(() => { startTimer = 0; schedule() }, wait)
}

/** Backstop poll. Two things need it: a pane being hidden leaves a player
 *  attached to something nobody can see, and 'always' mode has no user gesture
 *  driving it at all — its real trigger (the listing landing) races view-host's
 *  own deferred rebuild, so the reconcile can arrive before the tiles do. A
 *  second of latency, for a few dozen rect reads, beats a mode that sometimes
 *  never starts. */
function syncSweep(): void {
  const busy = players.size > 0 || anims.size > 0
    || (mode() === 'always' && !!document.querySelector('.vh-canvas img.vh-thumbimg[data-live]'))
  if (busy && !sweepTimer) sweepTimer = window.setInterval(() => reconcile(), SWEEP_MS)
  else if (!busy && sweepTimer) { clearInterval(sweepTimer); sweepTimer = 0 }
}

// ---------------------------------------------------------------------------
// install
// ---------------------------------------------------------------------------

const observed = new WeakSet<Element>()
let mo: MutationObserver | null = null

/** Canvases are created by mountViewHost AFTER this module is imported, and a
 *  second one appears the first time the tab is split — so they are picked up
 *  lazily rather than once at startup. */
function observeCanvases(): void {
  if (!mo) mo = new MutationObserver(() => schedule())
  for (const c of document.querySelectorAll('.vh-canvas')) {
    if (observed.has(c)) continue
    observed.add(c)
    mo.observe(c, { childList: true })
  }
}

/** Real input: somebody is looking at this window, whatever the platform says. */
function seen(): void {
  if (!dormant) return
  dormant = false
  schedule()
}

function setHover(img: HTMLImageElement | null): void {
  const path = img?.dataset.for ?? null
  if (path !== null && path === hoverPath) { hoverImg = img; return }   // same file, fresh element
  hoverPath = path
  hoverImg = img
  hoverReady = false
  if (hoverTimer) { clearTimeout(hoverTimer); hoverTimer = 0 }
  if (img) {
    hoverTimer = window.setTimeout(() => {
      hoverTimer = 0
      hoverReady = true
      schedule()
    }, HOVER_DELAY_MS)
  }
  schedule()
}

/** Re-find the tile under the pointer after the view rebuilt beneath it. */
function refreshHover(): void {
  if (!hoverImg || (hoverImg.isConnected && hoverImg.dataset.for === hoverPath)) return
  if (lastX < 0) { setHover(null); return }
  const item = (document.elementFromPoint(lastX, lastY) as Element | null)
    ?.closest?.('.vh-item') as HTMLElement | null
  const found = item?.querySelector('img.vh-thumbimg[data-live]') as HTMLImageElement | null
  if (found?.dataset.for === hoverPath) { hoverImg = found; return }
  setHover(found ?? null)
}

function install(): void {
  if (!document.querySelector('link[data-lm-style]')) {
    const link = document.createElement('link')
    link.rel = 'stylesheet'
    link.href = 'styles/livemedia.css'
    link.setAttribute('data-lm-style', '1')
    document.head.appendChild(link)
  }

  document.addEventListener('mousemove', (ev) => {
    lastX = ev.clientX
    lastY = ev.clientY
    seen()
    if (mode() === 'off') return
    // the overlay is pointer-events:none, so the target is the tile's own <img>
    // / label / cell — anywhere on the cell counts as pointing at the tile
    const item = (ev.target as Element | null)?.closest?.('.vh-item') as HTMLElement | null
    setHover(item?.querySelector('img.vh-thumbimg[data-live]') as HTMLImageElement | null)
    applyScrub(ev.clientX)
  }, { passive: true, capture: true })

  // scroll does not bubble off an element; capture is the only way to hear
  // every .vh-scroll (there are two once the tab is split) from one listener
  document.addEventListener('scroll', () => { seen(); schedule() }, true)

  // a press may become a rubber band sweeping over every tile in the folder,
  // and a drag carries the tile away — neither should recruit new players
  document.addEventListener('mousedown', () => { suspended = true }, true)
  document.addEventListener('mouseup', () => { suspended = false; schedule() }, true)
  document.addEventListener('dragstart', () => { suspended = true; stopAll() }, true)
  document.addEventListener('dragend', () => { suspended = false; schedule() }, true)
  document.addEventListener('drop', () => { suspended = false; schedule() }, true)

  document.addEventListener('visibilitychange', () => {
    dormant = document.hidden
    if (dormant) stopAll(); else schedule()
  })
  // sticky, not a one-shot stop: 'always' mode has a 1s sweep that would
  // otherwise re-open every player a second after the window lost focus
  window.addEventListener('blur', () => { dormant = true; stopAll() })
  window.addEventListener('focus', () => { dormant = false; schedule() })
  reduceMotion?.addEventListener('change', () => schedule())

  // the folder changing under a stationary pointer must not leave a player on a
  // tile that now shows something else
  const drop = (): void => { setHover(null); stopAll() }
  app.on('tab-navigated', drop)
  app.on('tabs-changed', drop)
  app.on('panes-changed', drop)
  app.on('tab-viewstate', drop)
  app.on('settings-changed', () => schedule())
  // NOT drop(): a background refresh must not kill a preview the pointer is
  // still resting on (hover is keyed by path precisely so it survives one).
  // Scheduling is what gets 'always' going as soon as the folder has listed.
  app.on('tab-listing', () => schedule())
}

install()

/** internals exposed for CDP-driven testing only — not part of the contract */
;(window as unknown as { liqLive?: unknown }).liqLive = {
  players, anims, failed, mode, reconcile, visibleTiles,
  stats: () => ({
    videos: players.size,
    anims: anims.size,
    failed: failed.size,
    mode: mode(),
    cap: videoCap(),
    suspended,
    dormant,
    reconciles,
    tiles: document.querySelectorAll('.vh-canvas img.vh-thumbimg[data-live]').length,
    visible: visibleTiles().length,
    hover: hoverReady ? hoverPath : null,
    live: [...players.values()].map(p => ({
      path: p.path,
      readyState: p.video.readyState,
      currentTime: Number(p.video.currentTime.toFixed(2)),
      duration: Number.isFinite(p.video.duration) ? Number(p.video.duration.toFixed(2)) : null,
      paused: p.video.paused,
      from: Number(p.from.toFixed(2)),
      connected: p.video.isConnected,
    })),
  }),
}
