// Disk usage vocabulary, shared by platform/diskusage.ts and its dialog.

export interface UsageRow {
  path: string
  name: string
  isDir: boolean
  /** bytes, including everything beneath it for a directory */
  bytes: number
  /** files beneath it (1 for a file) */
  files: number
  /** share of the scanned total, 0..1 — precomputed so the UI does no maths */
  share: number
}

export interface UsageResult {
  ok: boolean
  root: string
  /** immediate children of `root`, biggest first */
  children: UsageRow[]
  /** the largest individual FILES anywhere under root, biggest first */
  biggest: UsageRow[]
  totalBytes: number
  totalFiles: number
  /** directories that could not be read or timed out */
  problems: string[]
  cancelled?: boolean
  error?: string
}

export interface UsageProgress {
  scanId: number
  dirs: number
  files: number
  bytes: number
  /** the directory currently being read, for the "working on…" line */
  current: string
  done?: boolean
}

export const USAGE_PUSH = 'liqpush:diskusage'
/** how many "biggest files" to keep; a longer list is not more useful */
export const USAGE_TOP_FILES = 40
