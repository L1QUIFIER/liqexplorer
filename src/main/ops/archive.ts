// Archive operations for the op queue. The CLI plumbing lives in
// archive/backend.ts (7-Zip / unrar / unar / tar); this file is the policy
// layer the engine drives through ArchiveCtx.
//
// What "extract" means here, and why:
//
//  * SINGLE-ROOT POLICY — the archive is listed before anything is written.
//    Exactly one top-level entry => extract in place (the archive already
//    carries its own folder). More than one => everything goes into
//    "<archive-stem>/", de-collided with the engine's ' (2)' rule. This is the
//    tar-bomb guard; `unar` does it natively, 7z does not.
//
//  * ATOMIC — extraction always lands in a private ".liqtmp-extract-*" folder
//    inside the destination, and only then are the results moved into place
//    through the engine's conflict-aware move, so the user gets the familiar
//    Replace / Skip / Keep both dialog. A failed, refused or cancelled extract
//    removes the temp folder and leaves the destination exactly as it was.
//
//  * VOLUME SETS — .partN.rar / .rNN / .7z.NNN / .zNN are one logical archive.
//    Sources are mapped to their primary volume and de-duplicated, so selecting
//    all six parts extracts once, and selecting only part 3 still works.
//
//  * PASSWORDS — silent candidates first (see archive/passwords.ts), the user
//    only when those miss. No cracking of any kind.
//
//  * GUARDS — members with '..' or absolute paths are refused outright, as are
//    absurd expansion ratios (see backend.bombCheck).
//
// Real progress comes from `7z x -bsp1` percentages, not an indeterminate bar.
import { ipcMain, type IpcMainInvokeEvent, type WebContents } from 'electron'
import type { ChildProcess } from 'node:child_process'
import * as fsp from 'node:fs/promises'
import * as path from 'node:path'
import { CH } from '../../shared/ipc'
import type { FileEntry, OpRequest, OpStatus } from '../../shared/types'
import { mimeForName, iconsForMime } from '../fs/mime'
import * as backend from './archive/backend'
import { candidatesFor, MAX_SILENT_ATTEMPTS, MAX_SILENT_MS } from './archive/passwords'
import { askPassword, cancelPasswordPrompt, type PromptCtx } from './archive/prompt'

export { cancelPasswordPrompt }
export type { ArchiveEntry, ArchiveListing, VolumeInfo } from './archive/backend'

/** Which folder an extraction lands in. The context menu picks one per verb. */
export type ExtractMode =
  | 'auto'    // "Extract here"        — single-root policy decides
  | 'named'   // "Extract to <name>/"  — always the named subfolder
  | 'to'      // "Extract All…"        — exactly the folder the caller chose

/** What the engine exposes to archive operations. */
export interface ArchiveCtx {
  opId: number
  /** originating window, for the password prompt */
  sender: WebContents | null
  sources: string[]
  /** destination directory */
  dest: string
  format?: 'zip' | 'tar.gz' | '7z'
  isCancelled(): boolean
  /** throws the engine's CancelledError */
  checkCancel(): void
  pauseGate(): Promise<void> | void
  setStatus(s: OpStatus): void
  setCurrent(file: string): void
  setTotals(items: number, bytes: number): void
  /** absolute bytesDone, so percentages never drift */
  setBytes(n: number): void
  itemDone(): void
  fail(path: string, error: string): void
  /** engine kills/pauses this child on cancelOp/pauseOp */
  setChild(c: ChildProcess | null): void
  /** engine's ' (2)' lowest-unused suffix */
  uniqueName(dir: string, base: string, isDir: boolean): Promise<string>
  /** conflict-aware move of everything in fromDir into toDir; returns created paths */
  moveInto(fromDir: string, toDir: string): Promise<string[]>
  recordCreated(p: string): void
}

// ---------------- extract-mode registry ----------------
//
// OpRequest has no room for the verb, so the mode is parked under the op id
// between startOp() returning and the queue actually running the op. That gap
// is a setImmediate (see engine.pump), i.e. strictly after this microtask, so
// the mode is always in place. A missing mode simply means 'auto'.

const modes = new Map<number, ExtractMode>()

function takeMode(opId: number): ExtractMode {
  const m = modes.get(opId)
  modes.delete(opId)
  return m ?? 'auto'
}

type StartOpFn = (wc: WebContents, req: OpRequest) => Promise<number>
let startOpImpl: StartOpFn | null = null

/** Called once by engine.ts; avoids an import cycle between the two modules. */
export function bindEngine(fn: StartOpFn): void { startOpImpl = fn }

export interface ExtractVerbRequest {
  archives: string[]
  mode?: ExtractMode
  /** base destination; defaults to the folder the first archive lives in */
  dest?: string
}

/** "Extract here" / "Extract to <name>/" / "Extract All…" all land here. */
export async function startExtract(wc: WebContents, req: ExtractVerbRequest): Promise<number> {
  if (!startOpImpl) throw new Error('The file operations engine is not ready.')
  const archives = (req.archives ?? []).filter(Boolean)
  if (!archives.length) throw new Error('No archive was given.')
  const dest = req.dest || path.dirname(archives[0])
  const opId = await startOpImpl(wc, { kind: 'extract', sources: archives, dest })
  modes.set(opId, req.mode ?? 'auto')
  return opId
}

// ---------------- helpers ----------------

async function exists(p: string): Promise<boolean> {
  return fsp.lstat(p).then(() => true, () => false)
}

async function rmrf(p: string): Promise<void> {
  await fsp.rm(p, { recursive: true, force: true }).catch(() => {})
}

let tmpSeq = 0
/** Matches the engine's '.liqtmp-' convention so stray temps are recognizable. */
async function makeTempDir(inside: string): Promise<string> {
  for (;;) {
    const p = path.join(inside, `.liqtmp-extract-${process.pid}-${++tmpSeq}`)
    try {
      await fsp.mkdir(p, { recursive: false })
      return p
    } catch (e) {
      if ((e as NodeJS.ErrnoException)?.code !== 'EEXIST') throw e
    }
  }
}

/** Recursive byte count for compress progress (cheap next to the compression itself). */
async function walkBytes(p: string, depth = 0): Promise<number> {
  if (depth > 64) return 0
  const st = await fsp.lstat(p).catch(() => null)
  if (!st) return 0
  if (st.isSymbolicLink()) return 0
  if (!st.isDirectory()) return st.isFile() ? st.size : 0
  const names = await fsp.readdir(p).catch(() => [] as string[])
  let n = 0
  for (const name of names) n += await walkBytes(path.join(p, name), depth + 1)
  return n
}

// ---------------- compress ----------------

/**
 * Create an archive in ctx.dest. Name: single source's basename (extension
 * stripped for files, kept whole for dirs), else 'Archive'; name collisions get
 * the Explorer ' (2)' suffix (lowest unused).
 */
export async function runCompress(ctx: ArchiveCtx): Promise<{ created?: string; error?: string }> {
  const format = ctx.format ?? 'zip'
  const ext = backend.extensionFor(format)
  let stem = 'Archive'
  if (ctx.sources.length === 1) {
    const base = path.basename(ctx.sources[0])
    const isDir = await fsp.lstat(ctx.sources[0]).then(s => s.isDirectory(), () => false)
    if (isDir) stem = base
    else {
      const i = base.lastIndexOf('.')
      stem = i > 0 ? base.slice(0, i) : base
    }
  }
  let dest = path.join(ctx.dest, stem + ext)
  for (let i = 2; await exists(dest); i++) dest = path.join(ctx.dest, `${stem} (${i})${ext}`)

  ctx.setStatus('enumerating')
  let total = 0
  for (const s of ctx.sources) {
    ctx.checkCancel()
    total += await walkBytes(s)
  }
  ctx.setTotals(ctx.sources.length, total)
  ctx.setStatus('running')
  ctx.setCurrent(dest)

  const r = await backend.create(dest, ctx.sources, format, {
    onChild: ctx.setChild,
    onPercent: p => ctx.setBytes(Math.min(total, Math.round(total * p / 100))),
    onBytes: b => ctx.setBytes(Math.min(total, b)),
  })
  for (let i = 0; i < ctx.sources.length; i++) ctx.itemDone()

  if (ctx.isCancelled()) {
    await rmrf(dest)                     // never leave a partial archive
    return {}
  }
  if (!r.ok) {
    await rmrf(dest)
    return { error: r.error ?? `Could not create "${path.basename(dest)}"` }
  }
  if (!await exists(dest)) return { error: `Could not create "${path.basename(dest)}"` }
  ctx.setBytes(total)
  return { created: dest }
}

// ---------------- password resolution ----------------

/** Per-operation password memory. Never leaves this module. */
interface PwState {
  /** passwords already known to work in this op, tried first and silently */
  known: string[]
  /** user chose "apply to all" with a real password */
  applyAll: string | null
  /** user chose "apply to all" with skip */
  skipAll: boolean
}

/** Cheapest possible validity check: one small member, or the header for -mhe/-hp. */
async function probePassword(
  ctx: ArchiveCtx, archive: string, listing: backend.ArchiveListing, pw: string,
): Promise<boolean> {
  if (listing.headerEncrypted) {
    const l = await backend.list(archive, { password: pw, onChild: ctx.setChild })
    return l.ok
  }
  const member = listing.entries
    .filter(e => !e.isDir && e.encrypted && e.size > 0)
    .sort((a, b) => a.size - b.size)[0]
    ?? listing.entries.filter(e => !e.isDir && e.encrypted)[0]
  const r = await backend.test(archive, pw, { member: member?.path, onChild: ctx.setChild })
  return r.status === 'ok'
}

/**
 * Find the password for one archive: silent candidates first, the user only as
 * a last resort. Returns null when the archive must be skipped.
 */
async function resolvePassword(
  ctx: ArchiveCtx, archive: string, listing: backend.ArchiveListing, st: PwState,
): Promise<string | null> {
  if (st.skipAll) return null

  const tryPw = async (pw: string): Promise<boolean> => {
    ctx.checkCancel()
    await ctx.pauseGate()
    return probePassword(ctx, archive, listing, pw)
  }

  // 1. anything already accepted in this operation, then the silent heuristics.
  //    '' first: 7-Zip happily marks a member encrypted with an empty password.
  const seeds = st.applyAll ? [st.applyAll, ...st.known] : st.known
  const silent = ['', ...await candidatesFor(archive, seeds)]
  const deadline = Date.now() + MAX_SILENT_MS
  let tried = 0
  for (const pw of silent) {
    if (tried++ >= MAX_SILENT_ATTEMPTS) break
    // seeds are cheap and near-certain; everything after them respects the budget
    if (tried > seeds.length + 1 && Date.now() > deadline) break
    if (await tryPw(pw)) {
      if (pw && !st.known.includes(pw)) st.known.unshift(pw)
      return pw
    }
  }

  // 2. ask, and keep asking while the answer is wrong
  const promptCtx: PromptCtx = {
    opId: ctx.opId,
    sender: ctx.sender,
    setStatus: ctx.setStatus,
    isCancelled: ctx.isCancelled,
  }
  for (let attempt = 1; ; attempt++) {
    ctx.checkCancel()
    const res = await askPassword(promptCtx, archive, path.basename(archive), attempt)
    ctx.checkCancel()
    if (res.password === null) {
      if (res.applyToAll) st.skipAll = true
      return null
    }
    if (await tryPw(res.password)) {
      if (!st.known.includes(res.password)) st.known.unshift(res.password)
      if (res.applyToAll) st.applyAll = res.password
      return res.password
    }
    if (attempt >= 20) return null           // pathological loop guard
  }
}

// ---------------- extract ----------------

interface Plan {
  archive: string
  listing: backend.ArchiveListing
  /** uncompressed bytes, for the progress split between archives */
  bytes: number
}

/**
 * Extract every source archive into ctx.dest. Per-archive failures are
 * collected, not fatal — one broken archive in a selection of ten must not
 * abandon the other nine.
 */
export async function runExtract(ctx: ArchiveCtx): Promise<void> {
  const mode = takeMode(ctx.opId)

  const destSt = await fsp.stat(ctx.dest).catch(() => null)
  if (!destSt?.isDirectory()) throw new Error(`The destination folder ${ctx.dest} does not exist.`)

  // --- volume sets collapse to their primary volume, de-duplicated ---
  ctx.setStatus('enumerating')
  const primaries: string[] = []
  const seen = new Set<string>()
  for (const s of ctx.sources) {
    ctx.checkCancel()
    const vi = await backend.volumeInfo(s)
    if (!seen.has(vi.primary)) { seen.add(vi.primary); primaries.push(vi.primary) }
  }

  // --- list everything up front so progress is byte-accurate ---
  const plans: Plan[] = []
  const missing: string[] = []
  for (const archive of primaries) {
    ctx.checkCancel()
    await ctx.pauseGate()
    ctx.setCurrent(archive)
    if (!await exists(archive)) { missing.push(archive); continue }
    const listing = await backend.list(archive, { onChild: ctx.setChild })
    plans.push({ archive, listing, bytes: listing.totalSize })
  }
  for (const m of missing) {
    ctx.fail(m, `${path.basename(m)} is no longer located in ${path.dirname(m)}. ` +
      `Verify the item's location and try again.`)
  }
  let total = plans.reduce((n, p) => n + p.bytes, 0)
  ctx.setTotals(plans.length, total)

  ctx.setStatus('running')
  const pw: PwState = { known: [], applyAll: null, skipAll: false }
  let base = 0

  for (const plan of plans) {
    ctx.checkCancel()
    await ctx.pauseGate()
    const { archive } = plan
    const name = path.basename(archive)
    ctx.setCurrent(archive)

    let listing = plan.listing
    let password: string | undefined

    // --- password, silently if at all possible ---
    if (listing.encrypted || listing.headerEncrypted) {
      const found = await resolvePassword(ctx, archive, listing, pw)
      if (found === null) {
        ctx.fail(archive, `"${name}" is password protected and was skipped.`)
        base += plan.bytes
        ctx.setBytes(base)
        ctx.itemDone()
        continue
      }
      password = found
      if (listing.headerEncrypted) {
        listing = await backend.list(archive, { password, onChild: ctx.setChild })
        plan.bytes = listing.totalSize
        total += plan.bytes
        ctx.setTotals(plans.length, total)
      }
    }

    if (!listing.ok) {
      ctx.fail(archive, listing.error ?? `Could not read "${name}".`)
      ctx.itemDone()
      continue
    }
    if (!listing.entries.length) {
      ctx.fail(archive, `"${name}" contains no files.`)
      ctx.itemDone()
      continue
    }

    // --- security guards, before a single byte is written ---
    const unsafe = backend.unsafeMembers(listing.entries)
    if (unsafe.length) {
      ctx.fail(archive, `"${name}" contains unsafe paths (${unsafe[0]}) and was not extracted.`)
      base += plan.bytes
      ctx.setBytes(base)
      ctx.itemDone()
      continue
    }
    const bomb = backend.bombCheck(listing, name)
    if (bomb) {
      ctx.fail(archive, bomb)
      base += plan.bytes
      ctx.setBytes(base)
      ctx.itemDone()
      continue
    }

    // --- extract into a private temp dir, then move into place ---
    const tmp = await makeTempDir(ctx.dest)
    try {
      const r = await backend.extract(archive, tmp, {
        password,
        onChild: ctx.setChild,
        onPercent: p => ctx.setBytes(base + Math.round(plan.bytes * Math.min(100, p) / 100)),
      })
      ctx.checkCancel()
      if (!r.ok) {
        ctx.fail(archive, r.error ?? `Could not extract "${name}".`)
      } else {
        await unwrapSingleStream(ctx, tmp, listing)
        const targetDir = await chooseTarget(ctx, archive, tmp, mode)
        await fsp.mkdir(targetDir, { recursive: true })
        const created = await ctx.moveInto(tmp, targetDir)
        for (const c of created) ctx.recordCreated(c)
      }
    } finally {
      await rmrf(tmp)                       // cancel/failure never litters the destination
    }

    base += plan.bytes
    ctx.setBytes(base)
    ctx.itemDone()
  }
}

/**
 * `foo.tar.gz` is a gzip stream containing one file, `foo.tar` — 7z stops
 * there, so unwrap the inner tar in the staging folder and the user gets their
 * files instead of a .tar. Anything that is not actually a tar is left alone.
 */
async function unwrapSingleStream(ctx: ArchiveCtx, tmp: string, outer: backend.ArchiveListing): Promise<void> {
  if (!backend.SINGLE_STREAM_TYPES.has(outer.type.toLowerCase())) return
  const names = await fsp.readdir(tmp).catch(() => [] as string[])
  if (names.length !== 1) return
  const inner = path.join(tmp, names[0])
  const st = await fsp.lstat(inner).catch(() => null)
  if (!st?.isFile()) return
  const l = await backend.list(inner, { onChild: ctx.setChild })
  if (!l.ok || l.type.toLowerCase() !== 'tar' || !l.entries.length) return
  if (backend.unsafeMembers(l.entries).length) return

  const stage = await makeTempDir(tmp)
  try {
    const r = await backend.extract(inner, stage, { onChild: ctx.setChild })
    if (!r.ok) return
    await fsp.rm(inner, { force: true })
    for (const n of await fsp.readdir(stage)) {
      await fsp.rename(path.join(stage, n), path.join(tmp, n)).catch(() => {})
    }
  } finally {
    await rmrf(stage)
  }
}

/**
 * Single-root / tar-bomb policy, or the caller's explicit choice. The decision
 * is made on what actually landed in the staging folder rather than on the
 * listing, so implicit directories and unwrapped tars are handled correctly.
 */
async function chooseTarget(
  ctx: ArchiveCtx, archive: string, tmp: string, mode: ExtractMode,
): Promise<string> {
  if (mode === 'to') return ctx.dest
  const stem = backend.archiveStem(archive)
  if (mode === 'named') return path.join(ctx.dest, stem)   // merges if it exists; conflicts ask per file
  const roots = await fsp.readdir(tmp).catch(() => [] as string[])
  if (roots.length <= 1) return ctx.dest                   // archive carries its own folder
  const free = await exists(path.join(ctx.dest, stem))
    ? await ctx.uniqueName(ctx.dest, stem, true)
    : stem
  return path.join(ctx.dest, free)
}

// ---------------- verbs exposed over IPC ----------------

export interface ArchiveTestResult {
  status: backend.TestStatus
  /** archive needs a password we could not find silently */
  encrypted: boolean
  entries: number
  totalSize: number
  volumes: number
  type: string
  error?: string
}

/** "Test archive" — reports OK / corrupt / encrypted without writing anything. */
export async function testArchive(archivePath: string, password?: string): Promise<ArchiveTestResult> {
  const vi = await backend.volumeInfo(archivePath)
  const target = vi.primary
  const listing = await backend.list(target, { password })
  const base = {
    encrypted: listing.encrypted || listing.headerEncrypted,
    entries: listing.entries.length,
    totalSize: listing.totalSize,
    volumes: vi.members.length > 1 ? vi.members.length : listing.volumes,
    type: listing.type,
  }
  if (listing.headerEncrypted && !password) return { ...base, status: 'encrypted', error: listing.error }
  if (!listing.ok) return { ...base, status: 'corrupt', error: listing.error }
  const r = await backend.test(target, password ?? (listing.encrypted ? undefined : ''))
  return { ...base, status: r.status, error: r.error }
}

/** Multi-part detection helper for the renderer (grouping / "1 of 6" badges). */
export async function archiveVolumes(archivePath: string): Promise<backend.VolumeInfo> {
  return backend.volumeInfo(archivePath)
}

// ---------------- archive:// browsing (main-process capability only) ----------------

const ARCHIVE_URI = /^archive:\/\/(.*?)(?:!\/(.*))?$/

function parseArchiveUri(uri: string): { archive: string; inner: string } | null {
  const m = ARCHIVE_URI.exec(uri)
  if (!m) return null
  return { archive: m[1], inner: (m[2] ?? '').replace(/^\/+|\/+$/g, '') }
}

function entryToFileEntry(archive: string, e: { path: string; size: number; mtime: number; isDir: boolean }, name: string): FileEntry {
  const mime = mimeForName(name, e.isDir)
  const ext = e.isDir ? '' : (name.includes('.') ? name.slice(name.lastIndexOf('.') + 1).toLowerCase() : '')
  return {
    name,
    path: `archive://${archive}!/${e.path}`,
    isDir: e.isDir,
    isSymlink: false,
    size: e.isDir ? 0 : e.size,
    mtime: e.mtime,
    ctime: e.mtime,
    mime,
    icons: e.isDir ? ['folder'] : iconsForMime(mime),
    hidden: name.startsWith('.'),
    ext,
    writable: false,
  }
}

/**
 * One level of an archive as FileEntry[], for an Explorer-style zip-as-folder
 * view. `target` is either an `archive://<path>!/<inner>` URI or a plain
 * archive path with `innerPath` given separately. UI is NOT built on this yet.
 */
export async function listArchive(target: string, innerPath = '', password?: string): Promise<FileEntry[]> {
  const parsed = parseArchiveUri(target)
  const archive = parsed ? parsed.archive : target
  const inner = (parsed ? parsed.inner : innerPath).replace(/^\/+|\/+$/g, '')
  const vi = await backend.volumeInfo(archive)
  const listing = await backend.list(vi.primary, { password })
  if (!listing.ok) throw new Error(listing.error ?? `Could not read "${path.basename(archive)}".`)

  const prefix = inner ? inner + '/' : ''
  const out = new Map<string, FileEntry>()
  for (const e of listing.entries) {
    if (!e.path.startsWith(prefix)) continue
    const rest = e.path.slice(prefix.length)
    if (!rest) continue
    const slash = rest.indexOf('/')
    if (slash < 0) {
      out.set(rest, entryToFileEntry(archive, e, rest))
    } else {
      // implicit folder: some archives store no directory entries at all
      const name = rest.slice(0, slash)
      if (!out.has(name)) {
        out.set(name, entryToFileEntry(archive, { path: prefix + name, size: 0, mtime: e.mtime, isDir: true }, name))
      }
    }
  }
  return [...out.values()]
}

/**
 * Extract one member to destDir (open-on-demand for archive://). Returns the
 * path of the extracted file.
 */
export async function extractMember(
  archivePath: string, member: string, destDir: string, password?: string,
): Promise<{ ok: boolean; path?: string; error?: string }> {
  const vi = await backend.volumeInfo(archivePath)
  const norm = backend.normalizeMember(member)
  if (!norm || norm.split('/').includes('..') || norm.startsWith('/')) {
    return { ok: false, error: 'That item cannot be extracted.' }
  }
  await fsp.mkdir(destDir, { recursive: true })
  const r = await backend.extract(vi.primary, destDir, { password, members: [norm] })
  if (!r.ok) return { ok: false, error: r.error }
  const out = path.join(destDir, norm)
  if (!await exists(out)) return { ok: false, error: `"${path.basename(norm)}" was not found in the archive.` }
  return { ok: true, path: out }
}

// ---------------- IPC registration ----------------
//
// Registered here rather than in main/ipc.ts so the whole archive feature is
// self-contained. (prompt.ts registers 'resolvePassword' the same way.)
//
// NOTE: 'archiveList' is already routed by main/ipc.ts to the apps.ts stub, so
// the browse capability lives on 'archiveBrowse' instead. Re-pointing that
// route at listArchive() is a one-line change in ipc.ts when the UI lands.

type Handler = (event: IpcMainInvokeEvent, ...args: any[]) => unknown

function handle(method: string, fn: Handler): void {
  try {
    ipcMain.handle(CH(method), fn)
  } catch (e) {
    // a duplicate registration must not take the whole main process down
    console.warn(`[archive] could not register ${CH(method)}:`, (e as Error)?.message)
  }
}

handle('extractArchives', (e, req: ExtractVerbRequest) => startExtract(e.sender, req))
handle('testArchive', (_e, p: string, password?: string) => testArchive(p, password))
handle('archiveVolumes', (_e, p: string) => archiveVolumes(p))
handle('archiveBrowse', (_e, target: string, inner?: string, password?: string) => listArchive(target, inner ?? '', password))
handle('extractMember', (_e, a: string, m: string, d: string, password?: string) => extractMember(a, m, d, password))
handle('archiveTools', () => backend.availability())
