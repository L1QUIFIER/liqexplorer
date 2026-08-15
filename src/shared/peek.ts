// Peek popover vocabulary — shared by the renderer (views/peek.ts) and the main
// process (fs/peek.ts).
//
// Peek is the "look without opening" surface: hover an item for a moment, or
// press Space on the focused one (macOS Quick Look muscle memory), and a
// popover shows what is inside — a folder's contents as a thumbnail grid, a
// file through the same per-type renderers the preview pane uses.
//
// Like shared/preview.ts this module stays out of the core contract: it imports
// only the FileEntry shape and adds nothing to LiqApi (both IPC methods
// self-register, see main/fs/peek.ts).
import type { FileEntry } from './types'

export const PEEK = {
  /** hover dwell before a peek opens, when the setting leaves it unset */
  defaultDelayMs: 1400,
  minDelayMs: 400,
  maxDelayMs: 5000,
  /** entries statted and rendered for a folder peek (the rest are only counted) */
  gridLimit: 200,
  /** dirents read before the walk stops counting — a 100k-entry folder must not
   *  turn a peek into a full enumeration */
  scanCap: 100_000,
  /** peekDir answers within this whatever the filesystem does (hard-mounted CIFS) */
  deadlineMs: 4000,
  /** the pointer may be outside BOTH the item and the popover for this long
   *  before the popover closes — crossing the gap between them must not kill it */
  closeGraceMs: 320,
  /** text peek: bytes read main-side, then lines actually shown */
  textMaxBytes: 96 * 1024,
  textMaxLines: 100,
  /** archive peek: member rows before "…and N more" */
  archiveMaxRows: 80,
  /** a file inside an archive is extracted to be previewed — above this it is
   *  not worth a 7z run and a temp write for a glance */
  memberMaxBytes: 24 * 1024 * 1024,
} as const

export interface PeekDirRequest {
  path: string
  showHidden: boolean
  /** entries to stat and return; the total count covers everything seen */
  limit?: number
  /** cancellation handle — peekCancel(token) abandons the walk mid-flight */
  token?: number
}

export interface PeekDirResult {
  path: string
  /** first `limit` entries, folders first then natural name order */
  entries: FileEntry[]
  /** everything the walk saw (after the hidden filter), not just what it returned */
  total: number
  /** total is itself a floor: the walk hit scanCap or the deadline */
  partialCount: boolean
  /** the walk exceeded PEEK.deadlineMs (slow or hung mount) */
  timedOut: boolean
  error?: string
}

/** ms to wait before a hover opens a peek, clamped to something sane */
export function peekDelay(ms: number | undefined): number {
  const v = typeof ms === 'number' && Number.isFinite(ms) ? ms : PEEK.defaultDelayMs
  return Math.min(PEEK.maxDelayMs, Math.max(PEEK.minDelayMs, Math.round(v)))
}
