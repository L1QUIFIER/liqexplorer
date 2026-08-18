// Near-duplicate images — the copies the exact matcher cannot see.
//
// platform/duplicates.ts compares BYTES, staged size → head → full hash. That
// is the right design for finding true duplicates and it is fast because two
// files of different sizes can be dismissed without reading either. But it is
// blind to the thing a scraped image library is actually full of: the same
// picture saved again at a different quality, resized for a thumbnail, or
// re-encoded from PNG to JPEG. Not one byte matches, and every one is a copy.
//
// dHash (difference hash) finds those. Reduce the picture to 9x8 greyscale,
// then record for each row whether each pixel is brighter than the one to its
// right: 8 comparisons per row, 8 rows, 64 bits. It survives rescaling,
// re-encoding, small colour shifts and mild cropping, because all of those
// preserve the RELATIONSHIP between neighbouring areas even when they change
// every value.
//
// Distance is Hamming — how many of the 64 bits differ. Under about 10 is the
// usual "same picture" line; the threshold is exposed because the right value
// depends on the library (photos of the same scene sit closer together than a
// mixed folder does).
//
// ImageMagick does the scaling because it is already a dependency and already
// resolved per distribution (platform/tools.ts). One process per image is the
// cost, which is why this is a tool you run rather than something that happens
// on every listing.
import { ipcMain } from 'electron'
import { spawn } from 'node:child_process'
import * as path from 'node:path'
import { CH, PUSH } from '../../shared/ipc'
import type { SimilarGroup, SimilarPhase, SimilarResult } from '../../shared/similar'
import { keeperFirst } from '../../shared/similar'
import { broadcast } from '../windows'
import { walkTree } from './treewalk'
import { resolveTools } from './tools'

const IMAGE_EXT = new Set(['jpg', 'jpeg', 'png', 'gif', 'bmp', 'webp', 'tif', 'tiff', 'avif', 'heic'])
/** how many convert processes at once */
const LANES = 4
/**
 * Hard cap on images per run.
 *
 * This is the expensive tool: one ImageMagick process per picture, then an
 * all-pairs comparison. Only the directory count was bounded, so pointing it at
 * a real library meant tens of thousands of processes and an O(n²) pass over
 * them — hours of work and a main process holding every hash. Five hundred
 * million comparisons is not a better answer than three thousand pictures'
 * worth, it is the same answer arriving after you have given up.
 */
const MAX_IMAGES = 3000
/** how many paths to hand one `identify` process — one process for hundreds of headers */
const IDENTIFY_CHUNK = 150

/** one run at a time, and it can be stopped */
let active: { runId: number; cancelled: boolean } | null = null
let nextRunId = 1

function say(runId: number, phase: SimilarPhase, done: number, total: number, current?: string): void {
  broadcast(PUSH.similarProgress, { runId, phase, done, total, current })
}

/**
 * Pixel dimensions for many files in ONE process.
 *
 * `identify` reads headers, so this is cheap — but it is spawned per CHUNK rather than per file
 * because 3000 processes is the thing that makes this tool feel broken. `%i` echoes the filename
 * back, which is what makes the answers safe to map: a file identify refuses to read simply has no
 * line, and without the echo every dimension after it would be attributed to the wrong picture.
 */
function identifyMany(files: string[]): Promise<Map<string, { w: number; h: number }>> {
  const out = new Map<string, { w: number; h: number }>()
  const id = resolveTools().identify
  if (!id.length || !files.length) return Promise.resolve(out)
  return new Promise(resolve => {
    let done = false
    const finish = (): void => { if (!done) { done = true; resolve(out) } }
    try {
      const c = spawn(id[0], [...id.slice(1), '-format', '%w %h %i\n', ...files.map(f => f + '[0]')],
        { stdio: ['ignore', 'pipe', 'ignore'] })
      let buf = ''
      c.stdout.on('data', (d: Buffer) => { buf += d.toString('utf8') })
      const t = setTimeout(() => { try { c.kill('SIGKILL') } catch { /* gone */ } finish() }, 60_000)
      c.on('error', () => { clearTimeout(t); finish() })
      c.on('close', () => {
        clearTimeout(t)
        for (const line of buf.split('\n')) {
          const m = /^(\d+) (\d+) (.+)$/.exec(line.trim())
          if (!m) continue
          // strip the [0] frame selector identify echoes back
          out.set(m[3].replace(/\[\d+\]$/, ''), { w: Number(m[1]), h: Number(m[2]) })
        }
        finish()
      })
    } catch { finish() }
  })
}

/**
 * 64-bit dHash as a BigInt.
 *
 * `gray:-` gives one byte per pixel with no header to skip, which is why it is
 * used instead of a text format: parsing ImageMagick's txt: output would be
 * both slower and one more thing to get wrong.
 */
function dhash(file: string): Promise<bigint | null> {
  const conv = resolveTools().convert
  if (!conv.length) return Promise.resolve(null)
  return new Promise(resolve => {
    let done = false
    const finish = (v: bigint | null): void => { if (!done) { done = true; resolve(v) } }
    try {
      const c = spawn(conv[0], [
        ...conv.slice(1),
        // [0] takes the first frame: an animated GIF or a multi-page TIFF would
        // otherwise emit one image per frame and the byte count would not match
        `${file}[0]`,
        '-colorspace', 'Gray', '-resize', '9x8!', '-depth', '8', 'gray:-',
      ], { stdio: ['ignore', 'pipe', 'ignore'] })
      const chunks: Buffer[] = []
      c.stdout.on('data', (d: Buffer) => chunks.push(d))
      const t = setTimeout(() => { try { c.kill('SIGKILL') } catch { /* gone */ } finish(null) }, 20_000)
      c.on('error', () => { clearTimeout(t); finish(null) })
      c.on('close', () => {
        clearTimeout(t)
        const buf = Buffer.concat(chunks)
        if (buf.length < 72) { finish(null); return }
        let bits = 0n
        for (let row = 0; row < 8; row++) {
          for (let col = 0; col < 8; col++) {
            const left = buf[row * 9 + col]
            const right = buf[row * 9 + col + 1]
            bits = (bits << 1n) | (left > right ? 1n : 0n)
          }
        }
        finish(bits)
      })
    } catch { finish(null) }
  })
}

/**
 * Hamming distance over the 64-bit hash.
 *
 * Split into two 32-bit halves and counted with the SWAR popcount rather than
 * shifting a BigInt one bit at a time: the all-pairs pass runs this millions of
 * times, and a BigInt loop makes it the slowest thing in the tool by an order
 * of magnitude.
 */
function popcount32(v: number): number {
  v = v - ((v >>> 1) & 0x55555555)
  v = (v & 0x33333333) + ((v >>> 2) & 0x33333333)
  return (((v + (v >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24
}

function hamming(a: { hi: number; lo: number }, b: { hi: number; lo: number }): number {
  return popcount32(a.hi ^ b.hi) + popcount32(a.lo ^ b.lo)
}

export async function findSimilar(root: string, threshold = 10, roots?: string[]): Promise<SimilarResult> {
  const runId = nextRunId++
  active = { runId, cancelled: false }
  const me = active
  const empty: SimilarResult = { ok: false, root, groups: [], scanned: 0, threshold }
  const bail = (r: SimilarResult): SimilarResult => {
    if (active === me) active = null
    say(runId, 'done', 0, 0)
    return r
  }
  if (!root?.startsWith('/')) return bail({ ...empty, error: 'Not a folder on this computer.' })
  if (!resolveTools().convert.length) {
    return bail({ ...empty, error: 'This needs ImageMagick, which is not installed.' })
  }

  say(runId, 'listing', 0, 0)
  const files: { path: string; size: number }[] = []
  await walkTree(roots?.length ? roots : [root], {
    onFile: (f) => {
      const ext = path.extname(f.name).replace(/^\./, '').toLowerCase()
      if (files.length < MAX_IMAGES && IMAGE_EXT.has(ext)) {
        files.push({ path: f.path, size: f.stat.size })
        if (files.length % 50 === 0) say(runId, 'listing', files.length, 0)
      }
    },
    maxDirs: 8000,
  })
  if (me.cancelled) return bail({ ...empty, ok: true, cancelled: true, scanned: 0 })

  // dimensions first, in chunks: they decide which copy is the keeper, and they are what the
  // dialog shows so a person can choose for themselves
  const dims = new Map<string, { w: number; h: number }>()
  for (let i = 0; i < files.length; i += IDENTIFY_CHUNK) {
    if (me.cancelled) return bail({ ...empty, ok: true, cancelled: true, scanned: 0 })
    const chunk = files.slice(i, i + IDENTIFY_CHUNK)
    const got = await identifyMany(chunk.map(f => f.path))
    for (const [k, v] of got) dims.set(k, v)
    say(runId, 'measuring', Math.min(i + IDENTIFY_CHUNK, files.length), files.length)
  }

  const hashes: { path: string; size: number; hash: { hi: number; lo: number } }[] = []
  for (let i = 0; i < files.length; i += LANES) {
    // Stop KEEPS its work. Throwing away 28 finished fingerprints because the 29th was not wanted
    // is the same insult as reporting "0 checked, no repeats found" for a run that did most of the
    // folder — you asked it to stop, not to forget.
    if (me.cancelled) break
    const slice = files.slice(i, i + LANES)
    const got = await Promise.all(slice.map(f => dhash(f.path)))
    slice.forEach((f, k) => {
      const h = got[k]
      if (h === null) return
      hashes.push({ ...f, hash: { hi: Number(h >> 32n) >>> 0, lo: Number(h & 0xffffffffn) >>> 0 } })
    })
    say(runId, 'hashing', Math.min(i + LANES, files.length), files.length, slice[slice.length - 1]?.path)
  }

  // Single-link grouping: anything within `threshold` of a member joins the
  // group. O(n²) on the hashes, which is fine for a folder and honest about
  // why this is a tool and not a background service.
  say(runId, 'comparing', 0, hashes.length)
  const taken = new Set<number>()
  const groups: SimilarGroup[] = []
  for (let i = 0; i < hashes.length; i++) {
    if ((i & 0x3f) === 0) say(runId, 'comparing', i, hashes.length)
    if (taken.has(i)) continue
    const members = [i]
    taken.add(i)
    for (let j = i + 1; j < hashes.length; j++) {
      if (taken.has(j)) continue
      if (members.some(m => hamming(hashes[m].hash, hashes[j].hash) <= threshold)) {
        members.push(j)
        taken.add(j)
      }
    }
    if (members.length < 2) continue
    // The keeper is the most PIXELS, not the most bytes — a re-saved PNG is regularly bigger on
    // disk and smaller in picture than the JPEG beside it, and recommending you throw away the
    // higher-resolution copy is the worst thing a de-duplicator can do.
    const withDims = members.map(m => {
      const d = dims.get(hashes[m].path)
      const w = d?.w ?? 0
      const h = d?.h ?? 0
      return { ...hashes[m], w, h, pixels: w * h }
    })
    const files2 = withDims.sort(keeperFirst)
    groups.push({
      files: files2.map(f => ({
        path: f.path,
        name: path.basename(f.path),
        size: f.size,
        width: f.w,
        height: f.h,
        pixels: f.pixels,
        distance: hamming(files2[0].hash, f.hash),
      })),
    })
  }
  groups.sort((a, b) => b.files.length - a.files.length)
  if (active === me) active = null
  say(runId, 'done', hashes.length, hashes.length)
  return {
    ok: true, root, groups, scanned: hashes.length, threshold,
    truncated: files.length >= MAX_IMAGES || undefined,
    cancelled: me.cancelled || undefined,
  }
}

ipcMain.handle(CH('findSimilar'), (_e, root: string, threshold?: number, roots?: string[]) =>
  findSimilar(root, Number.isFinite(threshold) ? Number(threshold) : 10, roots))

ipcMain.handle(CH('cancelSimilar'), () => {
  if (active) active.cancelled = true
  return { ok: true }
})
