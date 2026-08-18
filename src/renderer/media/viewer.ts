// The media viewer itself: header + stage + transport bar, prev/next through a
// playlist, image zoom/pan, and a keyboard map. It is a plain component with no
// opinion about WHERE it lives, because it has two hosts:
//
//   media/overlay.ts  the floating translucent panel inside the file manager
//   media/popout.ts   the same viewer filling a real, separate Electron window
//
// so it must not import core/app (the pop-out page never boots the app). The
// host supplies the items, gets a handle back, and owns dragging, resizing,
// fullscreen and closing — the two hosts do those very differently.
//
// Video/audio stream over liqfile://, which serves real byte ranges; seeking is
// therefore a range request rather than a download, and the scrub bar paints
// `buffered` so a slow share is visible instead of just unresponsive.
import { clock, renderMedia, viewKindFor, type MediaHandle, type MediaItem, type ViewKind } from './render'
import { clearPreload, preloadAround } from './preload'
import { usableResume } from '../../shared/resume'
import { previewURL } from '../../shared/preview'
import { createTriage, type TriageDeck, type TriageHooks } from './triage'
import { createFilmstrip, type FilmstripHandle } from './filmstrip'
import { createWall, type WallHandle } from './wall'
import { attachAudioOutput, chosenOutput, listOutputs, useOutput } from './audioout'
import { attachSubtitles, type SubtitleAttachment } from './subtitles'
import { trackLabel, type MediaTracks } from '../../shared/tracks'

export interface ViewerState {
  index: number
  /** playback position in seconds (0 for stills) */
  time: number
  playing: boolean
  volume: number
  muted: boolean
  rate: number
}

export interface ViewerOptions {
  items: MediaItem[]
  index: number
  /** carried over when handing playback to another window */
  start?: Partial<ViewerState>
  autoplay?: boolean
  /** which header buttons exist; the pop-out window has no "pop out" button,
   *  and only a real OS window can be pinned above other applications */
  buttons?: { popout?: boolean; fullscreen?: boolean; close?: boolean; pin?: boolean }
  /** toggle always-on-top; only meaningful for the pop-out window */
  onPin?: (on: boolean) => void
  onPopout?: (state: ViewerState) => void
  onClose?: () => void
  /** toggle fullscreen: CSS-maximize in the overlay, a real fullscreen window in the pop-out */
  onFullscreen?: () => void
  /** shown item changed (title bars, window titles) */
  onItem?: (item: MediaItem, index: number, total: number) => void
  /** plain mouse wheel walks the playlist (Ctrl+wheel always zooms an image) */
  wheelNav?: boolean
  /** flip the wheel direction for people whose other viewers do */
  wheelInvert?: boolean
  /** tallest transcoded picture worth producing; a floating panel is small, a
   *  pop-out window can be a whole screen */
  maxHeight?: number
  /** storyboard frame on scrub hover */
  seekPreview?: boolean
  /** remember and restore the playback position */
  resume?: boolean
  /** play the next item when one finishes */
  autoAdvance?: boolean
  /** frames in the scene-select grid */
  sheetFrames?: number
  /** switch the first text subtitle track on by itself */
  subtitleAuto?: boolean
  /** rate / file / recycle without the mouse. Supplied only by hosts that can
   *  see the app; the pop-out window renders the same viewer without it. */
  triage?: TriageHooks
}

/**
 * One entry in the viewer's menu.
 *
 * The descriptor is the shared thing: the More button and the right-click menu
 * render the same list, and the pop-out window gets both for free because it is
 * this same viewer. Anything that can be done to the item on screen is declared
 * here once, so the two surfaces cannot disagree about what exists.
 */
export interface MvEntry {
  label: string
  /** right-aligned shortcut hint; '' for entries with no key */
  key?: string
  /** rendered as a toggle that is currently on */
  on?: boolean
  enabled: boolean
  /** destructive, rendered in the danger colour */
  danger?: boolean
  separator?: boolean
  submenu?: MvEntry[]
  run?: () => void
}

/**
 * The search sites, fetched once and cached.
 *
 * The list lives in main because that is where the URLs are built — the
 * renderer names an engine and never supplies a URL, so a compromised renderer
 * cannot hand the desktop an arbitrary one to open.
 */
let engineCache: { id: string; label: string; image: boolean; text: boolean }[] = []
void (async () => {
  engineCache = await window.liq?.invoke?.('mediaSearchEngines').catch(() => []) as
    { id: string; label: string; image: boolean; text: boolean }[] ?? []
})()

export interface ViewerHandle {
  root: HTMLElement
  /** the drag handle the overlay hooks; also where its resize edges start */
  header: HTMLElement
  show(index: number): void
  next(): void
  prev(): void
  state(): ViewerState
  /** true when the key was consumed */
  handleKey(e: KeyboardEvent): boolean
  /** re-measure after the host resized (fit-to-window zoom depends on it) */
  layout(): void
  setFullscreenLabel(on: boolean): void
  /** show/hide the triage deck; no-op when the host supplied no hooks */
  toggleTriage(on?: boolean): void
  destroy(): void
}

const RATES = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2]
/** how far "fit" may enlarge a small picture; see fitScale() */
const MAX_FIT_UPSCALE = 8
/**
 * Arrow-key seek, matched to BulkMediaManager's player.
 *
 * Its `seek_step_s` is 5 and `seek_step_fast_s` is 30 (app/services/hotkeys.py),
 * and its arrows are the OPPOSITE way round from what this viewer used to do:
 * a bare arrow moves to the next FILE and a modifier seeks within the current
 * one. Two players on the same machine disagreeing about what Left means is a
 * worse problem than either mapping being wrong, so this one follows.
 */
const SEEK_STEP = 5
const SEEK_STEP_FAST = 30
const ZOOM_MIN = 0.05
const ZOOM_MAX = 16
const ZOOM_STEP = 1.25

const ICONS = {
  play: '<path d="M4 2.6v10.8L13.2 8z"/>',
  pause: '<path d="M4.4 2.8h2.6v10.4H4.4zM9 2.8h2.6v10.4H9z"/>',
  prev: '<path d="M10.6 3.2 5.4 8l5.2 4.8z"/>',
  next: '<path d="M5.4 3.2 10.6 8l-5.2 4.8z"/>',
  vol: '<path d="M3 6.2h2.4L8.4 3.6v8.8L5.4 9.8H3z"/><path d="M10.4 5.8a3 3 0 0 1 0 4.4M12.2 4a5.4 5.4 0 0 1 0 8" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/>',
  mute: '<path d="M3 6.2h2.4L8.4 3.6v8.8L5.4 9.8H3z"/><path d="m10.6 6 3.2 4M13.8 6l-3.2 4" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/>',
  popout: '<path d="M6.2 2.6h6.2a1 1 0 0 1 1 1v6.2" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/><rect x="2.6" y="5.8" width="7.6" height="7.6" rx="1.2" fill="none" stroke="currentColor" stroke-width="1.3"/>',
  full: '<path d="M2.6 6V2.6H6M10 2.6h3.4V6M13.4 10v3.4H10M6 13.4H2.6V10" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>',
  pin: '<path d="M9.4 1.8a1 1 0 0 1 1.4 0l3.4 3.4a1 1 0 0 1 0 1.4l-.9.9a1 1 0 0 1-.9.3l-.7-.2-2.3 2.3.3 2.4a1 1 0 0 1-.3.8l-.3.3a1 1 0 0 1-1.4 0L5.4 11 2 14.4a.6.6 0 0 1-.9-.8L4.6 10 2.3 7.8a1 1 0 0 1 0-1.4l.3-.3a1 1 0 0 1 .8-.3l2.4.3 2.3-2.3-.2-.7a1 1 0 0 1 .3-.9z"/>',
  unfull: '<path d="M6 2.6V6H2.6M10 6V2.6M10 6h3.4M10 13.4V10h3.4M6 10v3.4M6 10H2.6" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>',
  close: '<path d="M3.4 3.4l9.2 9.2M12.6 3.4l-9.2 9.2" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>',
  grid: '<rect x="1.8" y="2.4" width="5" height="4.6" rx="0.8" fill="none" stroke="currentColor" stroke-width="1.2"/><rect x="9.2" y="2.4" width="5" height="4.6" rx="0.8" fill="none" stroke="currentColor" stroke-width="1.2"/><rect x="1.8" y="9" width="5" height="4.6" rx="0.8" fill="none" stroke="currentColor" stroke-width="1.2"/><rect x="9.2" y="9" width="5" height="4.6" rx="0.8" fill="none" stroke="currentColor" stroke-width="1.2"/>',
  strip: '<rect x="1.4" y="4.4" width="4" height="7.2" rx="0.8" fill="none" stroke="currentColor" stroke-width="1.2"/><rect x="6" y="4.4" width="4" height="7.2" rx="0.8" fill="none" stroke="currentColor" stroke-width="1.2"/><rect x="10.6" y="4.4" width="4" height="7.2" rx="0.8" fill="none" stroke="currentColor" stroke-width="1.2"/>',
  star: '<path d="M8 1.8l1.85 3.9 4.25.6-3.1 3 .75 4.25L8 11.55 4.25 13.55 5 9.3 1.9 6.3l4.25-.6z" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/>',
  loop: '<path d="M4.2 5.4h6.2a2.4 2.4 0 0 1 0 4.8H9M11.8 10.6H5.6a2.4 2.4 0 0 1 0-4.8H7" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/><path d="M8.9 3.9 10.4 5.4 8.9 6.9M7.1 12.1 5.6 10.6 7.1 9.1" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/>',
  more: '<circle cx="3.4" cy="8" r="1.15"/><circle cx="8" cy="8" r="1.15"/><circle cx="12.6" cy="8" r="1.15"/>',
  cc: '<rect x="1.6" y="3.2" width="12.8" height="9.6" rx="1.6" fill="none" stroke="currentColor" stroke-width="1.3"/><path d="M6.6 6.8a1.8 1.8 0 1 0 0 2.4M11.4 6.8a1.8 1.8 0 1 0 0 2.4" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/>',
  zoomIn: '<circle cx="7" cy="7" r="4.4" fill="none" stroke="currentColor" stroke-width="1.3"/><path d="M10.3 10.3 14 14M7 4.9v4.2M4.9 7h4.2" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/>',
  zoomOut: '<circle cx="7" cy="7" r="4.4" fill="none" stroke="currentColor" stroke-width="1.3"/><path d="M10.3 10.3 14 14M4.9 7h4.2" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/>',
  fit: '<rect x="2.6" y="3.6" width="10.8" height="8.8" rx="1.2" fill="none" stroke="currentColor" stroke-width="1.3"/><path d="M5.4 6.4h5.2v3.2H5.4z"/>',
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K, cls?: string, text?: string,
): HTMLElementTagNameMap[K] {
  const n = document.createElement(tag)
  if (cls) n.className = cls
  if (text !== undefined) n.textContent = text
  return n
}

function iconBtn(cls: string, icon: string, title: string): HTMLButtonElement {
  const b = el('button', 'mv-btn ' + cls)
  b.type = 'button'
  b.title = title
  b.setAttribute('aria-label', title)
  b.innerHTML = `<svg viewBox="0 0 16 16" width="16" height="16" fill="currentColor">${icon}</svg>`
  return b
}

function setIcon(b: HTMLButtonElement, icon: string): void {
  const svg = b.firstElementChild
  if (svg) svg.innerHTML = icon
}

export function createViewer(opts: ViewerOptions): ViewerHandle {
  // a COPY: triage removes entries from this list, and the host's array (a tab's
  // rows, in the overlay's case) is not ours to splice
  const items = opts.items.length ? [...opts.items] : []
  let index = Math.max(0, Math.min(items.length - 1, opts.index))
  let handle: MediaHandle | null = null
  let kind: ViewKind = 'other'
  let destroyed = false

  // playback settings survive item changes and the hand-off to a pop-out window
  let volume = clamp01(opts.start?.volume ?? 1)
  let muted = !!opts.start?.muted
  let rate = opts.start?.rate ?? 1
  let pendingTime = opts.start?.time ?? 0
  let pendingPlay = opts.start?.playing ?? !!opts.autoplay
  /**
   * Does the user want playback running?
   *
   * Carried ACROSS items, which is the point: stepping through a folder of
   * clips used to load each one paused, so thumbing through meant pressing play
   * every single time. Only an auto-advance set pendingPlay before; a manual
   * next did not. This remembers the intent instead — press pause and the next
   * clip stays paused, leave it playing and the folder plays through.
   */
  let wantPlay = pendingPlay

  // image zoom: scale 1 = one image pixel per CSS pixel; `fit` recomputes it
  // from the stage on every layout, which is what makes resizing feel right
  // resume: the stored position for the CURRENT item, applied once the decoder
  // reports a real duration (a position is only meaningful against a length)
  let subs: SubtitleAttachment | null = null
  let tracks: MediaTracks | null = null
  /** guards a slow track probe landing after the user moved on */
  let tracksToken = 0

  let resumeAt = 0
  let resumeToken = 0
  let saveTimer = 0

  let fit = true
  let scale = 1
  let panX = 0
  let panY = 0

  // ------------------------------------------------------------------ chrome

  const root = el('div', 'mv-viewer')
  const header = el('div', 'mv-head')
  const title = el('div', 'mv-title')
  const count = el('div', 'mv-count')
  const headBtns = el('div', 'mv-head-btns')
  const popoutBtn = iconBtn('mv-popout', ICONS.popout, 'Open in a separate window')
  const pinBtn = iconBtn('mv-pin', ICONS.pin, 'Keep this window on top')
  const fullBtn = iconBtn('mv-full', ICONS.full, 'Fullscreen (F)')
  const closeBtn = iconBtn('mv-close', ICONS.close, 'Close (Esc)')
  if (opts.buttons?.popout !== false) headBtns.appendChild(popoutBtn)
  if (opts.buttons?.pin) headBtns.appendChild(pinBtn)
  if (opts.buttons?.fullscreen !== false) headBtns.appendChild(fullBtn)
  if (opts.buttons?.close !== false) headBtns.appendChild(closeBtn)
  header.append(title, count, headBtns)

  const stage = el('div', 'mv-stage')
  const content = el('div', 'mv-content')

  /**
   * View modes.
   *
   *   single   one item, the transport, the filmstrip — what this always was
   *   theatre  the same item with everything else out of the way: chrome dimmed
   *            to the edges of vision, the picture given the whole panel
   *   wall     an equal grid of muted looping tiles (media/wall.ts)
   *
   * The mode lives here rather than in the overlay because the viewer owns the
   * stage, the playlist and the keyboard — the three things a mode changes.
   */
  type ViewerMode = 'single' | 'theatre' | 'wall'
  let vmode: ViewerMode = 'single'
  let wall: WallHandle | null = null
  /** the away-click listener of whichever menu is open, so it can be removed */
  let menuAway: ((ev: MouseEvent) => void) | null = null
  /** audio outputs, refreshed in the background so the menu can be built now */
  let outputs: { id: string; label: string }[] = []
  void listOutputs().then(o => { outputs = o })
  const errorBox = el('div', 'mv-error')
  errorBox.hidden = true
  // transient, and deliberately not an error: "this is being converted for you"
  // is information, and a file that needed converting is still a file that played
  const note = el('div', 'mv-note')
  note.hidden = true
  let noteTimer = 0
  const prevBtn = iconBtn('mv-nav mv-prev', ICONS.prev, 'Previous (←)')
  const nextBtn = iconBtn('mv-nav mv-next', ICONS.next, 'Next (→)')
  // inside the stage on purpose: the deck sits on the bottom edge of the
  // PICTURE, above the transport bar and clear of the filename in the header
  const triage: TriageDeck | null = opts.triage
    ? createTriage(
      opts.triage,
      () => { if (items.length > 1) show(index + 1) },
      (gone) => {
        const at = items.indexOf(gone)
        if (at < 0) return
        items.splice(at, 1)
        strip.setItems(items)
        if (!items.length) { opts.onClose?.(); return }
        // deleting the last photo lands on the new last one, not back at the top
        show(Math.min(at, items.length - 1))
      },
    )
    : null
  stage.append(content, errorBox, note, prevBtn, nextBtn)
  if (triage) stage.appendChild(triage.el)

  // transport (video/audio)
  const bar = el('div', 'mv-bar')
  const playBtn = iconBtn('mv-play', ICONS.play, 'Play/pause (Space)')
  const timeNow = el('span', 'mv-time', '0:00')
  const timeEnd = el('span', 'mv-time mv-dur', '0:00')
  const scrub = el('div', 'mv-scrub')
  scrub.tabIndex = -1
  // hover storyboard: a frame from the moment under the pointer, above the bar
  const seekPop = el('div', 'mv-seekpop')
  seekPop.hidden = true
  const seekImg = el('img', 'mv-seekimg')
  seekImg.alt = ''
  const seekTime = el('div', 'mv-seektime', '0:00')
  seekPop.append(seekImg, seekTime)
  const bufWrap = el('div', 'mv-buf')
  const played = el('div', 'mv-played')
  const knob = el('div', 'mv-knob')
  // the A-B segment paints INSIDE the existing bar rather than getting a second
  // one of its own — a loop is a region of this timeline, not a timeline of its own
  const loopBand = el('div', 'mv-loop')
  loopBand.hidden = true
  scrub.append(bufWrap, loopBand, played, knob)
  const muteBtn = iconBtn('mv-mute', ICONS.vol, 'Mute (M)')
  const vol = el('input', 'mv-vol')
  vol.type = 'range'
  vol.min = '0'
  vol.max = '1'
  vol.step = '0.01'
  vol.title = 'Volume'
  const rateSel = el('select', 'mv-rate')
  for (const r of RATES) {
    const o = document.createElement('option')
    o.value = String(r)
    o.textContent = r === 1 ? '1×' : `${r}×`
    rateSel.appendChild(o)
  }
  rateSel.title = 'Playback speed'
  // shown only when the file actually has something to choose between
  const tracksBtn = iconBtn('mv-tracks', ICONS.cc, 'Subtitles and audio tracks')
  tracksBtn.hidden = true
  const sheetBtn = iconBtn('mv-sheet', ICONS.grid, 'Jump to a scene (G)')
  sheetBtn.hidden = true
  /**
   * The tools that had no button.
   *
   * Filmstrip, triage and looping were reachable only by pressing S, T and L —
   * which nobody can guess, so from the outside the player looked like a plain
   * transport bar with nothing else in it. Every one of them now has a control,
   * and the overflow menu lists the whole key map so the shortcuts are
   * learnable rather than secret.
   *
   * Built twice because video and images use different bars (transport vs
   * zoom) and exactly one is ever visible; a shared row would have meant
   * restructuring the layout for no gain.
   */
  function toolButtons(): HTMLElement[] {
    const stripBtn = iconBtn('mv-tool mv-tool-strip', ICONS.strip, 'Filmstrip (S)')
    stripBtn.addEventListener('click', () => { strip.toggle(); layout(); syncTools() })
    const rateBtn = iconBtn('mv-tool mv-tool-rate', ICONS.star, 'Rate and sort (T)')
    rateBtn.addEventListener('click', () => { triage?.toggle(); syncTools() })
    if (!opts.triage) rateBtn.hidden = true
    const loopBtn = iconBtn('mv-tool mv-tool-loop', ICONS.loop, 'Loop a section (L)')
    loopBtn.addEventListener('click', () => { cycleLoop(); syncTools() })
    const moreBtn = iconBtn('mv-tool mv-tool-more', ICONS.more, 'More')
    moreBtn.addEventListener('click', () => openMoreMenu(moreBtn))
    return [stripBtn, rateBtn, loopBtn, moreBtn]
  }
  const videoTools = toolButtons()
  const imageTools = toolButtons()

  /** keep the toggles looking like what they are */
  function syncTools(): void {
    for (const set of [videoTools, imageTools]) {
      set[0]?.classList.toggle('is-on', strip.isOn())
      set[1]?.classList.toggle('is-on', !!triage?.isOn())
      set[2]?.classList.toggle('is-on', loopIn !== null)
      // looping is meaningless for a still picture
      if (set[2]) set[2].hidden = kind !== 'video' && kind !== 'audio'
    }
  }

  bar.append(playBtn, timeNow, scrub, timeEnd, sheetBtn, tracksBtn, ...videoTools, muteBtn, vol, rateSel)

  // zoom bar (images)
  const zoomBar = el('div', 'mv-bar mv-zoombar')
  const zoomOutBtn = iconBtn('', ICONS.zoomOut, 'Zoom out (−)')
  const zoomInBtn = iconBtn('', ICONS.zoomIn, 'Zoom in (+)')
  const fitBtn = iconBtn('', ICONS.fit, 'Fit to window (0)')
  const zoomLabel = el('button', 'mv-zoomlabel', '100%')
  zoomLabel.title = 'Actual size (1)'
  const dims = el('span', 'mv-dims')
  zoomBar.append(zoomOutBtn, zoomLabel, zoomInBtn, fitBtn, dims, ...imageTools)

  // below the bars, not inside the stage: the strip is navigation, not an
  // overlay on the picture, and it must not eat into the image the way the
  // triage deck deliberately does
  const strip: FilmstripHandle = createFilmstrip((i) => show(i))
  root.append(header, stage, bar, zoomBar, strip.el, seekPop)

  // ---------------------------------------------------------------- modes

  /**
   * Enter a mode. Idempotent, and always leaves exactly one of the three in
   * charge of the stage — a wall left running behind a single item would keep
   * every one of its decoders alive.
   */
  function setMode(next: ViewerMode): void {
    if (destroyed || next === vmode) return
    // leaving wall: tear the decoders down before anything else is built
    if (vmode === 'wall') {
      wall?.destroy()
      wall = null
      content.hidden = false
    }
    vmode = next
    root.dataset.vmode = next

    if (next === 'wall') {
      // the single item stops: its audio would play under a wall of muted tiles
      handle?.dispose()
      handle = null
      content.hidden = true
      wall = createWall({
        items,
        index,
        // double-click a tile to spotlight it; Enter (or the tile menu, later)
        // hands it back to the single viewer
        onOpen: (i) => { setMode('single'); show(i) },
      })
      stage.appendChild(wall.el)
    } else if (vmode !== 'wall' && !handle) {
      // coming back from the wall: the single item has to be rebuilt
      show(index)
    }
    syncTools()
    layout()
  }

  function cycleMode(): void {
    setMode(vmode === 'single' ? 'theatre' : vmode === 'theatre' ? 'wall' : 'single')
  }

  // -------------------------------------------------------------- item switch

  function show(i: number): void {
    if (destroyed || !items.length) return
    // true modulo: `(i + len) % len` only corrects i >= -len, which was fine
    // while every caller stepped by one, but the wheel can ask for -8 on a
    // three-item playlist and that lands on a negative index.
    const n = items.length
    // the outgoing item's position, taken while its element is still alive
    saveResume()
    index = ((i % n) + n) % n
    const item = items[index]
    handle?.dispose()
    errorBox.hidden = true
    errorBox.textContent = ''
    note.hidden = true
    window.clearTimeout(noteTimer)
    content.textContent = ''
    fit = true
    panX = panY = 0
    window.clearTimeout(seekStuck)
    seekTarget = -1
    seekInFlight = false
    kind = viewKindFor(item)
    root.dataset.kind = kind
    // a clip stepped onto starts playing if playback was running when we left
    // the last one (see wantPlay)
    if (kind === 'video' || kind === 'audio') pendingPlay = pendingPlay || wantPlay

    handle = renderMedia(content, item, {
      maxHeight: opts.maxHeight,
      onReady: () => { applyMediaSettings(); layout() },
      // a restart-seek replaces the element's whole timeline; the bar must be
      // repainted from the stream rather than from the stale element
      onRestart: () => { paintTransport(); paintBuffered() },
      onTranscoding: (why) => {
        // the transport was hidden when the direct attempt failed; the file is
        // playable after all, so bring it back
        bar.hidden = false
        showNote(why)
      },
      onError: (msg) => {
        // 'no codec' can arrive LATE — canDecode is optimistic about Matroska,
        // so the decoder's verdict lands after the element was built and the
        // transport was already shown. Hide it then, or the panel keeps a play
        // button that does nothing under a message saying it cannot play.
        if (msg === 'no codec') { bar.hidden = true; return }
        if (msg !== 'unsupported') { errorBox.textContent = msg; errorBox.hidden = false }
      },
    })
    if (handle.media) wireMedia(handle.media)
    requestResume(item.path)

    title.textContent = item.name
    title.title = item.path
    count.textContent = items.length > 1 ? `${index + 1} / ${items.length}` : ''
    prevBtn.hidden = nextBtn.hidden = items.length < 2
    // keyed on whether a media element actually exists, not on the file's kind:
    // an undecodable video is still kind 'video', and showing its transport put
    // a play button that did nothing and a frozen 0:00 under the codec notice
    bar.hidden = !handle.media
    root.querySelector('.mv-moremenu')?.remove()
    syncTools()
    stage.querySelector('.mv-sheetgrid')?.remove()
    hideSeekPreview()
    clearLoop()
    renaming = false
    sheetBtn.hidden = kind !== 'video' || !handle.media
    zoomBar.hidden = kind !== 'image'
    dims.textContent = ''
    triage?.setItem(item)
    strip.setIndex(index)
    loadTracks(item)
    opts.onItem?.(item, index, items.length)
    layout()
    // warm the neighbours only AFTER this item's own request is out: kicked off
    // any earlier and the two reads race for the same share, making the photo
    // the user is waiting on the slower of the three
    schedulePreload()
  }

  /** the wheel can fire show() many times in a burst; preloading a window that
   *  is about to be superseded is pure share traffic, so settle first */
  let preloadTimer = 0
  function schedulePreload(): void {
    window.clearTimeout(preloadTimer)
    preloadTimer = window.setTimeout(() => {
      if (!destroyed) preloadAround(items, index)
    }, 180)
  }

  /**
   * Ask the main process where this file was left off. Async, so it races the
   * decoder's metadata — whichever finishes last does the seek, which is why
   * both this and applyMediaSettings call maybeResume() rather than seeking
   * directly. The token discards an answer that arrives after the user has
   * already moved on to a different item.
   */
  function requestResume(path: string): void {
    resumeAt = 0
    if (opts.resume === false) return
    const token = ++resumeToken
    if (!handle?.media || !path.startsWith('/')) return
    void window.liq?.invoke?.('getResume', [path])
      .then((map: Record<string, number>) => {
        if (destroyed || token !== resumeToken) return
        resumeAt = Number(map?.[path]) || 0
        maybeResume()
      })
      .catch(() => { /* no store, or main is gone: start from the beginning */ })
  }

  function maybeResume(): void {
    const m = handle?.media
    if (!m || resumeAt <= 0) return
    // Not yet — and crucially, do NOT consume resumeAt here. This runs once as
    // soon as the stored position arrives, which is usually BEFORE the decoder
    // has a duration; clearing it then left nothing for the loadedmetadata
    // retry and the video always started from zero.
    const dur = mediaDuration()
    if (dur <= 0) return
    // usableResume re-checks against the REAL duration: the one recorded at
    // write time could have come from a still-loading file
    const at = usableResume(resumeAt, dur)
    resumeAt = 0
    if (at > 0) seekTo(at)
  }

  /** Persist the current position. The store decides whether it is worth
   *  keeping (too early / too near the end / too short) — see shared/resume.ts. */
  function saveResume(): void {
    if (opts.resume === false) return
    const m = handle?.media
    const path = handle?.item.path
    if (!m || !path || !path.startsWith('/')) return
    const dur = mediaDuration()
    if (dur <= 0) return
    void window.liq?.invoke?.('setResume', path, mediaTime(), dur).catch(() => {})
  }

  // A transcoded file's element counts from zero at whatever point ffmpeg
  // started, and its duration is meaningless — handle.stream carries the real
  // timeline. Everything below asks these three rather than the element, so the
  // transport, the scrub bar, resume and the key map all work unchanged whether
  // the source is a plain file or a live transcode.
  function mediaDuration(): number {
    const st = handle?.stream
    if (st) return st.duration
    const m = handle?.media
    return m && Number.isFinite(m.duration) ? m.duration : 0
  }

  function mediaTime(): number {
    const st = handle?.stream
    if (st) return st.currentTime()
    // a queued target is where the user has asked to be; reporting the element's
    // stale position instead makes the knob jump backwards mid-drag
    if (seekTarget >= 0) return seekTarget
    const m = handle?.media
    return m && Number.isFinite(m.currentTime) ? m.currentTime : 0
  }

  /**
   * Seeking a plain file over SMB, serialised.
   *
   * Dragging the scrub bar produces a seek per pointer move. Assigning
   * currentTime for each one asks the share for a fresh set of byte ranges
   * before the previous set has arrived, and they queue up behind each other —
   * so the picture lags the knob by however many seeks are still in flight.
   *
   * One at a time instead: issue a seek, remember the newest target while it
   * runs, and issue only that one when 'seeked' lands. Every intermediate
   * target is dropped, which is right — nobody wants to watch the frames they
   * scrubbed past. The timer is the safety net for a seek that never completes,
   * which a stalled share does produce.
   */
  const SEEK_STUCK_MS = 1200
  let seekTarget = -1
  let seekInFlight = false
  let seekStuck = 0

  function issueSeek(m: HTMLMediaElement): void {
    if (seekTarget < 0) return
    const at = seekTarget
    seekTarget = -1
    seekInFlight = true
    window.clearTimeout(seekStuck)
    seekStuck = window.setTimeout(() => { seekInFlight = false; nextSeek() }, SEEK_STUCK_MS)
    m.currentTime = at
    paintTransport()
  }

  function nextSeek(): void {
    const m = handle?.media
    if (!m || seekInFlight || seekTarget < 0) return
    issueSeek(m)
  }

  function seekTo(sec: number): void {
    const dur = mediaDuration()
    const at = Math.max(0, dur > 0 ? Math.min(sec, dur) : sec)
    const st = handle?.stream
    // a transcoded stream does its own debounced restart; do not double-manage it
    if (st) { st.seek(at); paintTransport(); return }
    const m = handle?.media
    if (!m) return
    seekTarget = at
    // paint immediately so the knob tracks the pointer even while a seek runs
    paintTransport()
    if (!seekInFlight) issueSeek(m)
  }

  function showNote(text: string): void {
    note.textContent = text
    note.hidden = false
    window.clearTimeout(noteTimer)
    noteTimer = window.setTimeout(() => { note.hidden = true }, 4000)
  }

  /**
   * Find out what tracks this file has. Deliberately AFTER the element is
   * built and playing: it costs an ffprobe, and nothing about starting playback
   * should wait on it.
   */
  function loadTracks(item: MediaItem): void {
    const mine = ++tracksToken
    subs?.dispose()
    subs = null
    tracks = null
    tracksBtn.hidden = true
    if (!handle?.media || !item.path.startsWith('/')) return
    const m = handle.media
    void window.liq?.invoke?.('mediaTracks', item.path).then((t: MediaTracks) => {
      if (destroyed || mine !== tracksToken || handle?.media !== m) return
      tracks = t
      // one audio track and no subtitles is the overwhelmingly common case, and
      // a menu offering a single choice is worse than no menu
      const worth = (t.subs?.length ?? 0) > 0 || (t.audio?.length ?? 0) > 1
      tracksBtn.hidden = !worth
      subs = attachSubtitles(m, item.path, () => handle?.stream, (msg) => showNote(msg))
      // switch the first readable track on by itself when asked to; bitmap
      // tracks are skipped because nothing can display them here
      if (opts.subtitleAuto) {
        const first = t.subs?.find(x => x.textBased)
        if (first) void subs.select(first.n)
      }
    }).catch(() => { /* no ffprobe: no menu, playback unaffected */ })
  }

  function trackMenu(): void {
    if (!tracks) return
    const menu = el('div', 'mv-trackmenu')
    const add = (label: string, on: boolean, enabled: boolean, hint: string, onPick: () => void): void => {
      const b = el('button', 'mv-trackitem')
      b.textContent = label
      b.classList.toggle('is-on', on)
      if (hint) b.title = hint
      if (!enabled) { b.disabled = true; b.classList.add('is-off') }
      else b.addEventListener('click', () => { onPick(); menu.remove() })
      menu.appendChild(b)
    }

    if (tracks.subs.length) {
      menu.appendChild(el('div', 'mv-trackhead', 'Subtitles'))
      add('Off', (subs?.current() ?? -1) < 0, true, '', () => { void subs?.select(-1) })
      for (const t of tracks.subs) {
        add(
          trackLabel(t, `Track ${t.n + 1}`) + (t.textBased ? '' : ' (picture-based)'),
          subs?.current() === t.n,
          t.textBased,
          // saying WHY beats a mystery greyed-out row
          t.textBased ? '' : `${t.codec} is a picture, not text — it cannot be shown here. The external player can.`,
          () => { void subs?.select(t.n) },
        )
      }
    }

    if (tracks.audio.length > 1) {
      menu.appendChild(el('div', 'mv-trackhead', 'Audio'))
      const st = handle?.stream
      const chosen = st ? st.audioTrack() : -1
      for (const t of tracks.audio) {
        const isOn = chosen >= 0 ? chosen === t.n : t.isDefault
        const ch = t.channels >= 6 ? ' 5.1' : t.channels === 2 ? ' stereo' : ''
        add(
          trackLabel(t, `Track ${t.n + 1}`) + (t.title ? '' : ch),
          isOn,
          // switching tracks means re-muxing, which only the transcoder can do
          !!st,
          st ? '' : 'Switching audio tracks needs the file to be converted; it is playing directly.',
          () => { st?.setAudioTrack(t.n) },
        )
      }
    }

    // close on the next click anywhere else
    const away = (e: MouseEvent): void => {
      if (menu.contains(e.target as Node) || e.target === tracksBtn) return
      menu.remove()
      document.removeEventListener('mousedown', away, true)
    }
    document.addEventListener('mousedown', away, true)
    root.appendChild(menu)
    // above the bar, right-aligned with the button that opened it
    const br = tracksBtn.getBoundingClientRect()
    const rr = root.getBoundingClientRect()
    menu.style.right = `${Math.max(6, rr.right - br.right)}px`
    menu.style.bottom = `${rr.bottom - br.top + 6}px`
  }

  /**
   * The contact sheet: twelve frames from across the file, click one to jump.
   *
   * Built on demand and cached main-side — twelve frames cost 0.17 s and 53 KB
   * — so the first open of a long film is not noticeably slower than the second.
   */
  let sheetBusy = false
  async function toggleSheet(): Promise<void> {
    const open = stage.querySelector('.mv-sheetgrid')
    if (open) { open.remove(); return }
    const item = items[index]
    if (!item || sheetBusy || kind !== 'video') return
    sheetBusy = true
    sheetBtn.classList.add('is-busy')
    try {
      const frames = await window.liq?.invoke?.('contactSheet', item.path, opts.sheetFrames ?? 12)
        .catch(() => []) as { file: string; at: number }[]
      if (destroyed || !frames?.length) {
        if (!destroyed) showNote('No frames could be taken from this file.')
        return
      }
      const grid = el('div', 'mv-sheetgrid')
      for (const f of frames) {
        const cell = el('button', 'mv-sheetcell')
        cell.title = `Jump to ${clock(f.at)}`
        const img = el('img')
        img.alt = ''
        img.src = previewURL(f.file, { type: 'image/jpeg' })
        const stamp = el('span', 'mv-sheettime', clock(f.at))
        cell.append(img, stamp)
        cell.addEventListener('click', () => {
          grid.remove()
          seekTo(f.at)
          const m = handle?.media
          if (m?.paused) void m.play().catch(() => {})
        })
        grid.appendChild(cell)
      }
      const close = el('button', 'mv-sheetclose', '\u2715')
      close.title = 'Close (G)'
      close.addEventListener('click', () => grid.remove())
      grid.appendChild(close)
      stage.appendChild(grid)
    } finally {
      sheetBusy = false
      sheetBtn.classList.remove('is-busy')
    }
  }

  sheetBtn.addEventListener('click', () => { void toggleSheet() })

  tracksBtn.addEventListener('click', () => {
    const open = root.querySelector('.mv-trackmenu')
    if (open) { open.remove(); return }
    trackMenu()
  })

  function applyMediaSettings(): void {
    const m = handle?.media
    if (!m) return
    m.volume = volume
    m.muted = muted
    m.playbackRate = rate
    vol.value = String(volume)
    rateSel.value = String(rate)
    setIcon(muteBtn, muted || volume === 0 ? ICONS.mute : ICONS.vol)
    if (pendingTime > 0 && mediaDuration() > 0) {
      // one-shot: the hand-off position only applies to the item we came in on
      seekTo(Math.min(pendingTime, Math.max(0, mediaDuration() - 0.25)))
      pendingTime = 0
      // an explicit hand-off beats a stored position: popping out mid-video
      // must land where the panel was, not where the file was last closed
      resumeAt = 0
    }
    maybeResume()
    if (pendingPlay) {
      pendingPlay = false
      void m.play().catch(() => { /* autoplay refused / codec gone */ })
    }
    paintTransport()
  }

  function wireMedia(m: HTMLMediaElement): void {
    // Follow the desktop's audio output. Chromium binds an element to a device
    // when it starts and keeps it there, so plugging in headphones mid-film
    // otherwise leaves the sound coming out of the speakers you walked away
    // from while every other app has already moved.
    attachAudioOutput(m, (text) => showNote(text))
    m.addEventListener('timeupdate', paintTransport)
    m.addEventListener('seeked', () => {
      window.clearTimeout(seekStuck)
      seekInFlight = false
      nextSeek()
    })
    // duration can arrive after the resume answer did
    m.addEventListener('loadedmetadata', maybeResume)
    m.addEventListener('durationchange', maybeResume)
    // periodic, because the common way out of a video is closing the whole
    // window — which does not always give us a teardown we can save from
    if (!saveTimer) saveTimer = window.setInterval(() => { if (!handle?.media?.paused) saveResume() }, 4000)
    m.addEventListener('pause', saveResume)
    m.addEventListener('progress', paintBuffered)
    m.addEventListener('durationchange', paintTransport)
    m.addEventListener('play', paintTransport)
    m.addEventListener('pause', paintTransport)
    m.addEventListener('volumechange', () => {
      volume = m.volume
      muted = m.muted
      vol.value = String(volume)
      setIcon(muteBtn, muted || volume === 0 ? ICONS.mute : ICONS.vol)
    })
    // walking a folder of clips: the next one starts when this one finishes,
    // and stops at the end rather than looping the folder for ever
    m.addEventListener('ended', () => {
      if (opts.autoAdvance === false) return
      if (index < items.length - 1) { pendingPlay = true; wantPlay = true; show(index + 1) }
    })
  }

  // ------------------------------------------------------------- transport UI

  /**
   * A-B looping.
   *
   * One key sets the in-point, the same key sets the out-point, and the third
   * press clears it — a single control for a feature that is only ever used
   * mid-playback, when reaching for a second key is the friction.
   *
   * MIN_LOOP exists because an accidental double-press produces a zero-length
   * span, and a zero-length loop is a hang: the player would seek back to the
   * in-point on every frame and never advance.
   */
  const MIN_LOOP = 0.4
  let loopIn: number | null = null
  let loopOut: number | null = null

  function cycleLoop(): void {
    if (!handle?.media || mediaDuration() <= 0) return
    const now = mediaTime()
    if (loopIn === null) {
      loopIn = now
      showNote(`Loop start ${clock(now)} — press L again to set the end`)
    } else if (loopOut === null) {
      if (now - loopIn < MIN_LOOP) { showNote('That loop is too short.'); return }
      loopOut = now
      showNote(`Looping ${clock(loopIn)} to ${clock(now)} — L again to clear`)
    } else {
      clearLoop()
      showNote('Loop cleared')
    }
    paintLoop()
  }

  function clearLoop(): void {
    loopIn = loopOut = null
    paintLoop()
  }

  function paintLoop(): void {
    const dur = mediaDuration()
    if (loopIn === null || dur <= 0) { loopBand.hidden = true; return }
    const a = Math.max(0, Math.min(1, loopIn / dur))
    // while only the in-point is set, show a hairline marker rather than a band
    const b = loopOut === null ? a : Math.max(0, Math.min(1, loopOut / dur))
    loopBand.hidden = false
    loopBand.classList.toggle('is-pending', loopOut === null)
    loopBand.style.left = (a * 100).toFixed(3) + '%'
    loopBand.style.width = (Math.max(b - a, 0) * 100).toFixed(3) + '%'
  }

  /** called from the transport paint, which already runs on every timeupdate */
  function enforceLoop(): void {
    if (loopIn === null || loopOut === null) return
    const m = handle?.media
    if (!m || m.paused) return
    // a small lead-in avoids overshooting past the end on a coarse timeupdate
    if (mediaTime() >= loopOut) seekTo(loopIn)
  }

  function paintTransport(): void {
    const m = handle?.media
    if (!m) return
    const dur = mediaDuration()
    const now = mediaTime()
    timeNow.textContent = clock(now)
    timeEnd.textContent = clock(dur)
    const frac = dur > 0 ? Math.min(1, now / dur) : 0
    played.style.width = (frac * 100).toFixed(3) + '%'
    knob.style.left = (frac * 100).toFixed(3) + '%'
    setIcon(playBtn, m.paused ? ICONS.play : ICONS.pause)
    paintLoop()
    enforceLoop()
    paintBuffered()
  }

  function paintBuffered(): void {
    const m = handle?.media
    if (!m) return
    const dur = mediaDuration()
    bufWrap.textContent = ''
    if (dur <= 0) return
    for (let i = 0; i < m.buffered.length; i++) {
      const seg = el('div', 'mv-buf-seg')
      seg.style.left = ((m.buffered.start(i) / dur) * 100).toFixed(3) + '%'
      seg.style.width = (((m.buffered.end(i) - m.buffered.start(i)) / dur) * 100).toFixed(3) + '%'
      bufWrap.appendChild(seg)
    }
  }

  function seekToClientX(clientX: number): void {
    const m = handle?.media
    if (!m || mediaDuration() <= 0) return
    const r = scrub.getBoundingClientRect()
    const frac = Math.max(0, Math.min(1, (clientX - r.left) / Math.max(1, r.width)))
    seekTo(frac * mediaDuration())
    paintTransport()
  }

  scrub.addEventListener('pointerdown', (e) => {
    e.preventDefault()
    scrub.setPointerCapture(e.pointerId)
    seekToClientX(e.clientX)
    const move = (ev: PointerEvent): void => seekToClientX(ev.clientX)
    const up = (): void => {
      scrub.removeEventListener('pointermove', move)
      scrub.removeEventListener('pointerup', up)
      scrub.removeEventListener('pointercancel', up)
    }
    scrub.addEventListener('pointermove', move)
    scrub.addEventListener('pointerup', up)
    scrub.addEventListener('pointercancel', up)
  })

  playBtn.addEventListener('click', () => togglePlay())
  muteBtn.addEventListener('click', () => toggleMute())
  vol.addEventListener('input', () => {
    volume = clamp01(Number(vol.value))
    muted = volume === 0
    const m = handle?.media
    if (m) { m.volume = volume; m.muted = muted }
    setIcon(muteBtn, muted ? ICONS.mute : ICONS.vol)
  })
  rateSel.addEventListener('change', () => {
    rate = Number(rateSel.value) || 1
    if (handle?.media) handle.media.playbackRate = rate
  })

  /**
   * The frame under the pointer, shown above the scrub bar.
   *
   * Two things keep this cheap enough to leave always on. The request is
   * debounced, so sweeping across the bar asks for the moment the pointer
   * SETTLES on rather than every pixel it crossed; and the main side snaps the
   * time to a 5-second grid, so a second pass over the same stretch is a cache
   * hit rather than another ffmpeg. The timestamp updates immediately either
   * way — the number is the useful half, and it must not wait for a picture.
   */
  const SEEK_PREVIEW_MS = 90
  let seekPreviewTimer = 0
  let seekPreviewToken = 0

  function timeAtClientX(clientX: number): number {
    const r = scrub.getBoundingClientRect()
    if (r.width <= 0) return 0
    return clamp01((clientX - r.left) / r.width) * mediaDuration()
  }

  function showSeekPreview(clientX: number): void {
    if (opts.seekPreview === false) { hideSeekPreview(); return }
    const item = items[index]
    if (!mediaDuration() || kind !== 'video' || !item) { hideSeekPreview(); return }
    const at = timeAtClientX(clientX)
    seekTime.textContent = clock(at)

    // keep the popup inside the panel rather than letting it hang off an edge
    const rr = root.getBoundingClientRect()
    const sr = scrub.getBoundingClientRect()
    const half = (seekPop.offsetWidth || 168) / 2
    seekPop.style.left = `${Math.max(half + 4, Math.min(clientX - rr.left, rr.width - half - 4))}px`
    seekPop.style.bottom = `${rr.bottom - sr.top + 10}px`
    seekPop.hidden = false

    const token = ++seekPreviewToken
    window.clearTimeout(seekPreviewTimer)
    seekPreviewTimer = window.setTimeout(() => {
      void window.liq?.invoke?.('seekFrame', item.path, at).then((file: string) => {
        // a frame that arrives after the pointer moved on is not wrong, just
        // stale — painting it would make the preview lag the cursor
        if (destroyed || token !== seekPreviewToken || !file || seekPop.hidden) return
        seekImg.src = previewURL(file, { type: 'image/jpeg' })
      }).catch(() => { /* no ffmpeg: the timestamp alone is still worth showing */ })
    }, SEEK_PREVIEW_MS)
  }

  function hideSeekPreview(): void {
    window.clearTimeout(seekPreviewTimer)
    seekPreviewToken++
    seekPop.hidden = true
    seekImg.removeAttribute('src')
  }

  scrub.addEventListener('pointermove', (e) => { showSeekPreview(e.clientX) })
  scrub.addEventListener('pointerleave', () => { hideSeekPreview() })

  /**
   * Rename the file you are looking at, without leaving it.
   *
   * The viewer is where you find out a name is wrong — you are looking at the
   * picture, not at a list of filenames — and going back to the grid to fix it
   * loses your place in the folder. F2 or a click on the title edits in place.
   *
   * It goes through liq.renameOne, the same verb the grid's inline rename uses,
   * so the collision handling, the undo entry and the history row are the ones
   * that already exist rather than a second implementation of each.
   */
  let renaming = false

  function startRename(): void {
    const item = items[index]
    if (renaming || !item || !item.path.startsWith('/')) return
    renaming = true
    const original = item.name
    const input = el('input', 'mv-rename')
    input.type = 'text'
    input.value = original
    title.replaceChildren(input)
    input.focus()
    // select the stem, not the extension — the same courtesy the grid extends
    const dot = original.lastIndexOf('.')
    input.setSelectionRange(0, dot > 0 ? dot : original.length)

    const finish = (commit: boolean): void => {
      if (!renaming) return
      renaming = false
      const next = input.value.trim()
      title.textContent = original
      title.title = item.path
      if (!commit || !next || next === original) return
      void window.liq?.invoke?.('renameOne', item.path, next).then((r: { ok: boolean; error?: string; newPath?: string }) => {
        if (!r?.ok) { showNote(r?.error || 'That name could not be used.'); return }
        // the playlist holds paths; leaving the old one there would make the
        // next prev/next open a file that no longer exists
        const moved = r.newPath ?? item.path
        items[index] = { ...item, path: moved, name: next, ext: next.slice(next.lastIndexOf('.') + 1).toLowerCase() }
        title.textContent = next
        title.title = moved
        strip.setItems(items)
        strip.setIndex(index)
        opts.onItem?.(items[index], index, items.length)
        showNote(`Renamed to ${next}`)
      }).catch(() => { showNote('That name could not be used.') })
    }

    input.addEventListener('keydown', (e) => {
      // stopPropagation, or the viewer's own key map would read the typing as
      // transport commands — 'l' would start a loop mid-word
      e.stopPropagation()
      if (e.key === 'Enter') { e.preventDefault(); finish(true) }
      else if (e.key === 'Escape') { e.preventDefault(); finish(false) }
    })
    input.addEventListener('blur', () => finish(true))
  }

  // The title sits in the header, and the header is the panel's DRAG HANDLE.
  // A plain click listener would therefore open the editor every time the user
  // finished dragging the panel by its title. So the click only counts when the
  // pointer did not travel — the same test dropbins.ts uses to tell a click on
  // its dock from a drag of it.
  const CLICK_SLOP = 4
  let downAt: { x: number; y: number } | null = null
  title.addEventListener('pointerdown', (e) => { downAt = { x: e.clientX, y: e.clientY } })
  title.addEventListener('click', (e) => {
    const from = downAt
    downAt = null
    if (renaming || !from) return
    if (Math.abs(e.clientX - from.x) > CLICK_SLOP || Math.abs(e.clientY - from.y) > CLICK_SLOP) return
    startRename()
  })

  /**
   * Everything the viewer can do, with its key.
   *
   * Doubles as the key map: a shortcut nobody can discover is a shortcut nobody
   * uses, and this player had six of them hidden behind letters.
   */
  function menuEntries(): MvEntry[] {
    const isMedia = kind === 'video' || kind === 'audio'
    const entries: MvEntry[] = [
      { label: 'Filmstrip', key: 'S', on: strip.isOn(), enabled: items.length > 1,
        run: () => { strip.toggle(); layout() } },
      { label: 'Rate and sort', key: 'T', on: !!triage?.isOn(), enabled: !!opts.triage,
        run: () => triage?.toggle() },
      { label: 'Scene select', key: 'G', enabled: kind === 'video', run: () => { void toggleSheet() } },
      { label: loopIn === null ? 'Loop a section' : 'Clear the loop', key: 'L',
        on: loopIn !== null, enabled: isMedia, run: () => cycleLoop() },
      { label: 'Rename…', key: 'F2', enabled: !!items[index]?.path.startsWith('/'), run: () => startRename() },
      { label: 'Fullscreen', key: 'F', enabled: true, run: () => opts.onFullscreen?.() },
      { label: 'Theatre mode', key: 'T', on: vmode === 'theatre', enabled: true,
        run: () => setMode(vmode === 'theatre' ? 'single' : 'theatre') },
      { label: 'Wall', key: 'W', on: vmode === 'wall', enabled: items.length > 1,
        run: () => setMode(vmode === 'wall' ? 'single' : 'wall') },
      { label: 'Grid size', key: 'G', enabled: vmode === 'wall', run: () => wall?.cycleGrid() },
      { label: 'Open with…', key: '', enabled: !!items[index],
        run: () => { void window.liq?.openPath?.(items[index].path) } },
    ]
    return entries.concat(itemEntries())
  }

  /**
   * Render the descriptor, either under an anchor or at a point.
   *
   * ONE renderer for the More button and the right-click menu, because the
   * popped-out window is this same viewer in a different frame: a second menu
   * built separately for it would drift, and the two would disagree about what
   * the viewer can do. That divergence is the bug, not the missing menu.
   */
  /**
   * What can be done to the ITEM on screen, as opposed to the viewer itself.
   *
   * Split out because the two lists have different lifetimes: the viewer's own
   * toggles are always the same, while these depend on what is showing. A gif
   * is not a video and not a still, and it is the only one of the three where
   * "convert this" is the most useful thing on the menu.
   */
  function itemEntries(): MvEntry[] {
    const it = items[index]
    const local = !!it?.path.startsWith('/')
    const dir = local ? it.path.slice(0, it.path.lastIndexOf('/')) || '/' : ''
    const isGif = it?.ext === 'gif'
    const out: MvEntry[] = [{ label: '', enabled: false, separator: true }]

    out.push(
      { label: 'Copy as path', key: '', enabled: local,
        run: () => { void window.liq?.copyTextToClipboard?.(it.path) } },
      { label: 'Copy', key: '', enabled: local,
        run: () => { void window.liq?.clipboardSet?.({ paths: [it.path], cut: false }) } },
      // "Show in folder" is what every other file manager calls this, and it
      // reveals the FILE — selected — rather than dropping you in the folder
      { label: 'Show in folder', key: '', enabled: local,
        run: () => { void window.liq?.invoke?.('revealPath', it.path) } },
    )

    if (isGif) {
      out.push({ label: '', enabled: false, separator: true })
      out.push({
        label: 'Convert to video', key: '', enabled: local,
        submenu: [
          { label: 'MP4', enabled: true, run: () => void convertGif('mp4') },
          { label: 'WebM', enabled: true, run: () => void convertGif('webm') },
        ],
      })
    }
    if (kind === 'video') {
      out.push({ label: '', enabled: false, separator: true })
      out.push({ label: 'Save frame as image…', key: '', enabled: local,
        run: () => void saveFrame() })
    }

    // Looking it up. Images search by the picture; a video or a gif searches by
    // the FRAME on screen, which is why this belongs to the viewer — it is the
    // only place that knows which frame you meant. Both routes hand off to the
    // browser, so neither makes a connection from this app.
    const searchable = kind === 'image' || kind === 'video'
    if (searchable && engineCache.length) {
      // filtered by what each site can actually do: DuckDuckGo has no reverse
      // image search, and listing it under one is offering something that does
      // not exist
      const byPicture: MvEntry[] = engineCache.filter(e => e.image).map(e => ({
        label: e.label, enabled: true, run: () => void searchFor(e.id, e.label),
      }))
      const byName: MvEntry[] = engineCache.filter(e => e.text).map(e => ({
        label: e.label, enabled: true, run: () => void searchName(e.id),
      }))
      out.push({ label: '', enabled: false, separator: true })
      if (byPicture.length) {
        out.push({
          label: 'Find this image online',
          key: '', enabled: local, submenu: byPicture,
        })
      }
      if (byName.length) {
        out.push({ label: 'Search the web', key: '', enabled: local, submenu: byName })
      }
    }

    // Where the sound goes. Only for things that HAVE sound, and only when the
    // machine has more than one place to send it — a single-output machine
    // would just get a menu item that says "Default".
    if ((kind === 'video' || kind === 'audio') && outputs.length > 1) {
      const cur = chosenOutput()
      out.push({ label: '', enabled: false, separator: true })
      out.push({
        label: 'Audio output', key: '', enabled: true,
        submenu: [
          {
            label: 'System default', enabled: true, on: !cur,
            run: () => { void useOutput('').then(l => showNote(`Sound follows the system default (${l})`)) },
          },
          ...outputs.filter(o => o.id !== 'default').map(o => ({
            label: o.label, enabled: true, on: cur === o.id,
            run: () => { void useOutput(o.id).then(l => showNote(`Sound going to ${l}`)) },
          })),
        ],
      })
    }

    // Delete belongs on the menu, not only on a key. A destructive action that
    // exists solely as a keyboard shortcut is invisible: nobody discovers it,
    // and anyone who half-remembers it is guessing at a key that deletes files.
    out.push({ label: '', enabled: false, separator: true })
    out.push({ label: 'Delete', key: 'Del', enabled: local, danger: true,
      run: () => deleteCurrent(false) })

    out.push({ label: '', enabled: false, separator: true })
    out.push({ label: 'Properties', key: '', enabled: local,
      run: () => { void window.liq?.showProperties?.([it.path]) } })
    return out
  }

  /**
   * Ask once, before anything is ever looked up on the internet.
   *
   * Rendered INSIDE the viewer, not through the dialog layer, because the
   * pop-out window has no dialog layer — it boots no app. A consent prompt that
   * only worked in the docked panel would mean the pop-out either asked nothing
   * or could not offer the feature at all.
   *
   * The wording says what actually happens rather than reassuring: the picture
   * goes to the clipboard and the browser is opened. This app makes no
   * connection of its own, and that is a fact worth stating plainly, because it
   * is the reason this needs no proxy and no VPN setting.
   */
  function askToSearch(engineLabel: string): Promise<boolean> {
    return new Promise(resolve => {
      root.querySelector('.mv-consent')?.remove()
      const box = el('div', 'mv-consent')
      box.appendChild(el('h3', '', 'Look this up on the internet?'))
      const p = el('div', 'mv-consent-body')
      p.appendChild(el('p', '', `The picture will be copied to your clipboard and ${engineLabel} will open in your normal browser. Paste it there with Ctrl+V.`))
      p.appendChild(el('p', 'mv-consent-note', 'LiqExplorer does not connect to anything itself — your browser makes the request, with whatever privacy setup it already has.'))
      box.appendChild(p)
      const row = el('div', 'mv-consent-row')
      const no = el('button', 'mv-consent-btn', 'Not this time')
      const yes = el('button', 'mv-consent-btn is-primary', 'Open my browser')
      row.append(no, yes)
      box.appendChild(row)
      const done = (ok: boolean, remember: '' | 'browser' | 'no'): void => {
        box.remove()
        if (remember) void window.liq?.setSettings?.({ mediaSearchConsent: remember })
        resolve(ok)
      }
      no.addEventListener('click', () => done(false, 'no'))
      yes.addEventListener('click', () => done(true, 'browser'))
      root.appendChild(box)
      yes.focus()
    })
  }

  interface SearchSettings {
    mediaSearchConsent?: string
    mediaSearchBrowser?: string
    mediaSearchUnfiltered?: boolean
    mediaSearchYandexDomain?: string
  }

  /**
   * Which browser to send this to, asked once and then remembered.
   *
   * Chrome, Chromium and LiqBrowser are all registered https handlers on a
   * machine like this one, and they are not interchangeable — one of them may
   * be the browser with the privacy setup the user actually wants this traffic
   * to go through. Sending it to whichever the desktop happens to default to
   * makes that choice for them silently.
   */
  function pickBrowser(list: { id: string; name: string }[]): Promise<{ id: string; remember: boolean } | null> {
    return new Promise(resolve => {
      root.querySelector('.mv-consent')?.remove()
      const box = el('div', 'mv-consent')
      box.appendChild(el('h3', '', 'Which browser should this open in?'))
      const body = el('div', 'mv-consent-body')
      let chosen = list[0]?.id ?? ''
      for (const b of list) {
        const row = el('label', 'mv-pick-row')
        const radio = document.createElement('input')
        radio.type = 'radio'
        radio.name = 'mv-browser'
        radio.checked = b.id === chosen
        radio.addEventListener('change', () => { chosen = b.id })
        row.append(radio, el('span', '', b.name))
        body.appendChild(row)
      }
      const remember = document.createElement('input')
      remember.type = 'checkbox'
      remember.checked = true
      const rem = el('label', 'mv-pick-row mv-pick-remember')
      rem.append(remember, el('span', '', 'Remember this and stop asking'))
      body.appendChild(rem)
      box.appendChild(body)
      const row = el('div', 'mv-consent-row')
      const cancel = el('button', 'mv-consent-btn', 'Cancel')
      const go = el('button', 'mv-consent-btn is-primary', 'Open it')
      row.append(cancel, go)
      box.appendChild(row)
      cancel.addEventListener('click', () => { box.remove(); resolve(null) })
      go.addEventListener('click', () => { box.remove(); resolve({ id: chosen, remember: remember.checked }) })
      root.appendChild(box)
      go.focus()
    })
  }

  /** settings + the browser to use, asking for whichever is not decided yet */
  async function searchContext(engineLabel: string, needConsent: boolean):
  Promise<{ opts: unknown; appId: string } | null> {
    const s = await window.liq?.getSettings?.().catch(() => null) as SearchSettings | null
    if (needConsent && s?.mediaSearchConsent !== 'browser') {
      // 'no' asks again rather than staying refused forever: the user chose this
      // entry deliberately, so treating an old "not this time" as a permanent
      // veto would leave a menu item that silently does nothing
      if (!await askToSearch(engineLabel)) return null
    }
    let appId = s?.mediaSearchBrowser ?? ''
    if (!appId) {
      const list = await window.liq?.invoke?.('mediaSearchBrowsers').catch(() => []) as
        { id: string; name: string }[] ?? []
      // one browser is not a choice, and no browsers means let the desktop decide
      if (list.length > 1) {
        const pick = await pickBrowser(list)
        if (!pick) return null
        appId = pick.id
        if (pick.remember) void window.liq?.setSettings?.({ mediaSearchBrowser: appId })
      }
    }
    return {
      opts: {
        unfiltered: s?.mediaSearchUnfiltered !== false,
        yandexDomain: s?.mediaSearchYandexDomain ?? 'yandex.com',
      },
      appId,
    }
  }

  /** Copy the picture (or this frame) out, then open the chosen search site. */
  async function searchFor(engine: string, engineLabel: string): Promise<void> {
    const it = items[index]
    if (!it) return
    const ctx = await searchContext(engineLabel, true)
    if (!ctx) { showNote('Nothing was sent.'); return }
    showNote('Copying the picture…')
    const c = await window.liq?.invoke?.('mediaCopyPicture', it.path, mediaTime())
      .catch((e: Error) => ({ ok: false, error: String(e?.message ?? e) })) as
      { ok: boolean; error?: string } | undefined
    if (!c?.ok) { showNote(c?.error ?? 'That picture could not be copied.'); return }
    const r = await window.liq?.invoke?.('mediaOpenImageSearch', engine, ctx.opts, ctx.appId)
      .catch((e: Error) => ({ ok: false, error: String(e?.message ?? e) })) as
      { ok: boolean; engine?: string; error?: string } | undefined
    showNote(r?.ok ? `${r.engine} opened — paste with Ctrl+V` : r?.error ?? 'That site could not be opened.')
  }

  /** Plain web search for the file's name. Nothing is uploaded at all. */
  async function searchName(engine: string): Promise<void> {
    const it = items[index]
    if (!it) return
    // strip the extension and the usual separators: "My.Clip.2019.1080p.mkv"
    // searches far better as words than as a filename
    const q = it.name.replace(/\.[^.]+$/, '').replace(/[._]+/g, ' ').trim()
    // no consent gate: this uploads nothing, it is a web search for a word
    const ctx = await searchContext('', false)
    if (!ctx) return
    const r = await window.liq?.invoke?.('mediaOpenTextSearch', engine, q, ctx.opts, ctx.appId)
      .catch((e: Error) => ({ ok: false, error: String(e?.message ?? e) })) as
      { ok: boolean; engine?: string; error?: string } | undefined
    showNote(r?.ok ? `Searched ${r.engine} for “${q}”` : r?.error ?? 'That search could not be opened.')
  }

  // ------------------------------------------------------------ deleting

  /**
   * Delete the file on screen.
   *
   * BOTH ROUTES GO TO THE RECYCLE BIN, and that is deliberate. `Shift+Delete`
   * skips the question, which is the point of it — culling a folder of photos
   * one key at a time is unusable if every press opens a dialog. But "no
   * confirmation" is only safe when the action is reversible, so the quiet path
   * is exactly as recoverable as the asked one and every delete leaves an undo
   * offer behind. A silent, permanent, unrecoverable delete on a bare keypress
   * is not a feature this should grow.
   *
   * The bar is rendered INSIDE the viewer rather than through the app's toast,
   * because the popped-out window has no app behind it — a delete there would
   * otherwise happen with no feedback and no way back.
   */
  function deleteCurrent(quiet: boolean): void {
    const it = items[index]
    if (!it?.path.startsWith('/')) return
    if (quiet) { void doDelete(it); return }
    askDelete(it.name).then(ok => { if (ok) void doDelete(it) })
  }

  function askDelete(name: string): Promise<boolean> {
    return new Promise(resolve => {
      root.querySelector('.mv-consent')?.remove()
      const box = el('div', 'mv-consent')
      box.appendChild(el('h3', '', 'Move to the Recycle Bin?'))
      const body = el('div', 'mv-consent-body')
      body.appendChild(el('p', '', midName(name)))
      body.appendChild(el('p', 'mv-consent-note', 'Shift+Delete does this without asking.'))
      box.appendChild(body)
      const row = el('div', 'mv-consent-row')
      const no = el('button', 'mv-consent-btn', 'Keep it')
      const yes = el('button', 'mv-consent-btn is-primary', 'Delete')
      row.append(no, yes)
      box.appendChild(row)
      const done = (v: boolean): void => { box.remove(); resolve(v) }
      no.addEventListener('click', () => done(false))
      yes.addEventListener('click', () => done(true))
      // Escape and Enter, because a confirmation you must reach for the mouse to
      // answer is the reason people stop reading confirmations
      box.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') { e.stopPropagation(); done(false) }
        if (e.key === 'Enter') { e.stopPropagation(); done(true) }
      })
      root.appendChild(box)
      yes.focus()
    })
  }

  /** middle-ellipsised, so a long name does not push the buttons off the box */
  function midName(n: string): string {
    return n.length <= 64 ? n : `${n.slice(0, 34)}…${n.slice(-26)}`
  }

  async function doDelete(it: MediaItem): Promise<void> {
    const gone = it
    try {
      await window.liq?.startOp?.({ kind: 'trash', sources: [gone.path] })
    } catch (e) {
      showNote(String((e as Error)?.message ?? e))
      return
    }
    dropItem(gone)
    showUndoBar(gone.name)
  }

  /** take a deleted item out of the playlist and land somewhere sensible */
  function dropItem(gone: MediaItem): void {
    const at = items.indexOf(gone)
    if (at < 0) return
    items.splice(at, 1)
    strip.setItems(items)
    if (!items.length) { opts.onClose?.(); return }
    // deleting the last item lands on the new last one, not back at the top
    show(Math.min(at, items.length - 1))
  }

  let undoTimer = 0

  function showUndoBar(name: string): void {
    root.querySelector('.mv-undobar')?.remove()
    window.clearTimeout(undoTimer)
    const bar = el('div', 'mv-undobar')
    bar.appendChild(el('span', 'mv-undobar-text', `${midName(name)} moved to the Recycle Bin`))
    const btn = el('button', 'mv-undobar-btn', 'Undo')
    btn.addEventListener('click', () => {
      window.clearTimeout(undoTimer)
      bar.remove()
      void window.liq?.undo?.()
        .then(() => showNote(`${midName(name)} put back`))
        .catch(() => showNote('That could not be undone.'))
    })
    bar.appendChild(btn)
    root.appendChild(bar)
    // long enough to notice and act on, short enough not to sit over the picture
    undoTimer = window.setTimeout(() => bar.remove(), 9000)
  }

  /** Write the frame on screen out as a PNG, beside the video. */
  async function saveFrame(): Promise<void> {
    const it = items[index]
    if (!it) return
    showNote('Saving this frame…')
    const r = await window.liq?.invoke?.('mediaSaveFrame', it.path, mediaTime())
      .catch((e: Error) => ({ ok: false, error: String(e?.message ?? e) })) as
      { ok: boolean; path?: string; error?: string } | undefined
    showNote(r?.ok ? `Saved ${r.path?.split('/').pop()}` : r?.error ?? 'That frame could not be saved.')
  }

  /**
   * Re-encode a gif as a real video.
   *
   * Worth having on the menu rather than buried in a tool: a gif is a very poor
   * container for what is usually video — 256 colours, no inter-frame audio, and
   * files many times the size of the same seconds as H.264. The conversion is
   * local, needs nothing but ffmpeg, and is almost always both smaller and
   * better looking, so it is the one "make this better" that costs nothing.
   */
  async function convertGif(format: 'mp4' | 'webm'): Promise<void> {
    const it = items[index]
    if (!it) return
    showNote(`Converting to ${format.toUpperCase()}…`)
    const r = await window.liq?.invoke?.('mediaGifToVideo', it.path, format)
      .catch((e: Error) => ({ ok: false, error: String(e?.message ?? e) })) as
      { ok: boolean; path?: string; saved?: number; error?: string } | undefined
    if (!r?.ok) { showNote(r?.error ?? 'That gif could not be converted.'); return }
    const pct = r.saved && r.saved > 0 ? ` — ${r.saved}% smaller` : ''
    showNote(`Made ${r.path?.split('/').pop()}${pct}`)
  }

  function renderMenu(entries: MvEntry[], at: { anchor: HTMLElement } | { x: number; y: number }): void {
    closeMenu()
    const menu = buildMenuEl(entries)
    root.appendChild(menu)
    if ('anchor' in at) {
      const ar = at.anchor.getBoundingClientRect()
      const rr = root.getBoundingClientRect()
      menu.style.right = `${Math.max(6, rr.right - ar.right)}px`
      menu.style.bottom = `${rr.bottom - ar.top + 6}px`
    } else {
      const rr = root.getBoundingClientRect()
      const mw = menu.offsetWidth || 210
      const mh = menu.offsetHeight || 200
      // flip rather than spill: a menu opened near the right or bottom edge of
      // the panel would otherwise be clipped by the panel's own overflow
      const lx = Math.min(at.x - rr.left, Math.max(0, rr.width - mw - 6))
      const ly = Math.min(at.y - rr.top, Math.max(0, rr.height - mh - 6))
      menu.style.left = `${Math.max(6, lx)}px`
      menu.style.top = `${Math.max(6, ly)}px`
    }
    const away = (ev: MouseEvent): void => {
      if (menu.contains(ev.target as Node)) return
      if ('anchor' in at && ev.target === at.anchor) return
      closeMenu()
    }
    menuAway = away
    document.addEventListener('mousedown', away, true)
  }

  function buildMenuEl(entries: MvEntry[]): HTMLElement {
    const menu = el('div', 'mv-moremenu')
    for (const e of entries) {
      if (e.separator) { menu.appendChild(el('div', 'mv-moresep')); continue }
      const b = el('button', 'mv-moreitem')
      b.classList.toggle('is-on', !!e.on)
      b.classList.toggle('is-danger', !!e.danger)
      b.appendChild(el('span', '', e.label))
      if (e.submenu) b.appendChild(el('i', 'mv-morearrow', '›'))
      else if (e.key) b.appendChild(el('kbd', '', e.key))
      b.disabled = !e.enabled
      if (e.enabled && e.submenu) {
        const open = (): void => {
          menu.querySelector('.mv-moremenu')?.remove()
          const sub = buildMenuEl(e.submenu!)
          sub.classList.add('mv-moresub')
          b.appendChild(sub)
          placeSubmenu(b, sub)
        }
        b.addEventListener('mouseenter', open)
        b.addEventListener('click', (ev) => { ev.stopPropagation(); open() })
      } else if (e.enabled) {
        b.addEventListener('click', () => { closeMenu(); e.run?.(); syncTools() })
      }
      menu.appendChild(b)
    }
    return menu
  }

  /**
   * Put a submenu where it actually fits.
   *
   * The CSS opens one to the right of its row (`left: 100%`), which is correct
   * until the row is near the right edge — and a menu opened by right-clicking
   * is near the right edge whenever the pointer was. Measured before this
   * existed: a submenu opened from a menu at x=843 ran to x=1260 in a 1180-wide
   * window, so a third of it was off-screen and unreachable, with a crude
   * nth-child CSS rule as the only nod to the problem.
   *
   * Measure, then decide. Flip to the LEFT of the row if the right does not
   * fit; if neither side fits (a narrow window), pin it inside the viewport
   * rather than picking a side that is wrong anyway. Vertically, lift it just
   * enough that the bottom stays in — never more, so it stays visually attached
   * to the row that opened it.
   */
  function placeSubmenu(row: HTMLElement, sub: HTMLElement): void {
    const PAD = 6
    // start from the stylesheet's defaults so a re-open never inherits the last
    // decision, which would make the second open of the same menu land wrong
    sub.style.left = ''
    sub.style.right = ''
    sub.style.top = ''
    sub.style.marginLeft = ''
    sub.style.marginRight = ''

    const rowRect = row.getBoundingClientRect()
    const w = sub.offsetWidth
    const h = sub.offsetHeight

    if (rowRect.right + 2 + w > window.innerWidth - PAD) {
      if (rowRect.left - 2 - w >= PAD) {
        // room on the left: flip
        sub.style.left = 'auto'
        sub.style.right = '100%'
        sub.style.marginLeft = '0'
        sub.style.marginRight = '2px'
      } else {
        // neither side fits — sit it inside the viewport, overlapping the row
        sub.style.left = `${PAD - rowRect.left}px`
      }
    }

    // vertical: the default is 5px above the row; lift further only if needed,
    // and never so far that the top leaves the window
    const top = sub.getBoundingClientRect().top
    const over = (top + h) - (window.innerHeight - PAD)
    if (over > 0) {
      const lift = Math.min(over, Math.max(0, top - PAD))
      sub.style.top = `${-5 - lift}px`
    }
  }

  function closeMenu(): void {
    root.querySelector('.mv-moremenu')?.remove()
    if (menuAway) { document.removeEventListener('mousedown', menuAway, true); menuAway = null }
  }

  function openMoreMenu(anchor: HTMLElement): void {
    renderMenu(menuEntries(), { anchor })
  }

  function togglePlay(): void {
    const m = handle?.media
    if (!m) return
    // the intent is recorded here, where it is unambiguous: element `pause`
    // events also fire on teardown, on a restart-seek and at the end of a clip,
    // none of which mean the user wants the next one to stay still
    if (m.paused) { wantPlay = true; void m.play().catch(() => { /* nothing to play */ }) }
    else { wantPlay = false; m.pause() }
  }

  function toggleMute(): void {
    const m = handle?.media
    muted = !muted
    if (m) m.muted = muted
    setIcon(muteBtn, muted ? ICONS.mute : ICONS.vol)
  }

  function seekBy(delta: number): void {
    const m = handle?.media
    if (!m || mediaDuration() <= 0) return
    seekTo(mediaTime() + delta)
    paintTransport()
  }

  // ------------------------------------------------------------- image zoom

  /**
   * The scale that makes the picture fit the stage.
   *
   * This used to clamp at 1 — "no bigger than its own pixels" — so fit only
   * ever shrank. The consequence showed up as a bug and it is a fair one: go
   * fullscreen with anything smaller than the display and the picture just sat
   * there at native size in the middle of a black screen, having apparently
   * ignored the request. Fit now means fit, and grows as well as shrinks, so
   * the picture tracks the box through fullscreen, a panel resize and theatre.
   *
   * The cap is what the old clamp was really protecting against: a 16×16 icon
   * scaled to a 4K display is 120× of blur that nobody asked for. Eight is
   * generous for anything photographic (a 640×480 photo needs 3× to fill a
   * 1920 screen) and still refuses the absurd cases.
   */
  function fitScale(): number {
    const h = handle
    if (!h?.image || !h.width || !h.height) return 1
    const r = stage.getBoundingClientRect()
    if (!r.width || !r.height) return 1
    return Math.min(MAX_FIT_UPSCALE, r.width / h.width, r.height / h.height)
  }

  function applyZoom(): void {
    const img = handle?.image
    if (!img) return
    if (fit) scale = fitScale()
    const h = handle!
    const r = stage.getBoundingClientRect()
    const w = h.width * scale
    const ht = h.height * scale
    // keep the image from being dragged out of sight: pan is clamped to the
    // overflow on each axis (0 when the image is smaller than the stage)
    const maxX = Math.max(0, (w - r.width) / 2)
    const maxY = Math.max(0, (ht - r.height) / 2)
    panX = Math.max(-maxX, Math.min(maxX, panX))
    panY = Math.max(-maxY, Math.min(maxY, panY))
    img.style.width = w ? `${w}px` : ''
    img.style.height = ht ? `${ht}px` : ''
    img.style.transform = `translate(-50%, -50%) translate(${panX}px, ${panY}px)`
    img.classList.toggle('is-pannable', maxX > 0 || maxY > 0)
    zoomLabel.textContent = `${Math.round(scale * 100)}%`
    dims.textContent = h.width ? `${h.width} × ${h.height}` : ''
  }

  function zoomAbout(factor: number, clientX?: number, clientY?: number): void {
    const h = handle
    if (!h?.image || !h.width) return
    const before = fit ? fitScale() : scale
    const after = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, before * factor))
    if (Math.abs(after - before) < 1e-6) return
    const r = stage.getBoundingClientRect()
    const cx = (clientX ?? r.left + r.width / 2) - (r.left + r.width / 2)
    const cy = (clientY ?? r.top + r.height / 2) - (r.top + r.height / 2)
    // keep the point under the cursor pinned while the scale changes
    panX = cx - (after / before) * (cx - panX)
    panY = cy - (after / before) * (cy - panY)
    fit = false
    scale = after
    applyZoom()
  }

  function setZoom(next: number | 'fit'): void {
    if (next === 'fit') { fit = true; panX = panY = 0 } else { fit = false; scale = next }
    applyZoom()
  }

  zoomInBtn.addEventListener('click', () => zoomAbout(ZOOM_STEP))
  zoomOutBtn.addEventListener('click', () => zoomAbout(1 / ZOOM_STEP))
  fitBtn.addEventListener('click', () => setZoom('fit'))
  zoomLabel.addEventListener('click', () => setZoom(1))

  // ---- wheel ----
  // Plain wheel walks the folder; Ctrl+wheel zooms (the same pairing the file
  // grid already uses). Two details are load-bearing on a network share:
  //
  //  * notches are ACCUMULATED and the remainder kept. A compositor that
  //    coalesces three notches into one 360px event must still advance three
  //    items, and a trackpad's fractional deltas must add up rather than being
  //    dropped one at a time.
  //  * a flurry jumps ONCE to where it lands. Replaying N single steps would
  //    decode N images off the share to show only the last of them.
  const WHEEL_NOTCH = 120
  const WHEEL_MAX_STEP = 8      // a flywheel spin moves 8 items, not 200
  let wheelAcc = 0

  stage.addEventListener('wheel', (e) => {
    const img = handle?.image
    // zoomed in past fit, the wheel belongs to the image: navigating away
    // mid-zoom because the gesture overshot is unrecoverable and baffling
    const zoomed = !!img && !fit
    if (img && (e.ctrlKey || e.metaKey || zoomed)) {
      e.preventDefault()
      zoomAbout(e.deltaY < 0 ? ZOOM_STEP : 1 / ZOOM_STEP, e.clientX, e.clientY)
      return
    }
    if (!opts.wheelNav || items.length < 2) return
    e.preventDefault()
    wheelAcc += e.deltaY
    let steps = Math.trunc(wheelAcc / WHEEL_NOTCH)
    if (!steps) return
    wheelAcc -= steps * WHEEL_NOTCH
    if (opts.wheelInvert) steps = -steps
    steps = Math.max(-WHEEL_MAX_STEP, Math.min(WHEEL_MAX_STEP, steps))
    show(index + steps)
  }, { passive: false })

  stage.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return
    const img = handle?.image
    if (!img || !img.classList.contains('is-pannable')) return
    e.preventDefault()
    const startX = e.clientX
    const startY = e.clientY
    const originX = panX
    const originY = panY
    stage.setPointerCapture(e.pointerId)
    img.classList.add('is-panning')
    const move = (ev: PointerEvent): void => {
      panX = originX + (ev.clientX - startX)
      panY = originY + (ev.clientY - startY)
      applyZoom()
    }
    const up = (): void => {
      img.classList.remove('is-panning')
      stage.removeEventListener('pointermove', move)
      stage.removeEventListener('pointerup', up)
      stage.removeEventListener('pointercancel', up)
    }
    stage.addEventListener('pointermove', move)
    stage.addEventListener('pointerup', up)
    stage.addEventListener('pointercancel', up)
  })

  // click a video to play/pause (the whole surface, like every other player);
  // double-click is fullscreen, so the toggle is deferred long enough to tell
  // the two apart — otherwise going fullscreen always pauses on the way
  let clickTimer = 0
  stage.addEventListener('click', (e) => {
    if (!handle?.media || kind !== 'video') return
    if ((e.target as HTMLElement).closest('.mv-nav')) return
    if (clickTimer) return
    clickTimer = window.setTimeout(() => { clickTimer = 0; togglePlay() }, 220)
  })
  stage.addEventListener('dblclick', (e) => {
    if ((e.target as HTMLElement).closest('.mv-nav')) return
    if (clickTimer) { clearTimeout(clickTimer); clickTimer = 0 }
    opts.onFullscreen?.()
  })

  /**
   * Right-click anywhere on the viewer.
   *
   * On the whole root, not just the stage: the point of a context menu here is
   * that it is the ONLY menu the popped-out window has — that window has no
   * command bar, no file list and no app behind it, so a right-click landing on
   * the header or the transport bar and doing nothing would read as broken.
   */
  root.addEventListener('contextmenu', (e) => {
    // let a real text field keep the system menu (the rename box lives here)
    const t = e.target as HTMLElement
    if (t.closest('input, textarea') || t.isContentEditable) return
    e.preventDefault()
    renderMenu(menuEntries(), { x: e.clientX, y: e.clientY })
  })

  prevBtn.addEventListener('click', () => show(index - 1))
  nextBtn.addEventListener('click', () => show(index + 1))
  popoutBtn.addEventListener('click', () => opts.onPopout?.(state()))
  let pinned = false
  pinBtn.addEventListener('click', () => {
    pinned = !pinned
    pinBtn.classList.toggle('is-on', pinned)
    pinBtn.title = pinned ? 'Stop keeping this window on top' : 'Keep this window on top'
    opts.onPin?.(pinned)
  })
  fullBtn.addEventListener('click', () => opts.onFullscreen?.())
  closeBtn.addEventListener('click', () => opts.onClose?.())

  // the stage is what resizes when the host is dragged; fit-zoom follows it
  const ro = new ResizeObserver(() => applyZoom())
  ro.observe(stage)

  // ------------------------------------------------------------------ keys

  function handleKey(e: KeyboardEvent): boolean {
    // Modified keys belong to the app (Ctrl+C, Ctrl+W, Alt+Enter...), with one
    // exception: BulkMediaManager's player uses Ctrl+Left/Right for a 30-second
    // seek, and matching it is the point of this key map. Nothing else in the
    // app claims Ctrl+Arrow while a viewer has focus.
    const ctrlSeek = e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey
      && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')
    if ((e.ctrlKey || e.metaKey || e.altKey) && !ctrlSeek) return false
    // mode switches work from any mode
    if (e.key === 'w' || e.key === 'W') { setMode(vmode === 'wall' ? 'single' : 'wall'); return true }
    if (e.key === 't' || e.key === 'T') { setMode(vmode === 'theatre' ? 'single' : 'theatre'); return true }
    // The wall owns paging, the grid size and pinning while it is up; anything
    // it does not claim (Escape, F, the rating digits) falls through to the
    // handler below, which is why this is a first refusal and not a return.
    if (vmode === 'wall' && wall?.handleKey(e)) return true
    // Delete is claimed HERE, before the triage deck sees it, so there is one
    // delete in the viewer rather than two that drift: the deck used to have
    // its own silent recycle that only worked while the deck was open, which
    // meant the same key did different things depending on a panel being up.
    if (e.key === 'Delete') { deleteCurrent(e.shiftKey); return true }
    // first refusal: while the deck is up the digits mean ratings, not zoom
    if (triage?.handleKey(e)) { syncTools(); return true }
    const k = e.key
    const media = handle?.media
    switch (k) {
      case ' ':
        if (!media) return false
        togglePlay(); return true
      // bare arrow = previous/next FILE; Shift = seek 5s; Ctrl = seek 30s
      case 'ArrowLeft':
        if (media && e.shiftKey) { seekBy(-SEEK_STEP); return true }
        if (media && e.ctrlKey) { seekBy(-SEEK_STEP_FAST); return true }
        show(index - 1); return true
      case 'ArrowRight':
        if (media && e.shiftKey) { seekBy(SEEK_STEP); return true }
        if (media && e.ctrlKey) { seekBy(SEEK_STEP_FAST); return true }
        show(index + 1); return true
      case 'PageUp': show(index - 1); return true
      case 'PageDown': show(index + 1); return true
      case 'Home':
        if (media) { seekTo(0); return true }
        show(0); return true
      case 'End':
        // 1.5s from the end, like BulkMediaManager: landing exactly on the
        // duration fires 'ended' and skips to the next file, which is not what
        // "go to the end" means
        if (media && mediaDuration() > 0) { seekTo(Math.max(0, mediaDuration() - 1.5)); return true }
        show(items.length - 1); return true
      case 'ArrowUp':
        if (!media) return false
        setVolume(volume + 0.05); return true
      case 'ArrowDown':
        if (!media) return false
        setVolume(volume - 0.05); return true
      case 'm': case 'M':
        if (!media) return false
        toggleMute(); return true
      case 'f': case 'F':
        opts.onFullscreen?.(); return true
      case 's': case 'S':
        // syncTools so the button reflects the keyboard — a toggle that is on
        // but does not look on is worse than no button at all
        strip.toggle(); layout(); syncTools(); return true
      case 'g': case 'G':
        if (kind !== 'video') return false
        void toggleSheet(); return true
      case 'l': case 'L':
        if (!handle?.media) return false
        cycleLoop(); syncTools(); return true
      case 'F2':
        startRename(); return true
      case '+': case '=':
        if (!handle?.image) return false
        zoomAbout(ZOOM_STEP); return true
      case '-': case '_':
        if (!handle?.image) return false
        zoomAbout(1 / ZOOM_STEP); return true
      case '0':
        if (!handle?.image) return false
        setZoom('fit'); return true
      case '1':
        if (!handle?.image) return false
        setZoom(1); return true
      default: return false
    }
  }

  function setVolume(v: number): void {
    volume = clamp01(v)
    muted = volume === 0
    const m = handle?.media
    if (m) { m.volume = volume; m.muted = muted }
    vol.value = String(volume)
    setIcon(muteBtn, muted ? ICONS.mute : ICONS.vol)
  }

  function state(): ViewerState {
    const m = handle?.media
    return {
      index,
      time: m ? mediaTime() : 0,
      playing: m ? !m.paused : false,
      volume, muted, rate,
    }
  }

  function layout(): void { applyZoom(); strip.refresh() }

  strip.setItems(items)
  show(index)

  return {
    root, header,
    show,
    next: () => show(index + 1),
    prev: () => show(index - 1),
    state,
    handleKey,
    layout,
    setFullscreenLabel: (on: boolean) => {
      setIcon(fullBtn, on ? ICONS.unfull : ICONS.full)
      fullBtn.title = on ? 'Exit fullscreen (F)' : 'Fullscreen (F)'
    },
    toggleTriage(on?: boolean): void { triage?.toggle(on) },
    destroy(): void {
      if (destroyed) return
      saveResume()
      destroyed = true
      window.clearInterval(saveTimer)
      saveTimer = 0
      window.clearTimeout(preloadTimer)
      clearPreload()
      // Everything built per-open has to be torn down per-close. The deck holds
      // a subscription to the app's undo bus and the subtitle attachment holds
      // a blob URL, so leaving either behind leaks once per file the user
      // opens — which is exactly the leak `app.on` was given an unsubscribe for.
      hideSeekPreview()
      subs?.dispose()
      subs = null
      triage?.destroy()
      strip.destroy()
      ro.disconnect()
      handle?.dispose()
      handle = null
      root.remove()
    },
  }
}

function clamp01(v: number): number { return Math.max(0, Math.min(1, Number.isFinite(v) ? v : 1)) }
