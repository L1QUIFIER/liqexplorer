// The second half of the hybrid: once a file has been streamed, convert it
// properly in the background and switch over to the real file.
//
// Streaming (platform/transcode.ts) already plays anything, and seeking through
// it costs 368-409 ms end to end — of which 260 ms is the renderer's own scrub
// debounce, so ffmpeg's restart is closer to 130 ms. That is good enough that
// this module is an OPTIMISATION, not a rescue, and it is sized accordingly:
//
//   * A SOURCE CEILING. Converting a 55 GB film to save 300 ms on a seek is a
//     terrible trade — an hour of encoding and tens of gigabytes for a file the
//     user may watch once. Above MAX_SOURCE_BYTES a file simply stays on the
//     stream permanently, which already works.
//   * AN LRU CAP on the cache as a whole, because the alternative is a cache
//     that grows until the disk is full.
//   * NEVER EVICT WHAT IS PLAYING. The obvious LRU bug is deleting the file
//     whose bytes are being read right now.
//
// Conversions run at NICE PRIORITY and one at a time. The user is watching a
// video while this happens; a background job that makes playback stutter has
// made things worse, not better.
import { ipcMain } from 'electron'
import { spawn, type ChildProcess } from 'node:child_process'
import * as crypto from 'node:crypto'
import * as fs from 'node:fs'
import * as fsp from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { CH, PUSH } from '../../shared/ipc'
import { decidePlay, type PlayMode } from '../../shared/playplan'
import { streamInfo } from './mediainfo'
import { ffmpegArgs } from './transcode'
import { getSettings, TEST_PROFILE, TEST_ROOT } from '../state/settings'
import { broadcast } from '../windows'

/** above this the file stays on the stream for ever; see the header */
const MAX_SOURCE_BYTES = 4 * 1024 * 1024 * 1024
/** total cache budget */
const MAX_CACHE_BYTES = 20 * 1024 * 1024 * 1024
/** a conversion that has not grown its output in this long is wedged */
const STALL_MS = 120_000

export interface CacheStatus {
  state: 'none' | 'building' | 'ready' | 'too-big' | 'failed'
  /** liqfile-servable absolute path, when ready */
  file?: string
  /** 0..1, best effort */
  progress?: number
}

function cacheRoot(): string {
  // a test profile must not write into (or wipe) the real user's cache
  if (TEST_PROFILE) return path.join(TEST_ROOT, 'cache/liqexplorer')
  return path.join(process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache'), 'liqexplorer')
}

function videoRoot(): string { return path.join(cacheRoot(), 'transcoded') }

/** path + mtime + size + how it will be encoded: an edited source, or a
 *  different target height, is a different file and must not collide */
function keyFor(p: string, st: fs.Stats, mode: PlayMode, height: number): string {
  const h = crypto.createHash('sha256')
  h.update(`${p}\0${st.mtimeMs}\0${st.size}\0${mode}\0${height}`)
  return h.digest('hex').slice(0, 32)
}

interface Building {
  child: ChildProcess
  out: string
  started: number
  /** last observed output size, for the stall check */
  seen: number
  timer: NodeJS.Timeout
}

const building = new Map<string, Building>()
/** files currently being read by a player; eviction must skip these */
const pinned = new Set<string>()

export function pinCached(file: string): void { pinned.add(file) }
export function unpinCached(file: string): void { pinned.delete(file) }

async function readyFile(key: string): Promise<string | null> {
  const f = path.join(videoRoot(), `${key}.mp4`)
  try {
    const st = await fsp.stat(f)
    if (st.size > 0) {
      // touch: the LRU sweep orders by atime, and a file being watched again
      // should not be the next one evicted
      await fsp.utimes(f, new Date(), st.mtime).catch(() => {})
      return f
    }
  } catch { /* not there */ }
  return null
}

/**
 * Where does this file stand? Called by the renderer once playback is under
 * way; it never blocks on the conversion.
 */
export async function cacheStatus(p: string, height: number): Promise<CacheStatus> {
  if (!p.startsWith('/')) return { state: 'none' }
  let st: fs.Stats
  try { st = await fsp.stat(p) } catch { return { state: 'none' } }
  if (!st.isFile()) return { state: 'none' }
  if (st.size > MAX_SOURCE_BYTES) return { state: 'too-big' }

  const info = await streamInfo(p)
  if (!info) return { state: 'none' }
  const plan = decidePlay(info)
  if (plan.mode === 'direct' || plan.mode === 'none') return { state: 'none' }

  const key = keyFor(p, st, plan.mode, height)
  const done = await readyFile(key)
  if (done) return { state: 'ready', file: done }

  const job = building.get(key)
  if (job) {
    let grown = 0
    try { grown = (await fsp.stat(job.out)).size } catch { /* not yet */ }
    // ffmpeg gives no reliable percentage on a pipe-free run without parsing
    // its progress output; output size against the source is close enough to
    // drive a progress bar and cannot lie about being finished
    return { state: 'building', progress: st.size > 0 ? Math.min(0.99, grown / st.size) : 0 }
  }
  return { state: 'none' }
}

/**
 * Start converting `p` in the background, if it is worth doing and not already
 * under way. Resolves as soon as the job is QUEUED, not when it finishes —
 * completion arrives as a broadcast.
 */
export async function startCaching(p: string, height: number): Promise<CacheStatus> {
  // gated main-side rather than in the renderer so that every caller — the
  // viewer, the preview pane, a future one — obeys it without having to know
  if (getSettings().mediaTranscodeCache === false) return { state: 'none' }
  const status = await cacheStatus(p, height)
  if (status.state !== 'none') return status
  // one at a time: the user is watching something while this runs
  if (building.size > 0) return { state: 'building', progress: 0 }

  let st: fs.Stats
  try { st = await fsp.stat(p) } catch { return { state: 'none' } }
  const info = await streamInfo(p)
  if (!info) return { state: 'none' }
  const plan = decidePlay(info)
  if (plan.mode === 'direct' || plan.mode === 'none') return { state: 'none' }

  const key = keyFor(p, st, plan.mode, height)
  await fsp.mkdir(videoRoot(), { recursive: true }).catch(() => {})
  const out = path.join(videoRoot(), `${key}.part`)
  const final = path.join(videoRoot(), `${key}.mp4`)

  const args = ffmpegArgs(p, plan.mode, 0, height, info, true, -1, { kind: 'file', file: out })

  let child: ChildProcess
  try {
    // nice: this must never take priority over the playback it is meant to help
    child = spawn('nice', ['-n', '15', 'ffmpeg', ...args], { stdio: ['ignore', 'ignore', 'ignore'] })
  } catch { return { state: 'failed' } }

  const job: Building = {
    child, out, started: Date.now(), seen: 0,
    timer: setInterval(() => { void checkStall(key) }, 20_000),
  }
  job.timer.unref?.()
  building.set(key, job)

  child.on('exit', (code) => {
    clearInterval(job.timer)
    building.delete(key)
    void (async () => {
      if (code === 0) {
        try {
          await fsp.rename(out, final)
          await evictToBudget()
          broadcast(PUSH.mediaCacheReady, { path: p, file: final })
          return
        } catch { /* fall through to the failure cleanup */ }
      }
      await fsp.rm(out, { force: true }).catch(() => {})
      broadcast(PUSH.mediaCacheReady, { path: p, file: '' })
    })()
  })
  child.on('error', () => { clearInterval(job.timer); building.delete(key) })

  return { state: 'building', progress: 0 }
}

async function checkStall(key: string): Promise<void> {
  const job = building.get(key)
  if (!job) return
  let size = 0
  try { size = (await fsp.stat(job.out)).size } catch { /* not yet */ }
  if (size > job.seen) { job.seen = size; job.started = Date.now(); return }
  if (Date.now() - job.started > STALL_MS) {
    try { job.child.kill('SIGKILL') } catch { /* gone */ }
  }
}

/** Drop least-recently-used entries until the cache fits its budget. */
async function evictToBudget(): Promise<void> {
  let entries: { file: string; size: number; atime: number }[] = []
  try {
    const names = await fsp.readdir(videoRoot())
    entries = (await Promise.all(names
      .filter(n => n.endsWith('.mp4'))
      .map(async n => {
        const f = path.join(videoRoot(), n)
        try {
          const st = await fsp.stat(f)
          return { file: f, size: st.size, atime: st.atimeMs }
        } catch { return null }
      }))).filter(Boolean) as typeof entries
  } catch { return }

  let total = entries.reduce((n, e) => n + e.size, 0)
  if (total <= MAX_CACHE_BYTES) return
  entries.sort((a, b) => a.atime - b.atime)
  for (const e of entries) {
    if (total <= MAX_CACHE_BYTES) break
    // the one obvious LRU bug: deleting the file currently being played
    if (pinned.has(e.file)) continue
    await fsp.rm(e.file, { force: true }).catch(() => {})
    total -= e.size
  }
}

/** Kill any conversion in flight; called on quit. */
export function stopCaching(): void {
  for (const [, job] of building) {
    clearInterval(job.timer)
    try { job.child.kill('SIGKILL') } catch { /* gone */ }
    fs.rmSync(job.out, { force: true })
  }
  building.clear()
}

export async function clearMediaCache(): Promise<number> {
  stopCaching()
  let freed = 0
  try {
    for (const n of await fsp.readdir(videoRoot())) {
      const f = path.join(videoRoot(), n)
      try { freed += (await fsp.stat(f)).size } catch { /* racing */ }
      await fsp.rm(f, { force: true }).catch(() => {})
    }
  } catch { /* never existed */ }
  return freed
}

export async function mediaCacheSize(): Promise<number> {
  let total = 0
  try {
    for (const n of await fsp.readdir(videoRoot())) {
      try { total += (await fsp.stat(path.join(videoRoot(), n))).size } catch { /* racing */ }
    }
  } catch { /* never existed */ }
  return total
}

ipcMain.handle(CH('mediaCacheStatus'), (_e, p: string, h: number) => cacheStatus(p, h || 720))
ipcMain.handle(CH('mediaCacheStart'), (_e, p: string, h: number) => startCaching(p, h || 720))
ipcMain.handle(CH('mediaCachePin'), (_e, f: string, on: boolean) => { on ? pinCached(f) : unpinCached(f); return true })
ipcMain.handle(CH('mediaCacheSize'), () => mediaCacheSize())
ipcMain.handle(CH('mediaCacheClear'), () => clearMediaCache())
