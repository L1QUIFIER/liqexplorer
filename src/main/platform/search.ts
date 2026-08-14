// Search: async BFS name-match walker + optional ripgrep content pass.
// Streams SearchChunk batches (~200 entries or 300ms) on PUSH.searchChunk,
// caps at 10k results, dedupes walker/rg hits, and kills both on cancel.
import { spawn, type ChildProcess } from 'node:child_process'
import type { Readable } from 'node:stream'
import * as fsp from 'node:fs/promises'
import * as path from 'node:path'
import type { WebContents } from 'electron'
import { PUSH } from '../../shared/ipc'
import type { FileEntry, SearchChunk, SearchRequest } from '../../shared/types'
import { entryFor } from '../fs/list'

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
  batch: FileEntry[]
  seen: Set<string>
  count: number
  flushTimer?: NodeJS.Timeout
  error?: string
}

let nextReq = 1
const jobs = new Map<number, SearchJob>()

export async function startSearch(wc: WebContents, req: SearchRequest): Promise<number> {
  const reqId = nextReq++
  const job: SearchJob = {
    reqId, wc, cancelled: false, finished: false,
    batch: [], seen: new Set(), count: 0,
  }
  jobs.set(reqId, job)
  job.flushTimer = setInterval(() => { if (job.batch.length) flush(job) }, FLUSH_MS)

  void (async () => {
    const match = makeMatcher(req.query)
    const tasks: Promise<void>[] = [walk(job, req, match)]
    if (req.contents && req.query) tasks.push(runRipgrep(job, req))
    await Promise.allSettled(tasks)
    finish(job)
  })()

  return reqId
}

export function cancelSearch(reqId: number): void {
  const job = jobs.get(reqId)
  if (!job) return
  job.cancelled = true
  try { job.rg?.kill() } catch { /* already exited */ }
  cleanup(job)
}

// ---------------------------------------------------------------- lifecycle

function cleanup(job: SearchJob): void {
  if (job.flushTimer) { clearInterval(job.flushTimer); job.flushTimer = undefined }
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
  if (done && job.error) chunk.error = job.error
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
 * Case-insensitive substring by default; '*'/'?' switch to whole-name
 * wildcard matching (everything else escaped).
 */
function makeMatcher(query: string): (name: string) => boolean {
  if (/[*?]/.test(query)) {
    const re = new RegExp(
      '^' + query.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$',
      'i',
    )
    return (name) => re.test(name)
  }
  const q = query.toLowerCase()
  return (name) => name.toLowerCase().includes(q)
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
