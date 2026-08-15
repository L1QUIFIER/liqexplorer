// Crop / rotate / straighten / resize, applied by ImageMagick in the main
// process rather than by a canvas in the renderer.
//
// WHY NOT CANVAS. A canvas round-trip forces everything through 8-bit sRGB and
// destroys EXIF and ICC — including the xmp:Rating this app's own ratings code
// reads back. It also means pulling the whole file through liqfile:// and
// holding a decoded RGBA bitmap in the renderer: the 10000x5622 wallpaper on
// this machine is 225 MB decoded, per open. ImageMagick streams it in a
// killable child instead, and convert.ts already owns the spawn, timeout,
// thread-limit and never-overwrite idioms this needs.
//
// The renderer never reads a pixel. Its crop box is a DOM overlay over an
// <img>, so the canvas-tainting question never arises either.
//
// OP ORDER IS FIXED and the UI depends on it:
//   auto-orient -> straighten -> rotate/flip -> crop -> resize -> encode
// Straighten before crop is why the preview must show the straightening applied
// before the box is committed: the crop box the user drew is a trim of the
// straightened image, not of the original.
import { spawn, type ChildProcess } from 'node:child_process'
import * as fsp from 'node:fs/promises'
import * as path from 'node:path'
import { resolveTools } from '../platform/tools'
import { ipcMain } from 'electron'
import { CH } from '../../shared/ipc'
import * as history from '../state/history'


const TIMEOUT_MS = 120_000

export interface EditRecipe {
  /** bake EXIF orientation into pixels first; almost always wanted */
  autoOrient: boolean
  /** degrees, -15..15; expands the canvas rather than trimming */
  straighten?: number
  rotate?: 0 | 90 | 180 | 270
  flip?: 'h' | 'v' | 'hv'
  /** fractions of the post-straighten image, 0..1 — NOT pixels. A box drawn on
   *  a 1600px preview then applies exactly to the full-resolution original. */
  crop?: { x: number; y: number; w: number; h: number }
  resize?: { mode: 'long' | 'wh' | 'pct'; long?: number; w?: number; h?: number; pct?: number; allowEnlarge: boolean }
  quality?: number
  /** default FALSE: dropping EXIF silently loses the date a photo was taken */
  strip?: boolean
}

export type EditDest =
  | { mode: 'copy' }
  | { mode: 'folder'; dir: string }
  | { mode: 'replace' }

export interface EditRequest { path: string; recipe: EditRecipe; dest: EditDest }
export interface EditResult { ok: boolean; out?: string; error?: string }

interface Tools { convert: string[]; identify: string[] }
let toolsPromise: Promise<Tools> | null = null

async function tools(): Promise<Tools> {
  if (!toolsPromise) {
    toolsPromise = (async () => {
      // IM7 ships `magick`; this machine has IM6, where the binary is `convert`
      // one shared answer; falling back to a bare 'convert' without checking it
      // exists meant a machine with neither failed inside the edit rather than
      // saying so up front
      const t = resolveTools()
      return { convert: t.convert, identify: t.identify }
    })()
  }
  return toolsPromise
}

function run(bin: string, args: string[]): Promise<{ code: number | null; stderr: string }> {
  return new Promise(resolve => {
    let child: ChildProcess
    try {
      child = spawn(bin, args, {
        stdio: ['ignore', 'ignore', 'pipe'],
        // ImageMagick's OpenMP otherwise takes every core for one image
        env: { ...process.env, MAGICK_THREAD_LIMIT: '1', OMP_NUM_THREADS: '1' },
      })
    } catch (e) { resolve({ code: -1, stderr: String((e as Error)?.message ?? e) }); return }
    let stderr = ''
    child.stderr?.on('data', (d: Buffer) => { if (stderr.length < 8192) stderr += d.toString() })
    const timer = setTimeout(() => child.kill('SIGKILL'), TIMEOUT_MS)
    child.on('error', e => { clearTimeout(timer); resolve({ code: -1, stderr: String(e) }) })
    child.on('close', code => { clearTimeout(timer); resolve({ code, stderr }) })
  })
}

/** pixel size of the source, needed to turn crop fractions into pixels */
async function dimensions(t: Tools, file: string): Promise<{ w: number; h: number } | null> {
  const out = await new Promise<string>(resolve => {
    let c: ChildProcess
    try {
      c = spawn(t.identify[0], [...t.identify.slice(1), '-format', '%w %h', `${file}[0]`],
        { stdio: ['ignore', 'pipe', 'ignore'] })
    } catch { resolve(''); return }
    let s = ''
    c.stdout?.on('data', (d: Buffer) => { s += d.toString() })
    c.on('error', () => resolve(''))
    c.on('close', () => resolve(s.trim()))
  })
  const m = /^(\d+)\s+(\d+)/.exec(out)
  return m ? { w: Number(m[1]), h: Number(m[2]) } : null
}

/** never overwrite: "photo.jpg" -> "photo (edited).jpg" -> "photo (edited 2).jpg" */
async function freeName(dir: string, srcPath: string, suffix: string): Promise<string> {
  const base = path.basename(srcPath)
  const dot = base.lastIndexOf('.')
  const stem = dot > 0 ? base.slice(0, dot) : base
  const ext = dot > 0 ? base.slice(dot) : ''
  for (let i = 1; i < 1000; i++) {
    const name = i === 1 ? `${stem} (${suffix})${ext}` : `${stem} (${suffix} ${i})${ext}`
    const p = path.join(dir, name)
    // lstat, not access: a dangling symlink still occupies the name
    if (!await fsp.lstat(p).then(() => true, () => false)) return p
  }
  throw new Error('too many files with this name')
}

/**
 * Build the argument list. The order here IS the op order documented at the top
 * of this file, and changing it changes what the user gets.
 */
function buildArgs(src: string, out: string, r: EditRecipe, dim: { w: number; h: number }): string[] {
  const a: string[] = [`${src}[0]`]        // [0] — a multi-frame GIF/TIFF would otherwise write N outputs

  if (r.autoOrient !== false) a.push('-auto-orient')

  if (r.straighten && Math.abs(r.straighten) > 0.05) {
    // -background none keeps the corners transparent where the rotation
    // expands the canvas; the user's crop box is what trims them off
    a.push('-background', 'none', '-rotate', String(r.straighten))
  }
  if (r.rotate) a.push('-rotate', String(r.rotate))
  if (r.flip === 'h' || r.flip === 'hv') a.push('-flop')
  if (r.flip === 'v' || r.flip === 'hv') a.push('-flip')

  if (r.crop) {
    const w = Math.max(1, Math.round(r.crop.w * dim.w))
    const h = Math.max(1, Math.round(r.crop.h * dim.h))
    const x = Math.max(0, Math.round(r.crop.x * dim.w))
    const y = Math.max(0, Math.round(r.crop.y * dim.h))
    // +repage is NOT optional: without it the output carries a page offset and
    // other tools honour it, so the crop appears to have moved the image
    a.push('-crop', `${w}x${h}+${x}+${y}`, '+repage')
  }

  if (r.resize) {
    const z = r.resize
    const spec = z.mode === 'long' ? `${z.long}x${z.long}`
      : z.mode === 'pct' ? `${z.pct}%`
        : `${z.w ?? ''}x${z.h ?? ''}`
    // '>' means "only shrink"; without it a resize silently upscales
    a.push('-resize', z.allowEnlarge ? spec : `${spec}>`)
  }

  if (r.quality) a.push('-quality', String(r.quality))
  if (r.strip) a.push('-strip')
  a.push(out)
  return a
}

/** ImageMagick 6 exits 0 while writing the wrong format (see convert.ts) — so
 *  a successful exit code is checked against the file that actually appeared. */
async function wroteSomething(file: string): Promise<boolean> {
  const st = await fsp.stat(file).catch(() => null)
  return !!st && st.isFile() && st.size > 0
}

export async function applyEdit(req: EditRequest): Promise<EditResult> {
  const { path: src, recipe, dest } = req
  if (!src.startsWith('/')) return { ok: false, error: 'Not a file on this computer.' }
  const t = await tools()
  const dim = await dimensions(t, src)
  if (!dim) return { ok: false, error: 'That picture could not be read.' }

  const dir = dest.mode === 'folder' ? dest.dir : path.dirname(src)
  // Replace never writes over the original directly: render to a temp beside it
  // (same filesystem, so the rename is atomic), verify, THEN swap. A crash or a
  // failed encode can therefore never leave a half-written original.
  const finalOut = dest.mode === 'replace' ? src : await freeName(dir, src, 'edited')
  const tmp = dest.mode === 'replace'
    ? path.join(dir, `.liqedit-${process.pid}-${Date.now()}${path.extname(src)}`)
    : finalOut

  const args = buildArgs(src, tmp, recipe, dim)
  const res = await run(t.convert[0], [...t.convert.slice(1), ...args])
  if (res.code !== 0 || !await wroteSomething(tmp)) {
    await fsp.rm(tmp, { force: true }).catch(() => {})
    return { ok: false, error: res.stderr.split('\n')[0] || 'The edit could not be applied.' }
  }

  if (dest.mode === 'replace') {
    // trash the original first so it is recoverable, then move the new file
    // into its name. Never rm an original.
    // gio trash, the same call the file engine uses — recoverable from the
    // desktop's Recycle Bin like any other delete
    const gio = await run('gio', ['trash', '--', src])
    if (gio.code !== 0) {
      await fsp.rm(tmp, { force: true }).catch(() => {})
      return { ok: false, error: 'The original could not be moved to the Recycle Bin, so nothing was changed.' }
    }
    try { await fsp.rename(tmp, src) } catch (e) {
      await fsp.rm(tmp, { force: true }).catch(() => {})
      return { ok: false, error: `The edited picture could not replace the original: ${String(e)}` }
    }
  }

  history.record({
    kind: 'edit',
    count: 1,
    sources: [src],
    dest: finalOut,
    status: 'done',
  })
  return { ok: true, out: finalOut }
}

ipcMain.handle(CH('applyEdit'), (_e, req: EditRequest) => applyEdit(req))
