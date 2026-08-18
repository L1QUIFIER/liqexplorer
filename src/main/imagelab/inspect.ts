// What a local picture actually is — measured, not assumed.
//
// Everything downstream is a comparison ("is that copy better than this one?"), and a comparison
// is only as good as its measurement of the file you already have. Two traps make that harder than
// it sounds, and both are documented failures rather than theory:
//
//   * `nativeImage` decodes PNG and JPEG ONLY, and returns an EMPTY image for anything else
//     instead of throwing. A WebP measured 0x0, a 0 area short-circuited the "is this big enough"
//     guard to accept, and the walk stopped before reaching the copies that had the real photo.
//     So dimensions come from ImageMagick, which reads everything this app can show.
//
//   * A FINGERPRINT IS ONLY VALID FOR THE PIPELINE THAT PRODUCED IT. imagelab/banned.ts carries a
//     hash computed by nativeImage → resize 32x32 `quality:'good'` → BGRA bitmap. Seeding the same
//     list from an ImageMagick RGBA dump of the identical file produced a hash NINE BITS away —
//     it would never have matched, and placeholder detection would have looked implemented while
//     catching nothing.
//
// Those two pull in opposite directions: the format we most need to measure is the one nativeImage
// cannot open, but the fingerprint has to go through nativeImage or it is worthless. The way out
// is to convert to PNG first and hand THAT to nativeImage — the pipeline is preserved, and
// ImageMagick is only ever a decoder, never the hasher.
import { nativeImage } from 'electron'
import { spawn } from 'node:child_process'
import * as fsp from 'node:fs/promises'
import * as path from 'node:path'
import { dHash, flatness, matchBanned, type BannedMatch } from './imghash'
import { BUILTIN_BANNED } from './banned'
import { webpSize } from './imgsize'
import { resolveTools } from '../platform/tools'

/** the fingerprint is taken at this size, matching the pipeline banned.ts was seeded with */
const FINGERPRINT_PX = 32

export interface ImageFacts {
  path: string
  name: string
  ext: string
  bytes: number
  width: number
  height: number
  /** pixels; 0 when the dimensions could not be read */
  area: number
  /** dHash, or '' when it could not be computed */
  fingerprint: string
  /** 0..1; low means a flat image, a weak second placeholder signal */
  flatness: number
  /** set when the picture matches a known placeholder */
  placeholder?: BannedMatch
  error?: string
}

function run(bin: string, args: string[], ms = 20_000): Promise<{ code: number; out: Buffer }> {
  return new Promise(resolve => {
    let done = false
    const finish = (code: number, out: Buffer): void => { if (!done) { done = true; resolve({ code, out }) } }
    try {
      const c = spawn(bin, args, { stdio: ['ignore', 'pipe', 'ignore'] })
      const chunks: Buffer[] = []
      c.stdout.on('data', (d: Buffer) => chunks.push(d))
      const t = setTimeout(() => { try { c.kill('SIGKILL') } catch { /* gone */ } finish(-1, Buffer.alloc(0)) }, ms)
      c.on('error', () => { clearTimeout(t); finish(-1, Buffer.alloc(0)) })
      c.on('close', code => { clearTimeout(t); finish(code ?? -1, Buffer.concat(chunks)) })
    } catch { finish(-1, Buffer.alloc(0)) }
  })
}

/**
 * Dimensions, from whichever source can actually read this format.
 *
 * The WebP header reader comes FIRST because it needs no process at all — it is a few bytes off
 * the front of the file — and WebP is the format this whole feature exists for.
 */
export async function measure(file: string, head?: Buffer): Promise<{ width: number; height: number }> {
  const bytes = head ?? await fsp.readFile(file).catch(() => null)
  if (bytes) {
    const w = webpSize(bytes)
    if (w) return { width: w.width, height: w.height }
    // nativeImage handles PNG/JPEG without spawning anything
    const img = nativeImage.createFromBuffer(bytes)
    if (!img.isEmpty()) {
      const s = img.getSize()
      if (s.width && s.height) return s
    }
  }
  const id = resolveTools().identify
  if (id.length) {
    const r = await run(id[0], [...id.slice(1), '-format', '%w %h', file + '[0]'])
    const m = /^(\d+)\s+(\d+)/.exec(r.out.toString('utf8').trim())
    if (m) return { width: Number(m[1]), height: Number(m[2]) }
  }
  return { width: 0, height: 0 }
}

/**
 * A 32x32 BGRA bitmap for fingerprinting, via nativeImage — always via nativeImage.
 *
 * Anything nativeImage cannot open is converted to PNG by ImageMagick first and then handed over,
 * so the hash is produced by the same pipeline that seeded the ban list. Converting and hashing
 * with ImageMagick directly would be simpler and would produce a hash that matches nothing.
 */
async function bitmapFor(file: string, bytes: Buffer | null): Promise<{ data: Buffer; width: number; height: number } | null> {
  let img = bytes ? nativeImage.createFromBuffer(bytes) : nativeImage.createEmpty()
  if (img.isEmpty()) {
    const conv = resolveTools().convert
    if (!conv.length) return null
    const r = await run(conv[0], [...conv.slice(1), file + '[0]', 'png:-'], 30_000)
    if (r.code !== 0 || !r.out.length) return null
    img = nativeImage.createFromBuffer(r.out)
    if (img.isEmpty()) return null
  }
  const small = img.resize({ width: FINGERPRINT_PX, height: FINGERPRINT_PX, quality: 'good' })
  const size = small.getSize()
  if (!size.width || !size.height) return null
  // Electron's own typings declare `getBitmap(): void`; it returns a Buffer at runtime. The cast
  // is the typings being wrong, not a shortcut — do not "fix" it by dropping the call.
  const data = small.getBitmap() as unknown as Buffer
  return { data, width: size.width, height: size.height }
}

/** Everything worth knowing about a picture before deciding whether to replace it. */
export async function inspectImage(file: string): Promise<ImageFacts> {
  const name = path.basename(file)
  const ext = path.extname(file).replace(/^\./, '').toLowerCase()
  const facts: ImageFacts = {
    path: file, name, ext, bytes: 0, width: 0, height: 0, area: 0, fingerprint: '', flatness: 1,
  }
  const st = await fsp.stat(file).catch(() => null)
  if (!st || !st.isFile()) return { ...facts, error: 'Not a file on this computer.' }
  facts.bytes = st.size

  const raw = await fsp.readFile(file).catch(() => null)
  const dims = await measure(file, raw ?? undefined)
  facts.width = dims.width
  facts.height = dims.height
  facts.area = dims.width * dims.height

  const bmp = await bitmapFor(file, raw)
  if (bmp) {
    // Electron's getBitmap() is BGRA on every platform this runs on. Getting the order wrong does
    // not throw — it produces a stable hash that matches nothing, which is the worst kind of bug
    // in a matcher.
    const img = { data: bmp.data, width: bmp.width, height: bmp.height, order: 'bgra' as const }
    facts.fingerprint = dHash(img)
    facts.flatness = flatness(img)
    const hit = matchBanned(facts.fingerprint, BUILTIN_BANNED)
    if (hit) facts.placeholder = hit
  }
  return facts
}

/**
 * Is this picture a plausible candidate for upgrading?
 *
 * Deliberately generous — this only decides whether to OFFER a search, and a wrong "no" here is
 * invisible to the user while a wrong "yes" costs one wasted look. WebP is called out because it
 * is nearly always a derived copy of something else, which is the observation the feature started
 * from.
 */
export function worthUpgrading(f: ImageFacts): { worth: boolean; why: string } {
  if (f.error || !f.area) return { worth: false, why: 'This picture could not be measured.' }
  if (f.placeholder) return { worth: true, why: `This is a known placeholder (${f.placeholder.label}).` }
  if (f.ext === 'webp') return { worth: true, why: 'WebP is nearly always a converted copy of another picture.' }
  if (f.area < 640 * 480) return { worth: true, why: 'Small enough that a larger copy probably exists.' }
  return { worth: false, why: 'Already a reasonable size, and not a derived format.' }
}
