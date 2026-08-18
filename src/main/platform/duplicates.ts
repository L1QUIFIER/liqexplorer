// Duplicate-file scanner — the engine behind "Find duplicate files…".
//
// WHY IT IS SHAPED LIKE THIS
// --------------------------
// Hashing every file in a tree is the naive answer and it is unusable: a photo
// folder is tens of gigabytes and almost none of it can possibly be duplicated.
// So the scan is a funnel and each stage only ever sees what the cheaper stage
// could not eliminate:
//
//   1. SIZE      readdir + lstat only. Two files of different sizes can never
//                have the same content, so a file with a unique size is never
//                opened at all. On a normal tree this removes >90% of it.
//   2. HEAD      the first 64 KB of each survivor. One short read splits
//                same-size-different-content files (media containers, disk
//                images, sparse logs) without touching the rest of the bytes.
//                A file <= 64 KB is fully hashed by this stage, so it skips
//                stage 3 entirely.
//   3. FULL      the REMAINDER (byte 64 KB onwards) of the files that still
//                share a head digest. The head is already known to match, so
//                the tail digest alone decides — no byte is read twice.
//
// HARD LINKS are collapsed before any hashing: two names for one inode are one
// file, not a duplicate pair, and "recovering" that space by deleting one of
// them frees nothing while destroying a name the user wanted. Dedupe is on
// dev+ino, which also folds the same file reached through two overlapping roots.
//
// SYMLINKS are skipped outright (never followed, never listed) — that is also
// the cycle guard for the walk.
//
// REMOTE ROOTS (fs/list.isRemotePath): every candidate read crosses the
// network, so the result carries `remote` for the dialog to warn with, and
// EVERY io call is raced against a timer — the CIFS share here is mounted
// `hard`, where a dead server never errors, it just never answers. Abandoning
// the promise does not free the libuv request (platform/indexer.ts explains
// this at length), but it does stop the scan queueing more of them, so it can
// still notice cancellation and finish.
//
// Cancellation is checked between directories, between stat batches, between
// files AND inside the read loop of a single big file.
//
// Self-registers its IPC verbs like ops/quick.ts and platform/indexer.ts —
// main/ipc.ts is not touched. Renderer side:
//   liq.invoke('startDupScan', req)  -> scanId   (progress on 'liqpush:duplicates')
//   liq.invoke('cancelDupScan', id)
//   liq.invoke('getDupPrefs') / liq.invoke('setDupPrefs', prefs)
import { ipcMain } from 'electron'
import type { IpcMainInvokeEvent, WebContents } from 'electron'
import * as crypto from 'node:crypto'
import * as fs from 'node:fs'
import * as fsp from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { CH } from '../../shared/ipc'
import {
  DEFAULT_DUP_PREFS, DUP_HEAD_BYTES, DUP_PUSH, byNewest,
  type DupFile, type DupGroup, type DupPrefs, type DupProgress,
  type DupAttachReply, type DupScanRequest, type DupScanResult, type DupScanSummary,
} from '../../shared/duplicates'
import { isRemotePath } from '../fs/list'
import { stateDir } from '../state/settings'

/** lstat fan-out inside one directory (mirrors fs/list.ts STAT_POOL) */
const STAT_POOL = 48
/** files hashed concurrently (halved for network roots — one dead mount is enough) */
const HASH_POOL = 4
const HASH_POOL_REMOTE = 2
/** yield to the event loop after this many directories */
const DIRS_PER_TICK = 8
/** …and after this many hashed files */
const FILES_PER_TICK = 32
/** progress push cadence — ~4/s, as designed */
const PUSH_MS = 250
/** ceiling on ONE readdir / lstat batch (same reasoning as indexer.ts) */
const IO_TIMEOUT_MS = 15_000
/** a read that delivers NO bytes for this long is a dead mount, not a slow disk */
const READ_STALL_MS = 20_000
/** timeouts inside one root before the root is abandoned as unreachable */
const MAX_TIMEOUTS_PER_ROOT = 3
/** hard ceiling on candidate files so a runaway root cannot eat RAM */
const MAX_FILES = 400_000
/** groups handed to the renderer (it has to build DOM for every one) */
const MAX_GROUPS = 5_000
/** failures kept for the dialog's footnotes */
const MAX_ERRORS = 50
/** how long a finished scan stays collectable after the dialog closed */
const FINISHED_TTL_MS = 10 * 60_000
/** never descend into these, whatever the roots say */
const SKIP_DIRS = new Set(['/proc', '/sys', '/dev', '/run', '/var/run', '/var/lock', '/lost+found'])

/**
 * One candidate file. The directory is kept as a SHARED string reference (one
 * per directory, not one per file) and the full path is only materialised when
 * a file is actually read or reported: on a 300k-file tree that is the
 * difference between ~100 MB of path strings and a few megabytes.
 */
interface Cand {
  dir: string
  name: string
  size: number
  mtime: number
  dev: number
  ino: number
}

const full = (c: Cand): string => (c.dir === '/' ? '/' + c.name : c.dir + '/' + c.name)

interface Job {
  id: number
  cancelled: boolean
  roots: string[]
  subfolders: boolean
  minSize: number
  includeHidden: boolean
  remote: boolean
  startedAt: number
  prog: DupProgress
  errors: { path: string; error: string }[]
  unreadable: number
  hardLinks: number
  truncated: boolean
  timer: NodeJS.Timeout | null
  /** every group confirmed so far, in arrival order — replayed on attach */
  found: DupGroup[]
  /** confirmed but not yet pushed; drained by the push timer */
  pending: DupGroup[]
  /** monotonic, so a group id is unique across the whole scan */
  seq: number
  /** the window that started it; a detached scan keeps running with none */
  wc: WebContents | null
  detached: boolean
}

let nextScan = 1
const jobs = new Map<number, Job>()

// ---------------------------------------------------------------- prefs

const prefsPath = (): string => path.join(stateDir(), 'duplicates.json')

export function getDupPrefs(): DupPrefs {
  try {
    const j = JSON.parse(fs.readFileSync(prefsPath(), 'utf8')) as Partial<DupPrefs>
    return {
      subfolders: typeof j.subfolders === 'boolean' ? j.subfolders : DEFAULT_DUP_PREFS.subfolders,
      minSize: Number.isFinite(j.minSize) ? Math.max(0, Math.floor(j.minSize as number)) : DEFAULT_DUP_PREFS.minSize,
      includeHidden: typeof j.includeHidden === 'boolean' ? j.includeHidden : DEFAULT_DUP_PREFS.includeHidden,
    }
  } catch { return { ...DEFAULT_DUP_PREFS } }
}

export async function setDupPrefs(patch: Partial<DupPrefs>): Promise<DupPrefs> {
  const next: DupPrefs = { ...getDupPrefs(), ...patch }
  // state lives in ~/.local/state/liqexplorer — never beside the code, which is
  // on the CIFS share shared with Windows
  const tmp = prefsPath() + '.tmp'
  try {
    await fsp.writeFile(tmp, JSON.stringify(next, null, 2))
    await fsp.rename(tmp, prefsPath())
  } catch { await fsp.unlink(tmp).catch(() => {}) }
  return next
}

// ---------------------------------------------------------------- plumbing

const tick = (): Promise<void> => new Promise<void>(res => setImmediate(res))

type Timed<T> = { timedOut: true; value: null } | { timedOut: false; value: T }

/** Race an fs call against a timer. `p` must never reject (callers .catch first). */
function withTimeout<T>(p: Promise<T>, ms: number): Promise<Timed<T>> {
  return new Promise(resolve => {
    let settled = false
    const timer = setTimeout(() => {
      if (!settled) { settled = true; resolve({ timedOut: true, value: null }) }
    }, ms)
    void p.then(value => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ timedOut: false, value })
    })
  })
}

/** run `fn` over `items` with at most `limit` in flight, stopping early on demand */
async function pool<T>(
  items: T[], limit: number, fn: (item: T) => Promise<void>, stop: () => boolean,
): Promise<void> {
  let i = 0
  const n = Math.max(1, Math.min(limit, items.length))
  await Promise.all(Array.from({ length: n }, async () => {
    while (i < items.length && !stop()) {
      const item = items[i++]
      await fn(item)
    }
  }))
}

/** absolute, trailing-slash-free, deduped, nested roots folded into parents */
export function normalizeDupRoots(list: string[]): string[] {
  const cleaned = (list.length ? list : [os.homedir()])
    .map(r => (r || '').trim())
    .filter(Boolean)
    .map(r => path.resolve(r.startsWith('~') ? path.join(os.homedir(), r.slice(1)) : r))
    .map(r => (r.length > 1 ? r.replace(/\/+$/, '') : r))
  const uniq = [...new Set(cleaned)].sort((a, b) => a.length - b.length)
  const out: string[] = []
  for (const r of uniq) {
    if (out.some(p => r === p || r.startsWith(p === '/' ? '/' : p + '/'))) continue
    out.push(r)
  }
  return out
}

function note(job: Job, p: string, error: string): void {
  job.unreadable++
  if (job.errors.length < MAX_ERRORS) job.errors.push({ path: p, error })
}

/**
 * Send progress, draining any groups confirmed since the last push.
 *
 * Batched on the existing timer rather than sent per group: a bucket of a
 * thousand small duplicates would otherwise be a thousand IPC messages, and the
 * renderer would spend the scan laying out rows instead of showing them.
 *
 * A DETACHED scan has no window to talk to. It keeps running and keeps
 * accumulating into `found`, so whoever attaches next gets the lot.
 */
function push(job: Job, extra?: Partial<DupProgress>): void {
  const batch = job.pending.length ? job.pending.splice(0, job.pending.length) : undefined
  const wc = job.wc
  if (!wc || wc.isDestroyed()) return
  wc.send(DUP_PUSH, { ...job.prog, ...(batch ? { groups: batch } : {}), ...extra })
}

/** Record confirmed groups: kept for replay, queued for the next push. */
function emit(job: Job, sets: Cand[][]): void {
  for (const g of sets) {
    if (job.found.length >= MAX_GROUPS) {
      if (!job.truncated) { job.truncated = true; job.prog.truncated = true }
      return
    }
    const size = g[0].size
    const files: DupFile[] = g
      .map(c => ({ path: full(c), size: c.size, mtime: c.mtime }))
      .sort(byNewest)
    const group: DupGroup = {
      id: `${size}-${job.seq++}`,
      size,
      wasted: size * (g.length - 1),
      files,
    }
    job.found.push(group)
    job.pending.push(group)
    job.prog.foundGroups = job.found.length
    job.prog.foundWasted += group.wasted
  }
}

// ---------------------------------------------------------------- hash cache
//
// Re-running a scan after deleting a few duplicates used to cost the same as
// the first run. Almost nothing has changed between the two, and a hash of the
// same bytes is the same hash, so the expensive part is entirely reusable.
//
// The key is dev+ino+size+mtime. `dev` is not optional: inode numbers are only
// unique WITHIN a filesystem, and this app is pointed at a CIFS mount and local
// disks at the same time, so ino alone would collide across them. Size and
// mtime are what make a stale entry impossible to trust — either changing
// discards the entry rather than returning a hash for bytes that are gone.
//
// Kept in memory and flushed to disk, because the win is mostly WITHIN a
// session (scan, delete, scan again) and a file write per hash would cost more
// than it saves.

interface CacheEntry { head?: string; tail?: string }

const hashCache = new Map<string, CacheEntry>()
let cacheDirty = false
let cacheLoaded = false

const cachePath = (): string => path.join(stateDir(), 'duphashes.json')

/** cap: this is a convenience, not a database — it must not grow without end */
const CACHE_MAX = 200_000

function cacheKey(c: Cand): string {
  return `${c.dev}:${c.ino}:${c.size}:${Math.floor(c.mtime)}`
}

function loadHashCache(): void {
  if (cacheLoaded) return
  cacheLoaded = true
  try {
    const raw = JSON.parse(fs.readFileSync(cachePath(), 'utf8')) as Record<string, CacheEntry>
    for (const [k, v] of Object.entries(raw)) {
      if (hashCache.size >= CACHE_MAX) break
      if (v && (typeof v.head === 'string' || typeof v.tail === 'string')) hashCache.set(k, v)
    }
  } catch { /* first run, or unreadable — an empty cache is always correct */ }
}

async function saveHashCache(): Promise<void> {
  if (!cacheDirty) return
  cacheDirty = false
  try {
    // youngest entries win if we are over the cap: a scan just ran, so what it
    // touched is what the next one is most likely to touch
    const entries = [...hashCache.entries()].slice(-CACHE_MAX)
    await fsp.mkdir(stateDir(), { recursive: true }).catch(() => {})
    const tmp = cachePath() + '.tmp'
    await fsp.writeFile(tmp, JSON.stringify(Object.fromEntries(entries)))
    await fsp.rename(tmp, cachePath())
  } catch { /* a cache that cannot be written is still a working scanner */ }
}

/** hashRange, but answered from the cache when the file has not changed */
async function cachedHash(
  c: Cand, which: 'head' | 'tail', p: string, start: number, end: number | undefined,
  stop: () => boolean,
): Promise<HashOut> {
  const key = cacheKey(c)
  const hit = hashCache.get(key)?.[which]
  if (hit) return { digest: hit, bytes: 0 }
  const r = await hashRange(p, start, end, stop)
  if (r.digest) {
    const e = hashCache.get(key) ?? {}
    e[which] = r.digest
    hashCache.set(key, e)
    cacheDirty = true
  }
  return r
}

// ---------------------------------------------------------------- hashing

interface HashOut { digest: string | null; bytes: number; error?: string }

/**
 * sha256 over [start, end] of one file, streamed — a 4 GB video never lands in
 * memory. The timer is a STALL timer, rearmed on every chunk: a legitimately
 * slow 2 GB read must not be killed, while a mount that has stopped answering
 * is dropped after READ_STALL_MS. `stop()` is polled per chunk so cancelling
 * the scan does not have to wait for a huge file to finish.
 */
function hashRange(
  p: string, start: number, end: number | undefined, stop: () => boolean,
): Promise<HashOut> {
  return new Promise<HashOut>(resolve => {
    const opts: { start: number; end?: number; highWaterMark: number } = { start, highWaterMark: 1 << 20 }
    if (end !== undefined) opts.end = end
    const h = crypto.createHash('sha256')
    let bytes = 0
    let done = false
    let timer: NodeJS.Timeout | null = null
    let rs: fs.ReadStream
    const finish = (digest: string | null, error?: string): void => {
      if (done) return
      done = true
      if (timer) clearTimeout(timer)
      rs.destroy()
      resolve({ digest, bytes, error })
    }
    const arm = (): void => {
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => finish(null, 'the file stopped responding'), READ_STALL_MS)
    }
    try {
      rs = fs.createReadStream(p, opts)
    } catch (e) {
      resolve({ digest: null, bytes: 0, error: String((e as Error)?.message ?? e) })
      return
    }
    arm()
    rs.on('data', (chunk: string | Buffer) => {
      if (stop()) { finish(null, 'cancelled'); return }
      const b = typeof chunk === 'string' ? Buffer.from(chunk) : chunk
      bytes += b.length
      h.update(b)
      arm()
    })
    rs.on('end', () => finish(h.digest('hex')))
    rs.on('error', (e: Error) => finish(null, String(e?.message ?? e)))
  })
}

// ---------------------------------------------------------------- the walk

/** collect every file at or under one root that could possibly be a duplicate */
async function walkRoot(job: Job, root: string, out: Cand[]): Promise<void> {
  const stack: string[] = [root]
  let sinceTick = 0
  let timeouts = 0
  /** true when this root is hopeless and must be abandoned */
  const noteTimeout = (p: string): boolean => {
    note(job, p, 'the folder stopped responding')
    return ++timeouts >= MAX_TIMEOUTS_PER_ROOT
  }

  while (stack.length && !job.cancelled) {
    if (out.length >= MAX_FILES) { job.truncated = true; return }
    const dir = stack.pop()!
    job.prog.current = dir
    if (!job.remote && isRemotePath(dir)) job.remote = true

    const read = await withTimeout(
      fsp.readdir(dir, { withFileTypes: true }).catch((e: unknown) => {
        note(job, dir, String((e as Error)?.message ?? e))
        return null
      }), IO_TIMEOUT_MS)
    if (read.timedOut) {
      if (noteTimeout(dir)) return
      continue
    }
    const ents = read.value
    if (!ents) continue
    job.prog.dirsSeen++

    const fileNames: string[] = []
    for (const d of ents) {
      const name = d.name
      if (!job.includeHidden && name.startsWith('.')) continue
      // symlinks are never followed and never counted: a link is not a copy,
      // and skipping them is also what makes the walk acyclic
      if (d.isSymbolicLink()) continue
      if (d.isDirectory()) {
        if (!job.subfolders) continue
        const full = path.join(dir, name)
        if (SKIP_DIRS.has(full)) continue
        stack.push(full)
      } else if (d.isFile()) {
        fileNames.push(name)
      }
      // fifos, sockets, devices: nothing to compare
    }

    for (let i = 0; i < fileNames.length && !job.cancelled; i += STAT_POOL) {
      const slice = fileNames.slice(i, i + STAT_POOL)
      const batch = await withTimeout(Promise.all(slice.map(n =>
        fsp.lstat(path.join(dir, n)).catch(() => null))), IO_TIMEOUT_MS)
      if (batch.timedOut) {
        // never queue the next 48 lstats behind a server that is not answering
        if (noteTimeout(dir)) return
        break
      }
      const stats = batch.value
      for (let k = 0; k < slice.length; k++) {
        const st = stats[k]
        if (!st || !st.isFile()) continue
        job.prog.filesSeen++
        if (st.size < job.minSize) continue
        out.push({ dir, name: slice[k], size: st.size, mtime: st.mtimeMs, dev: st.dev, ino: st.ino })
        if (out.length >= MAX_FILES) { job.truncated = true; return }
      }
    }
    if (++sinceTick >= DIRS_PER_TICK) { sinceTick = 0; await tick() }
  }
}

// ---------------------------------------------------------------- the scan

async function runScan(job: Job): Promise<DupScanResult> {
  loadHashCache()
  const files: Cand[] = []

  // ---- stage 1a: walk ----
  job.prog.stage = 'walking'
  for (const root of job.roots) {
    if (job.cancelled) break
    if (isRemotePath(root)) job.remote = true
    const st = await withTimeout(fsp.stat(root).catch(() => null), IO_TIMEOUT_MS)
    if (st.timedOut || !st.value) { note(job, root, 'the folder could not be read'); continue }
    if (!st.value.isDirectory()) { note(job, root, 'not a folder'); continue }
    await walkRoot(job, root, files)
  }

  // ---- stage 1b: group by size, collapse hard links ----
  job.prog.stage = 'grouping'
  job.prog.current = ''
  const bySize = new Map<number, Cand[]>()
  for (const c of files) {
    const list = bySize.get(c.size)
    if (list) list.push(c)
    else bySize.set(c.size, [c])
  }
  /** groups of files that share a size AND are distinct inodes */
  let live: Cand[][] = []
  for (const list of bySize.values()) {
    if (list.length < 2) continue           // unique size: never opened. Ever.
    const seen = new Set<string>()
    const uniq: Cand[] = []
    for (const c of list) {
      const key = c.dev + ':' + c.ino
      // TWO NAMES, ONE INODE. Reporting these as duplicates and letting the
      // user "free space" by deleting one is the classic hard-link bug: it
      // frees nothing and silently removes a name something else depends on.
      if (seen.has(key)) { job.hardLinks++; continue }
      seen.add(key)
      uniq.push(c)
    }
    if (uniq.length < 2) continue
    live.push(uniq)
  }
  bySize.clear()
  files.length = 0
  job.prog.candidates = live.reduce((n, g) => n + g.length, 0)

  // ---- stages 2 and 3, ONE BUCKET AT A TIME ----
  //
  // These used to run across the whole tree: head-hash every candidate, then
  // tail-hash every survivor, then report. Correct, but it meant no group could
  // be final until the last byte of the last file was read, so the dialog had
  // nothing to show for minutes.
  //
  // Taking one size bucket end to end instead — head, then tail within that
  // bucket, then emit — makes every group final the moment it is produced. No
  // provisional rows that later vanish, which would be worse than waiting.
  //
  // BIGGEST FILES FIRST, because the whole point is usually reclaiming space:
  // the largest wins land in the first seconds, and arrival order comes out
  // close to "most wasted first" without anything having to re-sort under the
  // user's pointer.
  live.sort((a, b) => b[0].size - a[0].size)

  job.prog.stage = 'head'
  job.prog.stageDone = 0
  job.prog.stageTotal = job.prog.candidates
  const stop = (): boolean => job.cancelled
  let sinceTick = 0

  for (const group of live) {
    if (job.cancelled) break
    const size = group[0].size

    if (size === 0) {
      // only reachable with minSize 0: every empty file has identical content,
      // and there is nothing to read to prove it
      job.prog.stageDone += group.length
      emit(job, [group])
      continue
    }

    // -- head --
    const byHead = new Map<string, Cand[]>()
    await pool(group, job.remote ? HASH_POOL_REMOTE : HASH_POOL, async (c) => {
      const p = full(c)
      job.prog.current = p
      const r = await cachedHash(c, 'head', p, 0, Math.min(size, DUP_HEAD_BYTES) - 1, stop)
      job.prog.stageDone++
      job.prog.bytesHashed += r.bytes
      if (++sinceTick >= FILES_PER_TICK) { sinceTick = 0; await tick() }
      if (!r.digest) {
        if (r.error !== 'cancelled') note(job, p, r.error ?? 'could not be read')
        return
      }
      const l = byHead.get(r.digest)
      if (l) l.push(c)
      else byHead.set(r.digest, [c])
    }, stop)
    if (job.cancelled) break

    // a file at or below DUP_HEAD_BYTES was COMPLETELY covered by that read, so
    // it is already content-verified and never reaches the tail stage
    const tailNeeded: Cand[][] = []
    for (const sub of byHead.values()) {
      if (sub.length < 2) continue
      if (size <= DUP_HEAD_BYTES) emit(job, [sub])
      else tailNeeded.push(sub)
    }
    if (!tailNeeded.length) continue

    // -- tail: the head already matches, so byte DUP_HEAD_BYTES onwards decides
    job.prog.stage = 'full'
    for (const sub of tailNeeded) {
      if (job.cancelled) break
      const byTail = new Map<string, Cand[]>()
      await pool(sub, job.remote ? HASH_POOL_REMOTE : HASH_POOL, async (c) => {
        const p = full(c)
        job.prog.current = p
        const r = await cachedHash(c, 'tail', p, DUP_HEAD_BYTES, undefined, stop)
        job.prog.bytesHashed += r.bytes
        if (++sinceTick >= FILES_PER_TICK) { sinceTick = 0; await tick() }
        if (!r.digest) {
          if (r.error !== 'cancelled') note(job, p, r.error ?? 'could not be read')
          return
        }
        const l = byTail.get(r.digest)
        if (l) l.push(c)
        else byTail.set(r.digest, [c])
      }, stop)
      if (job.cancelled) break
      emit(job, [...byTail.values()].filter(x => x.length >= 2))
    }
    job.prog.stage = 'head'
  }
  live = []

  // ---- result ----
  // The groups were streamed as they were confirmed; this is the same list,
  // sorted the way a FINISHED scan should be. The dialog keeps arrival order
  // while a scan runs (rows must not move under a selection) and adopts this
  // order when it completes.
  const groups = [...job.found].sort((a, b) => b.wasted - a.wasted || b.size - a.size
    || (a.files[0].path < b.files[0].path ? -1 : 1))

  return {
    scanId: job.id,
    groups,
    roots: job.roots,
    filesScanned: job.prog.filesSeen,
    candidates: job.prog.candidates,
    bytesHashed: job.prog.bytesHashed,
    elapsedMs: Date.now() - job.startedAt,
    remote: job.remote,
    cancelled: job.cancelled,
    truncated: job.truncated,
    hardLinks: job.hardLinks,
    unreadable: job.unreadable,
    errors: job.errors,
  }
}

/**
 * Start a scan. Returns the scanId immediately; progress (and, exactly once,
 * the finished result) arrive on DUP_PUSH addressed to the calling window only.
 */
export function startDupScan(wc: WebContents, req: DupScanRequest): number {
  const id = nextScan++
  const roots = normalizeDupRoots(req.roots ?? [])
  const job: Job = {
    id,
    cancelled: false,
    wc,
    roots,
    subfolders: req.subfolders !== false,
    minSize: Math.max(0, Math.floor(req.minSize ?? 1)),
    includeHidden: !!req.includeHidden,
    remote: false,
    startedAt: Date.now(),
    prog: {
      scanId: id, stage: 'walking', dirsSeen: 0, filesSeen: 0, candidates: 0,
      stageDone: 0, stageTotal: 0, bytesHashed: 0, current: '', done: false,
      foundGroups: 0, foundWasted: 0,
    },
    errors: [],
    unreadable: 0,
    hardLinks: 0,
    truncated: false,
    timer: null,
    found: [],
    pending: [],
    seq: 0,
    detached: false,
  }
  jobs.set(id, job)
  // ~4 pushes a second, and the window closing is itself a cancel — nobody is
  // left to read the answer, and on a share the reads cost real money
  // A destroyed window DETACHES the scan; it no longer cancels it. Closing the
  // dialog (or the whole window) used to throw away every byte hashed so far,
  // which on a network share is minutes of work for a folder someone glanced
  // at. The scan keeps going into `found`, and whoever attaches next gets it.
  job.timer = setInterval(() => {
    if (job.wc?.isDestroyed()) detachDupScan(job.id)
    push(job)
  }, PUSH_MS)

  void runScan(job)
    .then(result => {
      job.prog.stage = job.cancelled ? 'cancelled' : 'done'
      job.prog.current = ''
      job.prog.done = true
      push(job, { result })
    })
    .catch((e: unknown) => {
      job.prog.stage = 'cancelled'
      job.prog.done = true
      push(job, {
        result: {
          scanId: id, groups: [], roots, filesScanned: job.prog.filesSeen,
          candidates: job.prog.candidates, bytesHashed: job.prog.bytesHashed,
          elapsedMs: Date.now() - job.startedAt, remote: job.remote, cancelled: true,
          truncated: job.truncated, hardLinks: job.hardLinks, unreadable: job.unreadable,
          errors: [...job.errors, { path: roots[0] ?? '', error: String((e as Error)?.message ?? e) }],
        },
      })
    })
    .finally(() => {
      void saveHashCache()
      if (job.timer) clearInterval(job.timer)
      job.timer = null
      // A finished scan is kept for a while rather than dropped: someone who
      // closed the dialog while it ran should be able to come back and collect
      // the answer, which is the entire point of letting it outlive the dialog.
      setTimeout(() => jobs.delete(id), FINISHED_TTL_MS).unref?.()
    })

  return id
}

export function cancelDupScan(id: number): void {
  const job = jobs.get(id)
  if (job) job.cancelled = true
}

/** Stop sending to the window, but keep scanning. */
export function detachDupScan(id: number): void {
  const job = jobs.get(id)
  if (!job) return
  job.wc = null
  job.detached = true
}

/**
 * Re-attach a window to a scan and hand back everything found so far.
 *
 * Replaying `found` rather than only continuing live is what makes closing the
 * dialog safe: reopening shows the whole picture, not just the groups that
 * happen to arrive after you came back.
 */
export function attachDupScan(wc: WebContents, id: number): DupAttachReply {
  const job = jobs.get(id)
  if (!job) return { ok: false }
  job.wc = wc
  job.detached = false
  return { ok: true, progress: { ...job.prog }, groups: [...job.found] }
}

/** Scans worth offering to re-open. */
export function listDupScans(): DupScanSummary[] {
  return [...jobs.values()].map(j => ({
    scanId: j.id,
    roots: j.roots,
    stage: j.prog.stage,
    done: j.prog.done,
    foundGroups: j.found.length,
    foundWasted: j.prog.foundWasted,
    filesSeen: j.prog.filesSeen,
    startedAt: j.startedAt,
  }))
}

// ---------------------------------------------------------------- ipc

// Self-registered like ops/quick.ts — main/ipc.ts stays untouched.
ipcMain.handle(CH('startDupScan'), (e: IpcMainInvokeEvent, req: DupScanRequest) =>
  startDupScan(e.sender, req))
ipcMain.handle(CH('cancelDupScan'), (_e, id: number) => { cancelDupScan(id) })
ipcMain.handle(CH('detachDupScan'), (_e, id: number) => { detachDupScan(id) })
ipcMain.handle(CH('attachDupScan'), (e: IpcMainInvokeEvent, id: number) => attachDupScan(e.sender, id))
ipcMain.handle(CH('listDupScans'), () => listDupScans())
ipcMain.handle(CH('getDupPrefs'), () => getDupPrefs())
ipcMain.handle(CH('setDupPrefs'), (_e, patch: Partial<DupPrefs>) => setDupPrefs(patch))
