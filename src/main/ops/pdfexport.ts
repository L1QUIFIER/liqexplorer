// Exporting a PDF as pictures.
//
// Self-registered IPC, like the rest of ops/: main/ipc.ts and preload.ts are
// untouched.
//
//     pdfExportFormats()            -> PdfExportFormat[]  (capability-checked)
//     pdfExport(PdfExportRequest)   -> runId, progress on PDF_EXPORT_PROGRESS
//     pdfExportCancel(runId)
//
// THREE THINGS DECIDE THE QUALITY OF THE RESULT, and getting any of them wrong
// produces files that look fine in a list and disappoint when opened.
//
// 1. VECTOR OUT, WHERE THE FORMAT ALLOWS IT. A PDF is drawing instructions, not
//    pixels. Asked for SVG or EPS, poppler writes the instructions straight
//    through and the result stays sharp at any size; rasterising first would
//    discard exactly the thing that made the request worth making. Those
//    formats therefore never touch the raster path and ignore DPI.
//
// 2. RENDER ONCE, AT THE REQUESTED RESOLUTION. pdftocairo writes PNG, JPEG and
//    TIFF itself, so for those there is one render and no re-encode. Everything
//    else is rendered to PNG at the same DPI and handed to ImageMagick — one
//    decode, one encode, no intermediate JPEG to soften the text.
//
// 3. WHITE, NOT NOTHING. A PDF page has no background. Exported to PNG the
//    result is transparent, which reads as a blank or black page wherever
//    transparency is not composited — the single most likely way this feature
//    would be reported as broken. Pages are painted white unless transparency
//    is asked for.
//
// The offered format list is CHECKED, not declared. ops/convert.ts already
// learned that this machine's ImageMagick claims formats it cannot write and
// exits 0 while writing a mislabelled file; its probe is reused here rather
// than repeating the mistake in a second place.
import { ipcMain, type IpcMainInvokeEvent, type WebContents } from 'electron'
import { spawn, type ChildProcess } from 'node:child_process'
import * as fsp from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { CH } from '../../shared/ipc'
import {
  PDF_EXPORT_PROGRESS,
  type PdfExportFormat, type PdfExportProgress, type PdfExportRequest,
} from '../../shared/pdfexport'
import { convertFormats } from './convert'

/** a page render that takes longer than this is a document we cannot help with */
const PAGE_TIMEOUT_MS = 120_000
/** outputs reported over the wire; `written` carries the true count */
const MAX_REPORTED = 200
/** refuse absurd requests rather than fill the disk */
const MAX_PAGES = 2000

interface Run {
  id: number
  cancelled: boolean
  children: Set<ChildProcess>
}
const runs = new Map<number, Run>()
let nextRunId = 1

interface Ran { ok: boolean; stderr: string }

function run(r: Run, bin: string, args: string[], timeout: number): Promise<Ran> {
  return new Promise(resolve => {
    let done = false
    const finish = (ok: boolean, stderr: string): void => {
      if (done) return
      done = true
      resolve({ ok, stderr })
    }
    let c: ChildProcess
    try {
      // ImageMagick's OpenMP otherwise takes every core PER PROCESS; ops/convert.ts
      // measured 4.6x less machine used for the same work with this set
      c = spawn(bin, args, { stdio: ['ignore', 'ignore', 'pipe'], env: { ...process.env, MAGICK_THREAD_LIMIT: '1' } })
    } catch (e) { finish(false, String((e as Error)?.message ?? e)); return }
    r.children.add(c)
    let err = ''
    c.stderr?.on('data', d => { err = (err + String(d)).slice(-2000) })
    const t = setTimeout(() => { try { c.kill('SIGKILL') } catch { /* gone */ } finish(false, 'It took too long and was stopped.') }, timeout)
    c.on('error', e => { clearTimeout(t); r.children.delete(c); finish(false, String((e as Error)?.message ?? e)) })
    c.on('close', code => {
      clearTimeout(t)
      r.children.delete(c)
      finish(code === 0, err)
    })
  })
}

/** never overwrite: "page 1.png" -> "page 1 (2).png". Same rule as ops/quick.ts. */
async function freeName(dir: string, stem: string, ext: string): Promise<string> {
  for (let i = 1; i < 10_000; i++) {
    const name = i === 1 ? `${stem}.${ext}` : `${stem} (${i}).${ext}`
    const p = path.join(dir, name)
    try { await fsp.stat(p) } catch { return p }
  }
  return path.join(dir, `${stem} (${Date.now()}).${ext}`)
}

// ------------------------------------------------------------------ formats

/** what poppler writes directly, with no second encode */
const POPPLER_RASTER = new Set(['png', 'jpg', 'jpeg', 'tif', 'tiff'])
const POPPLER_VECTOR: PdfExportFormat[] = [
  { id: 'svg', label: 'SVG (stays sharp at any size)', backend: 'poppler', vector: true, lossy: false, multipage: false },
  { id: 'eps', label: 'EPS (for print work)', backend: 'poppler', vector: true, lossy: false, multipage: false },
  { id: 'ps', label: 'PostScript', backend: 'poppler', vector: true, lossy: false, multipage: true },
]

let formatsCache: PdfExportFormat[] | null = null

/**
 * The formats this machine can actually produce.
 *
 * Built from ops/convert.ts's probe — which round-trips a real image through
 * every candidate encoder and asks `identify` what came out — so a format that
 * ImageMagick claims and then silently fakes never reaches the menu. Poppler's
 * own outputs are added on top, and the three it writes directly are marked as
 * such so the export can skip the re-encode.
 */
export async function pdfExportFormats(): Promise<PdfExportFormat[]> {
  if (formatsCache) return formatsCache
  const probed = await convertFormats().catch(() => [])
  const raster: PdfExportFormat[] = probed.map(f => ({
    id: f.id,
    label: f.label,
    backend: POPPLER_RASTER.has(f.id) ? 'poppler' : f.backend,
    vector: false,
    lossy: f.lossy,
    // TIFF is the only raster format here that holds many pages in one file
    multipage: f.id === 'tif' || f.id === 'tiff',
  }))
  formatsCache = [...raster, ...POPPLER_VECTOR]
  return formatsCache
}

// ------------------------------------------------------------------ export

function send(wc: WebContents, p: PdfExportProgress): void {
  if (!wc.isDestroyed()) wc.send(PDF_EXPORT_PROGRESS, p)
}

async function pageCount(src: string): Promise<number> {
  const r = await new Promise<string>(resolve => {
    let out = ''
    try {
      const c = spawn('pdfinfo', ['--', src], { stdio: ['ignore', 'pipe', 'ignore'] })
      c.stdout.on('data', d => { out += String(d) })
      const t = setTimeout(() => { try { c.kill('SIGKILL') } catch { /* gone */ } resolve('') }, 20_000)
      c.on('error', () => { clearTimeout(t); resolve('') })
      c.on('close', () => { clearTimeout(t); resolve(out) })
    } catch { resolve('') }
  })
  return Number(/^Pages:\s+(\d+)$/m.exec(r)?.[1] ?? 0) || 0
}

/** poppler's flag for a format it writes itself */
function popplerFlag(format: string): string | null {
  switch (format) {
    case 'png': return '-png'
    case 'jpg': case 'jpeg': return '-jpeg'
    case 'tif': case 'tiff': return '-tiff'
    case 'svg': return '-svg'
    case 'eps': return '-eps'
    case 'ps': return '-ps'
    default: return null
  }
}

async function execute(wc: WebContents, r: Run, req: PdfExportRequest): Promise<void> {
  const emit = (p: Partial<PdfExportProgress>): void =>
    send(wc, {
      runId: r.id, status: 'running', done: 0, total: 0, current: '',
      outputs: [], written: 0, ...p,
    })

  const fail = (error: string): void =>
    emit({ status: 'error', error })

  if (!req.src?.startsWith('/') || !req.dest?.startsWith('/')) { fail('That is not a file on this computer.'); return }
  const formats = await pdfExportFormats()
  const fmt = formats.find(f => f.id === req.format)
  if (!fmt) { fail('This computer cannot write that format.'); return }

  const total = await pageCount(req.src)
  if (!total) { fail('That PDF could not be read.'); return }
  const from = Math.max(1, Math.min(req.from ?? 1, total))
  const to = Math.max(from, Math.min(req.to ?? total, total))
  const count = to - from + 1
  if (count > MAX_PAGES) { fail(`That is ${count} pages; export at most ${MAX_PAGES} at a time.`); return }

  const dpi = Math.max(24, Math.min(1200, Math.round(req.dpi || 150)))
  const stem = path.basename(req.src).replace(/\.pdf$/i, '')
  try { await fsp.mkdir(req.dest, { recursive: true }) } catch (e) { fail(String((e as Error)?.message ?? e)); return }

  const scratch = await fsp.mkdtemp(path.join(os.tmpdir(), 'liq-pdfexport-'))
  const outputs: string[] = []
  let written = 0

  try {
    emit({ total: count, current: 'Rendering…' })

    // ---- step 1: poppler renders the pages ----
    const direct = popplerFlag(req.format)
    // when poppler cannot write the target, render PNG and re-encode from that:
    // one decode, one encode, and no intermediate JPEG to soften the text
    const renderFlag = direct ?? '-png'
    const renderExt = direct
      ? (req.format === 'jpeg' ? 'jpg' : req.format === 'tiff' ? 'tif' : req.format)
      : 'png'

    const args = [renderFlag]
    if (!fmt.vector) {
      args.push('-r', String(dpi))
      // pdftocairo paints raster output on WHITE by default and `-transp` is
      // the opt-out — which is the behaviour this feature wants, so the flag
      // only appears when transparency was asked for. (`-nocrop` was tried
      // here first and is rejected outright: poppler accepts it for -ps/-eps
      // only, and the export failed with a message about page cropping that
      // had nothing to do with backgrounds.)
      if (req.transparent) args.push('-transp')
    }
    if (fmt.vector) {
      // poppler writes one vector file per invocation, so the page range is a loop
    } else {
      args.push('-f', String(from), '-l', String(to))
    }

    if (fmt.vector) {
      for (let n = from; n <= to; n++) {
        if (r.cancelled) { emit({ status: 'cancelled', done: written, total: count, written, outputs }); return }
        const out = path.join(scratch, `pg-${String(n).padStart(5, '0')}.${renderExt}`)
        const rr = await run(r, 'pdftocairo', [renderFlag, '-f', String(n), '-l', String(n), '--', req.src, out], PAGE_TIMEOUT_MS)
        if (!rr.ok && !await fsp.stat(out).then(s => s.size > 0, () => false)) {
          fail(rr.stderr.split('\n')[0] || 'That page could not be exported.'); return
        }
        emit({ done: n - from + 1, total: count, current: `Page ${n}`, written, outputs })
      }
    } else {
      const rr = await run(r, 'pdftocairo', [...args, '--', req.src, path.join(scratch, 'pg')], PAGE_TIMEOUT_MS * 4)
      const made = await fsp.readdir(scratch).catch(() => [] as string[])
      if (!made.length) { fail(rr.stderr.split('\n')[0] || 'The pages could not be rendered.'); return }
    }
    if (r.cancelled) { emit({ status: 'cancelled', done: written, total: count, written, outputs }); return }

    // ---- step 2: name them, re-encode if poppler could not write the format ----
    const made = (await fsp.readdir(scratch).catch(() => [] as string[]))
      .filter(n => !n.startsWith('.'))
      .sort()
    if (!made.length) { fail('Nothing was produced.'); return }

    // one tall image of every page, for sharing a document as a single picture
    if (req.combine && !fmt.vector) {
      emit({ done: 0, total: 1, current: 'Joining the pages…', written, outputs })
      const out = await freeName(req.dest, `${stem} (all pages)`, req.format)
      const cargs = made.map(n => path.join(scratch, n))
      const rr = await run(r, 'convert', [
        // `-alpha remove`, NOT `-flatten`. Flatten composites the sequence onto
        // the FIRST image's canvas, so after -append it crops the tall result
        // back to the height of page one — measured: five A4 pages came out
        // 1654x2339 instead of 1654x11695. alpha-remove paints the background
        // without touching geometry.
        '-background', req.transparent ? 'none' : 'white',
        ...cargs,
        ...(req.transparent ? [] : ['-alpha', 'remove', '-alpha', 'off']),
        '-append',
        ...(fmt.lossy && req.quality ? ['-quality', String(Math.max(1, Math.min(100, req.quality)))] : []),
        out,
      ], PAGE_TIMEOUT_MS * 4)
      if (!rr.ok) { fail(rr.stderr.split('\n')[0] || 'The pages could not be joined.'); return }
      outputs.push(out)
      emit({ status: 'done', done: 1, total: 1, current: path.basename(out), written: 1, outputs })
      return
    }

    const pad = String(to).length
    let i = 0
    for (const name of made) {
      if (r.cancelled) { emit({ status: 'cancelled', done: written, total: count, written, outputs }); return }
      const m = /-?(\d+)\.[a-z]+$/i.exec(name)
      const page = m ? Number(m[1]) : from + i
      const src = path.join(scratch, name)
      const label = count === 1 ? stem : `${stem} page ${String(page).padStart(pad, '0')}`
      const out = await freeName(req.dest, label, req.format)

      if (direct) {
        // poppler already wrote this format; a move is the whole job
        try { await fsp.rename(src, out) } catch {
          await fsp.copyFile(src, out).catch(() => { /* reported below */ })
          await fsp.unlink(src).catch(() => { /* temp */ })
        }
      } else {
        const rr = await run(r, 'convert', [
          `${src}[0]`,
          // same reason as the combine path: alpha-remove keeps the page size
          ...(req.transparent ? [] : ['-background', 'white', '-alpha', 'remove', '-alpha', 'off']),
          ...(fmt.lossy && req.quality ? ['-quality', String(Math.max(1, Math.min(100, req.quality)))] : []),
          out,
        ], PAGE_TIMEOUT_MS)
        if (!rr.ok) { fail(rr.stderr.split('\n')[0] || `Page ${page} could not be written.`); return }
      }
      if (await fsp.stat(out).then(s => s.size > 0, () => false)) {
        written++
        if (outputs.length < MAX_REPORTED) outputs.push(out)
      }
      i++
      emit({ done: i, total: count, current: path.basename(out), written, outputs })
    }
    emit({ status: 'done', done: count, total: count, current: '', written, outputs })
  } finally {
    await fsp.rm(scratch, { recursive: true, force: true }).catch(() => { /* temp */ })
  }
}

export async function pdfExport(wc: WebContents, req: PdfExportRequest): Promise<number> {
  const runId = nextRunId++
  const r: Run = { id: runId, cancelled: false, children: new Set() }
  runs.set(runId, r)
  void execute(wc, r, req)
    .catch(e => send(wc, {
      runId, status: 'error', done: 0, total: 0, current: '', outputs: [], written: 0,
      error: String((e as Error)?.message ?? e),
    }))
    .finally(() => runs.delete(runId))
  return runId
}

export function pdfExportCancel(runId: number): void {
  const r = runs.get(runId)
  if (!r) return
  r.cancelled = true
  for (const c of r.children) { try { c.kill('SIGKILL') } catch { /* already gone */ } }
}

ipcMain.handle(CH('pdfExportFormats'), () => pdfExportFormats())
ipcMain.handle(CH('pdfExport'), (e: IpcMainInvokeEvent, req: PdfExportRequest) => pdfExport(e.sender, req))
ipcMain.handle(CH('pdfExportCancel'), (_e, runId: number) => pdfExportCancel(Number(runId)))
ipcMain.handle(CH('pdfPageCount'), (_e, src: string) => pageCount(String(src)))
