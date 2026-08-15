// Frames from across a video, as a grid you can click to jump.
//
// Scene-select for any file, built from nothing but ffmpeg. One process per
// frame with input seeking (`-ss` before `-i`) rather than one pass decoding
// the whole file: measured on a 711 MB MPEG-2 rip off the share, twelve frames
// took 0.17 s and 53 KB in total, four processes at a time. A single-pass
// `fps=1/N` filter would have decoded twenty minutes of video to produce the
// same twelve pictures.
//
// The frames are REAL FILES in the cache directory rather than data: URIs,
// because the renderer already has liqfile:// to serve them and a data: URI of
// twelve JPEGs would have to cross IPC as one large base64 string.
import { ipcMain } from 'electron'
import { spawn, type ChildProcess } from 'node:child_process'
import * as crypto from 'node:crypto'
import * as fs from 'node:fs'
import * as fsp from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { CH } from '../../shared/ipc'
import { streamInfo } from './mediainfo'
import { TEST_PROFILE, TEST_ROOT } from '../state/settings'

/** frames per sheet; 12 fits a 4x3 grid and covers a film without crowding */
const FRAMES = 12
/** never more than this many ffmpeg processes at once for one sheet */
const CONCURRENCY = 4
/** a single frame that takes longer than this is not worth waiting for */
const FRAME_MS = 20_000
/** thumbnail height; the grid is small and these are stills, not video */
const FRAME_H = 120
/** sheets older than this are swept on the next request */
const SHEET_TTL_MS = 7 * 24 * 60 * 60 * 1000

export interface SheetFrame {
  /** absolute path of the JPEG, servable over liqfile:// */
  file: string
  /** position in the source, in seconds */
  at: number
}

function cacheRoot(): string {
  if (TEST_PROFILE) return path.join(TEST_ROOT, 'cache/liqexplorer')
  return path.join(process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache'), 'liqexplorer')
}

function sheetsRoot(): string { return path.join(cacheRoot(), 'sheets') }

function keyFor(p: string, st: fs.Stats, frames: number): string {
  return crypto.createHash('sha256')
    .update(`${p}\0${st.mtimeMs}\0${st.size}\0${frames}\0${FRAME_H}`)
    .digest('hex').slice(0, 32)
}

function grabFrame(src: string, at: number, out: string): Promise<boolean> {
  return new Promise(resolve => {
    let child: ChildProcess
    try {
      child = spawn('ffmpeg', [
        '-hide_banner', '-loglevel', 'error',
        // BEFORE -i: index seek, milliseconds. After -i it would decode the
        // whole file up to `at` for every single frame.
        '-ss', at.toFixed(2), '-i', src,
        '-frames:v', '1', '-vf', `scale=-2:${FRAME_H}`, '-q:v', '5',
        '-y', out,
      ], { stdio: 'ignore' })
    } catch { resolve(false); return }
    const timer = setTimeout(() => { try { child.kill('SIGKILL') } catch { /* gone */ } resolve(false) }, FRAME_MS)
    child.on('error', () => { clearTimeout(timer); resolve(false) })
    child.on('exit', (code) => { clearTimeout(timer); resolve(code === 0) })
  })
}

/** in flight per key, so two openings of the same video share one generation */
const inflight = new Map<string, Promise<SheetFrame[]>>()

export async function contactSheet(p: string, frames = FRAMES): Promise<SheetFrame[]> {
  if (!p.startsWith('/')) return []
  const n = Math.max(4, Math.min(24, Math.floor(frames) || FRAMES))
  let st: fs.Stats
  try { st = await fsp.stat(p) } catch { return [] }
  if (!st.isFile()) return []

  const info = await streamInfo(p)
  // no video track, or no length to spread frames across
  if (!info || !info.vcodec || info.duration <= 0) return []

  const key = keyFor(p, st, n)
  const dir = path.join(sheetsRoot(), key)
  const positions = Array.from({ length: n }, (_, i) => (info.duration * (i + 0.5)) / n)

  // already generated?
  const existing = await Promise.all(positions.map(async (at, i) => {
    const f = path.join(dir, `${String(i).padStart(2, '0')}.jpg`)
    try { return (await fsp.stat(f)).size > 0 ? { file: f, at } : null } catch { return null }
  }))
  if (existing.every(Boolean)) {
    await fsp.utimes(dir, new Date(), new Date()).catch(() => {})
    return existing as SheetFrame[]
  }

  const running = inflight.get(key)
  if (running) return running

  const job = (async (): Promise<SheetFrame[]> => {
    await fsp.mkdir(dir, { recursive: true }).catch(() => {})
    const out: SheetFrame[] = []
    for (let i = 0; i < positions.length; i += CONCURRENCY) {
      const batch = positions.slice(i, i + CONCURRENCY)
      const done = await Promise.all(batch.map(async (at, j) => {
        const idx = i + j
        const f = path.join(dir, `${String(idx).padStart(2, '0')}.jpg`)
        const ok = await grabFrame(p, at, f)
        return ok ? { file: f, at } : null
      }))
      // a frame that could not be grabbed is skipped, not fatal: the last frame
      // of a file with a truncated tail regularly fails, and eleven frames are
      // still a useful sheet
      for (const d of done) if (d) out.push(d)
    }
    void sweepOld()
    return out
  })()

  inflight.set(key, job)
  try { return await job } finally { inflight.delete(key) }
}

/** drop sheets nobody has opened in a week */
async function sweepOld(): Promise<void> {
  const cutoff = Date.now() - SHEET_TTL_MS
  try {
    for (const name of await fsp.readdir(sheetsRoot())) {
      const d = path.join(sheetsRoot(), name)
      try {
        const st = await fsp.stat(d)
        if (st.isDirectory() && st.mtimeMs < cutoff) await fsp.rm(d, { recursive: true, force: true })
      } catch { /* racing another sweep */ }
    }
  } catch { /* never created */ }
}

/**
 * One frame at one moment, for the preview that follows the pointer along the
 * scrub bar.
 *
 * Times are SNAPPED to a grid before they become filenames, which is what makes
 * this affordable: dragging along a two-hour film asks for a few dozen distinct
 * frames instead of one per pixel, and the second pass over the same region is
 * a cache hit. The grid is coarse enough to be cheap and fine enough that the
 * frame still looks like the moment under the cursor.
 */
const SNAP_SECONDS = 5

export async function seekFrame(p: string, at: number): Promise<string> {
  if (!p.startsWith('/') || !Number.isFinite(at) || at < 0) return ''
  let st: fs.Stats
  try { st = await fsp.stat(p) } catch { return '' }
  if (!st.isFile()) return ''
  const info = await streamInfo(p)
  if (!info || !info.vcodec || info.duration <= 0) return ''

  const snapped = Math.max(0, Math.min(
    Math.round(at / SNAP_SECONDS) * SNAP_SECONDS,
    Math.max(0, Math.floor(info.duration) - 1),
  ))
  const key = keyFor(p, st, 0)
  const dir = path.join(sheetsRoot(), `${key}-seek`)
  const file = path.join(dir, `${snapped}.jpg`)
  try {
    if ((await fsp.stat(file)).size > 0) return file
  } catch { /* not made yet */ }

  const pending = seekInflight.get(file)
  if (pending) return pending

  const job = (async (): Promise<string> => {
    await fsp.mkdir(dir, { recursive: true }).catch(() => {})
    const ok = await grabFrame(p, snapped, file)
    return ok ? file : ''
  })()
  seekInflight.set(file, job)
  try { return await job } finally { seekInflight.delete(file) }
}

const seekInflight = new Map<string, Promise<string>>()

export async function clearContactSheets(): Promise<void> {
  await fsp.rm(sheetsRoot(), { recursive: true, force: true }).catch(() => {})
}

ipcMain.handle(CH('contactSheet'), (_e, p: string, frames?: number) => contactSheet(p, frames))
ipcMain.handle(CH('seekFrame'), (_e, p: string, at: number) => seekFrame(p, at))
