// Is the WINDOW frozen? — renderer-side stall detection.
//
// state/health.ts watches the main process, and for a long time that was the
// only thing being watched. It is the wrong half for this symptom. The window,
// its layout, every listing and every repaint live in the RENDERER; when a user
// says the app froze, they mean this process stopped drawing. Main can be
// perfectly idle throughout — and was, in every log that came back reporting
// nothing while the app was visibly stuck.
//
// TWO CLOCKS, because they fail apart:
//
//   * TIMER LAG says JavaScript here blocked — a long loop, a huge JSON parse,
//     a synchronous layout over thousands of rows. Nothing repaints while this
//     is high.
//   * FRAME LAG says the compositor stopped producing frames even though script
//     was fine, which is what a stalled GPU process looks like from inside.
//
// Findings go to MAIN and into the ordinary run log, because a diagnostic that
// only exists in a devtools console nobody has open is not a diagnostic. The
// startup phase is reported whatever happens, so a slow launch says which step
// was slow instead of only that it was slow.
import { liq } from './app'

const SAMPLE_MS = 500
/** below this is ordinary scheduling noise */
const LAG_WARN_MS = 300
/** frames stop entirely under a hidden window, so this only judges a visible one */
const FRAME_WARN_MS = 1500

let worstLag = 0
let phase = 'boot'

/** what the renderer is doing, so a stall names a step rather than a moment */
export function setPhase(name: string): void { phase = name }

function report(kind: string, ms: number, detail = ''): void {
  // fire and forget: a diagnostic must never be able to wedge the thing it is
  // measuring, and main logs it whether or not this promise is observed
  void liq.invoke('healthRendererStall', {
    kind, ms: Math.round(ms), phase, detail,
    // no console.warn here: main writes the log line, and windows.ts forwards
    // renderer warnings to the same file — logging both put every stall in
    // twice, which makes a log harder to read at exactly the moment it matters
  }).catch(() => { /* main is busy; the stall is still real, just unrecorded */ })
}

function startTimerMonitor(): void {
  let expected = Date.now() + SAMPLE_MS
  setInterval(() => {
    const now = Date.now()
    const lag = now - expected
    expected = now + SAMPLE_MS
    if (lag > worstLag) worstLag = lag
    if (lag >= LAG_WARN_MS) report('script', lag)
  }, SAMPLE_MS)
}

/**
 * Frame production.
 *
 * requestAnimationFrame does not run while the page is hidden, which is the
 * normal state under the headless display this project is tested on — so a gap
 * is only evidence when the document says it is visible. Without that check
 * this would cry wolf on every test run.
 */
function startFrameMonitor(): void {
  let last = performance.now()
  const tick = (): void => {
    const now = performance.now()
    const gap = now - last
    last = now
    if (gap >= FRAME_WARN_MS && !document.hidden) report('paint', gap)
    requestAnimationFrame(tick)
  }
  requestAnimationFrame(tick)
}

let started = false
export function startRendererHealth(): void {
  if (started) return
  started = true
  startTimerMonitor()
  startFrameMonitor()

  // Startup is reported unconditionally. "It freezes when I open it" is the
  // one complaint that cannot be caught by a threshold, because the thing that
  // was slow may be slow every single time and therefore never look anomalous.
  const t0 = performance.now()
  const done = (): void => {
    const ms = Math.round(performance.now() - t0)
    void liq.invoke('healthRendererStall', {
      kind: 'startup', ms, phase: 'first listing painted', detail: `worst lag so far ${Math.round(worstLag)}ms`,
    }).catch(() => { /* nothing to do */ })
  }
  // whichever comes first: the first painted listing, or a hard deadline that
  // proves the listing never arrived
  let fired = false
  const once = (): void => { if (!fired) { fired = true; done() } }
  window.addEventListener('liq-first-listing', once, { once: true })
  window.setTimeout(once, 15_000)
}
