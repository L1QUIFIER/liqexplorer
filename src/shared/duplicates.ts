// Duplicate-file finder: the contract between main/platform/duplicates.ts
// (the scanner) and renderer/dialogs/duplicates.ts (the UI). Pure types plus a
// couple of pure helpers — nothing here imports node or the DOM.
//
// The scan is a THREE-STAGE funnel, and the stages are the whole performance
// story (see the scanner's header for why):
//   1. group by exact size      — no file is read at all
//   2. hash the first 64 KB     — one short read splits most size collisions
//   3. hash the rest            — only for files still sharing a head digest
// A file whose size is unique never gets opened, which is what makes scanning a
// photo library or a network share practical.

/** main -> renderer progress + final result (preload only allows 'liqpush:*') */
export const DUP_PUSH = 'liqpush:duplicates'

/** stage-2 sample size; a file this small is fully hashed by stage 2 alone */
export const DUP_HEAD_BYTES = 64 * 1024

export interface DupScanRequest {
  /** one or more folders; nested/duplicate roots are folded together */
  roots: string[]
  /** walk subfolders (default true) */
  subfolders?: boolean
  /** ignore files smaller than this many bytes (default 1 — empty files out) */
  minSize?: number
  /** include dot-files and files inside dot-folders (default false) */
  includeHidden?: boolean
}

/** remembered between sessions in ~/.local/state/liqexplorer/duplicates.json */
export interface DupPrefs {
  subfolders: boolean
  minSize: number
  includeHidden: boolean
}

export const DEFAULT_DUP_PREFS: DupPrefs = {
  subfolders: true,
  minSize: 1,
  includeHidden: false,
}

export interface DupFile {
  path: string
  size: number
  /** mtimeMs */
  mtime: number
}

export interface DupGroup {
  /** stable across a single result (used as a DOM key) */
  id: string
  /** every file in the group has exactly this size */
  size: number
  /** size * (files.length - 1) — what deleting all but one would free */
  wasted: number
  /** newest first */
  files: DupFile[]
}

export type DupStage =
  | 'walking'    // listing folders, collecting sizes
  | 'grouping'   // bucketing by size, collapsing hard links
  | 'head'       // hashing the first DUP_HEAD_BYTES of each candidate
  | 'full'       // hashing the remainder of the survivors
  | 'done'
  | 'cancelled'

export interface DupProgress {
  scanId: number
  stage: DupStage
  dirsSeen: number
  filesSeen: number
  /** files that survived the size grouping (i.e. that may still be read) */
  candidates: number
  /** progress WITHIN the current stage (files) */
  stageDone: number
  stageTotal: number
  bytesHashed: number
  /** the file being read right now */
  current: string
  done: boolean
  /** present exactly once, on the final push */
  result?: DupScanResult
}

export interface DupScanResult {
  scanId: number
  /** biggest wasted space first */
  groups: DupGroup[]
  roots: string[]
  filesScanned: number
  candidates: number
  bytesHashed: number
  elapsedMs: number
  /** at least one scanned folder lives on a network filesystem (cifs/nfs/…) */
  remote: boolean
  cancelled: boolean
  /** a limit was hit: the result is a prefix, not the whole truth */
  truncated: boolean
  /** extra links to an inode already counted — collapsed, never reported as dupes */
  hardLinks: number
  /** files that could not be read (permissions, timeout, vanished) */
  unreadable: number
  /** first few failures, for the dialog's footnotes */
  errors: { path: string; error: string }[]
}

// ---------------------------------------------------------------- helpers

export function totalWasted(groups: DupGroup[]): number {
  let n = 0
  for (const g of groups) n += g.wasted
  return n
}

/** duplicate files = every file beyond the first in each group */
export function totalDuplicates(groups: DupGroup[]): number {
  let n = 0
  for (const g of groups) n += g.files.length - 1
  return n
}

/** newest first; ties broken by path so the order never wobbles between scans */
export function byNewest(a: DupFile, b: DupFile): number {
  return b.mtime - a.mtime || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)
}
