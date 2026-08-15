// PDF page operations for the Doc tab: page thumbnails, and delete / reorder /
// extract / merge — poppler in killable child processes, following the
// destination model, temp->verify->rename discipline and history row that
// ops/imageedit.ts established.
//
// WHAT IS AND IS NOT POSSIBLE HERE, and why:
//
//   * There is no qpdf on this machine. qpdf is the tool that edits a PDF's
//     page tree in place — with it, rotating a page is a metadata change.
//     Without it the only lossless-ish route is pdfseparate + pdfunite, which
//     copies page content but rebuilds the document: the outline, form fields,
//     cross-page annotations and any encryption do not survive. That cost is
//     stated in the UI before a write (shared/doc.ts PDF_REBUILD_WARNING).
//   * Rotation is therefore NOT offered. Ghostscript could do it, but only by
//     re-interpreting and re-emitting every page — recompressing images and
//     subsetting fonts across a document the user asked to turn one page of.
//     A disabled control that says "Install qpdf to rotate pages" is honest;
//     silently degrading the whole file is not.
//   * Encrypted PDFs are refused outright. pdfinfo reports Encrypted: yes for
//     an owner-password file and exits non-zero on a user-password one; both
//     are refused, and there is no password prompt in v1.
//
// Thumbnails are REAL FILES in ~/.cache/liqexplorer/pdfpages/<key>/, served to
// the renderer through the existing liqfile:// protocol — no base64 across the
// bridge and no new scheme. The key is path|mtime|size, so an edited document
// can never show its old pages.
import { app, dialog, ipcMain, BrowserWindow, type IpcMainInvokeEvent } from 'electron'
import { spawn } from 'node:child_process'
import * as fs from 'node:fs'
import * as fsp from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { createHash } from 'node:crypto'
import { CH } from '../../shared/ipc'
import { previewURL } from '../../shared/preview'
import {
  DOC, type DocDest, type PdfInfo, type PdfMergeRequest, type PdfPagesRequest,
  type PdfResult, type PdfThumb, type PdfThumbs,
} from '../../shared/doc'
import { TEST_PROFILE, TEST_ROOT } from '../state/settings'
import * as history from '../state/history'

// ---------------------------------------------------------------- child procs

interface Run { code: number | null; stdout: string; stderr: string; timedOut: boolean }

/** Spawn, capture, and SIGKILL on the deadline. A dead CIFS mount can wedge any
 *  of these tools indefinitely, so nothing here is ever started without one. */
function run(bin: string, args: string[], timeoutMs: number = DOC.childTimeoutMs): Promise<Run> {
  return new Promise(resolve => {
    let child
    try {
      child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (e) {
      resolve({ code: -1, stdout: '', stderr: String((e as Error)?.message ?? e), timedOut: false })
      return
    }
    let stdout = ''
    let stderr = ''
    let done = false
    let timedOut = false
    const finish = (code: number | null) => {
      if (done) return
      done = true
      clearTimeout(timer)
      resolve({ code, stdout, stderr, timedOut })
    }
    const timer = setTimeout(() => {
      timedOut = true
      try { child.kill('SIGKILL') } catch { /* already gone */ }
      finish(-1)
    }, timeoutMs)
    child.stdout?.on('data', (d: Buffer) => { if (stdout.length < 1 << 20) stdout += d.toString() })
    child.stderr?.on('data', (d: Buffer) => { if (stderr.length < 8192) stderr += d.toString() })
    child.on('error', e => { stderr += String(e); finish(-1) })
    child.on('close', code => finish(code))
  })
}

let qpdfPromise: Promise<boolean> | null = null
/** qpdf is what rotation would need. Checked once, not assumed either way:
 *  this is exactly the sort of thing that gets installed later. */
function hasQpdf(): Promise<boolean> {
  if (!qpdfPromise) {
    qpdfPromise = new Promise<boolean>(resolve => {
      try {
        const c = spawn('qpdf', ['--version'], { stdio: 'ignore' })
        c.on('error', () => resolve(false))
        c.on('close', code => resolve(code === 0))
      } catch { resolve(false) }
    })
  }
  return qpdfPromise
}

/** stat() on a dead CIFS mount blocks forever (see platform/protocols.ts). */
function statDeadline(p: string, ms = 5000): Promise<fs.Stats | null> {
  return new Promise(resolve => {
    let settled = false
    const done = (v: fs.Stats | null) => { if (!settled) { settled = true; resolve(v) } }
    fsp.stat(p).then(done, () => done(null))
    setTimeout(() => done(null), ms).unref?.()
  })
}

/** ImageMagick 6 exits 0 while writing the wrong thing (ops/convert.ts explains
 *  the original case); poppler is better behaved but the rule stands — the
 *  output file is the evidence, not the exit code. */
async function wroteSomething(file: string): Promise<boolean> {
  const st = await fsp.stat(file).catch(() => null)
  return !!st && st.isFile() && st.size > 0
}

// ---------------------------------------------------------------- info

function field(out: string, key: string): string | undefined {
  const m = new RegExp(`^${key}:\\s*(.+)$`, 'mi').exec(out)
  return m ? m[1].trim() : undefined
}

export async function pdfDocInfo(p: string): Promise<PdfInfo> {
  const base: PdfInfo = { ok: false, pages: 0, encrypted: false, needsPassword: false, canRotate: false }
  if (!p || !p.startsWith('/')) return { ...base, error: 'Not a file on this computer.' }
  const canRotate = await hasQpdf()
  const r = await run('pdfinfo', ['-enc', 'UTF-8', '--', p], 15_000)
  if (r.timedOut) return { ...base, canRotate, error: 'This PDF did not answer in time — the drive it is on may be disconnected.' }
  if (r.code !== 0) {
    // poppler says "Incorrect password" when a user password is required; there
    // is no password prompt in v1, so this is as far as it goes
    const pw = /password/i.test(r.stderr + r.stdout)
    return {
      ...base, canRotate, needsPassword: pw,
      error: pw
        ? 'This PDF needs a password to open. Page editing is not available for it.'
        : (r.stderr.split('\n')[0] || 'This PDF could not be read.'),
    }
  }
  const pages = Number(field(r.stdout, 'Pages') ?? 0)
  const encRaw = field(r.stdout, 'Encrypted') ?? 'no'
  return {
    ok: pages > 0,
    pages,
    // "yes (print:no copy:no ...)" — anything but a bare "no" is encryption
    encrypted: !/^no\b/i.test(encRaw),
    needsPassword: false,
    title: field(r.stdout, 'Title'),
    producer: field(r.stdout, 'Producer'),
    pageSize: field(r.stdout, 'Page size'),
    version: field(r.stdout, 'PDF version'),
    fileSize: Number(/^File size:\s*(\d+)/mi.exec(r.stdout)?.[1] ?? 0) || undefined,
    canRotate,
    error: pages > 0 ? undefined : 'This PDF reports no pages.',
  }
}

// ---------------------------------------------------------------- thumbnails

function cacheRoot(): string {
  // a test profile must not write into (or wipe) the real user's cache
  if (TEST_PROFILE) return path.join(TEST_ROOT, 'cache/liqexplorer')
  return path.join(process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache'), 'liqexplorer')
}

function pagesRoot(): string { return path.join(cacheRoot(), 'pdfpages') }

/** path|mtime|size: an edited document gets a different key, so a stale page
 *  can never be shown for it. */
function cacheKey(p: string, st: fs.Stats): string {
  return createHash('sha1').update(`${p}|${st.mtimeMs}|${st.size}`).digest('hex')
}

/** dirs created this session, removed on quit */
const sessionDirs = new Set<string>()

// bounded: pdftoppm is CPU-heavy and a fast scroll through a 900-page document
// would otherwise fork one per window
let jobs = 0
const jobQueue: (() => void)[] = []
function slot(): Promise<void> {
  if (jobs < DOC.thumbJobs) { jobs++; return Promise.resolve() }
  return new Promise(res => jobQueue.push(() => { jobs++; res() }))
}
function freeSlot(): void {
  jobs--
  // LIFO: while scrolling, the newest request is the strip actually on screen
  jobQueue.pop()?.()
}

function pageFile(dir: string, n: number): string {
  return path.join(dir, `p-${n}.jpg`)
}

/**
 * Render pages [from..to] that are not already cached.
 *
 * pdftoppm names its output pg-<n>.jpg with the number zero-padded to the
 * document's page-count width (pg-7.jpg in a 9-page file, pg-007.jpg in a
 * 900-page one), so the files are rendered into a scratch directory and mapped
 * back by the number in the name rather than by guessing the padding.
 */
async function renderWindow(src: string, dir: string, from: number, to: number): Promise<void> {
  await slot()
  const scratch = await fsp.mkdtemp(path.join(dir, '.render-'))
  try {
    const r = await run('pdftoppm', [
      '-jpeg', '-r', String(DOC.thumbDpi), '-f', String(from), '-l', String(to), '--', src, path.join(scratch, 'pg'),
    ], 30_000)
    // the exit code is not the evidence: read back what actually appeared
    const made = await fsp.readdir(scratch).catch(() => [] as string[])
    if (!made.length) {
      throw new Error(r.stderr.split('\n')[0] || 'The pages could not be rendered.')
    }
    for (const f of made) {
      const m = /-(\d+)\.jpe?g$/i.exec(f)
      if (!m) continue
      const n = Number(m[1])
      if (n < from || n > to) continue
      const full = path.join(scratch, f)
      const st = await fsp.stat(full).catch(() => null)
      if (!st || st.size === 0) continue
      // same directory, so this is an atomic swap into place
      await fsp.rename(full, pageFile(dir, n)).catch(() => {})
    }
  } finally {
    await fsp.rm(scratch, { recursive: true, force: true }).catch(() => {})
    freeSlot()
  }
}

/** Drop page caches from earlier sessions. Best effort and never awaited by a
 *  request: a cache is a cache. */
async function pruneOld(): Promise<void> {
  const root = pagesRoot()
  const cutoff = Date.now() - 3 * 24 * 60 * 60 * 1000
  const names = await fsp.readdir(root).catch(() => [] as string[])
  for (const n of names) {
    const d = path.join(root, n)
    if (sessionDirs.has(d)) continue
    const st = await fsp.stat(d).catch(() => null)
    if (st && st.mtimeMs < cutoff) await fsp.rm(d, { recursive: true, force: true }).catch(() => {})
  }
}

export async function pdfThumbs(p: string, from: number, to: number): Promise<PdfThumbs> {
  if (!p || !p.startsWith('/')) return { ok: false, thumbs: [], error: 'Not a file on this computer.' }
  const st = await statDeadline(p)
  if (!st || !st.isFile()) return { ok: false, thumbs: [], error: 'The item is no longer in this location.' }

  const dir = path.join(pagesRoot(), cacheKey(p, st))
  try { await fsp.mkdir(dir, { recursive: true, mode: 0o700 }) } catch (e) {
    return { ok: false, thumbs: [], error: String((e as Error)?.message ?? e) }
  }
  if (!sessionDirs.has(dir)) { sessionDirs.add(dir); void pruneOld() }

  const lo = Math.max(1, Math.min(from, to))
  const hi = Math.max(from, to)
  const missing: number[] = []
  for (let n = lo; n <= hi; n++) {
    if (!await fsp.stat(pageFile(dir, n)).then(s => s.size > 0, () => false)) missing.push(n)
  }
  if (missing.length) {
    // one call across the whole gap rather than one per page: pdftoppm's start
    // cost is parsing the document, which is paid once either way
    try {
      await renderWindow(p, dir, missing[0], missing[missing.length - 1])
    } catch (e) {
      return { ok: false, thumbs: [], error: String((e as Error)?.message ?? e) }
    }
  }

  const thumbs: PdfThumb[] = []
  for (let n = lo; n <= hi; n++) {
    const f = pageFile(dir, n)
    if (await fsp.stat(f).then(s => s.size > 0, () => false)) {
      thumbs.push({ page: n, url: previewURL(f, { type: 'image/jpeg' }) })
    }
  }
  return { ok: true, thumbs }
}

// ---------------------------------------------------------------- writes

/** never overwrite: "book.pdf" -> "book (edited).pdf" -> "book (edited 2).pdf".
 *  Same rule as ops/imageedit.ts, deliberately duplicated rather than exported
 *  across modules that otherwise share nothing. */
async function freeName(dir: string, srcPath: string, suffix: string): Promise<string> {
  const base = path.basename(srcPath)
  const dot = base.lastIndexOf('.')
  const stem = dot > 0 ? base.slice(0, dot) : base
  const ext = dot > 0 ? base.slice(dot) : '.pdf'
  for (let i = 1; i < 1000; i++) {
    const name = i === 1 ? `${stem} (${suffix})${ext}` : `${stem} (${suffix} ${i})${ext}`
    const p = path.join(dir, name)
    // lstat, not access: a dangling symlink still occupies the name
    if (!await fsp.lstat(p).then(() => true, () => false)) return p
  }
  throw new Error('too many files with this name')
}

/** How many pages the file that was actually written contains. The whole point
 *  of this call is that "pdfunite exited 0" is not the same claim. */
async function pageCountOf(p: string): Promise<number> {
  const r = await run('pdfinfo', ['-enc', 'UTF-8', '--', p], 15_000)
  if (r.code !== 0) return 0
  return Number(field(r.stdout, 'Pages') ?? 0)
}

/**
 * Land `tmp` at its destination. Identical model to ops/imageedit.ts: a copy is
 * already at its final name, while a replace trashes the original first (so it
 * is recoverable from the desktop Recycle Bin) and only then renames the new
 * file into place. An original is never rm'd, and never written over directly.
 */
async function land(src: string, tmp: string, finalOut: string, dest: DocDest): Promise<string | null> {
  if (dest.mode !== 'replace') return null
  const gio = await run('gio', ['trash', '--', src], 30_000)
  if (gio.code !== 0) {
    await fsp.rm(tmp, { force: true }).catch(() => {})
    return 'The original could not be moved to the Recycle Bin, so nothing was changed.'
  }
  try { await fsp.rename(tmp, finalOut) } catch (e) {
    await fsp.rm(tmp, { force: true }).catch(() => {})
    return `The new PDF could not replace the original: ${String(e)}`
  }
  return null
}

async function destPaths(src: string, dest: DocDest, suffix: string): Promise<{ dir: string; finalOut: string; tmp: string }> {
  const dir = dest.mode === 'folder' ? dest.dir : path.dirname(src)
  const finalOut = dest.mode === 'replace' ? src : await freeName(dir, src, suffix)
  // replace renders to a temp beside the destination (same filesystem, so the
  // rename is atomic), verifies, THEN swaps
  const tmp = dest.mode === 'replace'
    ? path.join(dir, `.liqpdf-${process.pid}-${Date.now()}.pdf`)
    : finalOut
  return { dir, finalOut, tmp }
}

async function guardWritable(p: string): Promise<string | null> {
  const info = await pdfDocInfo(p)
  if (!info.ok) return info.error || 'This PDF could not be read.'
  if (info.encrypted || info.needsPassword) {
    return 'This PDF is encrypted. Page editing would have to strip that protection, so it is not allowed here.'
  }
  if (info.pages > DOC.maxPages) return `This PDF has ${info.pages} pages, more than the ${DOC.maxPages} this can rebuild.`
  return null
}

export async function pdfApplyPages(req: PdfPagesRequest): Promise<PdfResult> {
  const src = req.path
  if (!src || !src.startsWith('/')) return { ok: false, error: 'Not a file on this computer.' }
  const order = (req.order ?? []).map(n => Math.round(n)).filter(n => n >= 1)
  if (!order.length) return { ok: false, error: 'That would leave no pages at all.' }
  if (order.length > DOC.maxPages) return { ok: false, error: 'Too many pages to rebuild in one go.' }

  const bad = await guardWritable(src)
  if (bad) return { ok: false, error: bad }
  const info = await pdfDocInfo(src)
  const over = order.find(n => n > info.pages)
  if (over) return { ok: false, error: `Page ${over} does not exist — this PDF has ${info.pages}.` }

  const { finalOut, tmp } = await destPaths(src, req.dest, req.suffix || 'edited')
  // the scratch copy lives in /tmp: only the OUTPUT has to share a filesystem
  // with its destination for the rename to be atomic
  const scratch = await fsp.mkdtemp(path.join(os.tmpdir(), 'liqpdf-'))
  try {
    const lo = Math.min(...order)
    const hi = Math.max(...order)
    const sep = await run('pdfseparate', ['-f', String(lo), '-l', String(hi), '--', src, path.join(scratch, 'p-%d.pdf')], 120_000)
    const parts = order.map(n => path.join(scratch, `p-${n}.pdf`))
    for (const part of parts) {
      if (!await wroteSomething(part)) {
        return { ok: false, error: sep.stderr.split('\n')[0] || 'The pages could not be split out of this PDF.' }
      }
    }

    const uni = await run('pdfunite', [...parts, tmp], 120_000)
    if (!await wroteSomething(tmp)) {
      await fsp.rm(tmp, { force: true }).catch(() => {})
      return { ok: false, error: uni.stderr.split('\n')[0] || 'The new PDF could not be written.' }
    }
    // verify the RESULT, not the exit code: a truncated or wrong-length
    // document is exactly the failure a 0 exit would hide
    const got = await pageCountOf(tmp)
    if (got !== order.length) {
      await fsp.rm(tmp, { force: true }).catch(() => {})
      return { ok: false, error: `The new PDF came out with ${got} pages instead of ${order.length}, so nothing was changed.` }
    }

    const err = await land(src, tmp, finalOut, req.dest)
    if (err) return { ok: false, error: err }

    history.record({ kind: 'edit', count: 1, sources: [src], dest: finalOut, status: 'done' })
    return { ok: true, out: finalOut, pages: got }
  } catch (e) {
    await fsp.rm(tmp, { force: true }).catch(() => {})
    return { ok: false, error: String((e as Error)?.message ?? e) }
  } finally {
    await fsp.rm(scratch, { recursive: true, force: true }).catch(() => {})
  }
}

export async function pdfMerge(req: PdfMergeRequest): Promise<PdfResult> {
  const src = req.path
  if (!src || !src.startsWith('/')) return { ok: false, error: 'Not a file on this computer.' }
  const inputs = [src, ...(req.append ?? [])]
  if (inputs.length < 2) return { ok: false, error: 'Choose at least one PDF to add.' }

  let expected = 0
  for (const f of inputs) {
    const bad = await guardWritable(f)
    if (bad) return { ok: false, error: `${path.basename(f)}: ${bad}` }
    expected += (await pdfDocInfo(f)).pages
  }

  const { finalOut, tmp } = await destPaths(src, req.dest, 'merged')
  try {
    const uni = await run('pdfunite', [...inputs, tmp], 180_000)
    if (!await wroteSomething(tmp)) {
      return { ok: false, error: uni.stderr.split('\n')[0] || 'The merged PDF could not be written.' }
    }
    const got = await pageCountOf(tmp)
    if (got !== expected) {
      await fsp.rm(tmp, { force: true }).catch(() => {})
      return { ok: false, error: `The merged PDF came out with ${got} pages instead of ${expected}, so nothing was changed.` }
    }
    const err = await land(src, tmp, finalOut, req.dest)
    if (err) return { ok: false, error: err }

    history.record({ kind: 'edit', count: inputs.length, sources: inputs, dest: finalOut, status: 'done' })
    return { ok: true, out: finalOut, pages: got }
  } catch (e) {
    await fsp.rm(tmp, { force: true }).catch(() => {})
    return { ok: false, error: String((e as Error)?.message ?? e) }
  }
}

// ---------------------------------------------------------------- ipc

ipcMain.handle(CH('pdfDocInfo'), (_e, p: string) => pdfDocInfo(p))
ipcMain.handle(CH('pdfThumbs'), (_e, p: string, from: number, to: number) => pdfThumbs(p, from, to))
ipcMain.handle(CH('pdfApplyPages'), (_e, req: PdfPagesRequest) => pdfApplyPages(req))
ipcMain.handle(CH('pdfMerge'), (_e, req: PdfMergeRequest) => pdfMerge(req))

/** picker for "Add PDF…" and "Save to folder…" (foldericons.ts's pickImage
 *  pattern — the window is passed so the sheet is modal to it) */
ipcMain.handle(CH('pdfPick'), async (e: IpcMainInvokeEvent, kind: 'pdf' | 'folder', dir?: string) => {
  const win = BrowserWindow.fromWebContents(e.sender) ?? undefined
  const opts = kind === 'folder'
    ? { title: 'Choose a folder', defaultPath: dir, properties: ['openDirectory' as const, 'createDirectory' as const] }
    : {
      title: 'Choose a PDF to add',
      defaultPath: dir,
      filters: [{ name: 'PDF', extensions: ['pdf'] }],
      properties: ['openFile' as const, 'multiSelections' as const],
    }
  const r = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
  return r.canceled ? [] : r.filePaths
})

// The page cache is disposable by construction, so it goes when the app does.
// Only THIS session's directories are removed: a synchronous sweep of the whole
// cache on quit would stall the exit for as long as the filesystem felt like.
app.on('before-quit', () => {
  for (const d of sessionDirs) {
    try { fs.rmSync(d, { recursive: true, force: true }) } catch { /* nothing to be done at quit */ }
  }
  sessionDirs.clear()
})
