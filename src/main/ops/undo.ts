// Multi-level undo/redo (cap 20 each), global to the app like Explorer's shell
// undo. Undoable: move (inverse move), rename, copy (inverse: delete the
// copies), trash (inverse: restore from trash by original path), mkdir/mkfile
// (inverse: delete). Deliberately NOT recorded: permanent delete, emptyTrash,
// restoreTrash, compress/extract — executing one does NOT clear the stacks
// (Windows keeps its undo history; the entries just aren't added).
//
// Inverse/redo operations run through the normal engine queue via
// engine.runInternal (no re-recording), so they get progress UI, conflict
// dialogs and failure collection for free. engine.ts calls record() on
// successful completion of recordable ops; quick.ts records rename/newFolder/
// newFile. PUSH.undoChanged is broadcast on every stack change.
import { PUSH } from '../../shared/ipc'
import type { UndoInfo } from '../../shared/types'
import { broadcast } from '../windows'
import * as engine from './engine'
import * as trash from '../platform/trash'

export interface UndoEntry {
  kind: 'move' | 'rename' | 'copy' | 'trash' | 'mkdir' | 'mkfile' | 'symlink'
  /** item count for the label */
  count: number
  /** move/rename/copy: what happened, from -> to (to = actual created path) */
  pairs?: { from: string; to: string }[]
  /** copy/mkdir/mkfile: created paths (undo deletes them) */
  created?: string[]
  /** trash: original paths of the trashed items */
  trashed?: string[]
}

const CAP = 20
const undoStack: UndoEntry[] = []
const redoStack: UndoEntry[] = []
let busy = false

const VERBS: Record<UndoEntry['kind'], string> = {
  move: 'Move', rename: 'Rename', copy: 'Copy', trash: 'Delete', mkdir: 'New', mkfile: 'New',
  symlink: 'Create Shortcut',
}

function label(e: UndoEntry | undefined): string | null {
  if (!e) return null
  return e.count > 1 ? `${VERBS[e.kind]} (${e.count} items)` : VERBS[e.kind]
}

export function getUndoInfo(): UndoInfo {
  const u = label(undoStack[undoStack.length - 1])
  const r = label(redoStack[redoStack.length - 1])
  return { undoLabel: u ? `Undo ${u}` : null, redoLabel: r ? `Redo ${r}` : null }
}

function changed(): void {
  broadcast(PUSH.undoChanged, getUndoInfo())
}

/** Called by engine.ts / quick.ts after a successful recordable operation. */
export function record(e: UndoEntry): void {
  undoStack.push(e)
  if (undoStack.length > CAP) undoStack.shift()
  redoStack.length = 0
  changed()
}

export async function doUndo(): Promise<void> {
  if (busy) return
  const e = undoStack.pop()
  if (!e) return
  busy = true
  try {
    // A failed/partial inverse must NOT become a redo entry: the op row keeps
    // the error, and offering "Redo" for work that never reverted corrupts
    // history — drop the entry instead.
    if (await applyInverse(e)) {
      redoStack.push(e)
      if (redoStack.length > CAP) redoStack.shift()
    }
  } finally {
    busy = false
    changed()
  }
}

export async function doRedo(): Promise<void> {
  if (busy) return
  const e = redoStack.pop()
  if (!e) return
  busy = true
  try {
    // same rule as doUndo: a failed replay never re-enters the undo stack
    if (await applyForward(e)) {
      undoStack.push(e)
      if (undoStack.length > CAP) undoStack.shift()
    }
  } finally {
    busy = false
    changed()
  }
}

const ok = (r: engine.OpResult): boolean => r.status === 'done' && r.failureCount === 0

/** Runs the inverse op. False when it failed, was cancelled, or applied partially. */
async function applyInverse(e: UndoEntry): Promise<boolean> {
  switch (e.kind) {
    case 'move': {
      const inv = (e.pairs ?? []).map(p => ({ from: p.to, to: p.from })).reverse()
      if (!inv.length) return true
      return ok(await engine.runInternal({ kind: 'move', sources: inv.map(p => p.from) }, inv))
    }
    case 'rename': {
      const p = e.pairs?.[0]
      if (!p) return true
      return ok(await engine.runInternal({ kind: 'rename', sources: [p.to], dest: p.from }))
    }
    case 'copy':
      // undoing a copy deletes the copies (Explorer semantics — permanent)
      if (!e.created?.length) return true
      return ok(await engine.runInternal({ kind: 'delete', sources: e.created }))
    case 'trash': {
      const want = e.trashed?.length ?? 0
      if (!want) return true
      // gvfsd-trash indexing lag can leave items unresolved — restoring only
      // a subset is a partial undo, so require full coverage
      const uris = await trash.urisForOrigPaths(e.trashed ?? [])
      if (!uris.length) return false
      const r = await engine.runInternal({ kind: 'restoreTrash', sources: uris })
      return uris.length === want && ok(r)
    }
    case 'mkdir':
    case 'mkfile':
    case 'symlink':
      if (!e.created?.length) return true
      return ok(await engine.runInternal({ kind: 'delete', sources: e.created }))
  }
}

async function applyForward(e: UndoEntry): Promise<boolean> {
  switch (e.kind) {
    case 'move':
      if (!e.pairs?.length) return true
      return ok(await engine.runInternal({ kind: 'move', sources: e.pairs.map(p => p.from) }, e.pairs))
    case 'rename': {
      const p = e.pairs?.[0]
      if (!p) return true
      return ok(await engine.runInternal({ kind: 'rename', sources: [p.from], dest: p.to }))
    }
    case 'copy':
      if (!e.pairs?.length) return true
      return ok(await engine.runInternal({ kind: 'copy', sources: e.pairs.map(p => p.from) }, e.pairs))
    case 'trash':
      if (!e.trashed?.length) return true
      return ok(await engine.runInternal({ kind: 'trash', sources: e.trashed }))
    case 'mkdir':
    case 'mkfile': {
      let all = true
      for (const p of e.created ?? []) {
        if (!ok(await engine.runInternal({ kind: e.kind, sources: [], dest: p }))) all = false
      }
      return all
    }
    case 'symlink': {
      // dest is the full link path, so each link is recreated exactly where it was
      let all = true
      for (const p of e.pairs ?? []) {
        if (!ok(await engine.runInternal({ kind: 'symlink', sources: [p.from], dest: p.to }))) all = false
      }
      return all
    }
  }
}
