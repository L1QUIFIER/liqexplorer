// Entry point for the popped-out media window (media/popout.html).
//
// This page is NOT the file manager: it boots no tabs, no listings and no
// settings store — it asks main for the session the floating panel handed over
// (media/overlay.ts -> mediaPopout) and puts media/viewer.ts in a real window,
// so it can be dragged to another monitor and fullscreened by the window
// manager. Playback resumes at the exact position the panel was at.
import { createViewer, type ViewerHandle } from './viewer'
import type { MediaItem } from './render'

interface PopoutPayload {
  items: MediaItem[]
  index: number
  time: number
  playing: boolean
  volume: number
  muted: boolean
  rate: number
  /** stamped by the host: this page boots no app and reads no settings */
  wheelNav?: boolean
  wheelInvert?: boolean
}

let viewer: ViewerHandle | null = null
let full = false

async function boot(): Promise<void> {
  const theme: 'light' | 'dark' = await window.liq.getTheme().catch(() => 'dark')
  document.documentElement.dataset.theme = theme

  const payload: PopoutPayload | null = await window.liq.invoke('mediaPopoutPayload').catch(() => null)
  const host = document.getElementById('mv-root')!
  if (!payload || !payload.items?.length) {
    host.textContent = 'Nothing to show.'
    return
  }

  viewer = createViewer({
    items: payload.items,
    index: payload.index,
    start: {
      time: payload.time, playing: payload.playing,
      volume: payload.volume, muted: payload.muted, rate: payload.rate,
    },
    autoplay: payload.playing,
    // the pop-out boots no app, so it cannot read settings; the host stamps
    // these into the payload when it hands the session over
    wheelNav: payload.wheelNav !== false,
    wheelInvert: !!payload.wheelInvert,
    // this IS the separate window, and the OS frame owns closing it
    buttons: { popout: false, fullscreen: true, close: false, pin: true },
    onPin: (on) => { void window.liq.invoke('mediaWindowPinned', on).catch(() => {}) },
    onFullscreen: () => { void toggleFullscreen() },
    onItem: (item, i, n) => { document.title = n > 1 ? `${item.name} — ${i + 1} of ${n}` : item.name },
  })
  host.appendChild(viewer.root)
  ;(window as unknown as { viewer: ViewerHandle }).viewer = viewer   // for CDP-driven testing
  host.focus()
}

async function toggleFullscreen(): Promise<void> {
  // a real window: fullscreen belongs to the window manager, not to a CSS class
  full = await window.liq.invoke('mediaWindowFullscreen', !full).catch(() => full)
  viewer?.setFullscreenLabel(full)
  viewer?.layout()
}

document.addEventListener('keydown', (e) => {
  if (!viewer) return
  const tag = (e.target as HTMLElement | null)?.tagName
  if ((tag === 'INPUT' || tag === 'SELECT') && e.key !== 'Escape') return
  if (e.key === 'Escape') {
    e.preventDefault()
    if (full) void toggleFullscreen()
    else window.close()
    return
  }
  if (viewer.handleKey(e)) e.preventDefault()
})

window.addEventListener('resize', () => viewer?.layout())

boot().catch(err => {
  document.body.textContent = String(err?.stack ?? err)
})
