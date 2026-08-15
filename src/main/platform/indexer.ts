// Opt-in file-name index — the app's answer to "Searches might be slow in
// non-indexed locations". plocate is installed on this machine but
// /etc/updatedb.conf PRUNEFS lists cifs/smbfs/nfs, so the system database can
// never cover the CIFS share that matters most here; Windows likewise never
// indexes network drives locally. So we keep our own.
//
// STORAGE — a flat, front-coded text file in ~/.local/state/liqexplorer
// (never next to the code: that lives on the CIFS share, shared with Windows).
// No native modules are allowed here (no better-sqlite3, no node:sqlite), so
// the format is deliberately dumb and scan-friendly. One tagged line each:
//
//   #liqindex1 <builtAt>
//   r<TAB>/root/path                              covered root
//   d<TAB>/dir/path                               directory block header
//   e<TAB>name<TAB>flags<TAB>size<TAB>mtime       entry in the current block
//
// flags: 'd' dir | 'f' file, plus 'l' symlink, 'h' hidden. Names and paths
// escape \ TAB LF CR. Front-coding the directory once per block (instead of a
// full path per row) costs ~1 line per directory and saves ~60% of the bytes;
// a search is then one linear scan that only allocates for the hits. The whole
// file is loaded lazily on the first query (never at startup) and dropped when
// indexing is turned off.
//
// The build streams straight to a temp file, so peak memory during a scan is a
// single ~1 MB chunk, and lands with a rename (atomic).
import { ipcMain, BrowserWindow, dialog } from 'electron'
import * as fs from 'node:fs'
import * as fsp from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import type { IpcMainInvokeEvent } from 'electron'
import { CH, PUSH } from '../../shared/ipc'
import type { FileEntry, IndexStatus } from '../../shared/types'
import { getSettings, stateDir } from '../state/settings'
import { entryNoStat, isRemotePath, mountPoints } from '../fs/list'

const MAGIC = '#liqindex1'
const DB_NAME = 'index.db'
const META_NAME = 'index.meta.json'
/** flush the write stream roughly every megabyte */
const CHUNK_CHARS = 1 << 20
/** lstat fan-out inside one directory (mirrors fs/list.ts STAT_POOL) */
const STAT_POOL = 48
/** yield to the event loop after this many directories */
const DIRS_PER_TICK = 8
/** status push cadence while scanning */
const STATUS_MS = 300
/** hard ceiling so a runaway root can never eat the disk/RAM */
const MAX_ENTRIES = 2_000_000
/** never descend into these, whatever the roots say */
const SKIP_DIRS = new Set(['/proc', '/sys', '/dev', '/run', '/var/run', '/var/lock', '/lost+found'])
/** a rebuild is offered when the index is older than this and a search used it */
const STALE_MS = 30 * 60_000
/**
 * Ceiling on ONE readdir/lstat batch (fs/watch.ts uses 5s for a single stat;
 * a directory listing on a busy share legitimately takes longer). The CIFS
 * share here is mounted `hard`, so a dead server never returns an error — the
 * call simply retries forever — and without this the scan, the status pushes
 * and every later build are wedged for the life of the process.
 */
const IO_TIMEOUT_MS = 15_000
/** timeouts inside one root before the whole root is abandoned as unreachable */
const MAX_TIMEOUTS_PER_ROOT = 3
/** supervisor cadence: refresh scheduling + wedged-scan detection */
const SUPERVISOR_MS = 60_000
/** consecutive supervisor ticks with zero progress before a scan is abandoned */
const STALL_TICKS = 2

interface IndexMeta {
  /** 2 = adds `covered`; a v1 file is ignored and rebuilt (it over-claimed) */
  version: 2
  builtAt: number
  /** the roots this build was CONFIGURED with (drift detection) */
  roots: string[]
  /** the roots actually walked to completion — the only ones searches may use */
  covered: string[]
  files: number
  dirs: number
}

interface Scan {
  cancelled: boolean
  root: string
  seen: number
  /** dirs + entries; only used to tell "slow" from "wedged" */
  progress: number
  lastProgress: number
  stallTicks: number
}

let meta: IndexMeta | null = null
let metaLoaded = false
/** whole db text, loaded on demand; null = not loaded / invalidated */
let text: string | null = null
let scan: Scan | null = null
let lastError = ''
let statusTimer: NodeJS.Timeout | null = null
/** the user said stop (Clear/Cancel): the supervisor must not undo that */
let autoBuildBlocked = false
/** when a build last STARTED — failures retry on the interval, not every tick */
let lastBuildAttempt = 0

const dbPath = (): string => path.join(stateDir(), DB_NAME)
const metaPath = (): string => path.join(stateDir(), META_NAME)

// ---------------------------------------------------------------- text codec

const NEEDS_ESC = /[\\\t\n\r]/
function esc(s: string): string {
  if (!NEEDS_ESC.test(s)) return s
  return s.replace(/\\/g, '\\\\').replace(/\t/g, '\\t').replace(/\n/g, '\\n').replace(/\r/g, '\\r')
}
function unesc(s: string): string {
  if (!s.includes('\\')) return s
  return s.replace(/\\(.)/g, (_m, c: string) =>
    c === 't' ? '\t' : c === 'n' ? '\n' : c === 'r' ? '\r' : c)
}

// ---------------------------------------------------------------- matching

/**
 * Case-insensitive substring by default; '*'/'?' switch to whole-name wildcard
 * matching (everything else escaped). Shared with the live walker in search.ts
 * so both search paths agree on what "matches" means.
 */
export function nameMatcher(query: string): (name: string) => boolean {
  if (/[*?]/.test(query)) {
    const re = new RegExp(
      '^' + query.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$',
      'i',
    )
    return (name) => re.test(name)
  }
  const q = query.toLowerCase()
  if (!q) return () => true
  return (name) => name.toLowerCase().includes(q)
}

// ---------------------------------------------------------------- roots

/** absolute, trailing-slash-free, deduped, nested roots folded into parents */
export function normalizeRoots(list: string[]): string[] {
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

function under(p: string, root: string): boolean {
  return p === root || p.startsWith(root === '/' ? '/' : root + '/')
}

/**
 * True when the index is built and ACTUALLY holds p's subtree. `covered` is
 * what was walked to completion, not what was configured: a root that was
 * unreadable at scan time (offline share) or cut off by MAX_ENTRIES has no
 * entries in the db, and claiming it here is what turns "the index cannot
 * answer" into a confident "no items match your search".
 */
export function indexCovers(p: string): boolean {
  const m = loadMeta()
  if (!m || !m.builtAt || !getSettings().indexEnabled) return false
  return m.covered.some(r => under(p, r))
}

// ---------------------------------------------------------------- metadata

function loadMeta(): IndexMeta | null {
  if (metaLoaded) return meta
  metaLoaded = true
  try {
    const j = JSON.parse(fs.readFileSync(metaPath(), 'utf8')) as IndexMeta
    if (j && j.version === 2 && Array.isArray(j.roots) && Array.isArray(j.covered)) meta = j
  } catch { meta = null }
  return meta
}

/**
 * Forget the on-disk index. Called when the db turns out to be unusable: the
 * meta must stop claiming coverage the moment we know we cannot read the rows,
 * or every search under those roots answers "no matches" from thin air.
 */
function invalidateMeta(why: string): void {
  meta = null
  metaLoaded = true
  text = null
  lastError = why
}

function dbBytes(): number {
  try { return fs.statSync(dbPath()).size } catch { return 0 }
}

export function getIndexStatus(): IndexStatus {
  const m = loadMeta()
  const enabled = getSettings().indexEnabled
  const st: IndexStatus = {
    state: lastError ? 'error' : scan ? 'scanning' : !enabled ? 'off' : m?.builtAt ? 'ready' : 'idle',
    // what searches may actually be answered from — never the wish list
    roots: m?.covered ?? [],
    files: m?.files ?? 0,
    dirs: m?.dirs ?? 0,
    lastBuilt: m?.builtAt ?? 0,
    dbBytes: dbBytes(),
  }
  if (scan) st.scanning = { root: scan.root, seen: scan.seen }
  if (lastError) st.error = lastError
  return st
}

function broadcast(): void {
  const st = getIndexStatus()
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed() && !w.webContents.isDestroyed()) w.webContents.send(PUSH.indexStatus, st)
  }
}

// ---------------------------------------------------------------- building

const tick = (): Promise<void> => new Promise<void>(res => setImmediate(res))

function excluded(p: string, excludes: string[]): boolean {
  if (!excludes.length) return false
  const probe = p + '/'
  for (const ex of excludes) {
    const e = ex.trim()
    if (e && probe.includes(e)) return true
  }
  return false
}

/** mount prefixes whose filesystem is remote — never crossed from a local root */
function remotePrefixes(): string[] {
  return mountPoints().filter(mp => mp !== '/' && isRemotePath(mp))
}

type Timed<T> = { timedOut: true; value: null } | { timedOut: false; value: T }

/**
 * Race an fs call against a timer. `p` must never reject (callers .catch first),
 * so the only two outcomes are a value and a timeout.
 *
 * IMPORTANT, and the reason the supervisor below exists: abandoning the promise
 * does NOT free the libuv work request — the blocked readdir/lstat still pins
 * its threadpool thread until the kernel gives up (never, on a `hard` mount).
 * What this buys is that the scan stops QUEUEING more of them, notices
 * cancellation, and can finish; fs/watch.ts's header says the same thing.
 */
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

/** backpressure-aware write that never hangs when the stream dies mid-build */
async function writeChunk(ws: fs.WriteStream, s: string): Promise<void> {
  if (ws.write(s)) return
  await new Promise<void>((res, rej) => {
    const ok = (): void => { ws.off('error', bad); ws.off('close', bad); res() }
    const bad = (e?: Error): void => { ws.off('drain', ok); rej(e ?? new Error('index write stream closed')) }
    ws.once('drain', ok)
    ws.once('error', bad)
    ws.once('close', bad)
  })
}

/**
 * A build that finished but does not cover everything it was asked to. This is
 * the only cue the user gets that a folder is missing from the index, so it
 * names the folders and says what happens instead (IndexStatus.error, shown in
 * Options ▸ Search).
 */
function incompleteBuildError(unreadable: string[], unresponsive: string[], capped: boolean): string {
  const parts: string[] = []
  if (unreadable.length) parts.push(`${unreadable.join(', ')} could not be read`)
  if (unresponsive.length) parts.push(`${unresponsive.join(', ')} stopped responding`)
  if (capped) parts.push(`the ${MAX_ENTRIES.toLocaleString()}-item limit was reached`)
  if (!parts.length) return ''
  return `The index is incomplete: ${parts.join('; ')}. `
    + 'Searching those folders scans them directly instead.'
}

/**
 * Rebuild the whole index. Cancellable, and yields to the event loop every
 * DIRS_PER_TICK directories so the main process stays responsive.
 */
async function runBuild(job: Scan): Promise<void> {
  const s = getSettings()
  const roots = normalizeRoots(s.indexRoots)
  const excludes = s.indexExcludes ?? []
  const showHidden = s.indexHidden
  const remotes = remotePrefixes()
  const dir = stateDir()
  const tmp = path.join(dir, DB_NAME + '.tmp')

  let files = 0
  let dirs = 0
  let entries = 0
  let pending = `${MAGIC} ${Date.now()}\n`
  for (const r of roots) pending += `r\t${esc(r)}\n`

  // a root only earns coverage by being walked to the end; everything else is
  // reported instead of quietly pretending the index can answer for it
  const covered: string[] = []
  const unreadable: string[] = []
  const unresponsive: string[] = []
  let capped = false

  const ws = fs.createWriteStream(tmp)
  let wsError: Error | null = null
  ws.on('error', (e: Error) => { wsError = e })
  const closed = new Promise<void>(res => ws.once('close', () => res()))

  try {
    for (const root of roots) {
      if (job.cancelled) break
      job.root = root
      const rootRemote = isRemotePath(root)
      const stack: string[] = [root]
      let sinceTick = 0
      let rootOk = true
      let timeouts = 0

      /** returns true when this root is hopeless and must be abandoned */
      const noteTimeout = (): boolean => {
        rootOk = false
        if (!unresponsive.includes(root)) unresponsive.push(root)
        return ++timeouts >= MAX_TIMEOUTS_PER_ROOT
      }

      while (stack.length && !job.cancelled && entries < MAX_ENTRIES) {
        const cur = stack.pop()!
        const read = await withTimeout(
          fsp.readdir(cur, { withFileTypes: true }).catch(() => null), IO_TIMEOUT_MS)
        if (read.timedOut) {
          // the mount stopped answering: drop this subtree, and once that has
          // happened a few times stop feeding the dead server entirely
          if (noteTimeout()) stack.length = 0
          continue
        }
        const names = read.value
        if (!names) {                 // unreadable: skip the whole subtree
          if (cur === root) rootOk = false
          continue
        }
        dirs++
        job.progress++
        pending += `d\t${esc(cur)}\n`
        /** this root is unreachable: finish the current directory and stop */
        let giveUp = false

        for (let i = 0; i < names.length && !job.cancelled; i += STAT_POOL) {
          const slice = names.slice(i, i + STAT_POOL)
          const batch = await withTimeout(Promise.all(slice.map(d =>
            fsp.lstat(path.join(cur, d.name)).catch(() => null))), IO_TIMEOUT_MS)
          if (batch.timedOut) {
            // never queue the next 48 lstats behind a server that is not
            // answering the current 48
            giveUp = noteTimeout()
            break
          }
          const stats = batch.value
          for (let k = 0; k < slice.length; k++) {
            const name = slice[k].name
            const st = stats[k]
            if (!st) continue
            const hidden = name.startsWith('.')
            if (hidden && !showHidden) continue
            const full = path.join(cur, name)
            if (excluded(full, excludes)) continue
            const isLink = st.isSymbolicLink()
            let isDir = st.isDirectory()
            if (isLink) {
              // resolve only to label it — symlinked dirs are never descended
              // into (that is the cycle guard), so this costs one stat each
              const t = await withTimeout(fsp.stat(full).catch(() => null), IO_TIMEOUT_MS)
              if (t.timedOut) {
                if (noteTimeout()) { giveUp = true; break }
                continue
              }
              isDir = !!t.value?.isDirectory()
            }
            const flags = (isDir ? 'd' : 'f') + (isLink ? 'l' : '') + (hidden ? 'h' : '')
            const size = isDir ? -1 : st.size
            pending += `e\t${esc(name)}\t${flags}\t${size}\t${Math.round(st.mtimeMs)}\n`
            entries++
            job.seen++
            job.progress++
            if (isDir) {
              if (isLink) continue
              if (SKIP_DIRS.has(full)) continue
              if (!rootRemote && remotes.some(mp => under(full, mp))) continue
              stack.push(full)
            } else {
              files++
            }
          }
          if (giveUp) break
          if (pending.length >= CHUNK_CHARS) {
            await writeChunk(ws, pending)
            pending = ''
          }
        }
        // whatever this directory managed to yield is kept; the root just stops
        if (giveUp) stack.length = 0
        if (pending.length >= CHUNK_CHARS) { await writeChunk(ws, pending); pending = '' }
        if (++sinceTick >= DIRS_PER_TICK) { sinceTick = 0; await tick() }
      }

      if (job.cancelled) break
      let cutOff = false
      if (entries >= MAX_ENTRIES && stack.length) { capped = true; cutOff = true; rootOk = false }
      if (rootOk) covered.push(root)
      else if (!cutOff && !unresponsive.includes(root)) unreadable.push(root)
    }

    if (pending) await writeChunk(ws, pending)
    ws.end()
    await closed
    if (wsError) throw wsError

    if (job.cancelled) { await fsp.unlink(tmp).catch(() => {}); return }

    await fsp.rename(tmp, dbPath())
    meta = { version: 2, builtAt: Date.now(), roots, covered, files, dirs }
    metaLoaded = true
    await fsp.writeFile(metaPath() + '.tmp', JSON.stringify(meta))
    await fsp.rename(metaPath() + '.tmp', metaPath())
    text = null                        // reloaded lazily on the next query
    lastError = incompleteBuildError(unreadable, unresponsive, capped)
  } catch (e) {
    try { ws.destroy() } catch { /* already gone */ }
    await fsp.unlink(tmp).catch(() => {})
    if (!job.cancelled) lastError = String((e as Error)?.message ?? e)
  }
}

/** start (or restart) a full build; returns the status right after it starts */
export function buildIndex(): IndexStatus {
  if (scan) return getIndexStatus()
  lastError = ''
  // an explicit build is the user asking for one: it lifts a previous
  // Clear/Cancel block, and it is the only thing that does
  autoBuildBlocked = false
  lastBuildAttempt = Date.now()
  const job: Scan = { cancelled: false, root: '', seen: 0, progress: 0, lastProgress: -1, stallTicks: 0 }
  scan = job
  if (!statusTimer) statusTimer = setInterval(broadcast, STATUS_MS)
  void runBuild(job).finally(() => {
    if (scan === job) scan = null
    if (statusTimer && !scan) { clearInterval(statusTimer); statusTimer = null }
    broadcast()
  })
  broadcast()
  return getIndexStatus()
}

export function cancelIndex(): IndexStatus {
  if (scan) scan.cancelled = true
  // "Cancel" that restarts itself a minute later is not a cancel
  autoBuildBlocked = true
  return getIndexStatus()
}

export async function clearIndex(): Promise<IndexStatus> {
  if (scan) scan.cancelled = true
  await fsp.unlink(dbPath()).catch(() => {})
  await fsp.unlink(metaPath()).catch(() => {})
  meta = null
  metaLoaded = true
  text = null
  lastError = ''
  // "no meta" is also what "enabled but never built" looks like, so without
  // this the supervisor rebuilds the index the user just deleted within 60s
  autoBuildBlocked = true
  broadcast()
  return getIndexStatus()
}

// ---------------------------------------------------------------- querying

async function ensureLoaded(): Promise<boolean> {
  if (text !== null) return true
  if (!loadMeta()?.builtAt) return false
  try {
    const t = await fsp.readFile(dbPath(), 'utf8')
    if (!t.startsWith(MAGIC)) {
      invalidateMeta('The search index file is damaged and was ignored. Rebuild it from Options ▸ Search.')
      return false
    }
    text = t
    return true
  } catch (e) {
    // db gone (deleted by hand / a cleanup tool that missed the meta file) or
    // unreadable (EMFILE, ENOMEM). Either way the meta must stop claiming
    // coverage — otherwise searches keep routing here and get zero results.
    invalidateMeta(`The search index could not be read (${String((e as Error)?.message ?? e)}).`)
    return false
  }
}

/** drop the in-memory copy (indexing turned off / index cleared) */
export function unload(): void { text = null }

/**
 * `flags` is this index's on-disk serialisation ('d'/'f' + 'l' symlink + 'h'
 * hidden); everything past decoding it is shared with the FileFinder source, so
 * the entry-building itself lives in fs/list.ts and both callers get the same
 * FileEntry — including typeLabel and rating, which this used to drop.
 */
function entryFrom(dir: string, name: string, flags: string, size: number, mtime: number, remote: boolean): FileEntry {
  return entryNoStat(dir, name, {
    isDir: flags.charCodeAt(0) === 100 /* 'd' */,
    size,
    mtime,
    hidden: flags.includes('h'),
    isSymlink: flags.includes('l'),
    remote,
  })
}

/** does any path segment BELOW root start with a dot (root's own name is not our business) */
export function hiddenBelow(dir: string, root: string): boolean {
  if (dir.length <= root.length) return false
  const rel = dir.slice(root === '/' ? 1 : root.length + 1)
  let start = 0
  for (;;) {
    if (rel.charCodeAt(start) === 46 /* . */) return true
    const i = rel.indexOf('/', start)
    if (i < 0) return false
    start = i + 1
  }
}

export interface IndexSearchOpts {
  root: string
  subfolders?: boolean
  showHidden?: boolean
  limit?: number
}

/**
 * Name search straight out of the index — one linear scan, no stat() calls
 * (which is the whole point on a CIFS mount).
 *
 * Returns NULL when the index cannot answer (root not covered, db missing or
 * unreadable) and an array — possibly empty — when it can. The distinction is
 * the whole contract: an empty array means "searched, nothing matched", while
 * null means "ask the live walker", and collapsing the two is what made a
 * folder full of matches report "No items match your search".
 */
export async function indexSearch(query: string, opts: IndexSearchOpts): Promise<FileEntry[] | null> {
  if (!indexCovers(opts.root)) return null
  if (!await ensureLoaded()) return null
  const t = text!
  const match = nameMatcher(query)
  const limit = opts.limit ?? 10_000
  const root = opts.root.length > 1 ? opts.root.replace(/\/+$/, '') : opts.root
  const out: FileEntry[] = []

  let curDir = ''
  let inScope = false
  let curRemote = false
  /** the directory itself sits under a dot-folder (see the filter below) */
  let curDirHidden = false
  let pos = 0
  while (pos < t.length && out.length < limit) {
    let nl = t.indexOf('\n', pos)
    if (nl < 0) nl = t.length
    const tag = t.charCodeAt(pos)
    if (tag === 100 /* d */) {
      curDir = unesc(t.slice(pos + 2, nl))
      inScope = opts.subfolders === false ? curDir === root : under(curDir, root)
      if (inScope) {
        curRemote = isRemotePath(curDir)
        curDirHidden = hiddenBelow(curDir, root)
      }
    } else if (tag === 101 /* e */ && inScope) {
      const t1 = t.indexOf('\t', pos + 2)
      const t2 = t.indexOf('\t', t1 + 1)
      const t3 = t.indexOf('\t', t2 + 1)
      if (t1 > 0 && t2 > 0 && t3 > 0 && t3 < nl) {
        const raw = t.slice(pos + 2, t1)
        const name = raw.includes('\\') ? unesc(raw) : raw
        const flags = t.slice(t1 + 1, t2)
        // hiddenness is INHERITED: the live walker never descends into a dot
        // directory (search.ts), so with indexHidden on a plain file inside
        // ~/.mozilla — whose own name carries no 'h' — must not surface in an
        // ordinary search either, or the same query answers differently
        // depending on whether the index happens to cover the folder
        const visible = opts.showHidden || (!curDirHidden && !flags.includes('h'))
        if (visible && match(name)) {
          out.push(entryFrom(
            curDir, name, flags,
            Number(t.slice(t2 + 1, t3)), Number(t.slice(t3 + 1, nl)), curRemote,
          ))
        }
      }
    }
    pos = nl + 1
  }
  return out
}

// ---------------------------------------------------------------- scheduling

/** the configured roots no longer match what the index on disk actually covers */
function rootsDrifted(): boolean {
  const m = loadMeta()
  if (!m?.builtAt) return false
  return normalizeRoots(getSettings().indexRoots).join('\0') !== m.roots.join('\0')
}

/** kick a rebuild when the index is older than the configured interval */
function refreshDue(): boolean {
  const s = getSettings()
  if (!s.indexEnabled || scan || autoBuildBlocked) return false
  if (s.indexRefreshMins <= 0) return false
  const m = loadMeta()
  // Never built, or the last build failed/was abandoned: retry on the
  // CONFIGURED interval. The old code returned true here on every tick, which
  // turned a build that keeps failing (ENOSPC on ~/.local/state, a dead root)
  // into a full recursive re-scan every 60 seconds for the life of the process
  // — and ignored "Once a day" while doing it.
  if (!m?.builtAt) return Date.now() - lastBuildAttempt >= s.indexRefreshMins * 60_000
  // a root added/removed while a scan was running lands on the next tick
  if (rootsDrifted()) return true
  return Date.now() - m.builtAt >= s.indexRefreshMins * 60_000
}

/** called after an index-backed search: quietly re-scan when clearly stale */
export function refreshIfStale(): void {
  const s = getSettings()
  if (!s.indexEnabled || scan || autoBuildBlocked || s.indexRefreshMins <= 0) return
  const m = loadMeta()
  if (!m?.builtAt) return
  const age = Date.now() - m.builtAt
  if (age >= Math.min(s.indexRefreshMins * 60_000, STALE_MS)) buildIndex()
}

/** re-read settings after the Options dialog changed them */
export function applySettings(): IndexStatus {
  const s = getSettings()
  if (!s.indexEnabled) {
    if (scan) scan.cancelled = true
    unload()
  } else if (rootsDrifted() && !scan) {
    // the indexed-folder list changed: re-scan now rather than at the next tick
    // (an explicit edit of the roots also lifts a Clear/Cancel block)
    buildIndex()
  }
  broadcast()
  return getIndexStatus()
}

/**
 * A scan that has made ZERO progress for two ticks is not slow, it is blocked
 * in the kernel on a dead mount, and no flag we set can bring it back — the
 * in-flight readdir/lstat owns its threadpool thread until the server answers.
 * So the job is abandoned instead: the timer stops, `scan` goes back to null so
 * later builds are not refused at the `if (scan)` guard for the rest of the
 * session, and the orphan tidies up after itself if it ever returns (its
 * `.finally` re-checks `scan === job`, and `cancelled` makes it drop its temp
 * file rather than publish a half-built index).
 */
function superviseScan(job: Scan): void {
  if (job.progress !== job.lastProgress) {
    job.lastProgress = job.progress
    job.stallTicks = 0
    return
  }
  if (++job.stallTicks < STALL_TICKS) return
  job.cancelled = true
  lastError = `Indexing ${job.root || 'the selected folders'} stopped responding and was abandoned.`
  if (scan === job) scan = null
  if (statusTimer) { clearInterval(statusTimer); statusTimer = null }
  broadcast()
}

// One low-frequency supervisor instead of a timer per setting change: it costs
// nothing, survives settings edits made anywhere, and unref() keeps it from
// holding the process open.
const supervisor = setInterval(() => {
  if (scan) { superviseScan(scan); return }
  if (refreshDue()) buildIndex()
}, SUPERVISOR_MS)
supervisor.unref?.()

// ---------------------------------------------------------------- ipc

// Self-registered like ops/quick.ts — main/ipc.ts stays untouched.
// Renderer side: liq.invoke('<name>', ...).
ipcMain.handle(CH('getIndexStatus'), () => getIndexStatus())
ipcMain.handle(CH('buildIndex'), () => buildIndex())
ipcMain.handle(CH('cancelIndex'), () => cancelIndex())
ipcMain.handle(CH('clearIndex'), () => clearIndex())
// over IPC the "index cannot answer" signal collapses back to an empty list —
// only the main-process caller (search.ts) can act on it by walking live
ipcMain.handle(CH('indexSearch'), async (_e, query: string, opts: IndexSearchOpts) =>
  (await indexSearch(query, opts)) ?? [])
ipcMain.handle(CH('indexCovers'), (_e, p: string) => indexCovers(p))
ipcMain.handle(CH('indexApplySettings'), () => applySettings())

/** folder picker for the Options dialog's indexed-folder list */
ipcMain.handle(CH('pickFolder'), async (e: IpcMainInvokeEvent, defaultPath?: string) => {
  const win = BrowserWindow.fromWebContents(e.sender) ?? undefined
  const opts = {
    title: 'Select folder',
    defaultPath: defaultPath || os.homedir(),
    properties: ['openDirectory' as const, 'createDirectory' as const],
  }
  const r = win
    ? await dialog.showOpenDialog(win, opts)
    : await dialog.showOpenDialog(opts)
  return r.canceled || !r.filePaths.length ? null : r.filePaths[0]
})
