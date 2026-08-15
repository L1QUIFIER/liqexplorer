// Bulk image conversion for the Drop Bins "Convert images…" bin.
//
// Self-registers its IPC (like ops/quick.ts does for templatesList) so
// main/ipc.ts stays untouched:
//     convertFormats()               -> ConvertFormat[]   (capability-probed)
//     convertImages(ConvertRequest)  -> runId, progress on CONVERT_PROGRESS
//     convertCancel(runId)
//
// WHY THE CAPABILITY PROBE IS NOT OPTIONAL
// ----------------------------------------
// This machine has ImageMagick 6.9.12 (legacy `convert`; no `magick`). Its
// format table lists AVIF as `r--` — read only — and, critically,
// `convert in.png out.avif` still exits 0 and writes a **PNG carrying an .avif
// name**. Shipping that would hand the user silently mislabelled files. So the
// encoder set is discovered by ROUND-TRIPPING a tiny image through every
// candidate format and asking `identify` what actually came out; anything whose
// output does not match is not offered. AVIF then falls back to ffmpeg's
// libaom-av1, fed a PNG over a pipe by ImageMagick so there is exactly one
// decode/orient/resize implementation.
//
// Everything else worth knowing:
//   * sources are filtered by extension allowlist — ImageMagick will happily
//     *render a text file into an image*, so "convert whatever was dropped"
//     is not safe; folders are walked for images instead of being rejected.
//   * `src[0]` selects the first frame: without it a multi-frame GIF/TIFF/HEIC
//     makes convert write out-0.jpg, out-1.jpg, … and the caller's output list
//     is a lie. Animation is therefore dropped by design (see report).
//   * `-auto-orient` first, or EXIF-rotated phone photos come out sideways.
//   * outputs NEVER overwrite: an existing name gets " (2)", " (3)", … exactly
//     like ops/quick.ts. That also makes converting in place harmless.
//   * MAGICK_THREAD_LIMIT=1 per child. ImageMagick's OpenMP otherwise takes all
//     available cores *per process*, so parallel encoders fight each other. Measured
//     on 43x 3000x2000 JPEGs -> 1600px: 0.64s wall / 4.1s CPU with the limit,
//     0.89s wall / 19.0s CPU without it. Same work, 4.6x less of the machine.
import { ipcMain, type WebContents } from 'electron'
import { spawn, type ChildProcess } from 'node:child_process'
import * as fsp from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { CH } from '../../shared/ipc'
import {
  CONVERT_PROGRESS, type ConvertFormat, type ConvertProgress, type ConvertRequest,
} from '../../shared/bins'

/** Extensions accepted as conversion INPUT. Anything else is reported unusable
 *  rather than rendered (see header). */
const IMAGE_EXTS = new Set([
  'jpg', 'jpeg', 'jpe', 'png', 'gif', 'bmp', 'webp', 'tif', 'tiff', 'heic', 'heif',
  'avif', 'ico', 'tga', 'ppm', 'pgm', 'pbm', 'pnm', 'jp2', 'jxl', 'svg', 'xpm', 'dds',
])

/** Walk cap: one drop must not turn into an unbounded tree scan. */
const SOURCE_CAP = 5000
const WALK_DEPTH = 12
/** A wedged encoder must not hold a queue slot forever. */
const PER_FILE_TIMEOUT_MS = 180_000
const PROGRESS_MS = 120
const OUTPUTS_REPORTED = 200

interface Candidate {
  id: string
  label: string
  /** what `identify -format %m` must print for the round trip to count */
  magickName: string
  lossy: boolean
  /** ffmpeg encoder to try when ImageMagick cannot write the format */
  ffmpegCodec?: string
}

const CANDIDATES: Candidate[] = [
  { id: 'jpg', label: 'JPEG (.jpg)', magickName: 'JPEG', lossy: true },
  { id: 'png', label: 'PNG (.png)', magickName: 'PNG', lossy: false },
  { id: 'webp', label: 'WebP (.webp)', magickName: 'WEBP', lossy: true },
  { id: 'avif', label: 'AVIF (.avif)', magickName: 'AVIF', lossy: true, ffmpegCodec: 'libaom-av1' },
  { id: 'heic', label: 'HEIC (.heic)', magickName: 'HEIC', lossy: true },
  { id: 'tiff', label: 'TIFF (.tiff)', magickName: 'TIFF', lossy: false },
  { id: 'bmp', label: 'BMP (.bmp)', magickName: 'BMP', lossy: false },
]

// ------------------------------------------------------------ tool discovery

interface Tools {
  /** ['magick'] on IM7, ['convert'] on IM6 */
  convert: string[]
  identify: string[]
  ffmpeg: string | null
}
let toolsPromise: Promise<Tools> | null = null

function exists(bin: string, args: string[]): Promise<boolean> {
  return new Promise(resolve => {
    let done = false
    const finish = (v: boolean): void => { if (!done) { done = true; resolve(v) } }
    let child: ChildProcess
    try {
      child = spawn(bin, args, { stdio: 'ignore' })
    } catch { finish(false); return }
    child.on('error', () => finish(false))
    child.on('close', code => finish(code === 0))
    setTimeout(() => { child.kill('SIGKILL'); finish(false) }, 8000).unref?.()
  })
}

async function tools(): Promise<Tools> {
  if (!toolsPromise) {
    toolsPromise = (async (): Promise<Tools> => {
      // IM7 ships one `magick` driver; IM6 ships `convert`/`identify`. Prefer
      // `magick` where present — IM6's `convert` collides with a coreutils-era
      // name and is the build with the AVIF trap described in the header.
      const im7 = await exists('magick', ['-version'])
      const im6 = im7 ? false : await exists('convert', ['-version'])
      const ff = await exists('ffmpeg', ['-version'])
      return {
        convert: im7 ? ['magick'] : im6 ? ['convert'] : [],
        identify: im7 ? ['magick', 'identify'] : im6 ? ['identify'] : [],
        ffmpeg: ff ? 'ffmpeg' : null,
      }
    })()
  }
  return toolsPromise
}

// --------------------------------------------------------------- child procs

interface RunResult { code: number | null; stderr: string; timedOut: boolean }

/** Spawn, capture stderr, enforce a timeout, and register the child so a
 *  cancel can kill it. `reg` is the run's live-child set (null = probing). */
function run(
  bin: string, args: string[], reg: Set<ChildProcess> | null, timeoutMs = PER_FILE_TIMEOUT_MS,
): Promise<RunResult> {
  return new Promise(resolve => {
    let child: ChildProcess
    try {
      child = spawn(bin, args, {
        stdio: ['ignore', 'ignore', 'pipe'],
        env: { ...process.env, MAGICK_THREAD_LIMIT: '1', OMP_NUM_THREADS: '1' },
      })
    } catch (e) {
      resolve({ code: -1, stderr: String((e as Error)?.message ?? e), timedOut: false })
      return
    }
    reg?.add(child)
    let stderr = ''
    let timedOut = false
    child.stderr?.on('data', (d: Buffer) => { if (stderr.length < 8192) stderr += d.toString() })
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL') }, timeoutMs)
    const finish = (code: number | null, err?: string): void => {
      clearTimeout(timer)
      reg?.delete(child)
      resolve({ code, stderr: err ?? stderr, timedOut })
    }
    child.on('error', e => finish(-1, String((e as Error)?.message ?? e)))
    child.on('close', code => finish(code))
  })
}

/** ImageMagick decode/orient/resize piped straight into an ffmpeg encoder.
 *  One resize implementation for every backend, and no temp file. */
function runPiped(
  imBin: string, imArgs: string[], ffBin: string, ffArgs: string[], reg: Set<ChildProcess> | null,
): Promise<RunResult> {
  return new Promise(resolve => {
    const env = { ...process.env, MAGICK_THREAD_LIMIT: '1', OMP_NUM_THREADS: '1' }
    let im: ChildProcess, ff: ChildProcess
    try {
      im = spawn(imBin, imArgs, { stdio: ['ignore', 'pipe', 'pipe'], env })
      ff = spawn(ffBin, ffArgs, { stdio: ['pipe', 'ignore', 'pipe'], env })
    } catch (e) {
      resolve({ code: -1, stderr: String((e as Error)?.message ?? e), timedOut: false })
      return
    }
    reg?.add(im); reg?.add(ff)
    let stderr = ''
    let timedOut = false
    const grab = (d: Buffer): void => { if (stderr.length < 8192) stderr += d.toString() }
    im.stderr?.on('data', grab)
    ff.stderr?.on('data', grab)
    // ffmpeg dying first turns the next write into EPIPE; swallow both ends or
    // the unhandled 'error' takes the whole main process down.
    im.stdout?.on('error', () => {})
    ff.stdin?.on('error', () => {})
    im.stdout?.pipe(ff.stdin!)
    const timer = setTimeout(() => {
      timedOut = true
      im.kill('SIGKILL'); ff.kill('SIGKILL')
    }, PER_FILE_TIMEOUT_MS)
    let imCode: number | null = null
    im.on('error', () => { imCode = -1 })
    im.on('close', c => { imCode = c })
    const done = (code: number | null, err?: string): void => {
      clearTimeout(timer)
      reg?.delete(im); reg?.delete(ff)
      if (!im.killed) im.kill('SIGKILL')
      // a non-zero decoder exit means the encoder was fed a truncated stream
      resolve({ code: code === 0 && imCode !== 0 && imCode !== null ? imCode : code, stderr: err ?? stderr, timedOut })
    }
    ff.on('error', e => done(-1, String((e as Error)?.message ?? e)))
    ff.on('close', c => done(c))
  })
}

// ------------------------------------------------------------ format probing

let formatsPromise: Promise<ConvertFormat[]> | null = null

async function probeFormats(): Promise<ConvertFormat[]> {
  const t = await tools()
  if (!t.convert.length) return []
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'liqexplorer-fmtprobe-'))
  const out: ConvertFormat[] = []
  try {
    const seed = path.join(dir, 'seed.png')
    const mk = await run(t.convert[0], [...t.convert.slice(1), '-size', '32x32', 'gradient:red-blue', seed], null, 15000)
    if (mk.code !== 0) return []
    for (const c of CANDIDATES) {
      const target = path.join(dir, `probe.${c.id}`)
      await fsp.rm(target, { force: true }).catch(() => {})
      const r = await run(t.convert[0], [...t.convert.slice(1), seed, target], null, 20000)
      if (r.code === 0 && await identifyIs(t, target, c.magickName)) {
        out.push({ id: c.id, label: c.label, backend: 'magick', lossy: c.lossy })
        continue
      }
      // ImageMagick claimed success but produced something else (the AVIF trap)
      // or failed outright — try the declared ffmpeg encoder.
      if (!c.ffmpegCodec || !t.ffmpeg) continue
      await fsp.rm(target, { force: true }).catch(() => {})
      const r2 = await runPiped(
        t.convert[0], [...t.convert.slice(1), seed, 'png:-'],
        t.ffmpeg, ffmpegArgs(c.ffmpegCodec, 30, target), null,
      )
      if (r2.code === 0 && await identifyIs(t, target, c.magickName)) {
        out.push({ id: c.id, label: c.label, backend: 'ffmpeg', lossy: c.lossy })
      }
    }
  } finally {
    await fsp.rm(dir, { recursive: true, force: true }).catch(() => {})
  }
  return out
}

/** Both flags here are worth an order of magnitude and were measured, not guessed
 *  (one 1600x1067 frame, libaom-av1):
 *    -cpu-used 6 -row-mt 1 : 7.09s -> 0.51s wall, output 0.3% larger. libaom's
 *        default speed preset is tuned for video, and it is unusable per photo.
 *    -pix_fmt yuv420p      : ffmpeg otherwise picks gbrp (planar RGB) from a PNG
 *        input, giving a 110 KB "AVIF" where 4:2:0 gives 27 KB — 4x bigger than
 *        anyone means by AVIF, and readable by far fewer decoders. */
function ffmpegArgs(codec: string, crf: number, out: string): string[] {
  return [
    '-hide_banner', '-loglevel', 'error', '-y', '-i', '-',
    '-c:v', codec, '-crf', String(crf),
    '-cpu-used', '6', '-row-mt', '1', '-threads', '4',
    '-pix_fmt', 'yuv420p', '-frames:v', '1', out,
  ]
}

/** `identify -format %m` on the first frame — the only honest answer to
 *  "what did the encoder actually write". */
async function identifyIs(t: Tools, file: string, want: string): Promise<boolean> {
  if (!t.identify.length) return false
  const got = await new Promise<string>(resolve => {
    let child: ChildProcess
    try {
      child = spawn(t.identify[0], [...t.identify.slice(1), '-format', '%m', `${file}[0]`], {
        stdio: ['ignore', 'pipe', 'ignore'],
      })
    } catch { resolve(''); return }
    let s = ''
    child.stdout?.on('data', (d: Buffer) => { s += d.toString() })
    child.on('error', () => resolve(''))
    child.on('close', () => resolve(s.trim().toUpperCase()))
    setTimeout(() => child.kill('SIGKILL'), 15000).unref?.()
  })
  return got.startsWith(want.toUpperCase())
}

export function convertFormats(): Promise<ConvertFormat[]> {
  if (!formatsPromise) formatsPromise = probeFormats().catch(() => [])
  return formatsPromise
}

// ----------------------------------------------------------------- the queue

interface Run {
  id: number
  cancelled: boolean
  children: Set<ChildProcess>
  /** outputs already opened by an encoder; removed on cancel so a kill never
   *  strands a half-written file next to the good ones */
  inFlight: Set<string>
}

const runs = new Map<number, Run>()
let nextRunId = 1

function isImage(p: string): boolean {
  const i = p.lastIndexOf('.')
  return i > 0 && IMAGE_EXTS.has(p.slice(i + 1).toLowerCase())
}

/** Expand the drop: files kept if they look like images, folders walked. */
async function collect(sources: string[]): Promise<{ files: string[]; skipped: string[] }> {
  const files: string[] = []
  const skipped: string[] = []
  const seen = new Set<string>()
  const walk = async (p: string, depth: number): Promise<void> => {
    if (files.length >= SOURCE_CAP) return
    let st
    try { st = await fsp.lstat(p) } catch { skipped.push(p); return }
    if (st.isSymbolicLink()) {
      // follow a link to a real file, never into a directory (loop risk)
      const real = await fsp.stat(p).catch(() => null)
      if (!real?.isFile()) { skipped.push(p); return }
    } else if (st.isDirectory()) {
      if (depth >= WALK_DEPTH) return
      const names = await fsp.readdir(p).catch(() => [])
      for (const n of names.sort()) {
        if (n.startsWith('.')) continue
        await walk(path.join(p, n), depth + 1)
        if (files.length >= SOURCE_CAP) return
      }
      return
    } else if (!st.isFile()) { skipped.push(p); return }
    if (!isImage(p)) { skipped.push(p); return }
    if (seen.has(p)) return
    seen.add(p)
    files.push(p)
  }
  for (const s of sources) {
    await walk(s, 0)
    if (files.length >= SOURCE_CAP) break
  }
  return { files, skipped }
}

/** "photo.jpg" -> dest/photo.webp, or dest/photo (2).webp if taken. Never
 *  overwrites, so converting into the source folder is safe. */
async function freeName(dest: string, src: string, ext: string): Promise<string> {
  const base = path.basename(src)
  const dot = base.lastIndexOf('.')
  const stem = dot > 0 ? base.slice(0, dot) : base
  for (let i = 1; i < 1000; i++) {
    const p = path.join(dest, i === 1 ? `${stem}.${ext}` : `${stem} (${i}).${ext}`)
    if (p === src) continue
    // lstat, not access: a dangling symlink at that name still occupies it
    const taken = await fsp.lstat(p).then(() => true, () => false)
    if (!taken) return p
  }
  throw new Error('too many files with this name')
}

function magickArgs(
  bin: string[], src: string, out: string | null, fmt: string,
  maxDim: number, quality: number, strip: boolean, lossy: boolean,
): string[] {
  const a = [...bin.slice(1)]
  a.push(`${src}[0]`)          // first frame only — see header
  a.push('-auto-orient')       // EXIF rotation, before any resize
  if (maxDim > 0) a.push('-resize', `${maxDim}x${maxDim}>`)   // '>' = shrink only
  if (strip) a.push('-strip')
  // PNG/BMP read -quality as a zlib/filter pair, not as visual quality
  if (lossy && quality > 0) a.push('-quality', String(Math.round(quality)))
  a.push(out ?? `${fmt}:-`)
  return a
}

async function convertOne(
  r: Run, t: Tools, src: string, dest: string, f: ConvertFormat,
  maxDim: number, quality: number, strip: boolean,
): Promise<{ out?: string; error?: string }> {
  const out = await freeName(dest, src, f.id)
  r.inFlight.add(out)
  try {
    let res: RunResult
    if (f.backend === 'magick') {
      res = await run(t.convert[0], magickArgs(t.convert, src, out, f.id, maxDim, quality, strip, f.lossy), r.children)
    } else {
      const codec = CANDIDATES.find(c => c.id === f.id)?.ffmpegCodec
      if (!codec || !t.ffmpeg) return { error: 'no encoder for this format' }
      // quality 1..100 -> AV1 crf 63..0 (lower crf = better)
      const crf = Math.max(0, Math.min(63, Math.round(63 - (quality / 100) * 63)))
      res = await runPiped(
        t.convert[0], magickArgs(t.convert, src, null, 'png', maxDim, 0, strip, false),
        t.ffmpeg, ffmpegArgs(codec, crf, out), r.children,
      )
    }
    if (r.cancelled) { await fsp.rm(out, { force: true }).catch(() => {}); return {} }
    if (res.timedOut) { await fsp.rm(out, { force: true }).catch(() => {}); return { error: 'timed out' } }
    if (res.code !== 0) {
      await fsp.rm(out, { force: true }).catch(() => {})
      const msg = res.stderr.split('\n').map(s => s.trim()).filter(Boolean).pop()
      return { error: msg ? msg.replace(/^[^:]*: /, '') : `encoder exited ${res.code}` }
    }
    const st = await fsp.stat(out).catch(() => null)
    if (!st || st.size === 0) {
      await fsp.rm(out, { force: true }).catch(() => {})
      return { error: 'encoder produced an empty file' }
    }
    return { out }
  } finally {
    r.inFlight.delete(out)
  }
}

export async function convertImages(wc: WebContents, req: ConvertRequest): Promise<number> {
  const runId = nextRunId++
  const r: Run = { id: runId, cancelled: false, children: new Set(), inFlight: new Set() }
  runs.set(runId, r)
  void execute(wc, r, req).finally(() => runs.delete(runId))
  return runId
}

async function execute(wc: WebContents, r: Run, req: ConvertRequest): Promise<void> {
  const outputs: string[] = []
  const failures: { path: string; error: string }[] = []
  let done = 0
  let total = 0
  let current = ''
  let lastPush = 0

  const push = (status: ConvertProgress['status'], error?: string, force = false): void => {
    const now = Date.now()
    if (!force && now - lastPush < PROGRESS_MS) return
    lastPush = now
    if (wc.isDestroyed()) return
    const p: ConvertProgress = {
      runId: r.id, status, done, total, current, written: outputs.length,
      outputs: outputs.slice(0, OUTPUTS_REPORTED), failures: failures.slice(0, 100), error,
    }
    wc.send(CONVERT_PROGRESS, p)
  }

  try {
    const t = await tools()
    const formats = await convertFormats()
    const f = formats.find(x => x.id === req.format)
    if (!f) { push('error', `No working encoder for .${req.format} on this system.`, true); return }
    await fsp.mkdir(req.dest, { recursive: true })

    const { files, skipped } = await collect(req.sources)
    for (const s of skipped) failures.push({ path: s, error: 'not a supported image' })
    total = files.length
    if (!total) { push('done', undefined, true); return }

    const maxDim = Math.max(0, Math.round(req.maxDim ?? 0))
    const quality = Math.max(1, Math.min(100, Math.round(req.quality ?? 88)))
    const strip = req.strip === true
    // A quarter of the machine, capped at 8: enough to be worth it (43 photos
    // to JPEG take 1.01s at 6 lanes, 0.80s at 8) while leaving the box usable,
    // since each encoder is pinned to one thread by MAGICK_THREAD_LIMIT.
    const auto = Math.max(2, Math.floor((os.cpus()?.length ?? 4) / 4))
    const lanes = Math.max(1, Math.min(8, Math.round(req.concurrency ?? auto)))

    let next = 0
    push('running', undefined, true)
    const worker = async (): Promise<void> => {
      while (!r.cancelled) {
        const i = next++
        if (i >= files.length) return
        const src = files[i]
        current = path.basename(src)
        push('running')
        try {
          const res = await convertOne(r, t, src, req.dest, f, maxDim, quality, strip)
          if (res.out) outputs.push(res.out)
          else if (res.error) failures.push({ path: src, error: res.error })
        } catch (e) {
          failures.push({ path: src, error: String((e as Error)?.message ?? e) })
        }
        done++
        push('running')
      }
    }
    await Promise.all(Array.from({ length: Math.min(lanes, files.length) }, worker))
    current = ''
    push(r.cancelled ? 'cancelled' : 'done', undefined, true)
  } catch (e) {
    push('error', String((e as Error)?.message ?? e), true)
  }
}

export async function convertCancel(runId: number): Promise<void> {
  const r = runs.get(runId)
  if (!r) return
  r.cancelled = true
  for (const c of r.children) { try { c.kill('SIGKILL') } catch { /* already gone */ } }
  // half-written outputs from the encoders we just killed
  for (const p of [...r.inFlight]) await fsp.rm(p, { force: true }).catch(() => {})
}

// ------------------------------------------------------- self-registered IPC

ipcMain.handle(CH('convertFormats'), () => convertFormats())
ipcMain.handle(CH('convertImages'), (e, req: ConvertRequest) => convertImages(e.sender, req))
ipcMain.handle(CH('convertCancel'), (_e, runId: number) => convertCancel(runId))
