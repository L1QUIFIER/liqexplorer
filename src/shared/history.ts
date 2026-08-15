// Activity-history record shared by main and renderer.
import type { OpKind } from './types'

export interface HistoryEntry {
  /** epoch ms, stamped when the operation finished */
  at: number
  /** 'edit' is not an engine op — the image editor writes its own row */
  kind: OpKind | 'edit'
  /** how many items the operation covered */
  count: number
  /** up to a few source paths, for showing what it was */
  sources: string[]
  /** destination folder (copy/move/extract) or new path (rename) */
  dest?: string
  status: 'done' | 'error' | 'cancelled'
  /** number of per-file failures, when the op finished with some */
  failures?: number
  /** set when this row is the undo or redo OF an earlier row, not a fresh action */
  via?: 'undo' | 'redo'
}

const VERB: Record<string, string> = {
  copy: 'Copied', move: 'Moved', rename: 'Renamed', trash: 'Deleted',
  delete: 'Permanently deleted', mkdir: 'Created folder', mkfile: 'Created file',
  symlink: 'Created shortcut', restoreTrash: 'Restored', emptyTrash: 'Emptied Recycle Bin',
  compress: 'Compressed', extract: 'Extracted', edit: 'Edited',
}

function base(p: string): string {
  return p.replace(/\/+$/, '').split('/').pop() || p
}

/** one-line human description: "Moved 12 items to Backups" */
export function describeHistory(e: HistoryEntry): string {
  // An undo genuinely moved files on disk, so it earns its own row — but it
  // reads as a mystery unless it says so. "Undo — Moved 2 items to src" makes
  // the pair of rows tell the whole story.
  const undone = e.via === 'undo' ? 'Undo — ' : e.via === 'redo' ? 'Redo — ' : ''
  const verb = undone + (VERB[e.kind] ?? e.kind)
  const what = e.count === 1 && e.sources[0]
    ? `"${base(e.sources[0])}"`
    : `${e.count} item${e.count === 1 ? '' : 's'}`
  const where = e.dest ? ` to "${base(e.dest)}"` : ''
  const tail = e.status === 'cancelled' ? ' (cancelled)'
    : e.status === 'error' ? ' (failed)'
      : e.failures ? ` (${e.failures} failed)` : ''
  return `${verb} ${what}${where}${tail}`
}
