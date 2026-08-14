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

const CHUNK = 2000
const STAT_POOL = 48
const MOUNT_CACHE_MS = 10_000

let nextReq = 1
/** live listings by reqId; cancelListing flips the flag, checked between stats/chunks */
const listings = new Map<number, { cancelled: boolean }>()

// ---------------------------------------------------------------- mounts

interface MountInfo { prefix: string; fsType: string }
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
      out.push({ prefix: decodeMountPath(parts[1]), fsType: parts[2] })
    }
    if (out.length) mountTable = out
  } catch { /* keep the previous table */ }
  return mountTable
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
  const remote = ctx?.remote ?? isRemotePath(full)
  if (remote) e.remote = true
  if (ctx?.withWritable && isDir) {
    try { await fsp.access(full, fs.constants.W_OK); e.writable = true } catch { e.writable = false }
  }
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
  void runListing(wc, dir, opts, reqId, ctl).finally(() => listings.delete(reqId))
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
