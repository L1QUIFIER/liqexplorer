// On-demand extraction of individual archive members, cached on disk.
//
// This is what makes an archive browsable like a folder: the gallery asks for
// a thumbnail of every visible image, the viewer asks for one full-size file,
// and "open" asks for one member to hand to another app. Extracting each of
// those with its own 7z run would be unusably slow — a 60-image folder would
// mean 60 process spawns and 60 full archive scans — so requests are extracted
// in ONE call per archive.
//
// Cache lives in ~/.cache (never beside the code — checkouts may be on a
// network share) keyed by archive identity (path + mtime + size), so editing or
// replacing an archive invalidates it automatically. Stale directories are
// swept on startup (24h max age).
import * as crypto from 'node:crypto'
import * as fs from 'node:fs'
import * as fsp from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { ipcMain } from 'electron'
import { CH } from '../../../shared/ipc'
import * as backend from './backend'

const ROOT = path.join(os.homedir(), '.cache', 'liqexplorer', 'archive-members')
const MAX_AGE_MS = 24 * 60 * 60 * 1000
/** never auto-extract something enormous just to draw a 96px tile */
const DEFAULT_MAX_BYTES = 64 * 1024 * 1024

async function archiveKey(archive: string): Promise<string> {
  const st = await fsp.stat(archive)
  const h = crypto.createHash('sha1')
  h.update(`${archive}\0${st.mtimeMs}\0${st.size}`)
  return h.digest('hex').slice(0, 16)
}

/** in-flight extractions per archive, so parallel tile requests coalesce */
const inFlight = new Map<string, Promise<void>>()

export interface MemberRequest {
  archive: string
  members: string[]
  password?: string
  maxBytes?: number
}

/**
 * Materialise members into the cache and return member -> local path for the
 * ones that are now present. Missing entries simply have no key: callers show
 * a generic icon rather than an error, because a gallery must not fail loudly
 * over one unreadable file.
 */
export async function materialize(req: MemberRequest): Promise<Record<string, string>> {
  const { archive, password } = req
  const wanted = req.members
    .map(m => backend.normalizeMember(m))
    .filter((m): m is string => !!m && !m.split('/').includes('..') && !m.startsWith('/'))
  if (!wanted.length) return {}

  const key = await archiveKey(archive).catch(() => null)
  if (!key) return {}
  const dir = path.join(ROOT, key)

  const out: Record<string, string> = {}
  const missing: string[] = []
  for (const m of wanted) {
    const local = path.join(dir, m)
    if (fs.existsSync(local)) out[m] = local
    else missing.push(m)
  }
  if (!missing.length) return out

  // Check sizes BEFORE extracting, not after: a gallery asking for tiles from a
  // zip full of video would otherwise unpack gigabytes to disk only to discard
  // anything over the cap. The table of contents is cheap and cached per key.
  const cap = req.maxBytes ?? DEFAULT_MAX_BYTES
  const sizes = await memberSizes(archive, key, password)
  const affordable = sizes
    ? missing.filter(m => (sizes.get(m) ?? 0) <= cap)
    : missing

  // one extraction per archive at a time: concurrent tile requests wait on it
  // rather than spawning a second 7z over the same file
  if (!affordable.length) return out

  const prev = inFlight.get(dir)
  if (prev) await prev.catch(() => {})

  const still = affordable.filter(m => !fs.existsSync(path.join(dir, m)))
  if (still.length) {
    const job = (async () => {
      await fsp.mkdir(dir, { recursive: true })
      const vi = await backend.volumeInfo(archive)
      await backend.extract(vi.primary, dir, { password, members: still })
    })()
    inFlight.set(dir, job)
    try { await job } catch { /* per-member existence check below is the truth */ }
    finally { inFlight.delete(dir) }
  }

  for (const m of affordable) {
    const local = path.join(dir, m)
    try {
      const st = await fsp.stat(local)
      if (st.isFile()) out[m] = local
    } catch { /* not extracted: caller falls back to an icon */ }
  }
  return out
}

/** member -> uncompressed size, from the archive's table of contents (cached) */
const sizeCache = new Map<string, Map<string, number>>()

async function memberSizes(
  archive: string, key: string, password?: string,
): Promise<Map<string, number> | null> {
  const hit = sizeCache.get(key)
  if (hit) return hit
  try {
    const vi = await backend.volumeInfo(archive)
    const listing = await backend.list(vi.primary, { password })
    if (!listing.ok) return null
    const m = new Map<string, number>()
    for (const e of listing.entries) if (!e.isDir) m.set(e.path, e.size)
    if (sizeCache.size > 32) sizeCache.clear()      // bounded: these are per archive
    sizeCache.set(key, m)
    return m
  } catch { return null }
}

/** delete cache directories nobody has touched for a day */
export async function sweep(): Promise<void> {
  let names: string[]
  try { names = await fsp.readdir(ROOT) } catch { return }
  const now = Date.now()
  for (const n of names) {
    const p = path.join(ROOT, n)
    try {
      const st = await fsp.stat(p)
      if (now - st.mtimeMs > MAX_AGE_MS) await fsp.rm(p, { recursive: true, force: true })
    } catch { /* raced another sweep */ }
  }
}

setTimeout(() => { void sweep() }, 10_000).unref?.()

ipcMain.handle(CH('archiveMembers'), (_e, req: MemberRequest) => materialize(req))
