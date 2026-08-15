// Bounded directory read for the peek popover, self-registered as IPC
// (renderer: liq.invoke('peekDir', req) / liq.invoke('peekCancel', token)),
// following the platform/preview.ts + ops/quick.ts pattern so main/ipc.ts stays
// untouched.
//
// Why not reuse fs/list.ts: a peek must paint while the pointer is still on the
// item, and startListing stats EVERY entry before its first chunk lands (CHUNK
// is 2000). Here the walk only reads dirents — no stat — counts them, sorts by
// name with folders first, and then stats just the handful the grid can show.
// Measured on this machine, ~/.cache/liq-peek-bench with 20 000 files:
// full listing ≈ 1.2 s, this ≈ 45 ms.
//
// Every call is bounded three ways, because the project's own share is a
// hard-mounted CIFS: PEEK.scanCap dirents, PEEK.deadlineMs wall clock (partial
// results are returned, never a hang), and a cancellation token the renderer
// flips the moment the pointer moves on — an abandoned walk stops at its next
// dirent instead of statting 200 files nobody is looking at any more.
import { ipcMain, type IpcMainInvokeEvent } from 'electron'
import * as fsp from 'node:fs/promises'
import { CH } from '../../shared/ipc'
import { PEEK, type PeekDirRequest, type PeekDirResult } from '../../shared/peek'
import type { FileEntry } from '../../shared/types'
import { entryFor, isRemotePath } from './list'

/** stats in flight for one peek; more just queues behind libuv's threadpool */
const STAT_POOL = 24

const natural = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })

/** tokens the renderer has abandoned; entries are dropped when their call ends */
const cancelled = new Set<number>()

function empty(path: string, over: Partial<PeekDirResult> = {}): PeekDirResult {
  return { path, entries: [], total: 0, partialCount: false, timedOut: false, ...over }
}

/** Explorer-style wording rather than a raw errno string. */
function errText(e: unknown): string {
  switch ((e as NodeJS.ErrnoException)?.code) {
    case 'ENOENT': return 'This folder is no longer in this location.'
    case 'EACCES':
    case 'EPERM': return "You don't currently have permission to access this folder."
    case 'ENOTDIR': return 'Not a folder.'
    case 'EIO': return 'The location could not be read.'
  }
  return String((e as Error)?.message ?? e)
}

/** Resolve with `fallback()` after `ms` whatever the filesystem does. The walk
 *  itself is not cancellable (no fs syscall is) — it is abandoned. */
function withDeadline<T>(work: Promise<T>, ms: number, fallback: () => T): Promise<T> {
  return new Promise(resolve => {
    let settled = false
    const timer = setTimeout(() => { if (!settled) { settled = true; resolve(fallback()) } }, ms)
    const finish = (v: T): void => { if (!settled) { settled = true; clearTimeout(timer); resolve(v) } }
    work.then(finish, () => finish(fallback()))
  })
}

interface Name { name: string; dir: boolean }

async function scan(
  dir: string, showHidden: boolean, token: number,
): Promise<{ names: Name[]; capped: boolean }> {
  const names: Name[] = []
  let capped = false
  const handle = await fsp.opendir(dir)
  try {
    for await (const d of handle) {
      if (cancelled.has(token)) { capped = true; break }
      // NOTE: the per-directory `.hidden` file (freedesktop) is deliberately not
      // consulted — reading it is a second round trip on a network mount, and a
      // peek is a glance, not the listing you act on.
      if (!showHidden && d.name.startsWith('.')) continue
      // a symlink's dirent type says "link", not what it points at; resolving
      // every one would cost a stat per entry, so links sort with the files and
      // get their real isDir from entryFor if they make the cut
      names.push({ name: d.name, dir: d.isDirectory() })
      if (names.length >= PEEK.scanCap) { capped = true; break }
    }
  } finally {
    // the async iterator closes the handle when it runs out; closing again
    // throws ERR_DIR_CLOSED, which is exactly the case we do not care about
    await handle.close().catch(() => {})
  }
  return { names, capped }
}

async function peekDirInner(req: PeekDirRequest): Promise<PeekDirResult> {
  const dir = req.path
  const token = req.token ?? 0
  const limit = Math.min(500, Math.max(1, req.limit ?? PEEK.gridLimit))

  let names: Name[]
  let capped: boolean
  try {
    ({ names, capped } = await scan(dir, req.showHidden, token))
  } catch (e) {
    return empty(dir, { error: errText(e) })
  }
  if (cancelled.has(token)) return empty(dir, { partialCount: true })

  names.sort((a, b) =>
    (a.dir === b.dir ? 0 : a.dir ? -1 : 1) || natural.compare(a.name, b.name))

  const pick = names.slice(0, limit)
  const out: (FileEntry | null)[] = new Array(pick.length).fill(null)
  const remote = isRemotePath(dir)
  let next = 0
  const worker = async (): Promise<void> => {
    while (next < pick.length) {
      if (cancelled.has(token)) return
      const i = next++
      out[i] = await entryFor(dir, pick[i].name, null, { remote }).catch(() => null)
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(STAT_POOL, pick.length) }, () => worker()))

  return {
    path: dir,
    entries: out.filter((e): e is FileEntry => !!e),
    total: names.length,
    partialCount: capped,
    timedOut: false,
  }
}

export function peekDir(req: PeekDirRequest): Promise<PeekDirResult> {
  if (!req?.path?.startsWith('/')) return Promise.resolve(empty(req?.path ?? '', { error: 'Invalid path.' }))
  const token = req.token ?? 0
  const done = (): void => { if (token) cancelled.delete(token) }
  return withDeadline(peekDirInner(req), PEEK.deadlineMs, () => empty(req.path, { timedOut: true }))
    .then(r => { done(); return r }, () => { done(); return empty(req.path, { timedOut: true }) })
}

/** Abandon an in-flight peekDir. Safe to call for a token that already finished. */
export function peekCancel(token: number): void {
  if (!token) return
  cancelled.add(token)
  // a token whose call already returned would otherwise leak; the set is only
  // ever read by walks that are still running, so a delayed sweep is enough
  if (cancelled.size > 256) {
    setTimeout(() => cancelled.clear(), 5000)
  }
}

// ---------------------------------------------------------------- IPC

type Handler = (event: IpcMainInvokeEvent, ...args: any[]) => unknown

function handle(method: string, fn: Handler): void {
  try {
    ipcMain.handle(CH(method), fn)
  } catch (e) {
    // a duplicate registration must not take the main process down
    console.warn(`[peek] could not register ${CH(method)}:`, (e as Error)?.message)
  }
}

let registered = false

/** Idempotent; called on module load (protocols.ts side-effect imports this). */
export function registerPeekIpc(): void {
  if (registered) return
  registered = true
  handle('peekDir', (_e, req: PeekDirRequest) => peekDir(req))
  handle('peekCancel', (_e, token: number) => peekCancel(token))
}

registerPeekIpc()
