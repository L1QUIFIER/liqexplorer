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
import { isRemotePath, mountPoints } from '../fs/list'
import { mimeForName, iconsForMime, folderIcons } from '../fs/mime'

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

interface IndexMeta {
  version: 1
  builtAt: number
  roots: string[]
  files: number
  dirs: number
}

interface Scan {
  cancelled: boolean
  root: string
  seen: number
}

let meta: IndexMeta | null = null
let metaLoaded = false
/** whole db text, loaded on demand; null = not loaded / invalidated */
let text: string | null = null
let scan: Scan | null = null
let lastError = ''
let statusTimer: NodeJS.Timeout | null = null

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

/** true when the index is built and its roots contain p */
export function indexCovers(p: string): boolean {
  const m = loadMeta()
  if (!m || !m.builtAt || !getSettings().indexEnabled) return false
  return m.roots.some(r => under(p, r))
}

// ---------------------------------------------------------------- metadata

function loadMeta(): IndexMeta | null {
  if (metaLoaded) return meta
  metaLoaded = true
  try {
    const j = JSON.parse(fs.readFileSync(metaPath(), 'utf8')) as IndexMeta
    if (j && j.version === 1 && Array.isArray(j.roots)) meta = j
  } catch { meta = null }
  return meta
}

function dbBytes(): number {
  try { return fs.statSync(dbPath()).size } catch { return 0 }
}

export function getIndexStatus(): IndexStatus {
  const m = loadMeta()
  const enabled = getSettings().indexEnabled
  const st: IndexStatus = {
    state: lastError ? 'error' : scan ? 'scanning' : !enabled ? 'off' : m?.builtAt ? 'ready' : 'idle',
    roots: m?.roots ?? [],
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

      while (stack.length && !job.cancelled && entries < MAX_ENTRIES) {
        const cur = stack.pop()!
        let names: fs.Dirent[]
        try {
          names = await fsp.readdir(cur, { withFileTypes: true })
        } catch { continue }          // unreadable: skip the whole subtree
        dirs++
        pending += `d\t${esc(cur)}\n`

        for (let i = 0; i < names.length && !job.cancelled; i += STAT_POOL) {
          const slice = names.slice(i, i + STAT_POOL)
          const stats = await Promise.all(slice.map(d =>
            fsp.lstat(path.join(cur, d.name)).catch(() => null)))
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
              const t = await fsp.stat(full).catch(() => null)
              isDir = !!t?.isDirectory()
            }
            const flags = (isDir ? 'd' : 'f') + (isLink ? 'l' : '') + (hidden ? 'h' : '')
            const size = isDir ? -1 : st.size
            pending += `e\t${esc(name)}\t${flags}\t${size}\t${Math.round(st.mtimeMs)}\n`
            entries++
            job.seen++
            if (isDir) {
              if (isLink) continue
              if (SKIP_DIRS.has(full)) continue
              if (!rootRemote && remotes.some(mp => under(full, mp))) continue
              stack.push(full)
            } else {
              files++
            }
          }
          if (pending.length >= CHUNK_CHARS) {
            await writeChunk(ws, pending)
            pending = ''
          }
        }
        if (pending.length >= CHUNK_CHARS) { await writeChunk(ws, pending); pending = '' }
        if (++sinceTick >= DIRS_PER_TICK) { sinceTick = 0; await tick() }
      }
    }

    if (pending) await writeChunk(ws, pending)
    ws.end()
    await closed
    if (wsError) throw wsError

    if (job.cancelled) { await fsp.unlink(tmp).catch(() => {}); return }

    await fsp.rename(tmp, dbPath())
    meta = { version: 1, builtAt: Date.now(), roots, files, dirs }
    metaLoaded = true
    await fsp.writeFile(metaPath() + '.tmp', JSON.stringify(meta))
    await fsp.rename(metaPath() + '.tmp', metaPath())
    text = null                        // reloaded lazily on the next query
    lastError = ''
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
  const job: Scan = { cancelled: false, root: '', seen: 0 }
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
  broadcast()
  return getIndexStatus()
}

// ---------------------------------------------------------------- querying

async function ensureLoaded(): Promise<boolean> {
  if (text !== null) return true
  if (!loadMeta()?.builtAt) return false
  try {
    const t = await fsp.readFile(dbPath(), 'utf8')
    if (!t.startsWith(MAGIC)) return false
    text = t
    return true
  } catch { return false }
}

/** drop the in-memory copy (indexing turned off / index cleared) */
export function unload(): void { text = null }

function entryFrom(dir: string, name: string, flags: string, size: number, mtime: number, remote: boolean): FileEntry {
  const isDir = flags.charCodeAt(0) === 100 /* 'd' */
  const full = dir === '/' ? '/' + name : dir + '/' + name
  const mime = mimeForName(name, isDir)
  const e: FileEntry = {
    name,
    path: full,
    isDir,
    isSymlink: flags.includes('l'),
    size: isDir ? -1 : size,
    mtime,
    // the index stores one timestamp; ctime falls back to it (a stat would
    // defeat the point of the index on a network share)
    ctime: mtime,
    mime,
    icons: isDir ? folderIcons(full) : iconsForMime(mime),
    hidden: flags.includes('h'),
    ext: isDir ? '' : path.extname(name).slice(1).toLowerCase(),
  }
  if (remote) e.remote = true
  return e
}

export interface IndexSearchOpts {
  root: string
  subfolders?: boolean
  showHidden?: boolean
  limit?: number
}

/**
 * Name search straight out of the index — one linear scan, no stat() calls
 * (which is the whole point on a CIFS mount). Returns [] when the index cannot
 * answer, so callers can fall back to the live walker.
 */
export async function indexSearch(query: string, opts: IndexSearchOpts): Promise<FileEntry[]> {
  if (!indexCovers(opts.root)) return []
  if (!await ensureLoaded()) return []
  const t = text!
  const match = nameMatcher(query)
  const limit = opts.limit ?? 10_000
  const root = opts.root.length > 1 ? opts.root.replace(/\/+$/, '') : opts.root
  const out: FileEntry[] = []

  let curDir = ''
  let inScope = false
  let curRemote = false
  let pos = 0
  while (pos < t.length && out.length < limit) {
    let nl = t.indexOf('\n', pos)
    if (nl < 0) nl = t.length
    const tag = t.charCodeAt(pos)
    if (tag === 100 /* d */) {
      curDir = unesc(t.slice(pos + 2, nl))
      inScope = opts.subfolders === false ? curDir === root : under(curDir, root)
      if (inScope) curRemote = isRemotePath(curDir)
    } else if (tag === 101 /* e */ && inScope) {
      const t1 = t.indexOf('\t', pos + 2)
      const t2 = t.indexOf('\t', t1 + 1)
      const t3 = t.indexOf('\t', t2 + 1)
      if (t1 > 0 && t2 > 0 && t3 > 0 && t3 < nl) {
        const raw = t.slice(pos + 2, t1)
        const name = raw.includes('\\') ? unesc(raw) : raw
        const flags = t.slice(t1 + 1, t2)
        if ((opts.showHidden || !flags.includes('h')) && match(name)) {
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
  if (!s.indexEnabled || scan) return false
  const m = loadMeta()
  if (!m?.builtAt) return s.indexRefreshMins > 0    // enabled but never built
  // a root added/removed while a scan was running lands on the next tick
  if (rootsDrifted()) return true
  if (s.indexRefreshMins <= 0) return false
  return Date.now() - m.builtAt >= s.indexRefreshMins * 60_000
}

/** called after an index-backed search: quietly re-scan when clearly stale */
export function refreshIfStale(): void {
  const s = getSettings()
  if (!s.indexEnabled || scan || s.indexRefreshMins <= 0) return
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
    buildIndex()
  }
  broadcast()
  return getIndexStatus()
}

// One low-frequency supervisor instead of a timer per setting change: it costs
// nothing, survives settings edits made anywhere, and unref() keeps it from
// holding the process open.
const supervisor = setInterval(() => { if (refreshDue()) buildIndex() }, 60_000)
supervisor.unref?.()

// ---------------------------------------------------------------- ipc

// Self-registered like ops/quick.ts — main/ipc.ts stays untouched.
// Renderer side: liq.invoke('<name>', ...).
ipcMain.handle(CH('getIndexStatus'), () => getIndexStatus())
ipcMain.handle(CH('buildIndex'), () => buildIndex())
ipcMain.handle(CH('cancelIndex'), () => cancelIndex())
ipcMain.handle(CH('clearIndex'), () => clearIndex())
ipcMain.handle(CH('indexSearch'), (_e, query: string, opts: IndexSearchOpts) => indexSearch(query, opts))
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
