// Walking a directory tree without hanging on a dead mount.
//
// Extracted from platform/duplicates.ts, which learned all of this the hard
// way and states it at length in its own header. The short version, because
// every new tool that walks a tree needs the same three rules:
//
//   1. EVERY io call is raced against a timer. The share here is mounted
//      `hard`, where a dead server never errors — it simply never answers, and
//      an unraced readdir is an indefinite hang with no error to report.
//      Abandoning the promise does not free the libuv request, but it does stop
//      the walk queueing more of them, so it can still notice cancellation.
//   2. SYMLINKS are not followed. That is also the cycle guard: without it a
//      link pointing at an ancestor is an infinite walk.
//   3. HARD LINKS are counted once, by dev+ino. Two names for one inode are one
//      file's worth of disk, and a size report that says otherwise is wrong in
//      the direction that matters.
//
// Cancellation is checked between directories and between stat batches, so a
// scan of a network tree can always be stopped.
import * as fsp from 'node:fs/promises'
import { beginTask } from '../state/health'
import * as path from 'node:path'
import type { Dirent, Stats } from 'node:fs'

/** how long any single io call may take before the walk gives up on it */
export const IO_TIMEOUT_MS = 8000
/** lstats issued at once; a wider batch queues more work behind a slow server */
const STAT_BATCH = 48
/** consecutive timeouts in one directory before it is abandoned entirely */
const MAX_DIR_TIMEOUTS = 3

interface Timed<T> { timedOut: boolean; value: T | null }

export function withTimeout<T>(p: Promise<T>, ms = IO_TIMEOUT_MS): Promise<Timed<T>> {
  return new Promise(resolve => {
    let settled = false
    const timer = setTimeout(() => {
      if (!settled) { settled = true; resolve({ timedOut: true, value: null }) }
    }, ms)
    void p.then(
      value => { if (!settled) { settled = true; clearTimeout(timer); resolve({ timedOut: false, value }) } },
      () => { if (!settled) { settled = true; clearTimeout(timer); resolve({ timedOut: false, value: null }) } },
    )
  })
}

export interface WalkFile {
  path: string
  name: string
  /** the directory holding it */
  dir: string
  stat: Stats
}

export interface WalkOptions {
  /** stop as soon as this returns true; checked between directories and batches */
  cancelled?: () => boolean
  /** called for every readable file (never for directories or symlinks) */
  onFile(f: WalkFile): void | Promise<void>
  /** called when a directory has been read, with its entry count */
  onDir?(dir: string, entries: number): void
  /** unreadable directory, or one that timed out */
  onProblem?(dir: string, why: string): void
  /** do not descend into this directory */
  skipDir?(dir: string, name: string): boolean
  /** hard cap on directories visited, so a runaway tree cannot run for ever */
  maxDirs?: number
}

/**
 * Breadth-first walk of `roots`.
 *
 * Breadth-first rather than recursive depth-first on purpose: it keeps the
 * queue explicit (so cancellation is a check, not an unwind), it cannot blow
 * the stack on a deep tree, and it reaches shallow results early, which is
 * what a progress display wants to show first.
 */
export async function walkTree(roots: string[], opts: WalkOptions): Promise<void> {
  // One announcement here covers every scanner that walks a tree — disk usage,
  // duplicates, near-duplicates, folder compare, media health. Registering them
  // individually would mean registering the ones somebody remembered.
  const endTask = beginTask(`walk ${roots[0] ?? '?'}`)
  try {
    return await walkTreeInner(roots, opts)
  } finally {
    endTask()
  }
}

async function walkTreeInner(roots: string[], opts: WalkOptions): Promise<void> {
  const queue = roots.filter(r => r.startsWith('/'))
  const seenDirs = new Set<string>()
  /** dev:ino of files already counted, so a hard link is not counted twice */
  const seenInodes = new Set<string>()
  let dirs = 0

  while (queue.length) {
    if (opts.cancelled?.()) return
    const dir = queue.shift()!
    if (seenDirs.has(dir)) continue
    seenDirs.add(dir)
    if (opts.maxDirs && ++dirs > opts.maxDirs) return

    const read = await withTimeout(fsp.readdir(dir, { withFileTypes: true }))
    if (read.timedOut) { opts.onProblem?.(dir, 'timed out'); continue }
    const ents = read.value as Dirent[] | null
    if (!ents) { opts.onProblem?.(dir, 'could not be read'); continue }
    opts.onDir?.(dir, ents.length)

    const names: string[] = []
    for (const e of ents) {
      // never follow a link: it is the cycle guard as well as the size rule
      if (e.isSymbolicLink()) continue
      if (e.isDirectory()) {
        if (!opts.skipDir?.(dir, e.name)) queue.push(path.join(dir, e.name))
        continue
      }
      if (e.isFile()) names.push(e.name)
    }

    let timeouts = 0
    for (let i = 0; i < names.length; i += STAT_BATCH) {
      if (opts.cancelled?.()) return
      const slice = names.slice(i, i + STAT_BATCH)
      const batch = await withTimeout(Promise.all(
        slice.map(n => fsp.lstat(path.join(dir, n)).catch(() => null)),
      ))
      if (batch.timedOut) {
        // never queue the next batch behind a server that is not answering
        if (++timeouts >= MAX_DIR_TIMEOUTS) { opts.onProblem?.(dir, 'timed out'); break }
        continue
      }
      const stats = batch.value ?? []
      for (let k = 0; k < slice.length; k++) {
        const st = stats[k]
        if (!st || !st.isFile()) continue
        if (st.nlink > 1) {
          const key = `${st.dev}:${st.ino}`
          if (seenInodes.has(key)) continue
          seenInodes.add(key)
        }
        await opts.onFile({ path: path.join(dir, slice[k]), name: slice[k], dir, stat: st })
      }
    }
  }
}
