// FileFinder — a file index served by a machine on the LAN, used as a search
// source in front of the local index and the live walker.
//
// Why this exists: the CIFS shares hold millions of files and a recursive walk
// over SMB takes minutes. A FileFinder server keeps a SQLite FTS5 index of those
// same trees, refreshed from ZFS snapshot diffs rather than by walking, and
// answers a name query in well under a second.
//
// Three things about the server API shape the whole module:
//
//  1. `q` is passed to SQL LIKE with the wildcards LEFT LIVE. '%' and '_' are
//     metacharacters there and literals everywhere else in this app, so
//     `q=50%` comes back full of unrelated files. There is no ESCAPE clause to
//     escape into. FileFinder is therefore a CANDIDATE GENERATOR, never the
//     authority: LIKE metacharacters only ever broaden the match, so callers
//     re-filter every row with nameMatcher() and land back on exact parity.
//  2. Queries under 3 characters silently switch to PREFIX matching (a trigram
//     index cannot serve them), and '*'/'?' are literals here but glob syntax in
//     nameMatcher. Both UNDER-match, which no amount of post-filtering can undo,
//     so those queries are refused outright — see ffSearch's null contract.
//  3. An empty `q` returns {count:0} with no `note`, i.e. it claims to be an
//     authoritative empty answer. Also refused.
//
// The null contract is the same one platform/indexer.ts uses, for the same
// reason: null means "I cannot answer, ask something else", an empty array means
// "I searched, nothing matched". Collapsing them reports a folder full of
// matches as "No items match your search".
import * as http from 'node:http'
import * as https from 'node:https'
import { ipcMain } from 'electron'
import { CH } from '../../shared/ipc'
import { entryNoStat, isNetworkMountedAt, mountEntries } from '../fs/list'
import { getSettings } from '../state/settings'
import type { FileEntry } from '../../shared/types'

/** connect deadline: a SYN to a dead host on a live subnet is DROPPED, not
 * refused, so the OS default would hang this for ~2 minutes */
const CONNECT_MS = 1500
/** whole-response deadline; worst measured real query is ~550ms for 2MB */
const TOTAL_MS = 6000
/** the server caps at 5000, but cost scales with rows returned (1.7s at 1000 vs
 * 60ms for a narrow query). 1000 is what FileFinder's own UI asks for. */
export const PAGE_LIMIT = 1000
/** don't re-pay the connect timeout on every keystroke while the server is down */
const FAIL_COOLDOWN_MS = 30_000
const STATUS_TTL_MS = 30_000
/** refuse to buffer a pathological body */
const MAX_BODY = 32 * 1024 * 1024

export interface FfRow {
  entry: FileEntry
  /** the server-side path this came from, for diagnostics */
  serverPath: string
}

export interface FfResult {
  rows: FfRow[]
  /** the server hit its row cap: this is not the whole answer */
  truncated: boolean
  /** age of the newest scan covering these results, in hours */
  ageHours?: number
}

export interface FfShare {
  share: string
  root: string
  file_count?: number
  last_full_scan?: number
  last_delta?: number
  dirty?: number
}

export interface FfStatus {
  status?: string
  indexed?: number
  files?: number
  dirs?: number
  shares?: FfShare[]
}

let lastFailAt = 0
let statusCache: { at: number; value: FfStatus | null } | null = null
let searchesInFlight = 0

// ---------------------------------------------------------------- settings

export function ffEnabled(): boolean {
  const s = getSettings()
  return !!s.filefinderEnabled && !!s.filefinderUrl
}

function baseUrl(): string {
  return getSettings().filefinderUrl.replace(/\/+$/, '')
}

/** the server is down / unreachable and we said we would stop asking for a bit */
function inCooldown(): boolean {
  return lastFailAt > 0 && Date.now() - lastFailAt < FAIL_COOLDOWN_MS
}

function noteFailure(): void { lastFailAt = Date.now() }
function noteSuccess(): void { lastFailAt = 0 }

/** let the UI's "try again" clear a cooldown without waiting it out */
export function ffResetBackoff(): void {
  lastFailAt = 0
  statusCache = null
}

// ---------------------------------------------------------------- path mapping
//
// The server reports container paths ('/mnt/vault/...'); the client may see CIFS
// mounts ('/mnt/share/vault/...'). The two are matched by SHARE NAME off the
// mount device ('//server/share'), never by the API host — the
// FileFinder service and the SMB server are different machines.
//
// Case differs at all three layers (api 'vault', device 'Vault', mountpoint
// 'vault'), so every comparison here is case-insensitive.

/** '//host/Share' -> 'share'; anything else -> '' */
function deviceShare(device: string): string {
  const m = /^\/\/[^/]+\/(.+)$/.exec(device)
  return m ? m[1].replace(/\/+$/, '').toLowerCase() : ''
}

/** '/mnt/vault' -> 'vault' */
function containerShare(root: string): string {
  const i = root.lastIndexOf('/')
  return (i < 0 ? root : root.slice(i + 1)).toLowerCase()
}

interface Override { server: string; local: string }

function overrides(): Override[] {
  const out: Override[] = []
  for (const raw of getSettings().filefinderMounts ?? []) {
    const i = raw.indexOf('=')
    if (i <= 0) continue
    const server = raw.slice(0, i).trim().replace(/\/+$/, '')
    const local = raw.slice(i + 1).trim().replace(/\/+$/, '')
    if (server && local) out.push({ server, local })
  }
  return out
}

/**
 * Local mount point for a server share root, or null.
 *
 * Returns null when the share is not mounted RIGHT NOW. That check cannot be a
 * directory-existence test: these mounts are `noauto`, so /mnt/share/vault stays
 * behind as an empty local directory when the share is gone, and handing back
 * results pointing into it would name files that do not resolve.
 */
export function localRootFor(serverRoot: string): string | null {
  for (const o of overrides()) {
    if (o.server === serverRoot) return isNetworkMountedAt(o.local) ? o.local : null
  }
  const want = containerShare(serverRoot)
  if (!want) return null
  const hits = mountEntries().filter(m => deviceShare(m.device) === want)
  // two hosts exporting the same share name: refuse to guess, the user can pin
  // it with filefinderMounts
  const mounted = hits.filter(m => isNetworkMountedAt(m.prefix))
  if (mounted.length !== 1) return null
  return mounted[0].prefix
}

/** local path -> the server's container path, or null when not a mapped share */
export function toServerPath(localPath: string): string | null {
  const p = localPath.replace(/\/+$/, '') || '/'
  for (const o of overrides()) {
    if (p === o.local || p.startsWith(o.local + '/')) {
      return o.server + p.slice(o.local.length)
    }
  }
  let best: { prefix: string; share: string } | null = null
  for (const m of mountEntries()) {
    const share = deviceShare(m.device)
    if (!share) continue
    if (p !== m.prefix && !p.startsWith(m.prefix + '/')) continue
    if (!best || m.prefix.length >= best.prefix.length) best = { prefix: m.prefix, share }
  }
  if (!best || !isNetworkMountedAt(best.prefix)) return null
  return '/mnt/' + best.share + p.slice(best.prefix.length)
}

/** server container path -> local path, or null. Never escapes the local root. */
export function toLocalPath(serverPath: string): string | null {
  // '/mnt/vault/a/b' -> root '/mnt/vault'
  const m = /^(\/mnt\/[^/]+)(\/.*)?$/.exec(serverPath)
  if (!m) return null
  const localRoot = localRootFor(m[1])
  if (!localRoot) return null
  const full = localRoot + (m[2] ?? '')
  // these paths are handed to the file engine and the server has no auth:
  // refuse anything that climbed out of the mount
  if (full !== localRoot && !full.startsWith(localRoot + '/')) return null
  if (full.includes('/../') || full.endsWith('/..') || full.includes('\0')) return null
  return full
}

// ---------------------------------------------------------------- http

/**
 * GET + JSON with a connect deadline separate from the body deadline, over
 * node:http rather than Electron's net.fetch: net.fetch rides Chromium's stack
 * and would honour a system proxy, which must not sit between us and a LAN
 * index, and req.destroy() gives unambiguous cancellation for the abort hook.
 */
function getJson(url: URL, signal?: AbortSignal): Promise<unknown> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(new Error('aborted')); return }
    const mod = url.protocol === 'https:' ? https : http
    let settled = false
    const done = (err: Error | null, val?: unknown): void => {
      if (settled) return
      settled = true
      clearTimeout(total)
      signal?.removeEventListener('abort', onAbort)
      if (err) reject(err); else resolve(val)
    }

    const req = mod.request(url, { method: 'GET', headers: { accept: 'application/json' } })
    const onAbort = (): void => { req.destroy(); done(new Error('aborted')) }
    signal?.addEventListener('abort', onAbort, { once: true })

    const total = setTimeout(() => { req.destroy(); done(new Error('timeout')) }, TOTAL_MS)
    req.setTimeout(CONNECT_MS, () => { req.destroy(); done(new Error('connect timeout')) })

    req.on('error', e => done(e instanceof Error ? e : new Error(String(e))))
    req.on('response', res => {
      if (res.statusCode !== 200) { res.resume(); done(new Error(`http ${res.statusCode}`)); return }
      let size = 0
      const parts: Buffer[] = []
      res.on('data', (c: Buffer) => {
        size += c.length
        if (size > MAX_BODY) { req.destroy(); done(new Error('body too large')); return }
        parts.push(c)
      })
      res.on('error', e => done(e))
      res.on('end', () => {
        try { done(null, JSON.parse(Buffer.concat(parts).toString('utf8'))) }
        catch { done(new Error('bad json')) }
      })
    })
    // once the socket is up, the connect timeout must stop applying or a slow
    // body would be killed as if the host were unreachable
    req.on('socket', s => s.on('connect', () => req.setTimeout(0)))
    req.end()
  })
}

// ---------------------------------------------------------------- status

/** cached server status; null when unreachable. Never blocks a running search. */
export async function ffStatus(force = false): Promise<FfStatus | null> {
  if (!ffEnabled()) return null
  const now = Date.now()
  if (!force && statusCache && now - statusCache.at < STATUS_TTL_MS) return statusCache.value
  // the server is very likely a single sync worker: a status poll would queue
  // behind a running search and make both look slow
  if (searchesInFlight > 0 && statusCache) return statusCache.value
  if (!force && inCooldown()) return null
  try {
    const v = await getJson(new URL(baseUrl() + '/api/status')) as FfStatus
    noteSuccess()
    statusCache = { at: now, value: v && typeof v === 'object' ? v : null }
  } catch {
    noteFailure()
    statusCache = { at: now, value: null }
  }
  return statusCache.value
}

/** hours since the freshest scan covering a server root, or undefined */
function ageHoursFor(st: FfStatus | null, serverRoot: string | null): number | undefined {
  if (!st?.shares) return undefined
  // serverRoot is the searched FOLDER ('/mnt/vault/4-Browse'), not a share root:
  // find the share that CONTAINS it, or an equality test silently reports
  // "age unknown" for every search below a share root — i.e. all of them
  const rel = serverRoot
    ? st.shares.filter(s => s.root && (serverRoot === s.root || serverRoot.startsWith(s.root + '/')))
    : st.shares
  if (!rel.length) return undefined
  // Each share's own freshness is its most recent scan of either kind; across
  // several shares report the WORST of those, not the best. This number is a
  // staleness warning, and a whole-index search spanning a 22-hour-old share and
  // a 12-day-old one is only as trustworthy as the 12-day-old one.
  let oldest = 0
  for (const s of rel) {
    const t = Math.max(s.last_delta ?? 0, s.last_full_scan ?? 0)
    if (!t) continue
    if (!oldest || t < oldest) oldest = t
  }
  if (!oldest) return undefined
  return Math.max(0, (Date.now() / 1000 - oldest) / 3600)
}

/** local roots this server currently indexes AND that are mounted here */
export async function ffLocalRoots(): Promise<string[]> {
  const st = await ffStatus()
  const out: string[] = []
  for (const s of st?.shares ?? []) {
    const local = s.root ? localRootFor(s.root) : null
    if (local) out.push(local)
  }
  return out
}

// ---------------------------------------------------------------- search

export interface FfSearchOpts {
  /** local path to scope to, or null for the whole index */
  root: string | null
  subfolders: boolean
  limit?: number
  signal?: AbortSignal
}

/**
 * A query FileFinder would answer WRONGLY rather than slowly. Post-filtering can
 * undo a match that is too broad; it cannot invent rows the server never sent.
 */
function unanswerable(query: string): boolean {
  if (query.length < 3) return true          // server switches to prefix matching
  if (/[*?]/.test(query)) return true        // glob here, literal there
  return false
}

/**
 * Name search against the server index.
 *
 * Returns null when the server cannot or should not answer — unreachable, in
 * cooldown, the query is one of the shapes above, the path is not a mapped and
 * mounted share, or the server replied with `note` (which it does for ANY path
 * missing from its directory table, including a folder created since the last
 * scan — exactly the freshness guard we want).
 *
 * Rows still need nameMatcher() applied by the caller; see the header.
 */
export async function ffSearch(query: string, opts: FfSearchOpts): Promise<FfResult | null> {
  if (!ffEnabled() || inCooldown()) return null
  const q = query.trim()
  if (!q || unanswerable(q)) return null

  let serverRoot: string | null = null
  if (opts.root) {
    serverRoot = toServerPath(opts.root)
    if (!serverRoot) return null              // not a mapped share, or not mounted
  } else if (!(await ffLocalRoots()).length) {
    // whole-index search with nothing mounted locally: every result would point
    // at a path that does not resolve
    return null
  }

  const url = new URL(baseUrl() + '/api/search')
  url.searchParams.set('q', q)
  url.searchParams.set('limit', String(opts.limit ?? PAGE_LIMIT))
  if (serverRoot) {
    url.searchParams.set('under', serverRoot)
    url.searchParams.set('depth', opts.subfolders ? 'tree' : 'here')
  }

  searchesInFlight++
  let body: any
  try {
    body = await getJson(url, opts.signal)
    noteSuccess()
  } catch (e) {
    // an explicit cancel is not the server's fault — don't trip the breaker
    if (!opts.signal?.aborted) noteFailure()
    return null
  } finally {
    searchesInFlight--
  }

  if (!body || typeof body !== 'object' || !Array.isArray(body.results)) return null
  // `note` = "no indexed folder <x>". Present means it did NOT search, however
  // many results came back.
  if (typeof body.note === 'string' && body.note) return null

  const rows: FfRow[] = []
  for (const r of body.results) {
    if (!r || typeof r.name !== 'string' || typeof r.path !== 'string') continue
    if (r.name.includes('\0') || r.path.includes('\0')) continue
    const local = toLocalPath(r.path)
    if (!local) continue
    const slash = local.lastIndexOf('/')
    if (slash < 0) continue
    const dir = slash === 0 ? '/' : local.slice(0, slash)
    const name = local.slice(slash + 1)
    if (name !== r.name) continue             // mapping disagreed with the row
    rows.push({
      serverPath: r.path,
      entry: entryNoStat(dir, name, {
        isDir: !!r.is_dir,
        size: Number.isFinite(r.size) ? r.size : 0,
        // the server stores epoch SECONDS; FileEntry.mtime is ms, and a null
        // would render as "Invalid Date" in the details view
        mtime: Number.isFinite(r.mtime) ? r.mtime * 1000 : 0,
        remote: true,
      }),
    })
  }

  // The server found rows and NONE of them mapped to a local path: that is a
  // broken mapping (a share unmounted mid-search, a bad filefinderMounts entry),
  // not an empty answer. Saying "0 results" here would be the confident-wrong
  // failure the null contract exists to prevent.
  if (body.results.length && !rows.length) return null

  // freshness comes from the cache so the search never waits on a second round
  // trip; warm it in the background when this is the first query of the session
  if (!statusCache) void ffStatus().catch(() => { /* banner just stays quiet */ })

  return {
    rows,
    truncated: !!body.truncated,
    ageHours: ageHoursFor(statusCache?.value ?? null, serverRoot),
  }
}

/**
 * True when a search rooted here would go to the server: enabled, reachable,
 * the path maps to a mounted share, and the server says that share is indexed.
 * Used by the results banner — the search path itself relies on ffSearch's null.
 */
export async function ffCoversLocal(localPath: string): Promise<boolean> {
  if (!ffEnabled() || inCooldown()) return false
  const server = toServerPath(localPath)
  if (!server) return false
  const st = await ffStatus()
  if (!st?.shares?.length) return false
  return st.shares.some(s => s.root && (server === s.root || server.startsWith(s.root + '/')))
}

// ---------------------------------------------------------------- ipc
// Self-registered like ops/quick.ts and platform/search.ts, so main/ipc.ts and
// preload.ts stay untouched (the renderer reaches these via liq.invoke).
// Registering a handler at import time is fine; issuing a REQUEST at import time
// would not be — this module is loaded before app.whenReady().

export interface FfHealth {
  enabled: boolean
  url: string
  /** null when unreachable or disabled */
  status: FfStatus | null
  /** per share: is it indexed by the server AND mounted on this machine */
  shares: { share: string; root: string; localRoot: string | null; files: number; ageHours?: number }[]
}

async function health(force: boolean): Promise<FfHealth> {
  const s = getSettings()
  const st = ffEnabled() ? await ffStatus(force) : null
  return {
    enabled: !!s.filefinderEnabled,
    url: s.filefinderUrl,
    status: st,
    shares: (st?.shares ?? []).map(sh => ({
      share: sh.share,
      root: sh.root,
      localRoot: sh.root ? localRootFor(sh.root) : null,
      files: sh.file_count ?? 0,
      ageHours: ageHoursFor(st, sh.root),
    })),
  }
}

ipcMain.handle(CH('ffHealth'), (_e, force?: boolean) => health(!!force))
ipcMain.handle(CH('ffReset'), () => { ffResetBackoff(); return health(true) })
ipcMain.handle(CH('ffRoots'), () => ffLocalRoots())
