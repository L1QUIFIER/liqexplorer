// Navigation-pane places: Home + XDG user dirs, GTK bookmarks (pinned),
// drives + network mounts from /proc/self/mountinfo, gvfs fuse mounts, Trash.
//
// Watching: a 3s content-hash poll of mountinfo + the gvfs dir, plus fs.watch
// on ~/.config/gtk-3.0 (bookmarks is atomically replaced by GTK, so we watch
// the directory) — any change broadcasts PUSH.placesChanged with a fresh list.
// pin/unpin edit the GTK bookmarks file (shared with Nemo and GTK choosers).

import * as fs from 'node:fs'
import * as fsp from 'node:fs/promises'
import * as os from 'node:os'
import { STATE_DIR, TEST_PROFILE } from '../state/settings'
import * as path from 'node:path'
import { execFile } from 'node:child_process'
import type { DriveDetail, Place } from '../../shared/types'
import { userDirs } from '../fs/list'
import { broadcast } from '../windows'
import { PUSH } from '../../shared/ipc'
import { gioEncodeFileUri } from './protocols'

// ---------------------------------------------------------------------------
// mountinfo parsing
// ---------------------------------------------------------------------------

interface MountEntry {
  mountPoint: string
  fstype: string
  source: string
}

const BLOCK_FS = new Set(['ext4', 'ext3', 'ext2', 'btrfs', 'xfs', 'vfat', 'exfat', 'ntfs', 'ntfs3', 'f2fs'])
const SKIP_PREFIXES = ['/boot', '/snap', '/var/snap', '/timeshift', '/run/timeshift']

function unescapeMnt(s: string): string {
  return s.replace(/\\(\d{3})/g, (_, oct: string) => String.fromCharCode(parseInt(oct, 8)))
}

function parseMounts(): MountEntry[] {
  let txt = ''
  try { txt = fs.readFileSync('/proc/self/mountinfo', 'utf8') } catch { return [] }
  const out: MountEntry[] = []
  for (const line of txt.split('\n')) {
    const sep = line.indexOf(' - ')
    if (sep < 0) continue
    const pre = line.slice(0, sep).split(' ')
    const post = line.slice(sep + 3).split(' ')
    const mountPoint = unescapeMnt(pre[4] ?? '')
    const fstype = post[0] ?? ''
    const source = unescapeMnt(post[1] ?? '')
    if (mountPoint && fstype) out.push({ mountPoint, fstype, source })
  }
  return out
}

function isRealBlockDevice(source: string): boolean {
  return /^\/dev\/(sd[a-z]|nvme\d|vd[a-z]|mmcblk\d|mapper\/)/.test(source)
}

function isNetworkFs(fstype: string): boolean {
  return fstype === 'cifs' || fstype === 'smb3' || fstype.startsWith('nfs')
}

function isRemovableMount(mountPoint: string): boolean {
  return mountPoint.startsWith('/media/') || mountPoint.startsWith('/run/media/')
}

function driveMounts(): MountEntry[] {
  const out: MountEntry[] = []
  const seenDev = new Set<string>()
  for (const m of parseMounts()) {
    if (!BLOCK_FS.has(m.fstype)) continue
    if (!isRealBlockDevice(m.source)) continue
    if (SKIP_PREFIXES.some(p => m.mountPoint === p || m.mountPoint.startsWith(p))) continue
    if (seenDev.has(m.source)) continue           // bind/second mount of same device
    seenDev.add(m.source)
    out.push(m)
  }
  return out
}

function networkMounts(): MountEntry[] {
  return parseMounts().filter(m => isNetworkFs(m.fstype))
}

/** true when p is exactly a mountpoint (drive-properties trigger). */
export function isMountPoint(p: string): boolean {
  const norm = p !== '/' ? p.replace(/\/+$/, '') : p
  return parseMounts().some(m => m.mountPoint === norm)
}

/** per-mountpoint statfs state: one in-flight call max + last known capacity */
interface StatfsState { inflight: boolean; last?: { total: number; free: number } }
const statfsState = new Map<string, StatfsState>()

async function statfsSafe(p: string, timeoutMs = 2000): Promise<{ total: number; free: number } | undefined> {
  let entry = statfsState.get(p)
  if (!entry) { entry = { inflight: false }; statfsState.set(p, entry) }
  const s = entry
  // statfs on a hung network mount blocks a libuv threadpool thread until the
  // kernel gives up (minutes). Racing a timer abandons but cannot cancel it,
  // so never stack a second call on the same mount — serve the last known
  // capacity until the stuck call settles.
  if (s.inflight) return s.last
  s.inflight = true
  const real = fsp.statfs(p)
    .then(st => { s.last = { total: st.bsize * st.blocks, free: st.bsize * st.bavail }; return s.last })
    .catch(() => { s.last = undefined; return undefined })
    .finally(() => { s.inflight = false })
  const raced = await Promise.race([
    real,
    new Promise<null>(res => setTimeout(() => res(null), timeoutMs).unref()),
  ])
  return raced === null ? s.last : raced
}

// ---------------------------------------------------------------------------
// GTK bookmarks
// ---------------------------------------------------------------------------

const REAL_BOOKMARKS = path.join(os.homedir(), '.config', 'gtk-3.0', 'bookmarks')

/**
 * Pin/unpin EDIT this file, and it is shared with Nemo and every GTK file
 * chooser — so a test run must never write the real one. (It did: a scripted
 * unpin during QA removed entries from the user's actual bookmarks.) Under
 * LIQEXPLORER_TEST the file is redirected into the test profile and seeded
 * from the real one on first use, so test runs still see realistic data.
 */
function bookmarksFile(): string {
  if (!TEST_PROFILE) return REAL_BOOKMARKS
  const copy = path.join(STATE_DIR, 'gtk-bookmarks')
  if (!fs.existsSync(copy)) {
    try {
      fs.mkdirSync(STATE_DIR, { recursive: true })
      fs.copyFileSync(REAL_BOOKMARKS, copy)
    } catch { try { fs.writeFileSync(copy, '') } catch { /* read-only: fall through */ } }
  }
  return copy
}

let bmTmpCounter = 0

/** GTK replaces this file atomically; do the same so a crash or a concurrent
 *  Nemo/GTK write can never leave it truncated (it is shared by all GTK apps). */
async function writeBookmarksAtomic(file: string, txt: string): Promise<void> {
  const tmp = `${file}.liqtmp-${process.pid}-${bmTmpCounter++}`
  await fsp.writeFile(tmp, txt, 'utf8')
  await fsp.rename(tmp, file)
}

function decodeFileUri(uri: string): string | null {
  if (!uri.startsWith('file://')) return null
  let rest = uri.slice('file://'.length)
  if (!rest.startsWith('/')) return null            // file://host/... — skip
  try { rest = decodeURIComponent(rest) } catch { /* keep raw */ }
  return rest
}

interface Bookmark { path: string; label: string }

function readBookmarks(): Bookmark[] {
  let txt = ''
  try { txt = fs.readFileSync(bookmarksFile(), 'utf8') } catch { return [] }
  const out: Bookmark[] = []
  for (const raw of txt.split('\n')) {
    const line = raw.trim()
    if (!line) continue
    const sp = line.indexOf(' ')
    const uri = sp >= 0 ? line.slice(0, sp) : line
    const label = sp >= 0 ? line.slice(sp + 1).trim() : ''
    const p = decodeFileUri(uri)
    if (p === null) continue                        // non-file scheme (smb:// etc.)
    out.push({ path: p, label: label || path.basename(p) || p })
  }
  return out
}

// ---------------------------------------------------------------------------
// gvfs fuse mounts
// ---------------------------------------------------------------------------

function gvfsRoot(): string {
  const uid = typeof process.getuid === 'function' ? process.getuid() : 1000
  return `/run/user/${uid}/gvfs`
}

function gvfsLabel(name: string): { label: string; icons: string[] } {
  const colon = name.indexOf(':')
  const scheme = colon >= 0 ? name.slice(0, colon) : name
  const kv = new Map<string, string>()
  if (colon >= 0) {
    for (const part of name.slice(colon + 1).split(',')) {
      const eq = part.indexOf('=')
      if (eq >= 0) kv.set(part.slice(0, eq), part.slice(eq + 1))
    }
  }
  switch (scheme) {
    case 'smb-share': {
      const server = kv.get('server') ?? '?'
      const share = kv.get('share') ?? '?'
      return { label: `${share} on ${server}`, icons: ['folder-remote', 'network-server'] }
    }
    case 'google-drive':
      return { label: 'Google Drive', icons: ['folder-google-drive', 'folder-remote'] }
    case 'afc':
      return { label: 'iPhone / iPad', icons: ['phone-apple-iphone', 'phone', 'multimedia-player'] }
    case 'mtp':
      return { label: 'Portable device', icons: ['multimedia-player', 'phone', 'drive-removable-media'] }
    case 'gphoto2':
      return { label: 'Camera', icons: ['camera-photo', 'drive-removable-media'] }
    case 'sftp':
    case 'ftp':
    case 'dav':
    case 'davs':
    case 'nfs': {
      const host = kv.get('host') ?? '?'
      return { label: `${scheme} on ${host}`, icons: ['folder-remote', 'network-server'] }
    }
    default:
      return { label: name, icons: ['folder-remote'] }
  }
}

function gvfsNames(): string[] {
  try { return fs.readdirSync(gvfsRoot()) } catch { return [] }
}

// ---------------------------------------------------------------------------
// places assembly
// ---------------------------------------------------------------------------

const USER_DIR_META: [key: string, label: string, icon: string][] = [
  ['DESKTOP', 'Desktop', 'user-desktop'],
  ['DOWNLOAD', 'Downloads', 'folder-download'],
  ['DOCUMENTS', 'Documents', 'folder-documents'],
  ['PICTURES', 'Pictures', 'folder-pictures'],
  ['MUSIC', 'Music', 'folder-music'],
  ['VIDEOS', 'Videos', 'folder-videos'],
]

/** id -> data needed for eject; rebuilt on every computePlaces() */
const ejectInfo = new Map<string, { kind: 'drive' | 'network-drive' | 'gvfs'; path: string; device?: string }>()

async function computePlaces(): Promise<Place[]> {
  const h = os.homedir()
  const places: Place[] = []
  ejectInfo.clear()

  // (a) Home + XDG user dirs
  places.push({ id: 'home', kind: 'home', label: 'Home', path: h, icons: ['user-home', 'folder-home'] })
  const ud = userDirs()
  for (const [key, label, icon] of USER_DIR_META) {
    const p = ud[key]
    if (!p || p === h) continue
    try { if (!fs.statSync(p).isDirectory()) continue } catch { continue }
    if (unpinnedSet().has(p)) continue          // user took it out of Quick access
    // Quick access entries are pinned by definition (Windows ships Desktop /
    // Downloads / Documents / Pictures pinned), so they carry the pin glyph and
    // can be unpinned like any other.
    places.push({ id: `user-dir:${key}`, kind: 'user-dir', label, path: p, icons: [icon, 'folder'], pinned: true })
  }

  // (b) pinned GTK bookmarks. A bookmark for a folder that is already an XDG
  // user dir (very common — GTK adds them) must not produce a second row: mark
  // the existing entry pinned instead, so it keeps its proper icon and still
  // offers "Unpin from Quick access".
  for (const b of readBookmarks()) {
    const existing = places.find(p => p.path === b.path)
    if (existing) { existing.pinned = true; continue }
    places.push({
      id: `pin:${b.path}`, kind: 'pinned', label: b.label, path: b.path,
      icons: ['folder'], pinned: true,
    })
  }

  // (c) drives + kernel network mounts
  for (const m of driveMounts()) {
    const label = m.mountPoint === '/' ? 'Filesystem'
      : (m.mountPoint.split('/').filter(Boolean).pop() ?? m.mountPoint)
    const removable = isRemovableMount(m.mountPoint)
    const id = `drive:${m.mountPoint}`
    places.push({
      id, kind: 'drive', label, path: m.mountPoint,
      icons: removable ? ['drive-removable-media', 'drive-harddisk'] : ['drive-harddisk'],
      capacity: await statfsSafe(m.mountPoint),
      ejectable: removable,
    })
    ejectInfo.set(id, { kind: 'drive', path: m.mountPoint, device: m.source })
  }
  for (const m of networkMounts()) {
    // source '//server/share' -> 'share on server'
    const mm = m.source.match(/^\/\/([^/]+)\/(.+)$/)
    const label = mm ? `${mm[2].replace(/\/+$/, '')} on ${mm[1]}` : m.source
    const id = `net:${m.mountPoint}`
    places.push({
      id, kind: 'network-drive', label, path: m.mountPoint,
      icons: ['folder-remote', 'network-server'],
      capacity: await statfsSafe(m.mountPoint),
      ejectable: true,
    })
    ejectInfo.set(id, { kind: 'network-drive', path: m.mountPoint, device: m.source })
  }

  // (d) gvfs fuse mounts
  const groot = gvfsRoot()
  for (const name of gvfsNames()) {
    const { label, icons } = gvfsLabel(name)
    const id = `gvfs:${name}`
    const p = path.join(groot, name)
    places.push({ id, kind: 'gvfs', label, path: p, icons, ejectable: true })
    ejectInfo.set(id, { kind: 'gvfs', path: p })
  }

  // (e) trash last
  places.push({ id: 'trash', kind: 'trash', label: 'Recycle Bin', path: 'trash://', icons: ['user-trash'] })

  return places
}

// ---------------------------------------------------------------------------
// watching
// ---------------------------------------------------------------------------

let watchStarted = false
let lastHash = ''

function currentHash(): string {
  let mi = ''
  try { mi = fs.readFileSync('/proc/self/mountinfo', 'utf8') } catch { /* ignore */ }
  return mi + '\0' + gvfsNames().join(',')
}

async function fireChanged(): Promise<void> {
  broadcast(PUSH.placesChanged, await computePlaces())
}

function startWatching(): void {
  if (watchStarted) return
  watchStarted = true
  lastHash = currentHash()
  const t = setInterval(() => {
    const h = currentHash()
    if (h !== lastHash) {
      lastHash = h
      void fireChanged()
    }
  }, 3000)
  t.unref()
  try {
    const dir = path.dirname(bookmarksFile())
    const w = fs.watch(dir, (_ev, fname) => {
      if (fname && fname !== 'bookmarks') return
      void fireChanged()
    })
    w.unref()
  } catch { /* gtk-3.0 dir may not exist yet */ }
}

// ---------------------------------------------------------------------------
// exports (signatures fixed by main/ipc.ts)
// ---------------------------------------------------------------------------

export async function getPlaces(): Promise<Place[]> {
  startWatching()
  return computePlaces()
}

export async function getDriveDetails(): Promise<DriveDetail[]> {
  const out: DriveDetail[] = []
  for (const m of driveMounts()) {
    const cap = await statfsSafe(m.mountPoint)
    out.push({
      device: m.source,
      fsType: m.fstype,
      mountPoint: m.mountPoint,
      label: m.mountPoint === '/' ? 'Filesystem' : (m.mountPoint.split('/').filter(Boolean).pop() ?? m.mountPoint),
      total: cap?.total ?? 0,
      free: cap?.free ?? 0,
      isNetwork: false,
      isRemovable: isRemovableMount(m.mountPoint),
    })
  }
  for (const m of networkMounts()) {
    const cap = await statfsSafe(m.mountPoint)
    const mm = m.source.match(/^\/\/([^/]+)\/(.+)$/)
    out.push({
      device: m.source,
      fsType: m.fstype,
      mountPoint: m.mountPoint,
      label: mm ? `${mm[2].replace(/\/+$/, '')} on ${mm[1]}` : m.source,
      total: cap?.total ?? 0,
      free: cap?.free ?? 0,
      isNetwork: true,
      isRemovable: false,
    })
  }
  return out
}

export async function pinPlace(p: string): Promise<void> {
  await setUnpinned(p, false)      // re-pinning restores a removed user dir
  const file = bookmarksFile()
  await fsp.mkdir(path.dirname(file), { recursive: true })
  let txt = ''
  try { txt = await fsp.readFile(file, 'utf8') } catch { /* new file */ }
  const uri = gioEncodeFileUri(p)
  const lines = txt.split('\n').filter(Boolean)
  if (lines.some(l => (l.split(' ')[0] ?? '') === uri)) return   // already pinned
  lines.push(uri)
  await writeBookmarksAtomic(file, lines.join('\n') + '\n')
  void fireChanged()
}

export async function unpinPlace(p: string): Promise<void> {
  const file = bookmarksFile()
  let txt = ''
  try { txt = await fsp.readFile(file, 'utf8') } catch { txt = '' }
  if (txt) {
    const keep = txt.split('\n').filter(Boolean).filter(l => {
      const uri = l.split(' ')[0] ?? ''
      return decodeFileUri(uri) !== p
    })
    await writeBookmarksAtomic(file, keep.length ? keep.join('\n') + '\n' : '')
  }
  // The XDG user dirs are synthesized into Quick access whether or not they are
  // bookmarked (Windows pins Desktop/Downloads/Documents/Pictures by default),
  // so dropping the bookmark alone would leave the row sitting there and make
  // "Unpin" look broken. Remember the removal instead.
  await setUnpinned(p, true)
  void fireChanged()
}

// ---- user-dir removals (paths the user unpinned out of Quick access) ----

const unpinnedFile = (): string => path.join(STATE_DIR, 'quickaccess.json')
let unpinnedCache: Set<string> | null = null

function unpinnedSet(): Set<string> {
  if (unpinnedCache) return unpinnedCache
  try {
    const raw = fs.readFileSync(unpinnedFile(), 'utf8')
    const arr = JSON.parse(raw) as { unpinned?: string[] }
    unpinnedCache = new Set(Array.isArray(arr.unpinned) ? arr.unpinned : [])
  } catch {
    unpinnedCache = new Set()          // missing or unreadable: nothing removed
  }
  return unpinnedCache
}

async function setUnpinned(p: string, on: boolean): Promise<void> {
  const set = unpinnedSet()
  if (on) set.add(p); else set.delete(p)
  try {
    await fsp.mkdir(STATE_DIR, { recursive: true })
    const tmp = unpinnedFile() + `.tmp-${process.pid}`
    await fsp.writeFile(tmp, JSON.stringify({ unpinned: [...set] }, null, 1), 'utf8')
    await fsp.rename(tmp, unpinnedFile())
  } catch { /* keeps working this session, just not remembered */ }
}

function run(cmd: string, args: string[], timeoutMs = 20_000): Promise<{ ok: boolean; error?: string }> {
  return new Promise(res => {
    execFile(cmd, args, { timeout: timeoutMs, encoding: 'utf8' }, (err, _stdout, stderr) => {
      if (err) res({ ok: false, error: (stderr || err.message || 'failed').trim() })
      else res({ ok: true })
    })
  })
}

export async function ejectDrive(placeId: string): Promise<{ ok: boolean; error?: string }> {
  const info = ejectInfo.get(placeId)
  if (!info) return { ok: false, error: 'Unknown drive' }
  if (info.kind === 'gvfs' || info.kind === 'network-drive') {
    const r = await run('gio', ['mount', '-e', info.path])
    if (r.ok) return r
    return run('gio', ['mount', '-u', info.path])     // shares can't eject, only unmount
  }
  // real block device: unmount, then power off (power-off failure is not fatal —
  // internal SATA/NVMe devices refuse it, which is fine)
  if (!info.device) return { ok: false, error: 'No device node' }
  const um = await run('udisksctl', ['unmount', '-b', info.device])
  if (!um.ok) return um
  await run('udisksctl', ['power-off', '-b', info.device])
  void fireChanged()
  return { ok: true }
}
