// Playback positions: "you were 41 minutes into this one".
//
// Structurally this is the small sibling of state/ratings.ts and deliberately
// copies its shape — a Map index, a debounced atomic write, an LRU cap — with
// two differences that follow from what the data IS:
//
//   * No xattr copy. A rating is user intent worth carrying on the file itself;
//     a playback position is a convenience, and writing an SMB round-trip's
//     worth of xattr every few seconds during playback would be absurd.
//   * No fsync. Losing the last few seconds of progress to an unclean shutdown
//     costs the user nothing, so this is written as the cache it is.
//
// The keep/discard policy lives in shared/resume.ts, not here, so the viewer and
// the store cannot drift apart about what "finished" means.
import * as fs from 'node:fs'
import * as fsp from 'node:fs/promises'
import * as path from 'node:path'
import { ipcMain } from 'electron'
import { CH } from '../../shared/ipc'
import { STATE_DIR } from './settings'
import { resumeDecision } from '../../shared/resume'

const FILE = (): string => path.join(STATE_DIR, 'resume.json')
/** positions are disposable, so this cap can be tight; the oldest go first */
const MAX_ENTRIES = 4_000
const SAVE_DEBOUNCE_MS = 1_500

interface Rec { t: number; d: number; at: number }

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
      const t = Number(rec?.t)
      if (Number.isFinite(t) && t > 0) index.set(p, { t, d: Number(rec?.d) || 0, at: Number(rec?.at) || 0 })
    }
  } catch { /* absent or damaged: an empty index is a correct empty index */ }
}

async function writeAtomic(txt: string): Promise<void> {
  await fsp.mkdir(STATE_DIR, { recursive: true })
  const tmp = `${FILE()}.liqtmp-${process.pid}-${tmpCounter++}`
  try {
    await fsp.writeFile(tmp, txt, { encoding: 'utf8', mode: 0o600 })
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
      const keep = [...index.entries()].sort((a, b) => b[1].at - a[1].at).slice(0, MAX_ENTRIES)
      index = new Map(keep)
    }
    const entries: Record<string, Rec> = {}
    for (const [p, rec] of index) entries[p] = rec
    void writeAtomic(JSON.stringify({ version: 1, entries })).catch(() => {})
  }, SAVE_DEBOUNCE_MS)
  saveTimer.unref?.()
}

/** seconds to resume at, or 0. The viewer re-checks against the real duration. */
export function resumeOf(p: string): number {
  load()
  return index.get(p)?.t ?? 0
}

export function getResume(paths: string[]): Record<string, number> {
  load()
  const out: Record<string, number> = {}
  for (const p of paths) {
    const rec = index.get(p)
    if (rec) out[p] = rec.t
  }
  return out
}

/**
 * Record (or deliberately forget) a position. Passing a time that the policy
 * rejects — too early, too near the end, too short a file — DELETES the entry,
 * which is how "watched to the end" clears itself without a separate call.
 */
export function setResume(p: string, time: number, duration: number): number {
  load()
  if (!p.startsWith('/')) return 0
  const d = resumeDecision(time, duration)
  if (!d.store) {
    if (index.delete(p)) scheduleSave()
    return 0
  }
  const prev = index.get(p)
  // playback fires this every few seconds; skip the write when nothing moved
  if (prev && prev.t === d.seconds) return d.seconds
  index.set(p, { t: d.seconds, d: Math.floor(Number(duration)) || 0, at: Date.now() })
  scheduleSave()
  return d.seconds
}

export function clearResume(paths?: string[]): void {
  load()
  if (!paths) index.clear()
  else for (const p of paths) index.delete(p)
  scheduleSave()
}

export function resumeCount(): number { load(); return index.size }

/** Follow files this app moved or renamed, the way ratings.ts does. */
export function reindexResume(pairs: { from: string; to: string }[]): void {
  load()
  let touched = false
  for (const { from, to } of pairs) {
    const rec = index.get(from)
    if (rec) { index.delete(from); index.set(to, rec); touched = true }
    // a moved DIRECTORY carries children whose keys are their old full paths
    const prefix = from.endsWith('/') ? from : from + '/'
    for (const key of [...index.keys()]) {
      if (!key.startsWith(prefix)) continue
      const moved = index.get(key)!
      index.delete(key)
      index.set(to + key.slice(from.length), moved)
      touched = true
    }
  }
  if (touched) scheduleSave()
}

ipcMain.handle(CH('getResume'), (_e, paths: string[]) => getResume(paths))
ipcMain.handle(CH('setResume'), (_e, p: string, time: number, duration: number) => setResume(p, time, duration))
ipcMain.handle(CH('clearResume'), (_e, paths?: string[]) => { clearResume(paths); return true })
ipcMain.handle(CH('resumeCount'), () => resumeCount())
