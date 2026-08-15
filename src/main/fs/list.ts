// Directory enumeration: streaming listing, dirs-only listing, stat.
// Streams DirChunk batches over PUSH.dirChunk without buffering whole readdirs;
// stats run through a concurrency pool so huge/remote dirs never serialize.
import * as fs from 'node:fs'
import * as fsp from 'node:fs/promises'
import * as path from 'node:path'
import * as os from 'node:os'
import type { WebContents } from 'electron'
import { PUSH } from '../../shared/ipc'
import type { DirChunk, FileEntry, ListOptions } from '../../shared/types'
import { mimeForName, mimeLabel, iconsForMime, folderIcons, xdgUserDirs } from './mime'
import { allRated, ratingOf } from '../state/ratings'

const CHUNK = 2000
const STAT_POOL = 48
const MOUNT_CACHE_MS = 10_000

let nextReq = 1
/** live listings by reqId; cancelListing flips the flag, checked between stats/chunks */
const listings = new Map<number, { cancelled: boolean }>()

// ---------------------------------------------------------------- mounts

export interface MountInfo {
  prefix: string
  fsType: string
  /** the device field: '//server/share' for cifs, '/dev/sda2' for local */
  device: string
}
let mountTable: MountInfo[] = []
let mountTableAt = 0

/** \040-style octal escapes in /proc/mounts fields */
function decodeMountPath(s: string): string {
  return s.replace(/\\([0-7]{3})/g, (_, o: string) => String.fromCharCode(parseInt(o, 8)))
}

function mounts(): MountInfo[] {
  const now = Date.now()
  if (now - mountTableAt < MOUNT_CACHE_MS && mountTable.length) return mountTable
  mountTableAt = now
  try {
    const txt = fs.readFileSync('/proc/mounts', 'utf8')
    const out: MountInfo[] = []
    for (const line of txt.split('\n')) {
      const parts = line.split(' ')
      if (parts.length < 3) continue
      out.push({
        prefix: decodeMountPath(parts[1]),
        fsType: parts[2],
        device: decodeMountPath(parts[0]),
      })
    }
    if (out.length) mountTable = out
  } catch { /* keep the previous table */ }
  return mountTable
}

/**
 * The live mount table (cached ~10s, same as isRemotePath uses).
 *
 * Exposed for filefinder.ts, which has to answer a question pathExists() cannot:
 * a `noauto` CIFS mountpoint like /mnt/share/vault still exists as an empty local
 * directory when the share is NOT mounted. Handing back index results that point
 * into it would name files that do not resolve.
 */
export function mountEntries(): MountInfo[] { return mounts() }

/** true when a network filesystem is mounted at EXACTLY this path right now */
export function isNetworkMountedAt(mountpoint: string): boolean {
  return mounts().some(m => m.prefix === mountpoint && REMOTE_FS.test(m.fsType))
}

/** mount points, longest first — the renderer uses these to tell whether a
 * drag crosses volumes (Explorer: same volume moves, different volume copies) */
export function mountPoints(): string[] {
  return mounts().map(m => m.prefix).sort((a, b) => b.length - a.length)
}

const REMOTE_FS = /^(cifs|smb3|nfs|fuse\.sshfs|fuse\.gvfsd-fuse)/

/**
 * True when the longest-prefix mount containing p is a network filesystem.
 * Later /proc/mounts entries win prefix ties (a cifs mount over its autofs trigger).
 */
export function isRemotePath(p: string): boolean {
  let bestLen = -1
  let bestType = ''
  for (const m of mounts()) {
    if (m.prefix === '/' ? true : (p === m.prefix || p.startsWith(m.prefix + '/'))) {
      if (m.prefix.length >= bestLen) { bestLen = m.prefix.length; bestType = m.fsType }
    }
  }
  return REMOTE_FS.test(bestType)
}

// ---------------------------------------------------------------- entries

interface EntryCtx {
  /** names from the directory's .hidden file */
  hiddenSet?: Set<string>
  /** precomputed remote flag for the parent dir (skips per-entry mount lookup) */
  remote?: boolean
  /** include writable (access W_OK) for directories — statEntries only */
  withWritable?: boolean
}

export async function entryFor(p: string, name: string, st?: fs.Stats | null, ctx?: EntryCtx): Promise<FileEntry | null> {
  const full = path.join(p, name)
  let lst: fs.Stats
  try { lst = st ?? await fsp.lstat(full) } catch { return null }
  const isLink = lst.isSymbolicLink()
  let st2 = lst
  let target: string | undefined
  if (isLink) {
    try { target = await fsp.readlink(full) } catch { /* dangling */ }
    try { st2 = await fsp.stat(full) } catch { st2 = lst }
  }
  const isDir = st2.isDirectory()
  const ext = isDir ? '' : path.extname(name).slice(1).toLowerCase()
  const mime = mimeForName(name, isDir)
  const e: FileEntry = {
    name, path: full, isDir, isSymlink: isLink, target,
    size: isDir ? -1 : st2.size, mtime: st2.mtimeMs, ctime: st2.ctimeMs,
    btime: st2.birthtimeMs > 0 ? st2.birthtimeMs : undefined,
    atime: st2.atimeMs,
    mime,
    // octet-stream's description is literally "Unknown" — less useful than
    // Explorer's "<EXT> File" fallback, so leave it unset for those
    typeLabel: isDir || mime === 'application/octet-stream' ? undefined : mimeLabel(mime),
    icons: isDir ? folderIcons(full) : iconsForMime(mime),
    hidden: name.startsWith('.') || (ctx?.hiddenSet?.has(name) ?? false),
    ext,
  }
  // A Map lookup, deliberately: the rating xattr on the share costs a full SMB
  // round-trip (~1.33 ms) and reading one here would put a second and a half on
  // every 1000-file folder. state/ratings.ts explains the split.
  const rating = ratingOf(full)
  if (rating) e.rating = rating
  const remote = ctx?.remote ?? isRemotePath(full)
  if (remote) e.remote = true
  if (ctx?.withWritable && isDir) {
    try { await fsp.access(full, fs.constants.W_OK); e.writable = true } catch { e.writable = false }
  }
  return e
}

export interface NoStatFacts {
  isDir: boolean
  /** bytes; ignored for dirs (which always report -1, "unknown") */
  size: number
  /** epoch ms */
  mtime: number
  hidden?: boolean
  isSymlink?: boolean
  remote?: boolean
}

/**
 * Build a FileEntry from facts an index already knows — with ZERO stat calls.
 * That is the entire point of having an index on a CIFS mount: platform/indexer.ts
 * and platform/filefinder.ts both answer from a snapshot, and a stat here would
 * hand back the cost the index exists to avoid.
 *
 * Kept beside entryFor so the two cannot drift on what a FileEntry contains.
 * Fields a snapshot genuinely cannot know (atime, btime, writable, symlink
 * target) are left undefined rather than guessed; ctime falls back to mtime.
 */
export function entryNoStat(dir: string, name: string, f: NoStatFacts): FileEntry {
  const full = dir === '/' ? '/' + name : dir + '/' + name
  const mime = mimeForName(name, f.isDir)
  const e: FileEntry = {
    name,
    path: full,
    isDir: f.isDir,
    isSymlink: f.isSymlink ?? false,
    size: f.isDir ? -1 : f.size,
    mtime: f.mtime,
    ctime: f.mtime,
    mime,
    // same rule as entryFor: octet-stream's label is literally "Unknown", so the
    // view's "<EXT> File" fallback reads better
    typeLabel: f.isDir || mime === 'application/octet-stream' ? undefined : mimeLabel(mime),
    icons: f.isDir ? folderIcons(full) : iconsForMime(mime),
    hidden: f.hidden ?? name.startsWith('.'),
    ext: f.isDir ? '' : path.extname(name).slice(1).toLowerCase(),
  }
  // in-memory Map lookup, no xattr round trip — see state/ratings.ts
  const rating = ratingOf(full)
  if (rating) e.rating = rating
  if (f.remote) e.remote = true
  return e
}

/** the directory's .hidden file: one name per line (freedesktop convention) */
async function readHiddenFile(dir: string): Promise<Set<string> | undefined> {
  try {
    const txt = await fsp.readFile(path.join(dir, '.hidden'), 'utf8')
    const names = txt.split('\n').map(s => s.trim()).filter(Boolean)
    return names.length ? new Set(names) : undefined
  } catch { return undefined }
}

function errCode(e: unknown): DirChunk['errorCode'] {
  const code = (e as NodeJS.ErrnoException)?.code
  if (code === 'ENOENT') return 'ENOENT'
  if (code === 'EACCES' || code === 'EPERM') return 'EACCES'
  if (code === 'ENOTDIR') return 'ENOTDIR'
  return 'OTHER'
}

// ---------------------------------------------------------------- listing

export async function startListing(wc: WebContents, dir: string, opts: ListOptions): Promise<number> {
  const reqId = nextReq++
  const ctl = { cancelled: false }
  listings.set(reqId, ctl)
  // starred:// is served here rather than in the renderer's virtual-location
  // chain so it inherits the whole streaming path — chunking, cancellation,
  // the loading state and the error envelope — for free.
  //
  // Deferred by a tick ON PURPOSE. The renderer only learns this reqId when
  // THIS function's reply arrives, and it drops any chunk whose reqId it does
  // not yet recognise — so a chunk that overtakes the reply leaves the tab
  // showing nothing, loading forever. Today runListing happens to await
  // opendir() before its first send, but that is an accident of its
  // implementation, and invoke-replies and webContents.send are not formally
  // ordered against each other. One tick makes the guarantee explicit and
  // costs nothing next to a directory read.
  setImmediate(() => {
    // cancelList() can land inside that tick — a fast Back/Forward does exactly
    // this — and there is no point opening the directory at all then
    if (ctl.cancelled) { listings.delete(reqId); return }
    const run = dir === STARRED_URI
      ? runStarredListing(wc, opts, reqId, ctl)
      : runListing(wc, dir, opts, reqId, ctl)
    void run.finally(() => listings.delete(reqId))
  })
  return reqId
}

async function runListing(
  wc: WebContents, dir: string, opts: ListOptions, reqId: number, ctl: { cancelled: boolean },
): Promise<void> {
  const send = (c: DirChunk) => { if (!wc.isDestroyed()) wc.send(PUSH.dirChunk, c) }

  let handle: Awaited<ReturnType<typeof fsp.opendir>>
  try {
    handle = await fsp.opendir(dir)
  } catch (e: any) {
    send({ reqId, path: dir, entries: [], done: true, error: String(e?.message ?? e), errorCode: errCode(e) })
    return
  }

  const hiddenSet = await readHiddenFile(dir)
  const remote = isRemotePath(dir)
  const ctx: EntryCtx = { hiddenSet, remote }

  const batch: FileEntry[] = []
  const pending = new Set<Promise<void>>()
  let failure: unknown = null

  try {
    for await (const d of handle) {
      if (ctl.cancelled || wc.isDestroyed()) break
      const name = d.name
      const hid = name.startsWith('.') || (hiddenSet?.has(name) ?? false)
      if (!opts.showHidden && hid) continue
      // dirs-only pre-filter on dirent type (symlinks resolved in entryFor)
      if (opts.dirsOnly && !d.isDirectory() && !d.isSymbolicLink()) continue
      const task = (async () => {
        const e = await entryFor(dir, name, null, ctx)
        if (!e) return
        if (opts.dirsOnly && !e.isDir) return
        batch.push(e)
      })().catch(() => { /* per-entry errors: skip */ })
      pending.add(task)
      void task.finally(() => pending.delete(task))
      if (pending.size >= STAT_POOL) await Promise.race(pending)
      if (batch.length >= CHUNK) {
        send({ reqId, path: dir, entries: batch.splice(0, batch.length), done: false })
        if (ctl.cancelled) break
      }
    }
  } catch (e) {
    failure = e
  }
  await Promise.allSettled([...pending])
  if (ctl.cancelled || wc.isDestroyed()) return
  if (failure) {
    send({
      reqId, path: dir, entries: batch, done: true,
      error: String((failure as any)?.message ?? failure), errorCode: errCode(failure),
    })
  } else {
    send({ reqId, path: dir, entries: batch, done: true })
  }
}

// ---------------------------------------------------------------- starred://

export const STARRED_URI = 'starred://'
/** the view is a shortlist, not an archive; a rated set this big means the cap
 *  is doing its job rather than that someone is missing files */
const STARRED_CAP = 5000
/**
 * One stat here may be the first touch of a share that has gone away. The
 * indexer's finding applies: abandoning the promise does not free the libuv
 * thread, so the only thing worth buying is the right to STOP QUEUEING more.
 */
const STAT_TIMEOUT_MS = 5_000
const MAX_STAT_TIMEOUTS = 3

/** A row for a file we could not stat in time — the rating is real and the user
 *  should see it, so the entry is shown with whatever the path alone can tell. */
function unstattedEntry(p: string, rating: number): FileEntry {
  const name = path.basename(p)
  const mime = mimeForName(name, false)
  return {
    name, path: p, isDir: false, isSymlink: false,
    size: -1, mtime: 0, ctime: 0, mime,
    typeLabel: mime === 'application/octet-stream' ? undefined : mimeLabel(mime),
    icons: iconsForMime(mime),
    hidden: name.startsWith('.'),
    ext: path.extname(name).slice(1).toLowerCase(),
    remote: true, rating,
  }
}

/**
 * Everything rated, machine-wide. This never walks the filesystem — the index
 * already holds every rated path — which is exactly why a dead SMB mount cannot
 * wedge it the way a scan could. The only filesystem contact is one stat per
 * rated file to fill in size/type/icon, and that is bounded and gives up.
 */
async function runStarredListing(
  wc: WebContents, opts: ListOptions, reqId: number, ctl: { cancelled: boolean },
): Promise<void> {
  const send = (c: DirChunk): void => { if (!wc.isDestroyed()) wc.send(PUSH.dirChunk, c) }
  const rated = allRated().slice(0, STARRED_CAP)
  const batch: FileEntry[] = []
  let timeouts = 0

  for (let i = 0; i < rated.length && !ctl.cancelled && !wc.isDestroyed(); i += STAT_POOL) {
    const slice = rated.slice(i, i + STAT_POOL)
    const results = await Promise.all(slice.map(async ({ path: p, rating }) => {
      if (timeouts >= MAX_STAT_TIMEOUTS) return unstattedEntry(p, rating)
      const got = await Promise.race([
        entryFor(path.dirname(p), path.basename(p), null, { withWritable: false })
          .catch(() => null),
        new Promise<'timeout'>(res => {
          const t = setTimeout(() => res('timeout'), STAT_TIMEOUT_MS)
          t.unref?.()
        }),
      ])
      if (got === 'timeout') { timeouts++; return unstattedEntry(p, rating) }
      if (!got) return null                  // rated file has since been deleted
      got.rating = rating
      return got
    }))
    for (const e of results) {
      if (!e) continue
      if (!opts.showHidden && e.hidden) continue
      batch.push(e)
    }
    if (batch.length >= CHUNK) send({ reqId, path: STARRED_URI, entries: batch.splice(0, batch.length), done: false })
  }
  if (ctl.cancelled || wc.isDestroyed()) return
  send({ reqId, path: STARRED_URI, entries: batch, done: true })
}

export function cancelListing(reqId: number): void {
  const ctl = listings.get(reqId)
  if (ctl) ctl.cancelled = true
}

// ---------------------------------------------------------------- dirs-only fast path

const natural = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })

/**
 * Nav-tree listing: directories only, no per-entry stat (dirent type is enough);
 * only symlinks get resolved to see whether they point at a directory.
 */
export async function listChildDirs(dir: string, showHidden: boolean): Promise<FileEntry[]> {
  let handle: Awaited<ReturnType<typeof fsp.opendir>>
  try { handle = await fsp.opendir(dir) } catch { return [] }
  const hiddenSet = await readHiddenFile(dir)
  const remote = isRemotePath(dir)
  const out: FileEntry[] = []
  const linkNames: string[] = []
  try {
    for await (const d of handle) {
      const name = d.name
      const hid = name.startsWith('.') || (hiddenSet?.has(name) ?? false)
      if (!showHidden && hid) continue
      if (d.isDirectory()) {
        const full = path.join(dir, name)
        const e: FileEntry = {
          name, path: full, isDir: true, isSymlink: false,
          size: -1, mtime: 0, ctime: 0,
          mime: 'inode/directory', icons: folderIcons(full),
          hidden: hid, ext: '',
        }
        if (remote) e.remote = true
        out.push(e)
      } else if (d.isSymbolicLink()) {
        linkNames.push(name)
      }
    }
  } catch { /* partial results are fine for the tree */ }
  if (linkNames.length) {
    const resolved = await Promise.all(
      linkNames.map(n => entryFor(dir, n, null, { hiddenSet, remote })),
    )
    for (const e of resolved) if (e?.isDir) out.push(e)
  }
  out.sort((a, b) => natural.compare(a.name, b.name))
  return out
}

// ---------------------------------------------------------------- stat helpers

export async function statEntries(paths: string[]): Promise<(FileEntry | null)[]> {
  return Promise.all(paths.map(p =>
    entryFor(path.dirname(p), path.basename(p), null, { withWritable: true }),
  ))
}

export async function pathExists(p: string): Promise<boolean> {
  try { await fsp.access(p); return true } catch { return false }
}

export function homeDir(): string { return os.homedir() }

export function userDirs(): Record<string, string> { return xdgUserDirs() }
