// The floating media viewer — the "shadow player".
//
// A translucent, blurred panel that floats ABOVE the file list inside the app
// window. It is deliberately NOT a modal (dialogs/dialogs.ts): there is no
// overlay backdrop, no focus trap and no modal stack entry, so the file list
// stays fully clickable while a video plays on top of it. That is the whole
// point — you can keep browsing while something is open.
//
// Ownership split: media/viewer.ts draws the player and owns playback, zoom and
// the key map; this file owns the WINDOW behaviour — drag by the header, resize
// from any edge, remember where it was, maximise to the app window, and hand
// the whole session over to a real Electron window (media/popout.ts).
//
// SELF-MOUNTING: importing this module injects its stylesheet and subscribes to
// the app event bus. The only hook it needs is in actions.open() (see the
// comment on openInMediaViewer).
import { app, liq } from '../core/app'
import type { AppSettings, FileEntry } from '../../shared/types'
import { createViewer, type ViewerHandle, type ViewerState } from './viewer'
import { canDecode, isViewable, mustTranscode, viewKindFor, type MediaItem, type ViewKind } from './render'
import { assignHotkeys, type TriageHooks } from './triage'
import { applyRating } from '../views/ratings'
import { bins } from '../views/binstore'
import { runBin } from '../views/binrun'

const GEOM_KEY = 'mv-geom'
const PLAY_KEY = 'mv-play'
const MIN_W = 360
const MIN_H = 240
/** panel edge thickness that starts a resize drag (matches the CSS handles) */
const EDGE = 8

interface Geometry { x: number; y: number; w: number; h: number }

interface PlaybackPrefs { volume: number; muted: boolean; rate: number }

let panel: HTMLDivElement | null = null
let viewer: ViewerHandle | null = null
let fullscreen = false
/** geometry to restore when leaving fullscreen */
let restoreGeom: Geometry | null = null

/**
 * Everything the triage deck can do, expressed in terms of the app. Kept here
 * rather than in media/triage.ts because that module is shared with the pop-out
 * window, which has no app to ask (see the header comment there).
 *
 * The rating goes through applyRating and the recycle through the op engine, so
 * both land in history and in the same undo stack as the equivalent action taken
 * from the grid — which is what makes "Undo Delete IMG_2044.jpg" work at all.
 */
function triageHooks(): TriageHooks {
  const rated = new Map<string, number>()
  return {
    ratingOf: (it) => rated.get(it.path) ?? liveRating(it.path),
    setRating: (it, n) => { rated.set(it.path, n); applyRating([it.path], n) },
    bins: () => assignHotkeys(
      bins().bins.filter(b => !b.hidden && b.action !== 'stack').map(b => ({ id: b.id, label: b.label })),
    ),
    toBin: (it, id) => {
      const bin = bins().bins.find(b => b.id === id)
      if (bin) void runBin(bin, [it.path])
    },
    recycle: (it) => { void liq.startOp({ kind: 'trash', sources: [it.path] }) },
    undoLabel: () => app.undoInfo?.undoLabel ?? null,
    undo: () => { void liq.undo() },
    onUndoChanged: (fn) => app.on('undo-changed', fn),
  }
}

/** the rating the file list already knows, so the deck opens on the right stars */
function liveRating(path: string): number {
  for (const tab of app.tabs) {
    const row = tab.rows?.find(r => r.path === path)
    if (row) return row.rating ?? 0
  }
  return 0
}

// ---------------------------------------------------------------- settings

const ALL_KINDS: ViewKind[] = ['image', 'video', 'audio', 'pdf', 'text']

/** a settings file written before this feature existed has no list at all */
function enabledKinds(s: AppSettings): ViewKind[] {
  const raw = s.mediaViewerKinds
  if (!Array.isArray(raw)) return ALL_KINDS
  return ALL_KINDS.filter(k => (raw as string[]).includes(k))
}

// ---------------------------------------------------------------- playlist

function toItem(e: FileEntry): MediaItem {
  return { path: e.path, name: e.name, ext: e.ext, mime: e.mime, size: e.size, isDir: e.isDir }
}

/**
 * What ←/→ walks through. Pictures and clips share one playlist because a
 * camera folder is a mix of both and stepping over the videos would be wrong;
 * documents and text only ever walk their own kind, so opening a PDF never
 * lands you in a README two presses later.
 */
function playlistFor(entry: FileEntry, rows: FileEntry[]): { items: MediaItem[]; index: number } {
  const kind = viewKindFor(toItem(entry))
  const family: Set<ViewKind> = kind === 'image' || kind === 'video' || kind === 'audio'
    ? new Set<ViewKind>(['image', 'video', 'audio'])
    : new Set<ViewKind>([kind])
  const items = rows
    .filter(r => isViewable(toItem(r)) && family.has(viewKindFor(toItem(r))))
    .map(toItem)
  const index = Math.max(0, items.findIndex(i => i.path === entry.path))
  return items.length ? { items, index } : { items: [toItem(entry)], index: 0 }
}

// ---------------------------------------------------------------- geometry

function loadJSON<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(key)
    return raw ? JSON.parse(raw) as T : null
  } catch { return null }
}

function saveJSON(key: string, value: unknown): void {
  try { localStorage.setItem(key, JSON.stringify(value)) } catch { /* storage full */ }
}

function defaultGeometry(): Geometry {
  const w = Math.max(MIN_W, Math.min(1100, Math.round(window.innerWidth * 0.62)))
  const h = Math.max(MIN_H, Math.min(760, Math.round(window.innerHeight * 0.68)))
  return { x: Math.round((window.innerWidth - w) / 2), y: Math.round((window.innerHeight - h) / 2), w, h }
}

/** keep the panel on screen — the window may be smaller than when it was saved */
function clampGeometry(g: Geometry): Geometry {
  const w = Math.max(MIN_W, Math.min(g.w, window.innerWidth))
  const h = Math.max(MIN_H, Math.min(g.h, window.innerHeight))
  return {
    w, h,
    x: Math.max(0, Math.min(g.x, window.innerWidth - w)),
    y: Math.max(0, Math.min(g.y, window.innerHeight - h)),
  }
}

function readGeometry(): Geometry {
  const saved = loadJSON<Geometry>(GEOM_KEY)
  return clampGeometry(saved && Number.isFinite(saved.w) ? saved : defaultGeometry())
}

function applyGeometry(g: Geometry): void {
  if (!panel) return
  panel.style.left = g.x + 'px'
  panel.style.top = g.y + 'px'
  panel.style.width = g.w + 'px'
  panel.style.height = g.h + 'px'
}

function currentGeometry(): Geometry {
  if (!panel) return defaultGeometry()
  const r = panel.getBoundingClientRect()
  return { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) }
}

function rememberGeometry(): void {
  if (!panel || fullscreen) return
  saveJSON(GEOM_KEY, currentGeometry())
}

function playbackPrefs(): PlaybackPrefs {
  const p = loadJSON<PlaybackPrefs>(PLAY_KEY)
  return {
    volume: p && Number.isFinite(p.volume) ? p.volume : 1,
    muted: !!p?.muted,
    rate: p && Number.isFinite(p.rate) ? p.rate : 1,
  }
}

// ---------------------------------------------------------------- the panel

/** Injected at IMPORT time, not on first open: a stylesheet added in the same
 *  frame as the panel is applied a frame late, and the panel flashes unstyled
 *  (measured on :99 — the first open computed `position: static`). */
function ensureStyles(): void {
  if (document.querySelector('link[data-mv-style]')) return
  const link = document.createElement('link')
  link.rel = 'stylesheet'
  link.href = 'styles/media.css'
  link.setAttribute('data-mv-style', '1')
  document.head.appendChild(link)
}
ensureStyles()

/**
 * Fullscreen means FULLSCREEN — the whole display, not the app window.
 *
 * This used to be a CSS class and nothing else, so pressing F grew the panel to
 * the size of the LiqExplorer window and stopped there: title bar, tabs and
 * taskbar all still on screen. For a photo or a film that is not what the word
 * promises, and the only way to get a real one was to pop the viewer out into
 * its own window first.
 *
 * The element Fullscreen API gives the real thing for the docked viewer too.
 * The CSS class is kept and still applied, for two reasons: it lays the panel
 * out edge-to-edge inside whatever box it has been given, and it is the
 * fallback when requestFullscreen is refused (which happens without a user
 * gesture, and in some embedded contexts). So a refusal degrades to the old
 * fill-the-window behaviour instead of doing nothing at all.
 */
function setFullscreen(on: boolean): void {
  if (!panel || on === fullscreen) return
  if (on) {
    restoreGeom = currentGeometry()
    fullscreen = true
    panel.classList.add('is-full')
    panel.style.left = panel.style.top = panel.style.width = panel.style.height = ''
    void panel.requestFullscreen?.({ navigationUI: 'hide' }).catch(() => {
      // refused: the class alone still fills the window, which is what this
      // did before — worse than the real thing, better than nothing
    })
  } else {
    fullscreen = false
    // Leaving is asynchronous. Restoring the geometry here — while the element
    // is still presented fullscreen — was measured putting the panel back at
    // the size of the whole app window instead of the size it had before,
    // because the inline styles are applied against a box the UA is still
    // overriding. The restore therefore happens in restoreFromFullscreen(),
    // once the browser says it has finished.
    if (document.fullscreenElement) void document.exitFullscreen().catch(() => restoreFromFullscreen())
    else restoreFromFullscreen()
  }
  viewer?.setFullscreenLabel(fullscreen)
  viewer?.layout()
}

/** put the panel back where it was before fullscreen took it */
function restoreFromFullscreen(): void {
  if (!panel) return
  panel.classList.remove('is-full')
  applyGeometry(clampGeometry(restoreGeom ?? defaultGeometry()))
  viewer?.setFullscreenLabel(false)
  viewer?.layout()
}

/**
 * Fullscreen can also end without going through us — Chromium handles Escape
 * itself, and so do F11 and a monitor change. Without this the panel would come
 * back to a normal window still wearing .is-full: pinned edge-to-edge, with no
 * way to drag or resize it.
 */
document.addEventListener('fullscreenchange', () => {
  if (!panel) return
  if (document.fullscreenElement) return
  fullscreen = false
  restoreFromFullscreen()
})

export function closeMediaViewer(): void {
  if (!panel) return
  rememberGeometry()
  const st = viewer?.state()
  if (st) saveJSON(PLAY_KEY, { volume: st.volume, muted: st.muted, rate: st.rate })
  viewer?.destroy()
  viewer = null
  panel.remove()
  panel = null
  fullscreen = false
}

function startDrag(e: PointerEvent): void {
  if (!panel || fullscreen) return
  const g = currentGeometry()
  const dx = e.clientX - g.x
  const dy = e.clientY - g.y
  panel.setPointerCapture(e.pointerId)
  panel.classList.add('is-dragging')
  const move = (ev: PointerEvent): void => {
    const w = g.w
    const h = g.h
    applyGeometry({
      w, h,
      x: Math.max(0, Math.min(window.innerWidth - w, ev.clientX - dx)),
      y: Math.max(0, Math.min(window.innerHeight - h, ev.clientY - dy)),
    })
  }
  const up = (): void => {
    panel?.classList.remove('is-dragging')
    window.removeEventListener('pointermove', move)
    window.removeEventListener('pointerup', up)
    rememberGeometry()
  }
  window.addEventListener('pointermove', move)
  window.addEventListener('pointerup', up)
}

function startResize(e: PointerEvent, dir: string): void {
  if (!panel || fullscreen) return
  e.preventDefault()
  e.stopPropagation()
  const g = currentGeometry()
  const sx = e.clientX
  const sy = e.clientY
  panel.classList.add('is-dragging')
  const move = (ev: PointerEvent): void => {
    let { x, y, w, h } = g
    const mx = ev.clientX - sx
    const my = ev.clientY - sy
    if (dir.includes('e')) w = Math.max(MIN_W, Math.min(window.innerWidth - x, g.w + mx))
    if (dir.includes('s')) h = Math.max(MIN_H, Math.min(window.innerHeight - y, g.h + my))
    if (dir.includes('w')) {
      w = Math.max(MIN_W, Math.min(g.x + g.w, g.w - mx))
      x = g.x + g.w - w
    }
    if (dir.includes('n')) {
      h = Math.max(MIN_H, Math.min(g.y + g.h, g.h - my))
      y = g.y + g.h - h
    }
    applyGeometry({ x, y, w, h })
    viewer?.layout()
  }
  const up = (): void => {
    panel?.classList.remove('is-dragging')
    window.removeEventListener('pointermove', move)
    window.removeEventListener('pointerup', up)
    rememberGeometry()
  }
  window.addEventListener('pointermove', move)
  window.addEventListener('pointerup', up)
}

function buildPanel(): HTMLDivElement {
  const p = document.createElement('div')
  p.className = 'mv-panel'
  p.tabIndex = -1
  p.setAttribute('role', 'dialog')
  p.setAttribute('aria-label', 'Media viewer')
  if (app.settings.mediaViewerTranslucent === false) p.classList.add('is-opaque')
  for (const dir of ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw']) {
    const h = document.createElement('div')
    h.className = `mv-edge mv-edge-${dir}`
    h.style.setProperty('--edge', EDGE + 'px')
    h.addEventListener('pointerdown', (ev) => startResize(ev, dir))
    p.appendChild(h)
  }
  return p
}

/** hand the session to a real window; the floating panel goes away with it */
async function popOut(state: ViewerState, items: MediaItem[]): Promise<void> {
  const g = currentGeometry()
  closeMediaViewer()
  try {
    await liq.invoke('mediaPopout', {
      items, index: state.index, time: state.time, playing: state.playing,
      volume: state.volume, muted: state.muted, rate: state.rate,
      // page coordinates; main adds the window's own content origin so the new
      // window opens exactly where the floating panel was
      bounds: g,
      // the pop-out page reads no settings of its own
      wheelNav: app.settings.mediaViewerWheelNav !== false,
      wheelInvert: !!app.settings.mediaViewerWheelInvert,
    })
  } catch { /* main refused (no handler): the panel already closed, nothing to undo */ }
}

/**
 * Open `entry` in the floating viewer, walking `rows` with the arrow keys.
 * Returns false when the viewer is switched off or cannot show this file, in
 * which case the caller should fall back to the desktop's default application.
 *
 * `force` is for an EXPLICIT request ("View here" in the context menu): the
 * settings decide what double-click takes over, never what happens when the
 * user asked for the viewer by name.
 *
 * HOOK: actions.open() calls this before liq.openPath() — see the report.
 */
export function openInMediaViewer(
  entry: FileEntry, rows: FileEntry[] = [], opts: { force?: boolean } = {},
): boolean {
  const item = toItem(entry)
  if (!isViewable(item)) return false
  const kind = viewKindFor(item)
  if (!opts.force) {
    if (app.settings.mediaViewer === false) return false
    if (!enabledKinds(app.settings).includes(kind)) return false
    // Decline what we cannot decode so the caller falls through to the desktop's
    // player. Claiming the file and then drawing "no codec" under a live-looking
    // transport was the worst of both: the real player never opened, and the
    // panel that replaced it had a play button that did nothing.
    // ...unless ffmpeg can. A container with no Chromium demuxer (AVI, WMV,
    // FLV) is not undecodable any more, it just needs converting first, and a
    // user who has switched this kind ON has asked for it to open here.
    if (!canDecode(item, kind) && !mustTranscode(item)) return false
  }

  const { items, index } = playlistFor(entry, rows.length ? rows : [entry])

  // one viewer at a time: opening another file re-uses the panel where it is,
  // which is how Photos behaves and keeps the panel from stacking up
  if (panel && viewer) {
    const same = viewer.state()
    viewer.destroy()
    viewer = mountViewer(items, index, { ...playbackPrefs(), volume: same.volume, muted: same.muted, rate: same.rate })
    panel.focus()
    return true
  }

  panel = buildPanel()
  document.body.appendChild(panel)
  applyGeometry(readGeometry())
  viewer = mountViewer(items, index, playbackPrefs())
  panel.focus()
  return true
}

function mountViewer(items: MediaItem[], index: number, prefs: PlaybackPrefs): ViewerHandle {
  const v = createViewer({
    items, index,
    start: { volume: prefs.volume, muted: prefs.muted, rate: prefs.rate },
    autoplay: app.settings.mediaViewerAutoplay !== false,
    wheelNav: app.settings.mediaViewerWheelNav !== false,
    wheelInvert: !!app.settings.mediaViewerWheelInvert,
    seekPreview: app.settings.mediaSeekPreview !== false,
    resume: app.settings.mediaResume !== false,
    autoAdvance: app.settings.mediaAutoAdvance !== false,
    sheetFrames: app.settings.mediaSheetFrames || 12,
    subtitleAuto: !!app.settings.subtitleAutoEnable,
    maxHeight: app.settings.mediaMaxHeight || 720,
    buttons: { popout: true, fullscreen: true, close: true },
    onClose: () => closeMediaViewer(),
    onFullscreen: () => setFullscreen(!fullscreen),
    onPopout: (state) => { void popOut(state, items) },
    triage: triageHooks(),
  })
  v.header.addEventListener('pointerdown', (e) => {
    if ((e.target as HTMLElement).closest('button')) return
    startDrag(e)
  })
  // double-clicking the header maximises, like a real title bar
  v.header.addEventListener('dblclick', (e) => {
    if ((e.target as HTMLElement).closest('button')) return
    setFullscreen(!fullscreen)
  })
  v.setFullscreenLabel(fullscreen)
  panel!.appendChild(v.root)
  return v
}

// ------------------------------------------------------------------ keyboard
//
// One capture listener for the whole app, installed once. It only acts when the
// event is aimed at the panel, so the file list keeps every key it owns while
// the viewer floats above it. A stopPropagation() here also stops core/
// keyboard.ts (which listens on window, in the bubble phase) from acting on
// Backspace/Delete/Enter while the user is driving the player.
document.addEventListener('keydown', (e) => {
  if (!panel || !viewer) return
  // a modal or a context menu is on top and owns the keyboard (dialogs.ts uses
  // the same test for menus); acting too would double-handle Escape
  if (document.querySelector('#dialog-layer .dlg-overlay')) return
  if (document.querySelector('#menu-layer > .menu-root')) return
  const target = e.target as HTMLElement | null
  const inPanel = !!target && panel.contains(target)
  if (!inPanel) return
  const tag = target?.tagName
  if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') {
    // the volume slider and speed picker keep their own arrow keys
    if (e.key !== 'Escape') return
  }
  if (e.key === 'Escape') {
    e.preventDefault()
    e.stopPropagation()
    if (fullscreen) setFullscreen(false)
    else closeMediaViewer()
    return
  }
  if (viewer.handleKey(e)) {
    e.preventDefault()
    e.stopPropagation()
  }
}, true)

window.addEventListener('resize', () => {
  if (!panel || fullscreen) return
  applyGeometry(clampGeometry(currentGeometry()))
  viewer?.layout()
})

// Explicit request from elsewhere in the app (context menu, command bar).
// detail: { entry, rows? } or { path }
app.on('show-media-viewer', (d: { entry?: FileEntry; rows?: FileEntry[]; path?: string }) => {
  const tab = app.activeTab
  const rows = d?.rows ?? tab?.rows ?? []
  const entry = d?.entry ?? rows.find(r => r.path === d?.path)
  if (entry) openInMediaViewer(entry, rows, { force: true })
})

// same convention as index.ts's `window.app`: reachable from CDP for testing,
// and the one hook a script needs to open the viewer without a mouse
;(window as unknown as { openInMediaViewer: typeof openInMediaViewer }).openInMediaViewer = openInMediaViewer

app.on('close-media-viewer', () => closeMediaViewer())

// switching the viewer off in Options must not leave a panel floating
app.on('settings-changed', (s: AppSettings) => { if (s.mediaViewer === false) closeMediaViewer() })
