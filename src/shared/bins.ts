// DROP BINS — shared vocabulary for the drag-target dock (renderer views/dropbins.ts,
// main state/bins.ts + ops/convert.ts + ops/checksums.ts).
//
// Two behaviours, deliberately both present (macOS Dropzone / Yoink prior art):
//   * action bins — drop files on a tile, the action runs immediately;
//   * the Stack bin — drop files from ANY number of folders to accumulate them,
//     then pick one action for the whole pile. Plain drag & drop cannot express
//     "collect from five folders, then act", which is the point of the feature.
//
// Nothing here imports from './types' or './ipc' — this file is additive by
// design so the core contract files stay untouched.

// ---------------------------------------------------------------- bin model

export type BinAction =
  | 'stack'        // accumulate (no side effect)
  | 'copy'         // engine: copy      (undoable)
  | 'move'         // engine: move      (undoable)
  | 'symlink'      // engine: symlink   (undoable)
  | 'trash'        // engine: trash     (undoable)
  | 'compress'     // engine: compress  (NOT undoable — engine excludes it)
  | 'extract'      // archive backend   (NOT undoable)
  | 'favorites'    // favorites store   (own inline undo on the toast)
  | 'bulkRename'   // hands off to dialogs/bulkrename.ts
  | 'convert'      // ImageMagick / ffmpeg, writes NEW files (NOT undoable)
  | 'checksums'    // read-only

/** target sentinel: ask for a folder every time the bin runs */
export const TARGET_ASK = '$ASK'
/** target sentinel: the folder the active tab is showing */
export const TARGET_CWD = '$CWD'

export type ArchiveFormat = 'zip' | 'tar.gz' | '7z'
export type ChecksumAlgo = 'md5' | 'sha1' | 'sha256'

export interface ConvertOptions {
  /** lowercase extension of the output format, e.g. 'jpg' | 'png' | 'webp' | 'avif' */
  format: string
  /** longest edge in px; 0/undefined = keep original size. Never upscales. */
  maxDim?: number
  /** 1..100, lossy formats only */
  quality?: number
  /** strip EXIF/ICC from the output */
  strip?: boolean
}

export interface BinConfig {
  /** stable id; also the reorder key */
  id: string
  action: BinAction
  label: string
  /** liqicon name(s) are not used — tiles draw inline SVG picked by `action` */
  /** absolute path, TARGET_ASK or TARGET_CWD (actions with no destination ignore it) */
  target?: string
  /** hidden bins stay configured but are not drawn in the tray */
  hidden?: boolean
  /** ask for confirmation before running (defaults on for move/trash) */
  confirm?: boolean
  // --- per-action options ---
  format?: ArchiveFormat
  extractMode?: 'auto' | 'named' | 'to'
  convert?: ConvertOptions
  algo?: ChecksumAlgo
}

export interface BinsConfig {
  version: 1
  /** tray stays open instead of auto-collapsing after a drag */
  pinned: boolean
  bins: BinConfig[]
  /** the Stack bin's contents; survives restarts (paths only, never validated
   *  eagerly — a stat storm on a dead network mount would hang the app) */
  stack: string[]
  /** clear the Stack after an action consumed it (move/trash always clear) */
  clearStackAfterUse: boolean
}

/** Actions that take a destination folder; the rest ignore `target`. */
export const NEEDS_TARGET: ReadonlySet<BinAction> =
  new Set<BinAction>(['copy', 'move', 'symlink', 'compress', 'extract', 'convert'])

/** Actions whose engine op is recorded on the undo stack (main/ops/undo.ts). */
export const UNDOABLE: ReadonlySet<BinAction> =
  new Set<BinAction>(['copy', 'move', 'symlink', 'trash'])

export const ACTION_LABELS: Record<BinAction, string> = {
  stack: 'Stack',
  copy: 'Copy to…',
  move: 'Move to…',
  symlink: 'Create shortcuts in…',
  trash: 'Recycle Bin',
  compress: 'Compress to…',
  extract: 'Extract to…',
  favorites: 'Add to Favorites',
  bulkRename: 'Bulk rename',
  convert: 'Convert images…',
  checksums: 'Checksums',
}

let seq = 0
export function newBinId(action: BinAction): string {
  return `${action}-${Date.now().toString(36)}-${(seq++).toString(36)}`
}

/** The shipped set. Order is the tray order, top to bottom. */
export function defaultBins(): BinConfig[] {
  return [
    { id: 'stack', action: 'stack', label: 'Stack' },
    { id: 'copy', action: 'copy', label: 'Copy to…', target: TARGET_ASK },
    { id: 'move', action: 'move', label: 'Move to…', target: TARGET_ASK, confirm: true },
    { id: 'symlink', action: 'symlink', label: 'Shortcuts in…', target: TARGET_ASK },
    { id: 'compress', action: 'compress', label: 'Compress to…', target: TARGET_CWD, format: 'zip' },
    { id: 'extract', action: 'extract', label: 'Extract to…', target: TARGET_CWD, extractMode: 'to' },
    { id: 'favorites', action: 'favorites', label: 'Add to Favorites' },
    { id: 'bulkRename', action: 'bulkRename', label: 'Bulk rename' },
    {
      id: 'convert', action: 'convert', label: 'Convert images…', target: TARGET_ASK,
      convert: { format: 'jpg', maxDim: 0, quality: 88 },
    },
    { id: 'checksums', action: 'checksums', label: 'Checksums', algo: 'sha256' },
    { id: 'trash', action: 'trash', label: 'Recycle Bin', confirm: true },
  ]
}

export function defaultBinsConfig(): BinsConfig {
  return { version: 1, pinned: false, bins: defaultBins(), stack: [], clearStackAfterUse: true }
}

// ------------------------------------------------------- image conversion IPC
//
// invoke: convertFormats() -> ConvertFormat[]        (capability-probed, cached)
//         convertImages(ConvertRequest) -> runId
//         convertCancel(runId)
// push:   CONVERT_PROGRESS

export const CONVERT_PROGRESS = 'liqpush:convert-progress'
export const CHECKSUM_PROGRESS = 'liqpush:checksum-progress'
export const BINS_CHANGED = 'liqpush:bins-changed'

export interface ConvertFormat {
  /** output extension, e.g. 'jpg' */
  id: string
  label: string
  /** the encoder actually verified to produce this format on this machine */
  backend: 'magick' | 'ffmpeg'
  /** -quality / -crf is meaningful */
  lossy: boolean
}

export interface ConvertRequest {
  sources: string[]
  /** destination directory; never the source file itself */
  dest: string
  format: string
  maxDim?: number
  quality?: number
  strip?: boolean
  /** parallel encoders; clamped to 1..8 by main */
  concurrency?: number
}

export interface ConvertProgress {
  runId: number
  status: 'running' | 'done' | 'cancelled' | 'error'
  done: number
  total: number
  /** basename currently being encoded */
  current: string
  /** files successfully written (`outputs` is capped, this is not) */
  written: number
  /** paths written so far, capped at 200 */
  outputs: string[]
  failures: { path: string; error: string }[]
  error?: string
}

// ------------------------------------------------------------ checksums IPC
//
// invoke: checksumsRun(ChecksumRequest) -> ChecksumResult
//         checksumsCancel(runId)
// push:   CHECKSUM_PROGRESS

export interface ChecksumRequest {
  runId: number
  paths: string[]
  algo: ChecksumAlgo
}

export interface ChecksumProgress {
  runId: number
  done: number
  total: number
  current: string
}

export interface ChecksumResult {
  runId: number
  algo: ChecksumAlgo
  /** `<hash>  <path relative to root>` — byte-identical to sha256sum's output,
   *  so a saved file verifies with `sha256sum -c` from `root` */
  lines: string[]
  root: string
  files: number
  /** hit the file cap or unreadable */
  skipped: string[]
  cancelled?: boolean
  error?: string
}

/** Hard ceiling on files a single checksum run will hash. */
export const CHECKSUM_FILE_CAP = 5000
