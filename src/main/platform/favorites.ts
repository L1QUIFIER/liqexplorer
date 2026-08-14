// Home page data sources: the favorites store (Quick access folders +
// Favorites files) and the GTK recent-files list.
//
// Favorites live in ~/.local/state/liqexplorer/favorites.json — NEVER beside
// the code, which may sit on a share read by another OS. Recents are read from
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
import { broadcast } from '../windows'

const STATE_DIR = path.join(os.homedir(), '.local/state/liqexplorer')
const FAV_FILE = path.join(STATE_DIR, 'favorites.json')
const XBEL_FILE = path.join(os.homedir(), '.local/share/recently-used.xbel')

const XBEL_HEADER =
  '<?xml version="1.0" encoding="UTF-8"?>\n' +
  '<xbel version="1.0"\n' +
  '      xmlns:bookmark="http://www.freedesktop.org/standards/desktop-bookmarks"\n' +
  '      xmlns:mime="http://www.freedesktop.org/standards/shared-mime-info">\n'

let tmpCounter = 0

/** Replace a file atomically — recently-used.xbel is shared with every GTK app.
 *  0600 because both files list private paths (GTK keeps the xbel that way). */
async function writeAtomic(file: string, txt: string): Promise<void> {
  const tmp = `${file}.liqtmp-${process.pid}-${tmpCounter++}`
  await fsp.writeFile(tmp, txt, { encoding: 'utf8', mode: 0o600 })
  await fsp.rename(tmp, file)
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

async function loadFavorites(): Promise<FavoriteEntry[]> {
  if (favorites) return favorites
  try {
    favorites = sanitize(JSON.parse(await fsp.readFile(FAV_FILE, 'utf8')))
  } catch {
    favorites = []                       // missing or corrupt: start clean
  }
  return favorites
}

async function saveFavorites(list: FavoriteEntry[]): Promise<void> {
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

export async function addFavorite(paths: string[]): Promise<FavoriteEntry[]> {
  const list = [...(await loadFavorites())]
  const have = new Set(list.map(e => e.path))
  let added = false
  for (const raw of paths ?? []) {
    const p = typeof raw === 'string' ? raw.replace(/\/+$/, '') || '/' : ''
    if (!p.startsWith('/') || have.has(p)) continue
    have.add(p)
    list.push({ path: p, name: path.basename(p) || p, isDir: await isDirSafe(p), addedAt: Date.now() })
    added = true
  }
  if (added) await saveFavorites(list)
  return list
}

export async function removeFavorite(paths: string[]): Promise<FavoriteEntry[]> {
  const drop = new Set((paths ?? []).map(p => p.replace(/\/+$/, '') || '/'))
  const list = await loadFavorites()
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

async function readXbel(): Promise<RecentEntry[]> {
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
ipcMain.handle(CH('addFavorite'), (_e, paths: string[]) => addFavorite(paths))
ipcMain.handle(CH('removeFavorite'), (_e, paths: string[]) => removeFavorite(paths))
ipcMain.handle(CH('listRecent'), (_e, limit: number) => listRecent(limit))
ipcMain.handle(CH('removeRecent'), (_e, p: string) => removeRecent(p))
ipcMain.handle(CH('clearRecent'), () => clearRecent())
