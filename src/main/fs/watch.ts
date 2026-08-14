// Directory watching. Local dirs use fs.watch (inotify) with 150ms debounce;
// network mounts (CIFS/NFS/sshfs/gvfs — no remote inotify) fall back to a 2s
// mtime+size poll with a 5s stat timeout and 10s backoff; statInFlight stays
// set until the real stat settles, so a hung SMB call pins at most one
// threadpool thread per watch. Watch count is capped; oldest watches are
// recycled (dead-window watches first, live victims get an 'overflow' event).
import type { WebContents } from 'electron'
import * as fs from 'node:fs'
import * as fsp from 'node:fs/promises'
import { PUSH } from '../../shared/ipc'
import type { FsEvent, FsEventKind } from '../../shared/types'
import { isRemotePath } from './list'

const MAX_WATCHES = 30
const DEBOUNCE_MS = 150
const POLL_MS = 2000
const BACKOFF_MS = 10_000
const STAT_TIMEOUT_MS = 5000

interface WatchRec {
  id: number
  dir: string
  wc: WebContents
  closed: boolean
  // local
  watcher?: fs.FSWatcher
  debounce?: NodeJS.Timeout
  sawRename: boolean
  // remote
  pollTimer?: NodeJS.Timeout
  statInFlight: boolean
  backedOff: boolean
  lastMtime: number   // -1 = no baseline yet
  lastSize: number
}

let nextWatch = 1
/** insertion-ordered, so the first key is always the oldest watch */
const watches = new Map<number, WatchRec>()
/** WebContents whose 'destroyed' cleanup hook is already registered */
const hookedWCs = new WeakSet<WebContents>()

export function watchDir(wc: WebContents, dir: string): number {
  const id = nextWatch++
  if (!hookedWCs.has(wc)) {
    hookedWCs.add(wc)
    wc.once('destroyed', () => {
      for (const r of [...watches.values()]) if (r.wc === wc) closeWatch(r.id)
    })
  }
  if (watches.size >= MAX_WATCHES) {
    // recycle a dead-window watch if one exists; otherwise the oldest,
    // telling its renderer via 'overflow' so it can re-watch or poll
    let victim: WatchRec | undefined
    for (const r of watches.values()) {
      if (r.wc.isDestroyed()) { victim = r; break }
    }
    if (!victim) victim = watches.values().next().value
    if (victim) {
      if (!victim.wc.isDestroyed()) emit(victim, 'overflow')
      closeWatch(victim.id)
    }
  }
  const rec: WatchRec = {
    id, dir, wc, closed: false,
    sawRename: false, statInFlight: false, backedOff: false,
    lastMtime: -1, lastSize: -1,
  }
  watches.set(id, rec)
  if (isRemotePath(dir)) startPolling(rec)
  else startInotify(rec)
  return id
}

export function unwatchDir(id: number): void {
  closeWatch(id)
}

function closeWatch(id: number): void {
  const rec = watches.get(id)
  if (!rec) return
  rec.closed = true
  try { rec.watcher?.close() } catch { /* already gone */ }
  if (rec.debounce) clearTimeout(rec.debounce)
  if (rec.pollTimer) clearTimeout(rec.pollTimer)
  watches.delete(id)
}

function emit(rec: WatchRec, kind: FsEventKind, name?: string): void {
  if (rec.wc.isDestroyed()) { closeWatch(rec.id); return }
  const ev: FsEvent = { watchId: rec.id, path: rec.dir, kind, name }
  rec.wc.send(PUSH.fsEvent, ev)
}

// ---------------------------------------------------------------- local: inotify

function startInotify(rec: WatchRec): void {
  let w: fs.FSWatcher
  try {
    w = fs.watch(rec.dir, (eventType) => {
      if (rec.closed) return
      if (eventType === 'rename') rec.sawRename = true
      if (!rec.debounce) rec.debounce = setTimeout(() => flushLocal(rec), DEBOUNCE_MS)
    })
  } catch {
    // dir vanished between listing and watch — the listing itself reports errors
    return
  }
  w.on('error', () => {
    if (rec.closed) return
    // inotify errors here mean the watched dir itself went away
    emit(rec, 'deleted')
    closeWatch(rec.id)
  })
  rec.watcher = w
}

/** coalesce a burst of raw events into one FsEvent */
function flushLocal(rec: WatchRec): void {
  rec.debounce = undefined
  if (rec.closed) return
  const renamed = rec.sawRename
  rec.sawRename = false
  if (renamed && !fs.existsSync(rec.dir)) {
    emit(rec, 'deleted')
    closeWatch(rec.id)
    return
  }
  emit(rec, renamed ? 'renamed' : 'changed')
}

// ---------------------------------------------------------------- remote: mtime poll

function startPolling(rec: WatchRec): void {
  const schedule = (ms: number) => {
    if (rec.closed) return
    rec.pollTimer = setTimeout(tick, ms)
  }
  const tick = () => {
    if (rec.closed) return
    if (rec.wc.isDestroyed()) { closeWatch(rec.id); return }
    // still waiting on a hung stat: never stack another threadpool thread
    if (rec.statInFlight) { schedule(rec.backedOff ? BACKOFF_MS : POLL_MS); return }
    rec.statInFlight = true
    void statWithTimeout(rec).then((st) => {
      if (rec.closed) return
      if (st === 'timeout') {
        // hung mount: emit nothing, back off until a stat succeeds
        rec.backedOff = true
        schedule(BACKOFF_MS)
        return
      }
      if (st === null) {
        // watched dir itself is gone
        emit(rec, 'deleted')
        closeWatch(rec.id)
        return
      }
      rec.backedOff = false
      if (rec.lastMtime === -1) {
        rec.lastMtime = st.mtimeMs
        rec.lastSize = st.size
      } else if (st.mtimeMs !== rec.lastMtime || st.size !== rec.lastSize) {
        rec.lastMtime = st.mtimeMs
        rec.lastSize = st.size
        emit(rec, 'changed')
      }
      schedule(POLL_MS)
    })
  }
  schedule(POLL_MS)
}

/**
 * Stat that can never hang the poll loop: races a 5s timer, never rejects.
 * rec.statInFlight clears only when the underlying stat actually settles —
 * on timeout the abandoned call still occupies a libuv threadpool thread,
 * and the tick guard must keep skipping until it returns.
 */
function statWithTimeout(rec: WatchRec): Promise<fs.Stats | 'timeout' | null> {
  return new Promise((resolve) => {
    let settled = false
    const timer = setTimeout(() => {
      if (!settled) { settled = true; resolve('timeout') }
    }, STAT_TIMEOUT_MS)
    fsp.stat(rec.dir)
      .then(
        (st) => { if (!settled) { settled = true; clearTimeout(timer); resolve(st) } },
        () => { if (!settled) { settled = true; clearTimeout(timer); resolve(null) } },
      )
      .finally(() => { rec.statInFlight = false })
  })
}
