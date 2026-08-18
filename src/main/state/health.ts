// Why did it freeze? — main-process health instrumentation.
//
// "It lags sometimes" is unfixable without evidence, and the freeze only
// happens on a real workload against a real network mount, which is exactly
// where a debugger is least usable. So the app records what it was doing when
// it stalled, into the ordinary run log, and can be asked afterwards.
//
// TWO measurements, because they answer different questions:
//
//   * EVENT-LOOP LAG says the main process itself was blocked — a synchronous
//     call, a huge JSON parse, garbage collection. Nothing in the window can
//     repaint while this is high, so it is the closest thing to "frozen" that
//     can be measured from inside.
//
//   * SLOW IPC says a particular request took a long time even though the loop
//     was fine — which is what a stalled network filesystem looks like. The
//     window is responsive, but every listing sits waiting on a mount, and to
//     the user those are indistinguishable.
//
// The distinction matters because the fixes are opposite. Loop lag means "stop
// doing that work on this thread". Slow IPC on a healthy loop means "the mount
// is slow and the UI must stop pretending otherwise".
//
// THE THREAD POOL IS REPORTED, NOT TUNED. Node runs every fs call on a pool of
// UV_THREADPOOL_SIZE threads, four by default, and raising it looks like an
// obvious fix for a file manager on a slow mount. It is not: measured with this
// module, a pool of 8 or 32 made average loop lag EIGHTY-SEVEN TIMES worse and
// produced eight-second freezes that the default never showed. bin/run.sh
// carries the numbers. The size is in the report so that a future stall can be
// checked against it rather than guessed at.
import { ipcMain } from 'electron'
import * as fs from 'node:fs'
import { CH } from '../../shared/ipc'

/** how often the loop is sampled */
const SAMPLE_MS = 500
/** a stall worth recording; below this is ordinary scheduling noise */
const LAG_WARN_MS = 250
/** an IPC call slower than this is worth a line, even on a healthy loop */
const IPC_WARN_MS = 750
/** keep the recent history bounded — this is a diagnostic, not a log file */
const KEEP = 200

export interface Stall {
  at: number
  kind: 'loop' | 'ipc'
  ms: number
  /** the IPC verb, for kind 'ipc' */
  what?: string
  /** what the file-operations engine was doing at the time */
  op?: string
}

/**
 * IPC calls currently in flight, so a loop stall can name what was running.
 *
 * Without this a stall record says only "the main process froze for ten
 * seconds", which is the part you already knew. The in-flight set is the
 * difference between a symptom and a lead.
 */
const inflight = new Map<string, number>()

function inflightSummary(): string {
  if (!inflight.size) return ''
  const now = Date.now()
  return [...inflight.entries()]
    .sort((a, b) => a[1] - b[1])
    .slice(0, 4)
    .map(([verb, since]) => `${verb}(${now - since}ms)`)
    .join(', ')
}

/**
 * Long-running work that is NOT a single IPC call.
 *
 * The scanners return immediately and stream their results, so an in-flight IPC
 * list never sees them — and a stall recorded during a disk-usage walk said
 * only that the process froze, with no hint as to why. Anything that runs for
 * seconds announces itself here instead.
 */
const tasks = new Map<number, { label: string; since: number }>()
let taskSeq = 0

export function beginTask(label: string): () => void {
  const id = ++taskSeq
  tasks.set(id, { label, since: Date.now() })
  return () => { tasks.delete(id) }
}

function taskSummary(): string {
  if (!tasks.size) return ''
  const now = Date.now()
  return [...tasks.values()]
    .sort((a, b) => a.since - b.since)
    .slice(0, 3)
    .map(t => `${t.label}(${now - t.since}ms)`)
    .join(', ')
}

const stalls: Stall[] = []
let worstLag = 0
let samples = 0
let lagTotal = 0

/**
 * What the ops engine is doing, if anything.
 *
 * A function rather than an import so this module stays at the bottom of the
 * dependency graph: it is loaded first, before the engine exists, precisely so
 * it can wrap ipcMain before anything registers a handler.
 */
let describeOp: () => string = () => ''
export function setOpDescriber(fn: () => string): void { describeOp = fn }

function record(s: Stall): void {
  stalls.push(s)
  if (stalls.length > KEEP) stalls.splice(0, stalls.length - KEEP)
  const op = s.op ? `  during: ${s.op}` : ''
  const what = s.what ? `  in flight: ${s.what}` : ''
  console.warn(`[health] ${s.kind} stall ${Math.round(s.ms)}ms${what}${op}`)
}

/**
 * Event-loop lag: schedule for SAMPLE_MS, measure how late we actually were.
 *
 * `unref` so this timer alone never keeps the process alive — a diagnostic that
 * stops the app from quitting is a bug of its own.
 */
function startLoopMonitor(): void {
  let expected = Date.now() + SAMPLE_MS
  const t = setInterval(() => {
    const now = Date.now()
    const lag = now - expected
    expected = now + SAMPLE_MS
    samples++
    lagTotal += Math.max(0, lag)
    const mountMoved = pollMount()
    if (lag > worstLag) worstLag = lag
    if (lag >= LAG_WARN_MS) {
      // name the requests that were open across the stall; one of them is
      // almost always the cause
      const busy = [
        mountMoved ? 'NETWORK MOUNT RECONNECTED' : '',
        inflightSummary(),
        taskSummary(),
      ].filter(Boolean).join(' | ')
      const op = describeOp()
      record({ at: now, kind: 'loop', ms: lag, what: busy || undefined, op: op || undefined })
    }
  }, SAMPLE_MS)
  t.unref?.()
}

/**
 * Time every IPC handler, by wrapping ipcMain.handle once at startup.
 *
 * Wrapping here rather than editing ~120 call sites is the only version of this
 * that stays true: a per-handler timer would be added to the handlers someone
 * remembered, which are never the ones that turn out to be slow.
 */
function wrapIpc(): void {
  const original = ipcMain.handle.bind(ipcMain)
  ipcMain.handle = ((channel: string, listener: (...a: unknown[]) => unknown) => {
    const verb = channel.replace(/^liq[:.]/, '')
    return original(channel, async (...args: unknown[]) => {
      const t0 = Date.now()
      const key = `${verb}#${t0}#${Math.random().toString(36).slice(2, 6)}`
      inflight.set(key, t0)
      try {
        return await (listener as (...a: unknown[]) => unknown)(...args)
      } finally {
        inflight.delete(key)
        const ms = Date.now() - t0
        if (ms >= IPC_WARN_MS) {
          record({ at: Date.now(), kind: 'ipc', ms, what: verb, op: describeOp() || undefined })
        }
      }
    })
  }) as typeof ipcMain.handle
}

export interface HealthReport {
  /** threads available for every fs call in the process */
  threadPool: number
  loop: { samples: number; averageLagMs: number; worstLagMs: number }
  recent: Stall[]
  memoryMB: number
  /** long-running work in progress right now */
  busy: string[]
  /** network mount trouble seen since launch — NOT the app's doing */
  mount: { reconnectsSinceLaunch: number; sessionReconnects: number; shareReconnects: number } | null
}

export function healthReport(): HealthReport {
  return {
    threadPool: Number(process.env.UV_THREADPOOL_SIZE || 4),
    loop: {
      samples,
      averageLagMs: samples ? Math.round((lagTotal / samples) * 10) / 10 : 0,
      worstLagMs: Math.round(worstLag),
    },
    recent: stalls.slice(-40),
    memoryMB: Math.round(process.memoryUsage().rss / 1048576),
    busy: [...tasks.values()].map(t => `${t.label} (${Math.round((Date.now() - t.since) / 100) / 10}s)`),
    mount: mountLast
      ? { reconnectsSinceLaunch: reconnects, sessionReconnects: mountLast.sessions, shareReconnects: mountLast.shares }
      : null,
  }
}

/**
 * Is the network mount itself misbehaving?
 *
 * This is the question "is the app at fault" reduces to on this machine, and it
 * is answerable: the kernel counts CIFS session and share reconnects in
 * /proc/fs/cifs/Stats, readable without privileges. A reconnect stalls every
 * pending request on that mount for as long as the handshake takes, and from
 * inside the app that is indistinguishable from the app hanging.
 *
 * Measured on this machine: 31 session and 16 share reconnects, with the kernel
 * log carrying "Close interrupted" and "Close unmatched open" against the same
 * share. No amount of work inside this process prevents that — but saying so
 * is far better than showing a frozen window and letting the user conclude the
 * file manager is broken.
 */
interface MountState { sessions: number; shares: number }

function readCifsState(): MountState | null {
  let text: string
  try { text = fs.readFileSync('/proc/fs/cifs/Stats', 'utf8') } catch { return null }
  const m = /(\d+) session (\d+) share reconnects/.exec(text)
  if (!m) return null
  return { sessions: Number(m[1]), shares: Number(m[2]) }
}

let mountBase: MountState | null = null
let mountLast: MountState | null = null
let reconnects = 0

/** call on each sample: returns true when the mount reconnected since last look */
function pollMount(): boolean {
  const now = readCifsState()
  if (!now) return false
  if (!mountBase) { mountBase = now; mountLast = now; return false }
  const prev = mountLast ?? now
  mountLast = now
  const moved = now.sessions > prev.sessions || now.shares > prev.shares
  if (moved) {
    reconnects++
    console.warn(`[health] NETWORK MOUNT RECONNECTED (session ${prev.sessions}->${now.sessions}, share ${prev.shares}->${now.shares}) — stalls around this time are the mount, not the app`)
  }
  return moved
}

/**
 * Catch SYNCHRONOUS filesystem calls that block the main thread.
 *
 * This is the instrument that finally named the freeze. Event-loop lag says the
 * thread was stuck; a CPU profile says which native frame it was stuck in; but
 * neither says WHICH CALL SITE, and a sync call from a module you were not
 * suspecting is exactly the kind of thing that survives every other kind of
 * search. Timing the fs.*Sync family and printing a stack for the slow ones
 * gives the file and line directly.
 *
 * The wrapper is cheap — a Date.now() either side — and only prints past the
 * threshold, so it is left on rather than being a build-time option nobody
 * remembers to enable when it matters.
 */
const SYNC_WARN_MS = 200
const SYNC_FNS = [
  'readdirSync', 'statSync', 'lstatSync', 'readFileSync', 'writeFileSync',
  'existsSync', 'realpathSync', 'readlinkSync', 'accessSync', 'opendirSync',
] as const

function wrapSyncFs(): void {
  const mod = fs as unknown as Record<string, unknown>
  for (const name of SYNC_FNS) {
    const orig = mod[name]
    if (typeof orig !== 'function') continue
    const fn = orig as (...a: unknown[]) => unknown
    const wrapped = function wrapped(this: unknown, ...args: unknown[]): unknown {
      const t0 = Date.now()
      try {
        return fn.apply(this, args)
      } finally {
        const ms = Date.now() - t0
        if (ms >= SYNC_WARN_MS) {
          const where = (new Error().stack || '').split('\n').slice(2, 5)
            .map(l => l.trim().replace(/^at\s+/, '')).join(' <- ')
          const target = typeof args[0] === 'string' ? args[0] : String(args[0])
          console.warn(`[health] BLOCKING ${name} ${ms}ms on ${target}\n         ${where}`)
          record({ at: Date.now(), kind: 'loop', ms, what: `${name} ${target}` })
        }
      }
    }
    // Plain assignment fails here: the bundler's CommonJS interop exposes these
    // as GETTER-ONLY properties, and `fs.readdirSync = ...` throws at startup —
    // which took the whole app down the first time this was tried. defineProperty
    // replaces the accessor outright, and the try/catch means a future Node that
    // makes them truly read-only costs a missing diagnostic, not a dead app.
    try {
      Object.defineProperty(mod, name, {
        value: wrapped, writable: true, configurable: true, enumerable: true,
      })
    } catch { /* leave this one unmeasured rather than fail to start */ }
  }
}

let started = false
export function startHealth(): void {
  if (started) return
  started = true
  wrapIpc()
  wrapSyncFs()
  startLoopMonitor()
  console.log(`[health] watching main process — thread pool ${process.env.UV_THREADPOOL_SIZE || '4 (default)'}`)
}

/**
 * Stalls reported by the RENDERER.
 *
 * They land in the same log as the main-process ones, deliberately: a freeze is
 * one event to the person experiencing it, and having to correlate two logs to
 * see which half stopped is how a report ends up saying "nothing in the log".
 * The 'renderer/' prefix is the only distinction needed.
 */
ipcMain.handle(CH('healthRendererStall'), (_e, raw: unknown) => {
  const r = (raw ?? {}) as { kind?: string; ms?: number; phase?: string; detail?: string }
  const ms = Math.round(Number(r.ms) || 0)
  const kind = String(r.kind ?? 'unknown').slice(0, 20)
  const phase = String(r.phase ?? '').slice(0, 80)
  const detail = String(r.detail ?? '').slice(0, 120)
  if (kind === 'startup') {
    console.log(`[health] renderer/startup ${ms}ms to first listing — ${detail}`)
  } else {
    console.warn(`[health] renderer/${kind} stall ${ms}ms during "${phase}" ${detail}`)
  }
  stalls.push({ at: Date.now(), kind: 'loop', ms, what: `renderer/${kind} ${phase}` })
  if (stalls.length > KEEP) stalls.splice(0, stalls.length - KEEP)
  return true
})

ipcMain.handle(CH('health'), () => healthReport())
