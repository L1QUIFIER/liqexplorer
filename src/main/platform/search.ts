// Search: async BFS name-match walker + optional ripgrep content pass, with an
// index fast path in front of the walker.
// Streams SearchChunk batches (~200 entries or 300ms) on PUSH.searchChunk,
// caps at 10k results, dedupes walker/rg hits, and kills both on cancel.
//
// Name matching comes from the index (opt-in, see platform/indexer.ts) whenever
// settings.searchUseIndex is on and the index covers the searched root — that
// answers in one in-memory scan with zero stat() calls, which is what makes
// searching the CIFS share bearable. Everything else (uncovered roots, index
// off/stale-empty) walks live exactly as before. Content search is always
// ripgrep.
import { spawn, type ChildProcess } from 'node:child_process'
import type { Readable } from 'node:stream'
import * as fsp from 'node:fs/promises'
import * as path from 'node:path'
import { ipcMain, type WebContents } from 'electron'
import { CH, PUSH } from '../../shared/ipc'
import type { FileEntry, SearchChunk, SearchRequest, SearchSource } from '../../shared/types'
import { FINDER_URI } from '../../shared/types'
import { entryFor, isRemotePath } from '../fs/list'
import { getSettings } from '../state/settings'
import { hiddenBelow, indexCovers, indexSearch, nameMatcher, refreshIfStale } from './indexer'
import { ffEnabled, ffSearch, PAGE_LIMIT } from './filefinder'

const MAX_RESULTS = 10_000
const BATCH_SIZE = 200
const FLUSH_MS = 300
const DIR_CONCURRENCY = 16
const RG_STAT_CONCURRENCY = 8

interface SearchJob {
  reqId: number
  wc: WebContents
  cancelled: boolean
  finished: boolean
  rg?: ChildProcess
  /** kills an in-flight FileFinder request, like rg?.kill() kills the child */
  abort?: AbortController
  batch: FileEntry[]
  seen: Set<string>
  count: number
  flushTimer?: NodeJS.Timeout
  error?: string
  /** whichever source actually answered — reported on the final chunk */
  source: SearchSource
  /** the answer was capped, by the server or by MAX_RESULTS */
  truncated?: boolean
  indexAgeHours?: number
}

let nextReq = 1
const jobs = new Map<number, SearchJob>()

export async function startSearch(wc: WebContents, req: SearchRequest): Promise<number> {
  const reqId = nextReq++
  const job: SearchJob = {
    reqId, wc, cancelled: false, finished: false,
    batch: [], seen: new Set(), count: 0, source: 'walk',
  }
  jobs.set(reqId, job)
  job.flushTimer = setInterval(() => {
    // liveness FIRST: flush() used to be the only place a destroyed window was
    // noticed, and it is only reached when there is something to send — so a
    // search that has not matched anything yet (the slow, expensive kind) ran
    // the whole tree, and its rg child with it, for a window that was gone.
    if (job.wc.isDestroyed()) { job.cancelled = true; cleanup(job); return }
    if (job.batch.length) flush(job)
  }, FLUSH_MS)

  void (async () => {
    const tasks: Promise<void>[] = [runNameSearch(job, req)]
    // finder:// has no tree to grep and rg would be handed a URI
    if (req.contents && req.query && req.root !== FINDER_URI) tasks.push(runRipgrep(job, req))
    await Promise.allSettled(tasks)
    finish(job)
    // the index answered from a snapshot: quietly re-scan when it is stale so
    // the next search sees today's tree (no-op when refresh is set to manual)
    if (job.source === 'index') refreshIfStale()
  })()

  return reqId
}

/**
 * Pick a name source and run it: FileFinder -> local index -> live walk, each
 * falling through only on "could not answer" (null), never on "answered, no
 * hits" ([]).
 *
 * Order is deliberate. FileFinder goes first ONLY on a remote path — that is the
 * case it exists for, where the local index cannot cheaply build coverage. On a
 * local disk the local index wins: the user configured it, it honours
 * indexExcludes, and refreshIfStale keeps it fresher than a LAN snapshot.
 */
async function runNameSearch(job: SearchJob, req: SearchRequest): Promise<void> {
  const wholeIndex = req.root === FINDER_URI
  // "Search this folder directly" from the results banner: the point is to
  // bypass every snapshot, so no index gets a turn — except finder://, which is
  // nothing but the index and has no tree to walk.
  const live = !!req.live && !wholeIndex
  const ffFirst = !live && ffEnabled() && (wholeIndex || isRemotePath(req.root))

  if (ffFirst && await fromFileFinder(job, req)) return
  if (!live && !wholeIndex && searchUsesIndex(req.root, req.showHidden) && await fromIndex(job, req)) return
  // a whole-index search has no tree to fall back to — an empty answer with the
  // banner explaining why beats walking something that was never asked for
  if (wholeIndex) { job.source = 'filefinder'; return }
  job.source = 'walk'
  await walk(job, req, makeMatcher(req.query))
}

/**
 * True when a search rooted at `root` would be answered from the index.
 * `showHidden` matters: an index built without hidden files cannot answer a
 * "show hidden items" search, so that case walks live instead of quietly
 * returning fewer results than the folder actually holds.
 */
export function searchUsesIndex(root: string, showHidden = false): boolean {
  const s = getSettings()
  return s.searchUseIndex && (!showHidden || s.indexHidden) && indexCovers(root)
}

// Self-registered like ops/quick.ts (main/ipc.ts stays untouched). The results
// view can ask this to show Explorer's "searches might be slow in non-indexed
// locations" banner without re-deriving the coverage rules.
ipcMain.handle(CH('searchUsesIndex'), (_e, root: string, showHidden?: boolean) =>
  searchUsesIndex(root, showHidden))

export function cancelSearch(reqId: number): void {
  const job = jobs.get(reqId)
  if (!job) return
  job.cancelled = true
  cleanup(job)
}

// ---------------------------------------------------------------- lifecycle

function cleanup(job: SearchJob): void {
  if (job.flushTimer) { clearInterval(job.flushTimer); job.flushTimer = undefined }
  // every way a job ends goes through here, so this is the one place that can
  // promise the child dies with it — rg outlives cancel/window-close otherwise
  // and keeps scanning a CIFS tree for minutes with nobody left to read it
  try { job.rg?.kill() } catch { /* already exited */ }
  // same promise for the HTTP request: a cancelled search must not leave a
  // socket and a 6s timer alive against a host that may be gone
  try { job.abort?.abort() } catch { /* already settled */ }
  jobs.delete(job.reqId)
}

function flush(job: SearchJob, done = false): void {
  if (job.cancelled) return
  if (job.wc.isDestroyed()) { job.cancelled = true; cleanup(job); return }
  const chunk: SearchChunk = {
    reqId: job.reqId,
    entries: job.batch.splice(0, job.batch.length),
    done,
  }
  if (done) {
    if (job.error) chunk.error = job.error
    chunk.source = job.source
    // either the server capped its page or we hit our own ceiling; both mean
    // "this is not the whole answer" and the results view has to say so
    chunk.truncated = job.truncated || job.count >= MAX_RESULTS
    if (job.indexAgeHours !== undefined) chunk.indexAgeHours = job.indexAgeHours
  }
  job.wc.send(PUSH.searchChunk, chunk)
}

function finish(job: SearchJob): void {
  if (job.finished) return
  job.finished = true
  if (!job.cancelled) flush(job, true)
  cleanup(job)
}

// ---------------------------------------------------------------- matching

/**
 * Case-insensitive substring by default; '*'/'?' switch to whole-name wildcard
 * matching (everything else escaped). Lives in indexer.ts so the live walker
 * and the index cannot drift apart on what "matches" means.
 */
const makeMatcher = nameMatcher

/** push an already-built entry (index hits: no stat, that is the point) */
function addEntry(job: SearchJob, e: FileEntry): void {
  if (job.cancelled || job.count >= MAX_RESULTS) return
  if (job.seen.has(e.path)) return
  job.seen.add(e.path)
  job.count++
  job.batch.push(e)
  if (job.count >= MAX_RESULTS) {
    try { job.rg?.kill() } catch { /* already exited */ }
  }
  if (job.batch.length >= BATCH_SIZE) flush(job)
}

async function addResult(job: SearchJob, dir: string, name: string): Promise<void> {
  if (job.cancelled || job.count >= MAX_RESULTS) return
  const full = path.join(dir, name)
  if (job.seen.has(full)) return
  job.seen.add(full)
  const e = await entryFor(dir, name)
  if (!e || job.cancelled || job.count >= MAX_RESULTS) return
  job.count++
  job.batch.push(e)
  // cap reached: stop ripgrep now so its 'close' lets the job finish promptly
  if (job.count >= MAX_RESULTS) {
    try { job.rg?.kill() } catch { /* already exited */ }
  }
  if (job.batch.length >= BATCH_SIZE) flush(job)
}

// ---------------------------------------------------------------- index path

/**
 * Answer from the index. Same streaming contract as the walker: entries land in
 * the same batch/dedupe set, so ripgrep hits merge in and the 10k cap applies
 * unchanged.
 *
 * The fallback hangs on indexSearch's null/[] distinction, NOT on the result
 * being empty: null means the index could not answer (cleared between the check
 * and the read, db missing or unreadable, root not really covered) and the tree
 * must be walked live. Treating "no rows" as an answer is how a folder full of
 * matches came back as a confident "No items match your search".
 */
async function fromIndex(job: SearchJob, req: SearchRequest): Promise<boolean> {
  let hits: FileEntry[] | null
  try {
    hits = await indexSearch(req.query, {
      root: req.root,
      subfolders: req.subfolders,
      showHidden: req.showHidden,
      limit: MAX_RESULTS,
    })
  } catch { hits = null }
  if (job.cancelled) return true
  if (hits === null) return false
  job.source = 'index'
  await drain(job, hits)
  return true
}

/** push entries with a yield every so often so the flush timer can breathe */
async function drain(job: SearchJob, hits: FileEntry[]): Promise<void> {
  for (let i = 0; i < hits.length; i++) {
    if (job.cancelled || job.count >= MAX_RESULTS) break
    addEntry(job, hits[i])
    if ((i & 1023) === 1023) await new Promise<void>(res => setImmediate(res))
  }
}

// ---------------------------------------------------------------- FileFinder

/**
 * Answer from the LAN index. Same null contract as fromIndex.
 *
 * The two filters below are not optional. The server's `q` goes into a SQL LIKE
 * with '%' and '_' left live, so it returns a SUPERSET of what this app means by
 * the query — nameMatcher puts that back. And it indexes dotfiles
 * unconditionally, while both other sources never descend into a dot directory;
 * hiddenBelow reproduces that rule rather than restating it.
 */
async function fromFileFinder(job: SearchJob, req: SearchRequest): Promise<boolean> {
  const wholeIndex = req.root === FINDER_URI
  job.abort = new AbortController()
  let res
  try {
    res = await ffSearch(req.query, {
      root: wholeIndex ? null : req.root,
      subfolders: req.subfolders,
      limit: PAGE_LIMIT,
      signal: job.abort.signal,
    })
  } catch { res = null } finally { job.abort = undefined }
  if (job.cancelled) return true
  if (!res) return false

  const match = makeMatcher(req.query)
  const kept: FileEntry[] = []
  for (const row of res.rows) {
    if (!match(row.entry.name)) continue
    if (!req.showHidden) {
      if (row.entry.hidden) continue
      const slash = row.entry.path.lastIndexOf('/')
      const dir = slash <= 0 ? '/' : row.entry.path.slice(0, slash)
      // whole-index results span several mounts, so there is no single search
      // root to measure from — '/' works because no mount path here has a dot
      // segment of its own
      if (hiddenBelow(dir, wholeIndex ? '/' : req.root)) continue
    }
    kept.push(row.entry)
  }

  job.source = 'filefinder'
  // the server capped BEFORE these filters ran, so a truncated page that loses
  // rows here is doubly incomplete — the banner has to say so either way
  job.truncated = res.truncated
  job.indexAgeHours = res.ageHours
  await drain(job, kept)
  return true
}

// ---------------------------------------------------------------- name walker

/** breadth-first walk from req.root, up to DIR_CONCURRENCY dirs in flight */
async function walk(job: SearchJob, req: SearchRequest, match: (n: string) => boolean): Promise<void> {
  let level: string[] = [req.root]
  let isRoot = true
  while (level.length && !job.cancelled && job.count < MAX_RESULTS) {
    const next: string[] = []
    for (let i = 0; i < level.length && !job.cancelled && job.count < MAX_RESULTS; i += DIR_CONCURRENCY) {
      const slice = level.slice(i, i + DIR_CONCURRENCY)
      await Promise.all(slice.map(d => walkDir(job, req, match, d, next, isRoot)))
    }
    if (!req.subfolders) break
    level = next
    isRoot = false
  }
}

async function walkDir(
  job: SearchJob, req: SearchRequest, match: (n: string) => boolean,
  dir: string, next: string[], isRoot: boolean,
): Promise<void> {
  let handle: Awaited<ReturnType<typeof fsp.opendir>>
  try {
    handle = await fsp.opendir(dir)
  } catch (e: any) {
    if (isRoot) job.error = String(e?.message ?? e)
    return
  }
  try {
    for await (const d of handle) {
      if (job.cancelled || job.count >= MAX_RESULTS) break
      const name = d.name
      if (!req.showHidden && name.startsWith('.')) continue
      if (match(name)) await addResult(job, dir, name)
      // plain dirs only: never follow symlinked dirs (cycle safety)
      if (req.subfolders && d.isDirectory()) next.push(path.join(dir, name))
    }
  } catch { /* unreadable mid-walk: skip the rest of this dir */ }
}

// ---------------------------------------------------------------- content search (ripgrep)

function runRipgrep(job: SearchJob, req: SearchRequest): Promise<void> {
  return new Promise((resolve) => {
    const args = [
      '--files-with-matches', '-i', '--fixed-strings',
      '--no-messages', '--max-filesize', '10M', '--no-ignore',
    ]
    if (req.showHidden) args.push('--hidden')
    if (!req.subfolders) args.push('--max-depth', '1')
    args.push('--', req.query, req.root)

    let child: ChildProcess & { stdout: Readable }
    try {
      child = spawn('rg', args, { stdio: ['ignore', 'pipe', 'ignore'] })
    } catch { resolve(); return }
    job.rg = child

    // stream stdout lines -> stat pool -> merged into the same batch/dedupe set
    const lines: string[] = []
    let buf = ''
    let readerDone = false
    let inFlight = 0
    const pump = (): void => {
      while (inFlight < RG_STAT_CONCURRENCY && lines.length && !job.cancelled) {
        const line = lines.shift()!
        inFlight++
        void addResult(job, path.dirname(line), path.basename(line))
          .catch(() => { /* stat raced a delete */ })
          .finally(() => { inFlight--; pump() })
      }
      if (readerDone && inFlight === 0 && (lines.length === 0 || job.cancelled)) resolve()
    }
    child.stdout.on('data', (d: Buffer) => {
      if (job.cancelled) return
      buf += d.toString('utf8')
      const parts = buf.split('\n')
      buf = parts.pop() ?? ''
      for (const p of parts) if (p) lines.push(p)
      pump()
    })
    child.on('error', () => { readerDone = true; pump() })
    child.on('close', () => {
      if (buf.trim() && !job.cancelled) lines.push(buf.trim())
      readerDone = true
      pump()
    })
  })
}
