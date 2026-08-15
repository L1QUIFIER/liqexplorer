// File-operations engine — the single service every UI surface goes through
// (Explorer's IFileOperation analogue). ONE sequential queue: one op running,
// the rest queued FIFO (queued ops are visible in getOps()).
//
// Lifecycle per op: enumerate (walk sources, count items+bytes, cancellable)
// -> preflight (statfs free-space check for copy / cross-device move)
// -> execute. Progress broadcasts on PUSH.opProgress every ~200ms and on every
// status change; speed is an EMA over 500ms ticks with the last 30 ticks kept
// for the throughput graph. Pause gates between chunks/files (children get
// SIGSTOP/SIGCONT). Cancel removes the in-flight partial file and keeps
// completed files. Per-file errors (EACCES etc. — elevation is out of v1
// scope) are collected into failures[] and the op continues.
//
// Conflicts follow research-file-ops.md §2: file-over-file raises
// PUSH.opConflict and awaits resolveConflict (replace/skip/keepBoth/cancel);
// folders always merge but ask once (choice 'merge'); applyToAll is cached
// separately for file vs dir conflicts. Copy into the source folder
// auto-renames with ' - Copy' / ' - Copy (2)' and never prompts.
import type { WebContents } from 'electron'
import { spawn, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { finished } from 'node:stream/promises'
import * as fs from 'node:fs'
import * as fsp from 'node:fs/promises'
import * as path from 'node:path'
import { PUSH } from '../../shared/ipc'
import type {
  ConflictChoice, ConflictInfo, ConflictResolution, OpKind, OpProgress, OpRequest, OpStatus,
} from '../../shared/types'
import { broadcast } from '../windows'
import * as trash from '../platform/trash'
import * as undo from './undo'
import * as history from '../state/history'
import * as ratings from '../state/ratings'
import { reindexResume } from '../state/resume'
import { bindEngine, cancelPasswordPrompt, runCompress, runExtract, type ArchiveCtx } from './archive'

const HW = 1024 * 1024                 // 1MB stream chunks: pause/cancel stay responsive
const PROGRESS_MS = 200
const SPEED_MS = 500
const SPEED_HISTORY = 30

export interface MovePair { from: string; to: string }
export interface OpResult { status: OpStatus; failureCount: number }

class CancelledError extends Error {
  constructor() { super('The operation was cancelled') }
}

interface TopSrc {
  path: string
  isDir: boolean
  dev: number
  /** recursive item / byte counts for this source subtree */
  items: number
  bytes: number
  missing: boolean
}

interface Op {
  id: number
  kind: OpKind
  req: OpRequest
  /** explicit per-source destinations (undo/redo path); overrides req.dest joining */
  pairs?: MovePair[]
  /** originating window; conflicts go only here (null = internal replay, broadcast) */
  sender: WebContents | null
  record: boolean
  /** undo/redo replay tag, for the activity log */
  via?: 'undo' | 'redo'
  status: OpStatus
  bytesDone: number
  bytesTotal: number
  itemsDone: number
  itemsTotal: number
  currentFile: string
  error?: string
  failures: { path: string; error: string }[]
  paused: boolean
  cancelled: boolean
  resumeWaiters: (() => void)[]
  statusBeforePause: OpStatus
  child: ChildProcess | null
  inFlight: string | null
  pendingConflict: { conflictId: number; resolve: (r: ConflictResolution) => void } | null
  applyAllFile: ConflictChoice | null
  applyAllDir: ConflictChoice | null
  // outcome, for undo recording
  created: string[]
  copyPairs: MovePair[]
  movedPairs: MovePair[]
  trashedPaths: string[]
  // speed
  emaSpeed: number
  speedHistory: number[]
  lastTickUnits: number
  lastTickTime: number
  done: Promise<OpResult>
  doneResolve: (r: OpResult) => void
}

const TERMINAL = new Set<OpStatus>(['done', 'error', 'cancelled'])
const RECORDABLE = new Set<OpKind>(['copy', 'move', 'rename', 'trash', 'mkdir', 'mkfile', 'symlink'])
/** history covers more than undo does — a permanent delete is the single
 *  most important thing to be able to look back at */
const HISTORIC = new Set<OpKind>([...RECORDABLE, 'delete', 'emptyTrash', 'restoreTrash', 'compress', 'extract'])

const opsById = new Map<number, Op>()
const pending: Op[] = []
let running: Op | null = null
let nextOpId = 1
let nextConflictId = 1

// ---------------- public API (wired in ipc.ts) ----------------

export async function startOp(wc: WebContents, req: OpRequest): Promise<number> {
  const op = enqueue(req, { record: RECORDABLE.has(req.kind), sender: wc })
  return op.id
}

// archive.ts starts extract ops from its own IPC verbs; injected rather than
// imported to keep the two modules acyclic
bindEngine(startOp)

/**
 * Run an op outside the UNDO recording path (undo/redo replay). `via` tags it
 * for the activity log: a replay is not a new user action, but it does move
 * real files, so the log shows what it did and says which it was.
 */
export function runInternal(
  req: OpRequest, pairs?: MovePair[], via?: 'undo' | 'redo',
): Promise<OpResult> {
  return enqueue(req, { record: false, pairs, via }).done
}

export function pauseOp(id: number): void {
  const op = opsById.get(id)
  if (!op || op.paused || TERMINAL.has(op.status)) return
  op.paused = true
  op.child?.kill('SIGSTOP')
  if (op.status === 'running' || op.status === 'enumerating') {
    op.statusBeforePause = op.status
    setStatus(op, 'paused')
  }
}

export function resumeOp(id: number): void {
  const op = opsById.get(id)
  if (!op || !op.paused) return
  op.paused = false
  op.child?.kill('SIGCONT')
  if (op.status === 'paused') setStatus(op, op.statusBeforePause)
  drainWaiters(op)
}

export function cancelOp(id: number): void {
  const op = opsById.get(id)
  if (!op || TERMINAL.has(op.status)) return
  op.cancelled = true
  op.paused = false
  if (op.child) { op.child.kill('SIGCONT'); op.child.kill('SIGTERM') }
  drainWaiters(op)
  const pc = op.pendingConflict
  if (pc) pc.resolve({ opId: op.id, conflictId: pc.conflictId, choice: 'cancel', applyToAll: false })
  cancelPasswordPrompt(op.id)   // an archive waiting on a password must not block the queue
  if (op.status === 'queued') {
    // never started — finalize immediately
    const i = pending.indexOf(op)
    if (i >= 0) pending.splice(i, 1)
    finishOp(op, 'cancelled')
  }
}

export function resolveConflict(res: ConflictResolution): void {
  const op = opsById.get(res.opId)
  const pc = op?.pendingConflict
  if (op && pc && pc.conflictId === res.conflictId) pc.resolve(res)
}

export function getOps(): OpProgress[] {
  return [...opsById.values()].sort((a, b) => a.id - b.id).map(toProgress)
}

// ---------------- queue ----------------

function enqueue(
  req: OpRequest,
  opts: { record: boolean; pairs?: MovePair[]; sender?: WebContents; via?: 'undo' | 'redo' },
): Op {
  let doneResolve!: (r: OpResult) => void
  const done = new Promise<OpResult>(res => { doneResolve = res })
  const op: Op = {
    id: nextOpId++,
    kind: req.kind,
    req,
    pairs: opts.pairs,
    sender: opts.sender ?? null,
    record: opts.record,
    via: opts.via,
    status: 'queued',
    bytesDone: 0, bytesTotal: 0, itemsDone: 0, itemsTotal: 0,
    currentFile: '',
    failures: [],
    paused: false,
    cancelled: false,
    resumeWaiters: [],
    statusBeforePause: 'running',
    child: null,
    inFlight: null,
    pendingConflict: null,
    applyAllFile: null,
    applyAllDir: null,
    created: [], copyPairs: [], movedPairs: [], trashedPaths: [],
    emaSpeed: 0, speedHistory: [], lastTickUnits: 0, lastTickTime: Date.now(),
    done, doneResolve,
  }
  opsById.set(op.id, op)
  pending.push(op)
  pushProgress(op)
  setImmediate(pump)
  return op
}

function pump(): void {
  if (running || pending.length === 0) return
  const op = pending.shift()!
  running = op
  void runOp(op).finally(() => { running = null; pump() })
}

async function runOp(op: Op): Promise<void> {
  if (op.cancelled || TERMINAL.has(op.status)) {
    if (!TERMINAL.has(op.status)) finishOp(op, 'cancelled')
    return
  }
  op.lastTickTime = Date.now()
  const tick = setInterval(() => { if (!TERMINAL.has(op.status)) pushProgress(op) }, PROGRESS_MS)
  const speedTick = setInterval(() => sampleSpeed(op), SPEED_MS)
  let final: OpStatus = 'done'
  try {
    await execute(op)
    final = op.cancelled ? 'cancelled' : 'done'
  } catch (e) {
    if (e instanceof CancelledError || op.cancelled) {
      final = 'cancelled'
    } else {
      final = 'error'
      op.error = errMsg(e)
    }
  } finally {
    clearInterval(tick)
    clearInterval(speedTick)
    finishOp(op, final)
  }
}

function finishOp(op: Op, status: OpStatus): void {
  op.status = status
  if (status === 'done' && op.failures.length === 0) {
    // clean completion: snap to totals (per-node accounting under merges can run short)
    op.bytesDone = op.bytesTotal
    op.itemsDone = op.itemsTotal
  }
  op.currentFile = ''
  pushProgress(op)
  // Ratings follow the file. The xattr copy already survives a same-device
  // rename on its own, but a move ACROSS devices is a copy-and-delete that
  // drops it, and undo/redo replays move files too — so the index is re-keyed
  // here, where every kind of move lands, rather than in recordOutcome (which
  // internal replays skip).
  if (op.movedPairs.length) ratings.migrate(op.movedPairs)
  if (op.movedPairs.length) reindexResume(op.movedPairs)
  if (op.record && status === 'done') recordOutcome(op)
  // Activity history: written for EVERY user-started operation, including the
  // ones undo deliberately does not record (permanent delete, empty trash),
  // because those are exactly the ones someone needs to look back at. Internal
  // undo/redo replays (record === false) are skipped so the log reads as what
  // the user did, not what the machine did to satisfy them.
  // op.sender marks a user-started operation; op.via marks an undo/redo replay.
  // Both really happened to the user's files, so both are logged — anything
  // else (an internal replay with neither) stays out of it.
  if ((op.sender || op.via) && HISTORIC.has(op.kind)) {
    history.record({
      kind: op.kind,
      count: op.itemsTotal || op.req.sources.length,
      sources: op.req.sources.slice(0, 4),
      // an undo replay carries explicit per-source pairs instead of a single
      // dest, so read where the files actually landed from the first pair
      dest: op.req.dest ?? (op.pairs?.[0] ? path.dirname(op.pairs[0].to) : undefined),
      status: status === 'done' ? 'done' : status === 'cancelled' ? 'cancelled' : 'error',
      failures: op.failures.length || undefined,
      via: op.via,
    })
  }
  op.doneResolve({ status, failureCount: op.failures.length })
  const reap = setTimeout(() => { opsById.delete(op.id) }, status === 'error' ? 60_000 : 5_000)
  reap.unref?.()
}

function recordOutcome(op: Op): void {
  switch (op.kind) {
    case 'copy':
      if (op.created.length) undo.record({ kind: 'copy', created: [...op.created], pairs: [...op.copyPairs], count: op.created.length })
      break
    case 'move':
      if (op.movedPairs.length) undo.record({ kind: 'move', pairs: [...op.movedPairs], count: op.movedPairs.length })
      break
    case 'rename':
      if (op.movedPairs.length) undo.record({ kind: 'rename', pairs: [...op.movedPairs], count: 1 })
      break
    case 'trash':
      if (op.trashedPaths.length) undo.record({ kind: 'trash', trashed: [...op.trashedPaths], count: op.trashedPaths.length })
      break
    case 'mkdir':
      if (op.created.length) undo.record({ kind: 'mkdir', created: [...op.created], count: 1 })
      break
    case 'mkfile':
      if (op.created.length) undo.record({ kind: 'mkfile', created: [...op.created], count: 1 })
      break
    case 'symlink':
      if (op.created.length) {
        undo.record({
          kind: 'symlink', created: [...op.created],
          pairs: [...op.copyPairs], count: op.created.length,
        })
      }
      break
  }
}

// ---------------- progress / speed ----------------

function toProgress(op: Op): OpProgress {
  const byBytes = op.bytesTotal > 0
  const unitsTotal = byBytes ? op.bytesTotal : op.itemsTotal
  const unitsDone = byBytes ? op.bytesDone : op.itemsDone
  const remaining = Math.max(0, unitsTotal - unitsDone)
  const active = !TERMINAL.has(op.status)
  return {
    opId: op.id,
    kind: op.kind,
    status: op.status,
    bytesDone: op.bytesDone,
    bytesTotal: op.bytesTotal,
    itemsDone: op.itemsDone,
    itemsTotal: op.itemsTotal,
    speed: byBytes ? Math.round(op.emaSpeed) : 0,
    etaSec: active && op.emaSpeed > 0.01 ? Math.ceil(remaining / op.emaSpeed) : 0,
    currentFile: op.currentFile,
    speedHistory: [...op.speedHistory],
    error: op.error,
    failures: op.failures.length ? [...op.failures] : undefined,
    srcLabel: srcLabelOf(op),
    destLabel: op.req.dest ? (path.basename(op.req.dest) || op.req.dest) : undefined,
    dest: op.req.dest,
  }
}

function srcLabelOf(op: Op): string | undefined {
  const s = op.pairs?.[0]?.from ?? op.req.sources[0]
  if (!s || s.includes('://')) return undefined
  const d = path.dirname(s)
  return path.basename(d) || d
}

function pushProgress(op: Op): void {
  broadcast(PUSH.opProgress, toProgress(op))
}

function setStatus(op: Op, s: OpStatus): void {
  if (op.status === s) return
  op.status = s
  pushProgress(op)
}

function sampleSpeed(op: Op): void {
  const now = Date.now()
  const dt = (now - op.lastTickTime) / 1000
  if (dt <= 0) return
  const units = op.bytesTotal > 0 ? op.bytesDone : op.itemsDone
  const inst = Math.max(0, (units - op.lastTickUnits) / dt)
  op.lastTickUnits = units
  op.lastTickTime = now
  const stalled = op.status === 'paused' || op.status === 'conflict'
    || op.status === 'password' || op.status === 'queued'
  const sample = stalled ? 0 : inst
  op.emaSpeed = op.emaSpeed <= 0 ? sample : op.emaSpeed * 0.7 + sample * 0.3
  op.speedHistory.push(Math.round(sample))
  if (op.speedHistory.length > SPEED_HISTORY) op.speedHistory.shift()
}

// ---------------- pause / cancel plumbing ----------------

function drainWaiters(op: Op): void {
  const ws = op.resumeWaiters.splice(0)
  for (const w of ws) w()
}

function pauseGate(op: Op): Promise<void> | void {
  if (op.cancelled || !op.paused) return
  return new Promise<void>(res => op.resumeWaiters.push(res))
}

function checkCancel(op: Op): void {
  if (op.cancelled) throw new CancelledError()
}

// ---------------- helpers ----------------

function fail(op: Op, p: string, e: unknown): void {
  op.failures.push({ path: p, error: typeof e === 'string' ? e : errMsg(e) })
}

function errMsg(e: unknown): string {
  const err = e as NodeJS.ErrnoException
  switch (err?.code) {
    case 'EACCES':
    case 'EPERM': return 'You do not have permission to perform this action.'
    case 'ENOENT': return 'The item is no longer in this location.'
    case 'ENOSPC': return 'There is not enough space on the destination drive.'
    case 'ENAMETOOLONG': return 'The file name is too long for the destination folder.'
    case 'EROFS': return 'The destination is read-only.'
    case 'EBUSY': return 'The file is in use by another program.'
    case 'ENOTEMPTY': return 'The folder is not empty.'
    case 'EEXIST': return 'An item with the same name already exists.'
  }
  return String(err?.message ?? e)
}

function fmtSize(n: number): string {
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(1)} GB`
  if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(1)} MB`
  if (n >= 1024) return `${(n / 1024).toFixed(0)} KB`
  return `${n} bytes`
}

async function lstatOrNull(p: string): Promise<fs.Stats | null> {
  return fsp.lstat(p).then(s => s, () => null)
}

function isInside(child: string, parent: string): boolean {
  const pre = parent.endsWith('/') ? parent : parent + '/'
  return child === parent || child.startsWith(pre)
}

/** last-dot split; dirs and dotfiles keep the whole name as stem */
function splitName(base: string, isDir: boolean): { stem: string; ext: string } {
  if (isDir) return { stem: base, ext: '' }
  const i = base.lastIndexOf('.')
  if (i <= 0) return { stem: base, ext: '' }
  return { stem: base.slice(0, i), ext: base.slice(i) }
}

/** ' - Copy' / ' - Copy (2)' for paste into the source folder (research §2.5) */
async function uniqueCopyName(dir: string, base: string, isDir: boolean): Promise<string> {
  const { stem, ext } = splitName(base, isDir)
  let cand = `${stem} - Copy${ext}`
  for (let i = 2; await lstatOrNull(path.join(dir, cand)); i++) cand = `${stem} - Copy (${i})${ext}`
  return cand
}

/** ' (2)' lowest-unused suffix before the extension — keepBoth rule */
async function uniqueSuffixName(dir: string, base: string, isDir: boolean): Promise<string> {
  const { stem, ext } = splitName(base, isDir)
  for (let i = 2; ; i++) {
    const cand = `${stem} (${i})${ext}`
    if (!await lstatOrNull(path.join(dir, cand))) return cand
  }
}

function spawnCapture(op: Op, cmd: string, args: string[]): Promise<{ code: number; err: string }> {
  return new Promise(resolve => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'ignore', 'pipe'] })
    op.child = child
    let err = ''
    child.stderr?.on('data', d => { if (err.length < 65536) err += String(d) })
    child.on('error', e => { op.child = null; resolve({ code: -1, err: String(e) }) })
    child.on('close', code => { op.child = null; resolve({ code: code ?? -1, err }) })
  })
}

// ---------------- enumeration ----------------

/**
 * Recursive walk counting items (every node) and bytes (regular files).
 * tally=true feeds op.itemsTotal/bytesTotal live for the "Discovering items…" phase.
 */
async function walkCount(op: Op, p: string, tally: boolean, st?: fs.Stats | null): Promise<{ items: number; bytes: number }> {
  checkCancel(op)
  await pauseGate(op)
  const s = st ?? await lstatOrNull(p)
  if (!s) return { items: 0, bytes: 0 }
  if (s.isDirectory() && !s.isSymbolicLink()) {
    let items = 1
    let bytes = 0
    if (tally) op.itemsTotal++
    let names: string[] = []
    try { names = await fsp.readdir(p) } catch { /* unreadable dir counts alone */ }
    for (const n of names) {
      const c = await walkCount(op, path.join(p, n), tally)
      items += c.items
      bytes += c.bytes
    }
    return { items, bytes }
  }
  const bytes = s.isFile() ? s.size : 0
  if (tally) { op.itemsTotal++; op.bytesTotal += bytes }
  return { items: 1, bytes }
}

async function enumerateTops(op: Op, destDev = -1): Promise<TopSrc[]> {
  const srcPaths = op.pairs ? op.pairs.map(p => p.from) : op.req.sources
  const tops: TopSrc[] = []
  for (const p of srcPaths) {
    checkCancel(op)
    op.currentFile = p
    const st = await lstatOrNull(p)
    if (!st) {
      tops.push({ path: p, isDir: false, dev: -1, items: 0, bytes: 0, missing: true })
      continue
    }
    if (op.kind === 'move' && !op.pairs && destDev !== -1 && st.dev === destDev) {
      // same-device move is a single rename — don't walk the subtree first
      op.itemsTotal += 1
      tops.push({ path: p, isDir: st.isDirectory() && !st.isSymbolicLink(), dev: st.dev, items: 1, bytes: 0, missing: false })
      continue
    }
    const c = await walkCount(op, p, true, st)
    tops.push({ path: p, isDir: st.isDirectory() && !st.isSymbolicLink(), dev: st.dev, items: c.items, bytes: c.bytes, missing: false })
  }
  return tops
}

/** progress-advance for a skipped subtree (counts without tallying totals) */
async function skipCount(op: Op, p: string, st?: fs.Stats | null): Promise<void> {
  const c = await walkCount(op, p, false, st)
  op.itemsDone += c.items
  op.bytesDone += c.bytes
}

// ---------------- conflicts ----------------

async function askConflict(
  op: Op, srcPath: string, srcSt: fs.Stats, dstPath: string, dstSt: fs.Stats, dirPair: boolean,
): Promise<ConflictChoice> {
  const cached = dirPair ? op.applyAllDir : op.applyAllFile
  if (cached) return cached
  const conflictId = nextConflictId++
  const info: ConflictInfo = {
    opId: op.id,
    conflictId,
    source: { path: srcPath, size: srcSt.size, mtime: srcSt.mtimeMs, isDir: srcSt.isDirectory() },
    dest: { path: dstPath, size: dstSt.size, mtime: dstSt.mtimeMs, isDir: dstSt.isDirectory() },
  }
  setStatus(op, 'conflict')
  const sendConflict = (): void => {
    if (op.sender && !op.sender.isDestroyed()) op.sender.send(PUSH.opConflict, info)
    else if (!op.sender) broadcast(PUSH.opConflict, info)
  }
  sendConflict()
  // re-send while unresolved (reloaded renderer recovers); dead window = cancel
  const resend = setInterval(() => {
    if (op.sender?.isDestroyed()) {
      op.pendingConflict?.resolve({ opId: op.id, conflictId, choice: 'cancel', applyToAll: false })
      return
    }
    sendConflict()
  }, 3000)
  const res = await new Promise<ConflictResolution>(resolve => {
    op.pendingConflict = { conflictId, resolve }
  })
  clearInterval(resend)
  op.pendingConflict = null
  if (!op.cancelled) setStatus(op, 'running')
  let choice = res.choice
  if (dirPair && choice === 'replace') choice = 'merge'     // folders are never replaced, only merged
  if (choice === 'cancel') {
    op.cancelled = true
    throw new CancelledError()
  }
  if (res.applyToAll) {
    if (dirPair) op.applyAllDir = choice
    else op.applyAllFile = choice
  }
  return choice
}

// ---------------- dispatch ----------------

async function execute(op: Op): Promise<void> {
  switch (op.kind) {
    case 'copy':
    case 'move': return execCopyMove(op)
    case 'delete': return execDelete(op)
    case 'trash': return execTrash(op)
    case 'restoreTrash': return execRestoreTrash(op)
    case 'emptyTrash': return execEmptyTrash(op)
    case 'rename': return execRename(op)
    case 'mkdir':
    case 'mkfile': return execMake(op)
    case 'symlink': return execSymlink(op)
    case 'compress':
    case 'extract': return execArchive(op)
    default: throw new Error(`Unknown operation: ${String(op.kind)}`)
  }
}

// ---------------- copy / move ----------------

async function execCopyMove(op: Op): Promise<void> {
  const destDir = op.req.dest
  if (!destDir && !op.pairs?.length) throw new Error('No destination folder was given.')
  if (destDir?.includes('://')) throw new Error('Items cannot be copied to this location.')

  // stat the destination before enumerating: same-device moves skip the walk
  let destDev = -1
  if (destDir) {
    const dstSt = await fsp.stat(destDir).catch(() => null)
    if (!dstSt || !dstSt.isDirectory()) throw new Error(`The destination folder ${destDir} does not exist.`)
    destDev = dstSt.dev
  }

  setStatus(op, 'enumerating')
  const tops = await enumerateTops(op, destDev)

  // preflight: free space (copy always, move only for cross-device bytes)
  if (destDir) {
    const needed = op.kind === 'copy'
      ? op.bytesTotal
      : tops.filter(t => !t.missing && t.dev !== destDev).reduce((n, t) => n + t.bytes, 0)
    if (needed > 0) {
      const sf = await fsp.statfs(destDir).catch(() => null)
      if (sf) {
        const free = Number(sf.bavail) * Number(sf.bsize)
        if (needed > free) {
          throw new Error(
            `There is not enough space on ${path.basename(destDir) || destDir}. ` +
            `You need an additional ${fmtSize(needed - free)} to ${op.kind} these files.`)
        }
      }
    }
  }

  setStatus(op, 'running')
  for (let i = 0; i < tops.length; i++) {
    checkCancel(op)
    await pauseGate(op)
    const src = tops[i]
    if (src.missing) {
      fail(op, src.path, `${path.basename(src.path)} is no longer located in ${path.dirname(src.path)}. Verify the item's location and try again.`)
      continue
    }
    let dst = op.pairs ? op.pairs[i].to : path.join(destDir!, path.basename(src.path))
    if (op.pairs) await fsp.mkdir(path.dirname(dst), { recursive: true }).catch(() => {})

    if (op.kind === 'copy') {
      if (!op.pairs && path.dirname(src.path) === destDir) {
        // copy into its own folder: silent ' - Copy' auto-rename, never a dialog
        dst = path.join(destDir, await uniqueCopyName(destDir, path.basename(src.path), src.isDir))
      }
      if (src.isDir && isInside(dst, src.path)) {
        fail(op, src.path, 'The destination folder is a subfolder of the source folder.')
        await skipCount(op, src.path)
        continue
      }
      const rec: MovePair[] = []
      await copyEntry(op, src.path, dst, rec)
      // rec holds only entries actually created (a merged-into dir records just
      // its created children) — undo must never delete a pre-existing folder
      for (const pr of rec) {
        op.created.push(pr.to)
        op.copyPairs.push(pr)
      }
    } else {
      if (dst === src.path) {   // move onto itself: no-op
        op.itemsDone += src.items
        op.bytesDone += src.bytes
        continue
      }
      if (src.isDir && isInside(dst, src.path)) {
        fail(op, src.path, 'The destination folder is a subfolder of the source folder.')
        await skipCount(op, src.path)
        continue
      }
      const sameDev = op.pairs
        ? src.dev === ((await fsp.stat(path.dirname(dst)).catch(() => null))?.dev ?? -2)
        : src.dev === destDev
      const before = op.failures.length
      const res = await moveEntry(op, src.path, dst, sameDev, src)
      if (res.moved && res.finalDst && !res.merged && op.failures.length === before) {
        op.movedPairs.push({ from: src.path, to: res.finalDst })
      }
    }
  }
}

/** Recursive copy. Returns the path copied to (keepBoth may rename), or null.
 * rec, when given, collects the topmost entries actually CREATED — a dir that
 * was merged into is never recorded, only its actually-created children. */
async function copyEntry(op: Op, src: string, dst: string, rec?: MovePair[]): Promise<string | null> {
  checkCancel(op)
  await pauseGate(op)
  const st = await lstatOrNull(src)
  if (!st) { fail(op, src, 'The item is no longer in this location.'); return null }
  op.currentFile = src
  if (st.isSymbolicLink()) return copySymlinkEntry(op, src, dst, st, rec)
  if (st.isDirectory()) return copyDirEntry(op, src, dst, st, rec)
  if (!st.isFile()) { fail(op, src, 'This type of file cannot be copied.'); op.itemsDone++; return null }
  return copyFileEntry(op, src, dst, st, rec)
}

/** symlinks are copied as links, never followed (better than Explorer — research §9) */
async function copySymlinkEntry(op: Op, src: string, dst: string, st: fs.Stats, rec?: MovePair[]): Promise<string | null> {
  let realDst = dst
  const dstSt = await lstatOrNull(dst)
  if (dstSt) {
    const choice = await askConflict(op, src, st, dst, dstSt, false)
    if (choice === 'skip') { op.itemsDone++; return null }
    if (choice === 'keepBoth') {
      realDst = path.join(path.dirname(dst), await uniqueSuffixName(path.dirname(dst), path.basename(dst), false))
    } else {
      try { await fsp.rm(dst, { recursive: true, force: true }) }
      catch (e) { fail(op, src, e); op.itemsDone++; return null }
    }
  }
  try {
    const target = await fsp.readlink(src)
    await fsp.symlink(target, realDst)     // CIFS cannot create symlinks -> recorded failure, op continues
    op.itemsDone++
    rec?.push({ from: src, to: realDst })
    return realDst
  } catch (e) {
    fail(op, src, `Could not copy the symbolic link: ${errMsg(e)}`)
    op.itemsDone++
    return null
  }
}

async function copyDirEntry(op: Op, src: string, dst: string, st: fs.Stats, rec?: MovePair[]): Promise<string | null> {
  let realDst = dst
  // once this dir itself is created, its whole subtree is covered by one rec
  // entry; only a merge keeps passing rec down to record created children
  let childRec: MovePair[] | undefined
  const dstSt = await lstatOrNull(dst)
  if (dstSt) {
    if (dstSt.isDirectory()) {
      const choice = await askConflict(op, src, st, dst, dstSt, true)
      if (choice === 'skip') { await skipCount(op, src, st); return null }
      if (choice === 'keepBoth') {
        realDst = path.join(path.dirname(dst), await uniqueSuffixName(path.dirname(dst), path.basename(dst), true))
        try { await fsp.mkdir(realDst) }
        catch (e) { fail(op, src, e); await skipCount(op, src, st); return null }
        rec?.push({ from: src, to: realDst })
      } else {
        // 'merge': copy into the existing folder, file conflicts surface per
        // file. The folder was NOT created — recording it for undo would make
        // Ctrl+Z delete pre-existing files, so record only created children.
        childRec = rec
      }
    } else {
      fail(op, src, 'There is already a file with the same name as the folder name you specified. Specify a different name.')
      await skipCount(op, src, st)
      return null
    }
  } else {
    try { await fsp.mkdir(realDst) }
    catch (e) { fail(op, src, e); await skipCount(op, src, st); return null }
    rec?.push({ from: src, to: realDst })
  }
  op.itemsDone++
  let names: string[] = []
  try { names = await fsp.readdir(src) }
  catch (e) { fail(op, src, e); return realDst }
  for (const n of names) {
    checkCancel(op)
    await copyEntry(op, path.join(src, n), path.join(realDst, n), childRec)
  }
  return realDst
}

async function copyFileEntry(op: Op, src: string, dst: string, st: fs.Stats, rec?: MovePair[]): Promise<string | null> {
  let realDst = dst
  let replacing = false
  const dstSt = await lstatOrNull(dst)
  if (dstSt) {
    if (dstSt.isDirectory()) {
      fail(op, src, 'There is already a folder with the same name in this location.')
      op.itemsDone++
      op.bytesDone += st.size
      return null
    }
    const choice = await askConflict(op, src, st, dst, dstSt, false)
    if (choice === 'skip') { op.itemsDone++; op.bytesDone += st.size; return null }
    if (choice === 'keepBoth') {
      realDst = path.join(path.dirname(dst), await uniqueSuffixName(path.dirname(dst), path.basename(dst), false))
    } else {
      replacing = true
    }
  }
  // replace streams to a temp sibling and renames over dst only after the copy
  // fully succeeded — failure/cancel must never destroy the old destination
  const writeDst = replacing ? `${realDst}.liqtmp-${process.pid}` : realDst
  try {
    await streamCopy(op, src, writeDst, st)
    await fsp.utimes(writeDst, st.atime, st.mtime).catch(() => {})      // Explorer preserves mtime
    await fsp.chmod(writeDst, st.mode & 0o777).catch(() => {})          // best-effort; CIFS forces modes
    if (replacing) await fsp.rename(writeDst, realDst)
    op.itemsDone++
    rec?.push({ from: src, to: realDst })
    return realDst
  } catch (e) {
    if (replacing) await fsp.unlink(writeDst).catch(() => {})
    if (e instanceof CancelledError) throw e
    fail(op, src, e)
    op.itemsDone++
    return null
  }
}

/** 1MB-chunk streamed copy; pause gates between chunks; cancel removes the partial file. */
async function streamCopy(op: Op, src: string, dst: string, st: fs.Stats): Promise<void> {
  await pauseGate(op)
  checkCancel(op)
  const rs = fs.createReadStream(src, { highWaterMark: HW })
  const ws = fs.createWriteStream(dst, { highWaterMark: HW, mode: st.mode & 0o777 })
  let wsError: Error | null = null
  ws.on('error', e => { wsError = e })
  op.inFlight = dst
  try {
    for await (const chunk of rs) {
      if (wsError) throw wsError
      if (!ws.write(chunk as Buffer)) await once(ws, 'drain')
      op.bytesDone += (chunk as Buffer).length
      await pauseGate(op)
      checkCancel(op)
    }
    if (wsError) throw wsError
    ws.end()
    await finished(ws)
  } catch (e) {
    rs.destroy()
    ws.destroy()
    await fsp.unlink(dst).catch(() => {})   // never leave a partial file behind
    throw e
  } finally {
    op.inFlight = null
  }
}

interface MoveResult { moved: boolean; finalDst?: string; merged?: boolean }

async function moveEntry(op: Op, src: string, dst: string, sameDev: boolean, top?: TopSrc): Promise<MoveResult> {
  checkCancel(op)
  await pauseGate(op)
  const st = await lstatOrNull(src)
  if (!st) { fail(op, src, 'The item is no longer in this location.'); return { moved: false } }
  op.currentFile = src
  const dstSt = await lstatOrNull(dst)

  if (!dstSt) {
    if (sameDev) {
      try {
        await fsp.rename(src, dst)
        if (top) { op.itemsDone += top.items; op.bytesDone += top.bytes }
        else { op.itemsDone++; if (st.isFile()) op.bytesDone += st.size }
        return { moved: true, finalDst: dst }
      } catch (e) {
        if ((e as NodeJS.ErrnoException)?.code !== 'EXDEV') {
          fail(op, src, e)
          await skipCount(op, src, st)
          return { moved: false }
        }
        // EXDEV despite matching st.dev (bind mounts etc.) — fall through to copy+delete
      }
    }
    // cross-device: copy the subtree, delete the source only if it fully succeeded
    const before = op.failures.length
    const created = await copyEntry(op, src, dst)
    if (created && op.failures.length === before && !op.cancelled) {
      await deleteEntry(op, src, false)
      return { moved: true, finalDst: created }
    }
    return { moved: false, finalDst: created ?? undefined }
  }

  const srcIsDir = st.isDirectory() && !st.isSymbolicLink()
  const dstIsDir = dstSt.isDirectory() && !dstSt.isSymbolicLink()

  if (srcIsDir && dstIsDir) {
    const choice = await askConflict(op, src, st, dst, dstSt, true)
    if (choice === 'skip') { await skipCount(op, src, st); return { moved: false } }
    if (choice === 'keepBoth') {
      const nd = path.join(path.dirname(dst), await uniqueSuffixName(path.dirname(dst), path.basename(dst), true))
      return moveEntry(op, src, nd, sameDev, top)
    }
    // merge: move children into the existing folder
    let names: string[] = []
    try { names = await fsp.readdir(src) }
    catch (e) { fail(op, src, e); return { moved: false } }
    op.itemsDone++
    for (const n of names) {
      checkCancel(op)
      await pauseGate(op)
      await moveEntry(op, path.join(src, n), path.join(dst, n), sameDev)
    }
    await fsp.rmdir(src).catch(() => {})   // only removes if everything moved out
    return { moved: true, finalDst: dst, merged: true }
  }

  if (!srcIsDir && !dstIsDir) {
    const choice = await askConflict(op, src, st, dst, dstSt, false)
    if (choice === 'skip') { op.itemsDone++; if (st.isFile()) op.bytesDone += st.size; return { moved: false } }
    if (choice === 'keepBoth') {
      const nd = path.join(path.dirname(dst), await uniqueSuffixName(path.dirname(dst), path.basename(dst), false))
      return moveEntry(op, src, nd, sameDev, top)
    }
    // replace — never remove dst up front: rename() replaces atomically on the
    // same device, and the cross-device path copies to a temp sibling first so
    // a failed/cancelled copy can never destroy the old destination
    if (sameDev) {
      try {
        await fsp.rename(src, dst)
        if (top) { op.itemsDone += top.items; op.bytesDone += top.bytes }
        else { op.itemsDone++; if (st.isFile()) op.bytesDone += st.size }
        return { moved: true, finalDst: dst }
      } catch (e) {
        if ((e as NodeJS.ErrnoException)?.code !== 'EXDEV') {
          fail(op, src, e)
          op.itemsDone++
          return { moved: false }
        }
        // EXDEV despite matching st.dev (bind mounts etc.) — temp-copy path
      }
    }
    const tmp = `${dst}.liqtmp-${process.pid}`
    const before = op.failures.length
    const created = await copyEntry(op, src, tmp)
    if (!created || op.failures.length !== before || op.cancelled) {
      await fsp.unlink(tmp).catch(() => {})
      return { moved: false }
    }
    try { await fsp.rename(tmp, dst) }
    catch (e) {
      await fsp.unlink(tmp).catch(() => {})
      fail(op, src, e)
      return { moved: false }
    }
    await deleteEntry(op, src, false)
    return { moved: true, finalDst: dst }
  }

  // file/folder name clash — Explorer refuses outright
  fail(op, src, srcIsDir
    ? 'There is already a file with the same name as the folder name you specified. Specify a different name.'
    : 'There is already a folder with the same name in this location.')
  await skipCount(op, src, st)
  return { moved: false }
}

// ---------------- delete / trash ----------------

async function execDelete(op: Op): Promise<void> {
  setStatus(op, 'enumerating')
  for (const s of op.req.sources) {
    checkCancel(op)
    if (s.startsWith('trash://')) op.itemsTotal++
    else await walkCount(op, s, true)
  }
  op.bytesTotal = 0   // delete progress is item-based
  setStatus(op, 'running')
  for (const s of op.req.sources) {
    checkCancel(op)
    await pauseGate(op)
    op.currentFile = s
    if (s.startsWith('trash://')) {
      const r = await trash.removeOne(s)
      if (!r.ok) fail(op, s, r.error ?? 'Could not delete the item')
      op.itemsDone++
    } else {
      await deleteEntry(op, s, true)
    }
  }
}

/** bottom-up recursive delete; symlinks removed as links, never followed */
async function deleteEntry(op: Op, p: string, countProgress: boolean): Promise<void> {
  checkCancel(op)
  await pauseGate(op)
  const st = await lstatOrNull(p)
  if (!st) { fail(op, p, 'The item is no longer in this location.'); return }
  op.currentFile = p
  if (st.isDirectory() && !st.isSymbolicLink()) {
    let names: string[] = []
    try { names = await fsp.readdir(p) }
    catch (e) { fail(op, p, e); return }
    for (const n of names) await deleteEntry(op, path.join(p, n), countProgress)
    try {
      await fsp.rmdir(p)
      if (countProgress) op.itemsDone++
    } catch (e) {
      // ENOTEMPTY means children already failed and are recorded — don't double-report
      if ((e as NodeJS.ErrnoException)?.code !== 'ENOTEMPTY') fail(op, p, e)
    }
  } else {
    try {
      await fsp.unlink(p)
      if (countProgress) op.itemsDone++
    } catch (e) {
      fail(op, p, e)
    }
  }
}

async function execTrash(op: Op): Promise<void> {
  op.itemsTotal = op.req.sources.length   // gio trash is per-item (same-volume rename: fast)
  setStatus(op, 'running')
  for (const s of op.req.sources) {
    checkCancel(op)
    await pauseGate(op)
    op.currentFile = s
    const r = await spawnCapture(op, 'gio', ['trash', '--', s])
    if (op.cancelled) throw new CancelledError()
    if (r.code === 0) op.trashedPaths.push(s)
    else fail(op, s, r.err.trim() || 'The item could not be moved to the Recycle Bin.')
    op.itemsDone++
  }
}

async function execRestoreTrash(op: Op): Promise<void> {
  op.itemsTotal = op.req.sources.length
  setStatus(op, 'running')
  for (const s of op.req.sources) {
    checkCancel(op)
    await pauseGate(op)
    op.currentFile = s
    const r = await trash.restoreOne(s)
    if (!r.ok) fail(op, s, r.error ?? 'Could not restore the item')
    op.itemsDone++
  }
}

async function execEmptyTrash(op: Op): Promise<void> {
  op.itemsTotal = await trash.itemCount().catch(() => 0)
  setStatus(op, 'running')
  const r = await spawnCapture(op, 'gio', ['trash', '--empty'])
  if (op.cancelled) throw new CancelledError()
  if (r.code !== 0) throw new Error(r.err.trim() || 'Could not empty the Recycle Bin')
  op.itemsDone = op.itemsTotal
}

// ---------------- rename / mkdir / mkfile / symlink ----------------

async function execRename(op: Op): Promise<void> {
  const src = op.req.sources[0]
  const dst = op.req.dest
  if (!src || !dst) throw new Error('Invalid rename request')
  op.itemsTotal = 1
  setStatus(op, 'running')
  if (src !== dst) {
    const caseOnly = src.toLowerCase() === dst.toLowerCase()
    const dstSt = await lstatOrNull(dst)
    if (dstSt) {
      // case-only: dst may resolve to the source itself (case-insensitive
      // mount) — same dev+ino. Anything else is a distinct entry that a bare
      // rename() would silently clobber (both names can coexist on ext4).
      const srcSt = caseOnly ? await lstatOrNull(src) : null
      const sameEntry = srcSt !== null && srcSt.dev === dstSt.dev && srcSt.ino === dstSt.ino
      if (!sameEntry) throw new Error('There is already a file with the same name in this location.')
    }
    await fsp.rename(src, dst)
    op.movedPairs.push({ from: src, to: dst })
  }
  op.itemsDone = 1
}

async function execMake(op: Op): Promise<void> {
  const dst = op.req.dest
  if (!dst) throw new Error('Invalid request')
  op.itemsTotal = 1
  setStatus(op, 'running')
  op.currentFile = dst
  if (op.kind === 'mkdir') await fsp.mkdir(dst)
  else await fsp.writeFile(dst, '', { flag: 'wx' })
  op.created.push(dst)
  op.itemsDone = 1
}

async function execSymlink(op: Op): Promise<void> {
  const dst = op.req.dest
  if (!op.req.sources.length || !dst) throw new Error('Invalid request')
  // dest is either a full link path (single source) or a destination folder
  // (right-drag 'Create shortcuts here', which links every source into it)
  const dstSt = await lstatOrNull(dst)
  const intoDir = op.req.sources.length > 1 || !!dstSt?.isDirectory()
  op.itemsTotal = op.req.sources.length
  setStatus(op, 'running')
  for (const target of op.req.sources) {
    checkCancel(op)
    await pauseGate(op)
    op.currentFile = target
    let linkPath = dst
    if (intoDir) {
      const st = await lstatOrNull(target)
      const base = `${path.basename(target)} - Shortcut`
      const name = await lstatOrNull(path.join(dst, base))
        ? await uniqueSuffixName(dst, base, st?.isDirectory() ?? false)
        : base
      linkPath = path.join(dst, name)
    }
    try {
      await fsp.symlink(target, linkPath)
      op.created.push(linkPath)
      op.copyPairs.push({ from: target, to: linkPath })   // redo needs the target
    } catch (e) {
      const code = (e as NodeJS.ErrnoException)?.code
      if (code === 'EPERM' || code === 'EACCES' || code === 'ENOSYS') {
        // CIFS mounts here cannot create symlinks (research §9)
        fail(op, target, 'This location does not support symbolic links.')
      } else if (!intoDir) {
        throw e
      } else {
        fail(op, target, e)
      }
    }
    op.itemsDone++
  }
}

// ---------------- archives ----------------

/**
 * Move the results of an extraction out of its temp folder and into the
 * destination, reusing the normal conflict-aware move so the user gets the
 * usual Replace / Skip / Keep both dialog. Everything here is a same-device
 * rename; the bytes were already counted as they were extracted, so the
 * progress counters are restored afterwards instead of being counted twice.
 */
async function moveExtracted(op: Op, fromDir: string, toDir: string): Promise<string[]> {
  const bytes = op.bytesDone
  const items = op.itemsDone
  const created: string[] = []
  try {
    for (const n of await fsp.readdir(fromDir)) {
      checkCancel(op)
      await pauseGate(op)
      const r = await moveEntry(op, path.join(fromDir, n), path.join(toDir, n), true)
      if (r.moved && r.finalDst && !r.merged) created.push(r.finalDst)
    }
  } finally {
    op.bytesDone = bytes
    op.itemsDone = items
  }
  return created
}

async function execArchive(op: Op): Promise<void> {
  const dest = op.req.dest
  if (!dest) throw new Error('No destination folder was given.')
  op.itemsTotal = op.req.sources.length
  const ctx: ArchiveCtx = {
    opId: op.id,
    sender: op.sender,
    sources: op.req.sources,
    dest,
    format: op.req.format,
    isCancelled: () => op.cancelled,
    checkCancel: () => checkCancel(op),
    pauseGate: () => pauseGate(op),
    setStatus: s => setStatus(op, s),
    setCurrent: f => { op.currentFile = f },
    setTotals: (items, bytes) => { op.itemsTotal = items; op.bytesTotal = bytes },
    setBytes: n => { op.bytesDone = n },
    itemDone: () => { op.itemsDone++ },
    fail: (p, e) => fail(op, p, e),
    setChild: c => { op.child = c },
    uniqueName: (dir, base, isDir) => uniqueSuffixName(dir, base, isDir),
    moveInto: (from, to) => moveExtracted(op, from, to),
    recordCreated: p => { op.created.push(p) },
  }
  if (op.kind === 'compress') {
    const r = await runCompress(ctx)
    if (op.cancelled) throw new CancelledError()
    if (r.error) throw new Error(r.error)
    if (r.created) op.created.push(r.created)
  } else {
    await runExtract(ctx)
    if (op.cancelled) throw new CancelledError()
  }
}
