// Star ratings — the index that every read goes through.
//
// WHY AN INDEX AND NOT JUST XATTRS. Extended attributes do work here, on ext4
// and on the CIFS share both (platform/ratingmeta.ts has the numbers and how
// they were taken), and they are written for every rating because that is what
// makes a rating survive a move by a tool that is not this app. But reading one
// costs a full SMB round-trip on the share — 1.33 ms against 0.004 ms for the
// lstat the listing already did, 363x — so a listing that read them per file
// would stall for over a second on a 1000-file folder. The index answers in a
// Map lookup, which is what fs/list.ts calls for every entry it builds.
//
// So the two layers have different jobs:
//   index  — authoritative for READS, and the only thing "Starred" needs (no
//            filesystem walk at all, which is also why a dead mount cannot
//            wedge it the way a scan could)
//   xattr  — durable copy ON the file, so an external move/rename keeps it;
//            read back lazily by backfill() when the index has never seen a path
//
// Moves made by this app are re-keyed directly from the op engine's movedPairs,
// so a rating follows a file across a copy-and-delete move between devices,
// where the xattr does not survive at all.
import * as fs from 'node:fs'
import * as fsp from 'node:fs/promises'
import * as path from 'node:path'
import { ipcMain } from 'electron'
import { CH } from '../../shared/ipc'
import { STATE_DIR } from './settings'
import { broadcast } from '../windows'
import { clampRating, RATINGS_CHANGED, type RatingsChanged } from '../../shared/ratings'
import { canHoldXmp, readXattrRatings, readXmpRating, writeXattrRating } from '../platform/ratingmeta'

const FILE = (): string => path.join(STATE_DIR, 'ratings.json')
/** a rated file is a deliberate act, so this is generous; the cap only exists
 *  so a runaway caller cannot grow the file without bound */
const MAX_ENTRIES = 50_000
const SAVE_DEBOUNCE_MS = 400
/** ceiling on one backfill sweep — bounded because each miss is an SMB
 *  round-trip on the share (see ratingmeta.ts) */
const BACKFILL_CAP = 240
/** images opened per sweep to look for an embedded xmp:Rating */
const XMP_CAP = 60

interface Rec { r: number; at: number }

let index = new Map<string, Rec>()
let loaded = false
let saveTimer: NodeJS.Timeout | null = null
let tmpCounter = 0

function load(): void {
  if (loaded) return
  loaded = true
  try {
    const raw = JSON.parse(fs.readFileSync(FILE(), 'utf8')) as { entries?: Record<string, Rec> }
    for (const [p, rec] of Object.entries(raw.entries ?? {})) {
      const r = clampRating(rec?.r)
      if (r) index.set(p, { r, at: Number(rec?.at) || 0 })
    }
  } catch { /* absent or damaged: an empty index is a correct empty index */ }
}

async function writeAtomic(txt: string): Promise<void> {
  await fsp.mkdir(STATE_DIR, { recursive: true })
  const tmp = `${FILE()}.liqtmp-${process.pid}-${tmpCounter++}`
  try {
    const fh = await fsp.open(tmp, 'w', 0o600)
    try {
      await fh.writeFile(txt, 'utf8')
      await fh.sync()          // ratings are user intent, not a cache: an
    } finally { await fh.close() }   // unclean shutdown must not empty the file
    await fsp.rename(tmp, FILE())
  } catch (err) {
    await fsp.unlink(tmp).catch(() => {})
    throw err
  }
}

function scheduleSave(): void {
  if (saveTimer) return
  saveTimer = setTimeout(() => {
    saveTimer = null
    if (index.size > MAX_ENTRIES) {
      // oldest ratings go first — the cap is a backstop, not a policy
      const keep = [...index.entries()].sort((a, b) => b[1].at - a[1].at).slice(0, MAX_ENTRIES)
      index = new Map(keep)
    }
    const entries: Record<string, Rec> = {}
    for (const [p, rec] of index) entries[p] = rec
    void writeAtomic(JSON.stringify({ version: 1, entries })).catch(() => {})
  }, SAVE_DEBOUNCE_MS)
  saveTimer.unref?.()
}

function publish(changes: Record<string, number>): void {
  if (!Object.keys(changes).length) return
  scheduleSave()
  broadcast(RATINGS_CHANGED, { changes } satisfies RatingsChanged)
}

// ---------------------------------------------------------------- reads

/** Synchronous by design: fs/list.ts calls this for every entry it builds, so
 *  it must cost a Map lookup and never touch the disk or the network. */
export function ratingOf(p: string): number {
  load()
  return index.get(p)?.r ?? 0
}

export function allRated(): { path: string; rating: number }[] {
  load()
  return [...index].map(([p, rec]) => ({ path: p, rating: rec.r }))
}

export function ratedCount(): number { load(); return index.size }

// ---------------------------------------------------------------- writes

export async function setRating(paths: string[], rating: number): Promise<Record<string, number>> {
  load()
  const r = clampRating(rating)
  const changes: Record<string, number> = {}
  const at = Date.now()
  for (const p of paths) {
    if (!p.startsWith('/')) continue         // virtual rows have nothing to tag
    if (r) index.set(p, { r, at }); else index.delete(p)
    changes[p] = r
  }
  publish(changes)
  // The xattr is the copy that travels with the file. It is best-effort on
  // purpose: a read-only file or a filesystem without user_xattr must still
  // take the rating, because the index already did.
  await Promise.all(paths.map(p => writeXattrRating(p, r).catch(() => false)))
  return changes
}

/**
 * Re-key ratings after this app moved or renamed files. Directory moves are
 * handled by prefix, since the engine records one pair for the directory and
 * none for the children whose ratings are keyed by their old full path.
 */
export function migrate(pairs: { from: string; to: string }[]): void {
  load()
  if (!index.size) return
  const changes: Record<string, number> = {}
  for (const { from, to } of pairs) {
    if (!from || !to || from === to) continue
    const exact = index.get(from)
    if (exact) {
      index.delete(from)
      index.set(to, exact)
      changes[from] = 0
      changes[to] = exact.r
    }
    const prefix = from.endsWith('/') ? from : from + '/'
    for (const [p, rec] of [...index]) {
      if (!p.startsWith(prefix)) continue
      const moved = to + p.slice(from.length)
      index.delete(p)
      index.set(moved, rec)
      changes[p] = 0
      changes[moved] = rec.r
    }
  }
  publish(changes)
}

/** Ratings written by something else: an external move carried the xattr, or a
 *  photo arrived already rated in digiKam/Lightroom/Explorer. Bounded, and only
 *  ever called for paths the index has never seen. */
export async function backfill(paths: string[]): Promise<Record<string, number>> {
  load()
  const unknown = paths.filter(p => p.startsWith('/') && !index.has(p)).slice(0, BACKFILL_CAP)
  if (!unknown.length) return {}
  const changes: Record<string, number> = {}
  const at = Date.now()

  const fromXattr = await readXattrRatings(unknown).catch(() => new Map<string, number>())
  for (const [p, r] of fromXattr) {
    if (!r || index.has(p)) continue
    index.set(p, { r, at })
    changes[p] = r
  }

  // Only images can carry XMP, and only the ones no xattr answered for — this
  // is what keeps the sweep off the "open every file in the folder" path.
  // Capped separately because each one is a file open, which on the share is
  // dearer than the xattr probe that already ran.
  const forXmp = unknown
    .filter(p => !index.has(p) && canHoldXmp(path.extname(p).slice(1).toLowerCase()))
    .slice(0, XMP_CAP)
  for (const p of forXmp) {
    const r = await readXmpRating(p).catch(() => null)
    if (!r) continue
    index.set(p, { r, at })
    changes[p] = r
  }

  publish(changes)
  return changes
}

// ---------------------------------------------------------------------- ipc
// Self-registered (the ops/quick.ts pattern) so main/ipc.ts stays untouched;
// the module is reached through fs/list.ts, which needs ratingOf() anyway.

ipcMain.handle(CH('setRating'), (_e, paths: string[], rating: number) => setRating(paths, rating))
ipcMain.handle(CH('getRatings'), (_e, paths: string[]) => {
  load()
  const out: Record<string, number> = {}
  for (const p of paths) { const r = index.get(p)?.r; if (r) out[p] = r }
  return out
})
ipcMain.handle(CH('backfillRatings'), (_e, paths: string[]) => backfill(paths))
ipcMain.handle(CH('ratedCount'), () => ratedCount())
ipcMain.handle(CH('clearAllRatings'), async () => {
  load()
  const changes: Record<string, number> = {}
  for (const p of index.keys()) changes[p] = 0
  index.clear()
  publish(changes)
  return Object.keys(changes).length
})
