// Home page data sources: the favorites store (Quick access folders +
// Favorites files) and the GTK recent-files list.
//
// Favorites live in the app state dir (state/settings.ts owns its location, so
// LIQEXPLORER_TEST isolates them) — NEVER beside the code, which may sit on a
// share read by another OS. Recents are read from
// ~/.local/share/recently-used.xbel, the freedesktop store GTK/Nemo share, so
// "Recent" matches what the rest of the desktop shows. That file is ~90 KB and
// re-read only when its mtime/size change.
//
// Liveness: entries whose file is gone are filtered out, but a path on a
// network mount is NEVER stat'ed here — a dead CIFS/NFS server would block a
// libuv thread for minutes and hang the app. Remote entries are assumed alive.
import { ipcMain } from 'electron'
import * as fsp from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { CH, PUSH } from '../../shared/ipc'
import type { FavoriteEntry, RecentEntry } from '../../shared/types'
import { isRemotePath } from '../fs/list'
import { STATE_DIR, TEST_PROFILE } from '../state/settings'
import { broadcast } from '../windows'

const FAV_FILE = path.join(STATE_DIR, 'favorites.json')
/** The store GTK/Nemo share. Under LIQEXPLORER_TEST it is redirected into the
 *  scratch state dir (seeded once from the real file) so "Clear recent files"
 *  in a QA run cannot truncate the list every desktop app depends on. */
const REAL_XBEL = path.join(os.homedir(), '.local/share/recently-used.xbel')
const XBEL_FILE = TEST_PROFILE ? path.join(STATE_DIR, 'recently-used.xbel') : REAL_XBEL

const XBEL_HEADER =
  '<?xml version="1.0" encoding="UTF-8"?>\n' +
  '<xbel version="1.0"\n' +
  '      xmlns:bookmark="http://www.freedesktop.org/standards/desktop-bookmarks"\n' +
  '      xmlns:mime="http://www.freedesktop.org/standards/shared-mime-info">\n'

let tmpCounter = 0

/** Replace a file atomically — recently-used.xbel is shared with every GTK app.
 *  0600 because both files list private paths (GTK keeps the xbel that way).
 *  The fsync before the rename is what stops an unclean shutdown from leaving a
 *  zero-length favorites.json behind the freshly renamed name. */
async function writeAtomic(file: string, txt: string): Promise<void> {
  const tmp = `${file}.liqtmp-${process.pid}-${tmpCounter++}`
  try {
    const fh = await fsp.open(tmp, 'w', 0o600)
    try {
      await fh.writeFile(txt, 'utf8')
      await fh.sync()
    } finally {
      await fh.close()
    }
    await fsp.rename(tmp, file)
  } catch (err) {
    await fsp.unlink(tmp).catch(() => {})
    throw err
  }
}

/** access() unless the path is on a network mount (see file header). */
async function existsSafe(p: string): Promise<boolean> {
  if (isRemotePath(p)) return true
  return fsp.access(p).then(() => true, () => false)
}

// ---------------------------------------------------------------------------
// favorites store
// ---------------------------------------------------------------------------

let favorites: FavoriteEntry[] | null = null
/** favorites.json exists but could not be read (EMFILE/EIO/EACCES) or could not
 *  be quarantined after a parse failure. The list we are holding is therefore
 *  NOT the user's list, and writing it back would destroy every favorite they
 *  ever saved — there is no backup and no undo — so every save is refused until
 *  a read succeeds. */
let loadFailed = false

function sanitize(raw: unknown): FavoriteEntry[] {
  if (!Array.isArray(raw)) return []
  const out: FavoriteEntry[] = []
  const seen = new Set<string>()
  for (const item of raw) {
    const e = item as Partial<FavoriteEntry>
    if (!e || typeof e.path !== 'string' || !e.path.startsWith('/')) continue
    if (seen.has(e.path)) continue
    seen.add(e.path)
    out.push({
      path: e.path,
      name: typeof e.name === 'string' && e.name ? e.name : path.basename(e.path),
      isDir: !!e.isDir,
      addedAt: typeof e.addedAt === 'number' ? e.addedAt : Date.now(),
    })
  }
  return out
}

/**
 * Only a MISSING file means "no favorites yet". Every other failure is a case
 * where the user's favorites may well be intact on disk and simply unreadable
 * right now, so the empty result is neither cached nor writable.
 */
async function loadFavorites(): Promise<FavoriteEntry[]> {
  if (favorites) return favorites
  let txt: string
  try {
    txt = await fsp.readFile(FAV_FILE, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') {
      loadFailed = false
      favorites = []                     // no file yet: legitimately empty
      return favorites
    }
    loadFailed = true                    // transient (EMFILE/EIO) or unreadable
    console.warn('[favorites] favorites.json could not be read:', (err as Error)?.message)
    return []                            // not cached: the next call retries
  }
  if (!txt.trim()) { loadFailed = false; favorites = []; return favorites }
  try {
    const parsed: unknown = JSON.parse(txt)
    if (!Array.isArray(parsed)) throw new Error('favorites.json is not a list')
    favorites = sanitize(parsed)
    loadFailed = false
  } catch {
    // readable but not valid JSON (hand-edited, partial restore): keep the
    // bytes under a .bad-<ts> name so nothing is thrown away, then start clean
    const bad = `${FAV_FILE}.bad-${Date.now()}`
    try {
      await fsp.rename(FAV_FILE, bad)
      console.warn(`[favorites] favorites.json was corrupt; kept it as ${bad}`)
      loadFailed = false
      favorites = []
    } catch (err) {
      loadFailed = true                  // could not preserve it: never write
      console.warn('[favorites] favorites.json is corrupt and could not be set aside:', (err as Error)?.message)
      return []
    }
  }
  return favorites
}

async function saveFavorites(list: FavoriteEntry[]): Promise<void> {
  if (loadFailed) return                 // see loadFailed: this would wipe the file
  favorites = list
  await fsp.mkdir(STATE_DIR, { recursive: true })
  await writeAtomic(FAV_FILE, JSON.stringify(list, null, 2) + '\n')
  broadcast(PUSH.favoritesChanged, await listFavorites())   // push what is visible
}

/** stat with a deadline: a hung network mount must degrade, never stall. */
async function isDirSafe(p: string): Promise<boolean> {
  if (isRemotePath(p)) return !path.extname(p)      // best-effort guess, no stat
  const st = await Promise.race([
    fsp.stat(p).catch(() => null),
    new Promise<null>(res => { setTimeout(() => res(null), 800).unref() }),
  ])
  return st ? st.isDirectory() : !path.extname(p)
}

export async function listFavorites(): Promise<FavoriteEntry[]> {
  const list = await loadFavorites()
  const alive = await Promise.all(list.map(e => existsSafe(e.path)))
  // dead entries are hidden, never deleted: an unmounted drive must not silently
  // eat the user's favorites
  return list.filter((_, i) => alive[i])
}

/** The renderer already holds the FileEntry, so it can say whether a path is a
 *  directory; isDirSafe's extension guess is only the fallback for callers
 *  (older payloads, drops) that cannot. */
export type FavoriteInput = string | { path?: unknown; isDir?: unknown }

function inputPath(raw: FavoriteInput): string {
  const p = typeof raw === 'string' ? raw
    : (raw && typeof raw.path === 'string') ? raw.path : ''
  return p ? p.replace(/\/+$/, '') || '/' : ''
}

export async function addFavorite(items: FavoriteInput[]): Promise<FavoriteEntry[]> {
  const current = await loadFavorites()
  if (loadFailed) return current         // unreadable store: never write over it
  const list = [...current]
  const have = new Set(list.map(e => e.path))
  let added = false
  for (const raw of items ?? []) {
    const p = inputPath(raw)
    if (!p.startsWith('/') || have.has(p)) continue
    have.add(p)
    const told = typeof raw === 'object' && raw !== null && typeof raw.isDir === 'boolean'
      ? raw.isDir
      : undefined
    list.push({
      path: p, name: path.basename(p) || p,
      isDir: told ?? await isDirSafe(p), addedAt: Date.now(),
    })
    added = true
  }
  if (added) await saveFavorites(list)
  return list
}

export async function removeFavorite(items: FavoriteInput[]): Promise<FavoriteEntry[]> {
  const drop = new Set((items ?? []).map(inputPath).filter(Boolean))
  const list = await loadFavorites()
  if (loadFailed) return list            // unreadable store: never write over it
  const kept = list.filter(e => !drop.has(e.path))
  if (kept.length !== list.length) await saveFavorites(kept)
  return kept
}

// ---------------------------------------------------------------------------
// recently-used.xbel
// ---------------------------------------------------------------------------

const OPEN_TAG_RE = /<bookmark\b([^>]*)>/g
const HREF_RE = /\bhref="([^"]*)"/
const VISITED_RE = /\bvisited="([^"]*)"/
const MODIFIED_RE = /\bmodified="([^"]*)"/
const ADDED_RE = /\badded="([^"]*)"/
const MIME_RE = /<mime:mime-type\s+type="([^"]*)"/
const CLOSE_TAG = '</bookmark>'

const ENTITIES: Record<string, string> = {
  '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'", '&#39;': "'",
}

function decodeEntities(s: string): string {
  return s.replace(/&(?:amp|lt|gt|quot|apos|#39);/g, m => ENTITIES[m] ?? m)
}

function pathFromFileUri(href: string): string | null {
  const uri = decodeEntities(href)
  if (!uri.startsWith('file:///')) return null       // recent:// only ever stores local files
  try { return decodeURIComponent(uri.slice('file://'.length)) } catch { return null }
}

function timeOf(s: string | undefined): number {
  if (!s) return 0
  const t = Date.parse(s)                            // ISO 8601, GTK writes microseconds
  if (!Number.isNaN(t)) return t
  const n = Number(s)                                // pre-2.10 GTK wrote unix seconds
  return Number.isFinite(n) && n > 0 ? n * 1000 : 0
}

/** Scanner-based XBEL read — an XML dependency would be the only npm addition. */
function parseXbel(txt: string): RecentEntry[] {
  const out: RecentEntry[] = []
  const seen = new Set<string>()
  OPEN_TAG_RE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = OPEN_TAG_RE.exec(txt)) !== null) {
    const attrs = m[1]
    let body = ''
    if (!attrs.trimEnd().endsWith('/')) {
      const end = txt.indexOf(CLOSE_TAG, OPEN_TAG_RE.lastIndex)
      if (end < 0) break
      body = txt.slice(OPEN_TAG_RE.lastIndex, end)
      OPEN_TAG_RE.lastIndex = end + CLOSE_TAG.length
    }
    const href = HREF_RE.exec(attrs)?.[1]
    if (!href) continue
    const p = pathFromFileUri(href)
    if (!p || seen.has(p)) continue
    seen.add(p)
    out.push({
      path: p,
      name: path.basename(p) || p,
      mime: decodeEntities(MIME_RE.exec(body)?.[1] ?? '') || 'application/octet-stream',
      visitedAt: timeOf(VISITED_RE.exec(attrs)?.[1]) || timeOf(MODIFIED_RE.exec(attrs)?.[1])
        || timeOf(ADDED_RE.exec(attrs)?.[1]),
      dir: path.dirname(p),
    })
  }
  return out
}

let xbelCache: { mtimeMs: number; size: number; entries: RecentEntry[] } | null = null
let xbelSeeded = !TEST_PROFILE

/** Test profile: start the private xbel off as a copy of the real one so Recent
 *  still has something to show, then never touch the shared file again. */
async function seedTestXbel(): Promise<void> {
  if (xbelSeeded) return
  xbelSeeded = true
  try {
    await fsp.mkdir(STATE_DIR, { recursive: true })
    await fsp.copyFile(REAL_XBEL, XBEL_FILE, fsp.constants.COPYFILE_EXCL)
  } catch { /* already seeded, or no real list — Recent just starts empty */ }
}

async function readXbel(): Promise<RecentEntry[]> {
  await seedTestXbel()
  const st = await fsp.stat(XBEL_FILE).catch(() => null)
  if (!st) { xbelCache = null; return [] }
  if (xbelCache && xbelCache.mtimeMs === st.mtimeMs && xbelCache.size === st.size) {
    return xbelCache.entries
  }
  let txt = ''
  try { txt = await fsp.readFile(XBEL_FILE, 'utf8') } catch { return [] }
  const entries = parseXbel(txt).sort((a, b) => b.visitedAt - a.visitedAt)
  xbelCache = { mtimeMs: st.mtimeMs, size: st.size, entries }
  return entries
}

export async function listRecent(limit = 25): Promise<RecentEntry[]> {
  const n = Math.max(1, Math.min(200, Math.floor(limit) || 25))
  const all = await readXbel()
  const out: RecentEntry[] = []
  // walk newest-first in batches: a long history must not stat every entry
  for (let i = 0; i < all.length && out.length < n; i += 32) {
    const batch = all.slice(i, i + 32)
    const alive = await Promise.all(batch.map(e => existsSafe(e.path)))
    for (let j = 0; j < batch.length && out.length < n; j++) if (alive[j]) out.push(batch[j])
  }
  return out
}

export async function removeRecent(target: string): Promise<void> {
  const want = target.replace(/\/+$/, '') || '/'
  let txt: string
  try { txt = await fsp.readFile(XBEL_FILE, 'utf8') } catch { return }
  OPEN_TAG_RE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = OPEN_TAG_RE.exec(txt)) !== null) {
    const attrs = m[1]
    let blockEnd = OPEN_TAG_RE.lastIndex
    if (!attrs.trimEnd().endsWith('/')) {
      const end = txt.indexOf(CLOSE_TAG, OPEN_TAG_RE.lastIndex)
      if (end < 0) return
      blockEnd = end + CLOSE_TAG.length
      OPEN_TAG_RE.lastIndex = blockEnd
    }
    const href = HREF_RE.exec(attrs)?.[1]
    const p = href ? pathFromFileUri(href) : null
    if (!p || p.replace(/\/+$/, '') !== want) continue
    // take the element with its indentation and trailing newline
    let start = m.index
    while (start > 0 && (txt[start - 1] === ' ' || txt[start - 1] === '\t')) start--
    let end = blockEnd
    if (txt[end] === '\r') end++
    if (txt[end] === '\n') end++
    await writeAtomic(XBEL_FILE, txt.slice(0, start) + txt.slice(end))
    xbelCache = null
    return
  }
}

export async function clearRecent(): Promise<void> {
  await writeAtomic(XBEL_FILE, XBEL_HEADER + '</xbel>\n')
  xbelCache = null
}

// ---------------------------------------------------------------------------
// self-registered IPC (renderer: liq.invoke('listFavorites') etc.)
// ---------------------------------------------------------------------------

ipcMain.handle(CH('listFavorites'), () => listFavorites())
ipcMain.handle(CH('addFavorite'), (_e, items: FavoriteInput[]) => addFavorite(items))
ipcMain.handle(CH('removeFavorite'), (_e, items: FavoriteInput[]) => removeFavorite(items))
ipcMain.handle(CH('listRecent'), (_e, limit: number) => listRecent(limit))
ipcMain.handle(CH('removeRecent'), (_e, p: string) => removeRecent(p))
ipcMain.handle(CH('clearRecent'), () => clearRecent())
