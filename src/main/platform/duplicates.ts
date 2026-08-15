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
  type DupScanRequest, type DupScanResult,
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
  wc: WebContents
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

function push(job: Job, extra?: Partial<DupProgress>): void {
  if (job.wc.isDestroyed()) return
  job.wc.send(DUP_PUSH, { ...job.prog, ...extra })
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

  // ---- stage 2: head sample ----
  // A file at or below DUP_HEAD_BYTES is COMPLETELY covered by this read, so it
  // is already content-verified and skips stage 3.
  job.prog.stage = 'head'
  job.prog.stageDone = 0
  job.prog.stageTotal = job.prog.candidates
  const verified: Cand[][] = []
  const needTail: Cand[][] = []
  const stop = (): boolean => job.cancelled
  let sinceTick = 0

  for (const group of live) {
    if (job.cancelled) break
    const size = group[0].size
    if (size === 0) {
      // only reachable with minSize 0: every empty file has identical content,
      // and there is nothing to read to prove it
      job.prog.stageDone += group.length
      verified.push(group)
      continue
    }
    const byHead = new Map<string, Cand[]>()
    await pool(group, job.remote ? HASH_POOL_REMOTE : HASH_POOL, async (c) => {
      const p = full(c)
      job.prog.current = p
      const r = await hashRange(p, 0, Math.min(size, DUP_HEAD_BYTES) - 1, stop)
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
    for (const sub of byHead.values()) {
      if (sub.length < 2) continue
      if (size <= DUP_HEAD_BYTES) verified.push(sub)
      else needTail.push(sub)
    }
  }
  live = []

  // ---- stage 3: the rest of the bytes ----
  // The head already matches inside each group, so hashing byte DUP_HEAD_BYTES
  // onwards is enough to decide — nothing is read twice.
  job.prog.stage = 'full'
  job.prog.stageDone = 0
  job.prog.stageTotal = needTail.reduce((n, g) => n + g.length, 0)
  for (const group of needTail) {
    if (job.cancelled) break
    const byTail = new Map<string, Cand[]>()
    await pool(group, job.remote ? HASH_POOL_REMOTE : HASH_POOL, async (c) => {
      const p = full(c)
      job.prog.current = p
      const r = await hashRange(p, DUP_HEAD_BYTES, undefined, stop)
      job.prog.stageDone++
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
    for (const sub of byTail.values()) if (sub.length >= 2) verified.push(sub)
  }

  // ---- results: biggest recoverable space first ----
  const groups: DupGroup[] = verified.map((g, i) => {
    const filesOut: DupFile[] = g
      .map(c => ({ path: full(c), size: c.size, mtime: c.mtime }))
      .sort(byNewest)
    return {
      id: `${g[0].size}-${i}`,
      size: g[0].size,
      wasted: g[0].size * (g.length - 1),
      files: filesOut,
    }
  })
  groups.sort((a, b) => b.wasted - a.wasted || b.size - a.size
    || (a.files[0].path < b.files[0].path ? -1 : 1))
  if (groups.length > MAX_GROUPS) {
    groups.length = MAX_GROUPS
    job.truncated = true
  }

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
    },
    errors: [],
    unreadable: 0,
    hardLinks: 0,
    truncated: false,
    timer: null,
  }
  jobs.set(id, job)
  // ~4 pushes a second, and the window closing is itself a cancel — nobody is
  // left to read the answer, and on a share the reads cost real money
  job.timer = setInterval(() => {
    if (job.wc.isDestroyed()) { job.cancelled = true; return }
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
      if (job.timer) clearInterval(job.timer)
      job.timer = null
      jobs.delete(id)
    })

  return id
}

export function cancelDupScan(id: number): void {
  const job = jobs.get(id)
  if (job) job.cancelled = true
}

// ---------------------------------------------------------------- ipc

// Self-registered like ops/quick.ts — main/ipc.ts stays untouched.
ipcMain.handle(CH('startDupScan'), (e: IpcMainInvokeEvent, req: DupScanRequest) =>
  startDupScan(e.sender, req))
ipcMain.handle(CH('cancelDupScan'), (_e, id: number) => { cancelDupScan(id) })
ipcMain.handle(CH('getDupPrefs'), () => getDupPrefs())
ipcMain.handle(CH('setDupPrefs'), (_e, patch: Partial<DupPrefs>) => setDupPrefs(patch))
