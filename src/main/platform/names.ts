// Problem-name scanner + batch fixer (the "Fix problem names…" tool).
//
// Rules and suggestions live in shared/names.ts (pure). This file only supplies
// the filesystem context those rules need and performs the renames:
//
//  - readdir in BUFFER mode, so a name whose raw bytes are not valid UTF-8 is
//    detectable (Node hands such names to a string reader as U+FFFD, which is
//    both undetectable and unusable for renaming). The whole walk carries
//    Buffer paths; strings are produced only for display/IPC.
//  - Windows rules are applied where they matter: fs/list.isRemotePath() decides
//    by default ('auto'), so a ':' in ~/Documents is never nagged about while
//    the same file on /mnt/share is. 'always'/'never' override, per request or
//    via namePolicy for a future setting.
//  - renames go through the file-operations engine (ops/engine.runInternal) as
//    ONE 'move' op with explicit pairs, so the batch gets the normal progress
//    UI, conflict handling and failure collection, and lands on the undo stack
//    as a SINGLE entry (undo.record here, exactly like ops/quick.ts does).
//
// Self-registers its IPC verbs (renderer: liq.invoke('scanNames' | 'fixNames' |
// 'checkName', …)), like platform/favorites.ts and ops/quick.ts.
import { ipcMain } from 'electron'
import * as fsp from 'node:fs/promises'
import * as path from 'node:path'
import { CH } from '../../shared/ipc'
import {
  MAX_NAME_BYTES, MAX_PATH, analyzeName, caseCollisionGroups, suggestName, uniqueName,
  type FixNameRequest, type FixNameResult, type FixNamesResult, type NameIssue,
  type NameOptions, type NameProblem, type ScanNamesRequest, type ScanNamesResult,
  type WindowsRule,
} from '../../shared/names'
import { isRemotePath } from '../fs/list'
import * as engine from '../ops/engine'
import * as quick from '../ops/quick'
import * as undo from '../ops/undo'

const DEFAULT_LIMIT = 5000
const MAX_DEPTH = 64

/** Defaults for every check; a settings screen can drive these later. */
export const namePolicy = {
  /** 'auto' = Windows rules only on filesystems Windows reads (cifs/smb/nfs/…) */
  windows: 'auto' as WindowsRule,
  maxNameBytes: MAX_NAME_BYTES,
  maxPath: MAX_PATH,
}

export function configureNames(patch: Partial<typeof namePolicy>): void {
  Object.assign(namePolicy, patch)
}

// ---------------------------------------------------------------- buffer paths

const SLASH = 0x2f

function bufJoin(dir: Buffer, name: Buffer): Buffer {
  const sep = dir.length && dir[dir.length - 1] === SLASH ? Buffer.alloc(0) : Buffer.from('/')
  return Buffer.concat([dir, sep, name])
}

/** raw bytes -> string, plus whether that string round-trips (valid UTF-8) */
function decode(buf: Buffer): { text: string; valid: boolean } {
  const text = buf.toString('utf8')
  return { text, valid: Buffer.from(text, 'utf8').equals(buf) }
}

/** a path string is only usable with fs when it round-trips to the same bytes */
function pathIsExact(p: string, raw?: Buffer): boolean {
  if (raw) return Buffer.from(p, 'utf8').equals(raw)
  return !p.includes('�')
}

// ---------------------------------------------------------------- policy

/** Does this location need the Windows rules? */
export function windowsForPath(p: string, rule: WindowsRule = namePolicy.windows): boolean {
  if (rule === 'always') return true
  if (rule === 'never') return false
  return isRemotePath(p)
}

/**
 * Cheap SYNCHRONOUS check for the inline rename path / New-folder path.
 * Resolves the Windows rules from the folder itself; returns [] when the name
 * is fine. (The renderer can call the same logic without IPC via
 * shared/names.ts firstIssue/warnForName with `windows: entry.remote`.)
 */
export function checkName(dir: string, name: string, isDir = false): NameIssue[] {
  return analyzeName(name, {
    windows: windowsForPath(dir),
    fullPath: path.join(dir, name),
    isDir,
    maxNameBytes: namePolicy.maxNameBytes,
    maxPath: namePolicy.maxPath,
  })
}

/** The first problem's message for `dir/name`, or null. */
export function warnForPath(dir: string, name: string, isDir = false): string | null {
  return checkName(dir, name, isDir)[0]?.message ?? null
}

// ---------------------------------------------------------------- scanning

interface Ent {
  nameBuf: Buffer
  name: string
  /** the raw bytes decode as valid UTF-8 */
  valid: boolean
  isDir: boolean
  pathBuf: Buffer
  path: string
}

async function readEntries(dirBuf: Buffer): Promise<Ent[]> {
  const names = await fsp.readdir(dirBuf, { encoding: 'buffer' })
  const out: Ent[] = []
  for (const nameBuf of names) {
    const pathBuf = bufJoin(dirBuf, nameBuf)
    let isDir = false
    try {
      const st = await fsp.lstat(pathBuf)
      isDir = st.isDirectory()
    } catch { /* vanished mid-scan: still report the name */ }
    const { text, valid } = decode(nameBuf)
    out.push({ nameBuf, name: text, valid, isDir, pathBuf, path: decode(pathBuf).text })
  }
  return out
}

interface DirScan {
  /** every name in the folder, for de-collision and case-collision detection */
  names: string[]
  /** names already handed out as suggestions in this folder */
  reserved: Set<string>
  /** name -> the sibling it case-collides with (only the 2nd+ of a group) */
  collides: Map<string, string>
  windows: boolean
}

function dirScanFor(dir: string, ents: Ent[], rule: WindowsRule): DirScan {
  const names = ents.map(e => e.name)
  const collides = new Map<string, string>()
  for (const group of caseCollisionGroups(names)) {
    // the first one keeps its name; the rest are the ones reported/renamed
    for (const n of group.slice(1)) collides.set(n, group[0])
  }
  return { names, reserved: new Set<string>(), collides, windows: windowsForPath(dir, rule) }
}

function problemFor(e: Ent, dir: string, scan: DirScan): NameProblem | null {
  const opts: NameOptions = {
    windows: scan.windows,
    fullPath: e.path,
    isDir: e.isDir,
    encodingInvalid: !e.valid,
    caseCollidesWith: scan.collides.get(e.name),
    maxNameBytes: namePolicy.maxNameBytes,
    maxPath: namePolicy.maxPath,
  }
  const issues = analyzeName(e.name, opts)
  if (!issues.length) return null
  // the path string is unusable with fs whenever ANY component has stray bytes
  // (a fine name inside a broken folder still needs Buffer paths to rename)
  const pathExact = pathIsExact(e.path, e.pathBuf)

  // de-collide against every sibling except this entry itself, plus the
  // suggestions already reserved for other problem rows in this folder
  const taken = new Set<string>(scan.reserved)
  for (const n of scan.names) if (n !== e.name) taken.add(n)
  const suggested = uniqueName(suggestName(e.name, opts), taken, e.isDir)
  scan.reserved.add(suggested)

  return {
    path: e.path,
    dir,
    name: e.name,
    isDir: e.isDir,
    issues,
    suggested,
    encodingInvalid: !e.valid,
    pathHex: pathExact ? undefined : e.pathBuf.toString('hex'),
    windows: scan.windows,
  }
}

/**
 * Walk a folder (optionally recursive) or check an explicit list of paths.
 * Buffer-mode readdir throughout, so invalid UTF-8 is detected rather than
 * silently turned into U+FFFD.
 */
export async function scanNames(req: ScanNamesRequest): Promise<ScanNamesResult> {
  const rule: WindowsRule = req.windows ?? namePolicy.windows
  const limit = req.limit ?? DEFAULT_LIMIT
  const showHidden = req.showHidden ?? false
  const problems: NameProblem[] = []
  const errors: { path: string; error: string }[] = []
  let scanned = 0
  let truncated = false
  let windowsChecked = false

  // dot-files are skipped by default, but a name made ONLY of dots is not a
  // dot-file — it is one of the problems this tool exists to find
  const hidden = (n: string): boolean => n.startsWith('.') && !/^\.+$/.test(n)

  /** folders still to walk, as [pathBuf, depth] */
  const queue: [Buffer, number][] = []
  const seenDirs = new Set<string>()

  const pushDir = (p: string, depth: number): void => {
    if (depth > MAX_DEPTH || p.includes('://')) return
    if (seenDirs.has(p)) return
    seenDirs.add(p)
    queue.push([Buffer.from(p, 'utf8'), depth])
  }

  if (req.paths?.length) {
    // explicit selection: check the given names against their real folders
    const byDir = new Map<string, string[]>()
    for (const p of req.paths) {
      if (p.includes('://')) continue
      const d = path.dirname(p)
      const g = byDir.get(d)
      if (g) g.push(path.basename(p))
      else byDir.set(d, [path.basename(p)])
    }
    for (const [dir, wanted] of byDir) {
      let ents: Ent[]
      try { ents = await readEntries(Buffer.from(dir, 'utf8')) }
      catch (e) { errors.push({ path: dir, error: msg(e) }); continue }
      const scan = dirScanFor(dir, ents, rule)
      if (scan.windows) windowsChecked = true
      const want = new Set(wanted)
      for (const e of ents) {
        if (!want.has(e.name)) continue
        scanned++
        const pr = problemFor(e, dir, scan)
        if (pr) problems.push(pr)
        if (req.recursive && e.isDir && !seenDirs.has(e.path)) {
          seenDirs.add(e.path)
          queue.push([e.pathBuf, 1])          // raw bytes: the folder name may be broken
        }
      }
      if (problems.length >= limit) { truncated = true; break }
    }
  } else if (req.root) {
    pushDir(req.root, 0)
  }

  while (queue.length && problems.length < limit) {
    const [dirBuf, depth] = queue.shift()!
    const dir = decode(dirBuf).text
    let ents: Ent[]
    try { ents = await readEntries(dirBuf) }
    catch (e) { errors.push({ path: dir, error: msg(e) }); continue }
    const scan = dirScanFor(dir, ents, rule)
    if (scan.windows) windowsChecked = true
    for (const e of ents) {
      if (!showHidden && hidden(e.name)) continue
      scanned++
      const pr = problemFor(e, dir, scan)
      if (pr) problems.push(pr)
      if (problems.length >= limit) { truncated = true; break }
      if (req.recursive && e.isDir && depth < MAX_DEPTH) {
        // a folder whose own name is broken is still walked — using its raw bytes
        if (!seenDirs.has(e.path)) { seenDirs.add(e.path); queue.push([e.pathBuf, depth + 1]) }
      }
    }
  }
  if (queue.length && problems.length >= limit) truncated = true

  return { problems, scanned, errors, truncated, windowsChecked }
}

function msg(e: unknown): string {
  const err = e as NodeJS.ErrnoException
  switch (err?.code) {
    case 'EACCES':
    case 'EPERM': return 'You do not have permission to read this folder.'
    case 'ENOENT': return 'The folder is no longer in this location.'
    case 'ENOTDIR': return 'This is not a folder.'
  }
  return String(err?.message ?? e)
}

// ---------------------------------------------------------------- fixing

interface Row {
  req: FixNameRequest
  fromPath: string
  fromBuf: Buffer
  toPath: string
  toBuf: Buffer
  toName: string
  /** the source name has invalid UTF-8: only Buffer paths can address it */
  raw: boolean
  /** differs from the current name only by case */
  caseOnly: boolean
  result: FixNameResult
}

function bad(row: Row, error: string): void {
  row.result.ok = false
  row.result.error = error
}

/**
 * Rename a reviewed batch. Nothing is overwritten: a destination that already
 * exists fails that row and leaves the file alone.
 *
 * Undo: the valid-UTF-8 rows run through the engine and are recorded as ONE
 * undo entry — Ctrl+Z reverts the whole batch. (A recursive fix that renames a
 * folder AND items inside it needs one entry per nesting level, because an
 * engine op stats all of its sources before it starts; a single folder's worth
 * of problems, which is the normal case, is always exactly one entry.)
 * Rows whose CURRENT path has invalid UTF-8 cannot go through the engine at all
 * (its paths are strings, and a string cannot express those bytes) — they are
 * renamed here with Buffer paths and reported with undoable: false.
 */
export async function fixNames(reqs: FixNameRequest[]): Promise<FixNamesResult> {
  const rows: Row[] = []
  const claimed = new Set<string>()

  for (const req of reqs) {
    const fromPath = req.from
    const fromBuf = req.fromHex ? Buffer.from(req.fromHex, 'hex') : Buffer.from(fromPath, 'utf8')
    const dir = path.dirname(fromPath)
    const toName = req.to.includes('/') ? path.basename(req.to) : req.to
    const toPath = req.to.includes('/') ? req.to : path.join(dir, toName)
    // build the destination from the SOURCE's raw parent bytes, so an item
    // inside a folder whose own name has stray bytes is still addressable
    const cut = fromBuf.lastIndexOf(SLASH)
    const parentBuf = cut > 0 ? fromBuf.subarray(0, cut) : Buffer.from('/')
    const toBuf = req.to.includes('/')
      ? Buffer.from(toPath, 'utf8')
      : bufJoin(parentBuf, Buffer.from(toName, 'utf8'))
    const row: Row = {
      req, fromPath, fromBuf, toPath, toBuf, toName,
      raw: !!req.fromHex || !pathIsExact(fromPath),
      caseOnly: path.basename(fromPath).toLowerCase() === toName.toLowerCase()
        && path.basename(fromPath) !== toName,
      result: { from: fromPath, to: toPath, ok: true, undoable: true },
    }
    rows.push(row)

    const invalid = quick.validateName(toName)
    if (invalid) { bad(row, invalid); continue }
    if (path.dirname(toPath) !== dir) { bad(row, 'A file name cannot contain a path.'); continue }
    if (toName === path.basename(fromPath) && !row.raw) { bad(row, 'The name is unchanged.'); continue }
    // two rows aiming at the same destination (case-insensitively, like CIFS).
    // The folder half of the key is raw bytes when the path has stray ones, so
    // two different folders can never look identical through a lossy string.
    const key = (row.raw ? parentBuf.toString('hex') : dir.toLowerCase()) + '\0' + toName.toLowerCase()
    if (claimed.has(key)) { bad(row, 'Another item in this batch is being renamed to the same name.'); continue }
    claimed.add(key)
  }

  // never overwrite: check the destination up front (the engine would raise a
  // conflict dialog, but the Buffer-path renames below have no such guard)
  for (const row of rows) {
    if (!row.result.ok) continue
    const st = await fsp.lstat(row.toBuf).catch(() => null)
    if (!st) continue
    if (row.caseOnly) {
      // on a case-insensitive mount the destination IS the source
      const src = await fsp.lstat(row.fromBuf).catch(() => null)
      if (src && src.dev === st.dev && src.ino === st.ino) continue
    }
    bad(row, 'There is already a file with the same name in this location.')
  }

  // Deepest first, so renaming a folder never invalidates the rows for the
  // items inside it. Groups run raw -> case-only -> engine batch; a raw path
  // can only ever be a DESCENDANT of a plain one (stray bytes in a folder name
  // make every path below it raw too), so that order is already child-first.
  const live = rows.filter(r => r.result.ok).sort(deepestFirst)
  const rawRows = live.filter(r => r.raw)
  const caseRows = live.filter(r => !r.raw && r.caseOnly)
  const plainRows = live.filter(r => !r.raw && !r.caseOnly)

  // the one ordering the grouping cannot honour: a case-only folder rename that
  // an engine-batch row lives under would move the ground beneath it
  for (const c of caseRows) {
    if (!c.result.ok) continue
    if (plainRows.some(p => p.result.ok && isUnder(p.fromPath, c.fromPath))) {
      bad(c, 'Rename the items inside this folder first, then rename the folder.')
    }
  }

  // --- invalid-UTF-8 rows first: Buffer paths only, outside the undo stack
  for (const r of rawRows) {
    r.result.undoable = false
    if (!r.result.ok) continue
    try {
      await fsp.rename(r.fromBuf, r.toBuf)
    } catch (e) {
      bad(r, msg(e))
    }
  }

  // --- case-only rows: quick.renameOne owns the CIFS-safe two-step dance
  // (and records its own single-item undo entry)
  for (const r of caseRows) {
    if (!r.result.ok) continue
    const res = await quick.renameOne(r.fromPath, r.toName)
    if (!res.ok) bad(r, res.error ?? 'The item could not be renamed.')
  }

  // --- everything else: one engine op per ancestry-safe group.
  // The engine stats every source of an op UP FRONT, so a folder and something
  // inside it cannot share one op (the child's path is only valid before the
  // folder moves, the folder's only after). Rows are deepest-first, so a row can
  // only be an ANCESTOR of ones already placed: drop each row into the first
  // group that holds none of its descendants. Everything unrelated therefore
  // stays in group 0 — one folder's worth of problems, the normal case, is a
  // single group and a single Ctrl+Z.
  const groups: Row[][] = []
  for (const r of plainRows) {
    let gi = 0
    while (gi < groups.length && groups[gi].some(o => isUnder(o.fromPath, r.fromPath))) gi++
    if (gi === groups.length) groups.push([])
    groups[gi].push(r)
  }

  let recorded = false
  for (const group of groups) {
    const pairs = group.map(r => ({ from: r.fromPath, to: r.toPath }))
    try {
      await engine.runInternal({ kind: 'move', sources: pairs.map(p => p.from) }, pairs)
    } catch (e) {
      for (const r of group) bad(r, msg(e))
    }
    // runInternal reports only a status + failure count, so confirm each row
    // here, while the group's folders are still where this group saw them.
    // Groups are recorded oldest-deepest first, and undo pops newest-first, so
    // folders are restored before the contents recorded under their old names.
    const done: { from: string; to: string }[] = []
    for (const r of group) {
      if (!r.result.ok) continue
      const there = await fsp.lstat(r.toBuf).catch(() => null)
      const stillHere = await fsp.lstat(r.fromBuf).catch(() => null)
      if (there && !stillHere) done.push({ from: r.fromPath, to: r.toPath })
      else bad(r, 'The item could not be renamed.')
    }
    if (done.length) {
      // 'move' (not 'rename') because ops/undo.ts only reverses pairs[0] for a
      // rename entry, while its move inverse replays every pair — which is
      // exactly a batch rename in place.
      undo.record({ kind: 'move', count: done.length, pairs: done })
      recorded = true
    }
  }

  const results = rows.map(r => r.result)
  return {
    results,
    fixed: results.filter(r => r.ok).length,
    failed: results.filter(r => !r.ok).length,
    undoRecorded: recorded,
  }
}

/** deepest path first: children are always renamed before their folder */
function deepestFirst(a: Row, b: Row): number {
  const da = depthOf(a.fromPath)
  const db = depthOf(b.fromPath)
  if (da !== db) return db - da
  return a.fromPath < b.fromPath ? -1 : a.fromPath > b.fromPath ? 1 : 0
}

function depthOf(p: string): number {
  let n = 0
  for (let i = 0; i < p.length; i++) if (p.charCodeAt(i) === SLASH) n++
  return n
}

/** true when `child` lives inside the folder `parent` */
function isUnder(child: string, parent: string): boolean {
  return child.startsWith(parent.endsWith('/') ? parent : parent + '/')
}

// ---------------------------------------------------------------- IPC
// self-registered, like ops/quick.ts (renderer: liq.invoke('scanNames', …))

ipcMain.handle(CH('scanNames'), (_e, req: ScanNamesRequest) => scanNames(req ?? {}))
ipcMain.handle(CH('fixNames'), (_e, reqs: FixNameRequest[]) => fixNames(reqs ?? []))
ipcMain.handle(CH('checkName'), (_e, dir: string, name: string, isDir?: boolean) =>
  checkName(dir, name, !!isDir))
