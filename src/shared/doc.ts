// Doc-tab vocabulary — shared by the renderer (views/inspector/doc.ts) and the
// main process (ops/textfile.ts + ops/pdfops.ts).
//
// Like shared/preview.ts this deliberately imports nothing from types.ts/ipc.ts:
// the Doc tab is additive and must not widen the core contract.

export const DOC = {
  /** Hard cap on an editable text file. Past this the pane offers the file to a
   *  real editor instead: the whole document lives in a <textarea>, and the
   *  browser's undo stack goes with it. */
  textMaxBytes: 2 * 1024 * 1024,
  /** a read that takes longer than this answers "timed out" rather than hanging
   *  the pane — /mnt/share is a hard mount where one read can block for minutes */
  readTimeoutMs: 8000,
  /** a save may legitimately take longer than a read (fsync on a network mount) */
  writeTimeoutMs: 20_000,
  /** every child process (iconv, pdfinfo, pdftoppm, …) is SIGKILLed after this */
  childTimeoutMs: 20_000,
  /** page thumbnails are rendered in windows of this many as the strip scrolls */
  thumbWindow: 12,
  /** thumbnail resolution: 24 dpi is ~204x264 for US Letter, a legible card */
  thumbDpi: 24,
  /** at most this many pdftoppm processes at once */
  thumbJobs: 2,
  /** refuse to rebuild a document bigger than this many pages: every page
   *  becomes a temp file and a pdfunite argument */
  maxPages: 2000,
} as const

// ---------------------------------------------------------------------------
// text  (IPC: 'textRead', 'textWrite' — self-registered by main/ops/textfile.ts)
// ---------------------------------------------------------------------------

export type TextEol = 'lf' | 'crlf' | 'cr'

/** Why a file cannot be edited here — each one has a different way out. */
export type TextRefusal = 'binary' | 'too-big' | 'not-a-file' | 'timeout' | 'unreadable'

export interface TextFile {
  ok: boolean
  error?: string
  refusal?: TextRefusal
  /** ALWAYS \n-normalised: a <textarea> normalises its value anyway, so the
   *  real line endings travel separately in `eol` and are re-applied on save */
  text: string
  /** iconv name of the encoding that was PROVEN to reproduce the file's bytes */
  encoding: string
  /** the file starts with a byte-order mark, which is re-emitted on save */
  bom: boolean
  /** false when no candidate encoding round-tripped: saving in `encoding`
   *  would not reproduce the untouched bytes, so the UI must say so */
  lossless: boolean
  eol: TextEol
  /** the file mixes line endings; a save normalises them to `eol` */
  mixedEol: boolean
  hadFinalNewline: boolean
  bytes: number
  size: number
  /** mtimeMs, rounded — half of the optimistic lock */
  mtime: number
  /** st_mode, re-applied to the replacement file */
  mode: number
  /** the path actually written to, when the selected file is a symlink */
  realPath?: string
}

export interface TextWriteOpts {
  /** iconv name, or 'UTF-8' for the explicit "Save as UTF-8" choice */
  encoding: string
  bom: boolean
  eol: TextEol
  /** re-add the trailing newline the file had (never invents one it lacked) */
  finalNewline: boolean
  /** the optimistic lock: what the file looked like when it was read */
  expectMtime: number
  expectSize: number
  /** write <name>~ first — the only physical undo a text save has */
  backup: boolean
  /** the user chose "Overwrite anyway" after a conflict */
  force?: boolean
}

export interface TextWriteResult {
  ok: boolean
  error?: string
  /** the file changed on disk between the read and the save */
  conflict?: boolean
  /** the chosen encoding cannot represent something in the text */
  unrepresentable?: boolean
  /** the backup could not be written; the save still happened */
  backupError?: string
  backup?: string
  mtime?: number
  size?: number
}

// ---------------------------------------------------------------------------
// pdf  (IPC: 'pdfDocInfo', 'pdfThumbs', 'pdfApplyPages', 'pdfMerge', 'pdfPick')
// ---------------------------------------------------------------------------

export interface PdfInfo {
  ok: boolean
  error?: string
  pages: number
  /** pdfinfo says Encrypted: yes — every write path refuses */
  encrypted: boolean
  /** pdfinfo could not open it at all without a password */
  needsPassword: boolean
  title?: string
  producer?: string
  pageSize?: string
  version?: string
  /** bytes, as pdfinfo reports them — the FileEntry's size is a snapshot from
   *  the listing and is stale the moment a replace rewrites the file */
  fileSize?: number
  /** rotation needs qpdf; Ghostscript would re-render the whole document */
  canRotate: boolean
  /**
   * Which tool will perform a write. qpdf edits the page tree, so a reorder
   * keeps the outline and form fields; the poppler fallback
   * (pdfseparate+pdfunite) rebuilds the document and loses them. The pane shows
   * PDF_REBUILD_WARNING only for 'poppler', because on a machine with qpdf the
   * warning is simply untrue.
   */
  engine: 'qpdf' | 'poppler'
}

export interface PdfThumb {
  /** 1-based source page number */
  page: number
  /** liqfile:// URL of a real JPEG in the cache — no base64, no new scheme */
  url: string
}

export interface PdfThumbs {
  ok: boolean
  error?: string
  thumbs: PdfThumb[]
}

export type DocDest =
  | { mode: 'copy' }
  | { mode: 'folder'; dir: string }
  | { mode: 'replace' }

export interface PdfPagesRequest {
  path: string
  /** 1-based source pages in OUTPUT order; may omit pages (delete), reorder
   *  them, or list a subset (extract). Repeats are allowed. */
  order: number[]
  dest: DocDest
  /** file-name suffix for a copy: "book (edited).pdf" / "book (pages).pdf" */
  suffix?: string
  /**
   * Quarter-turns clockwise to add to a SOURCE page, keyed by source page
   * number. Relative to however the page is already rotated, so applying the
   * same edit twice is not a way to end up at 180.
   *
   * Keyed by source rather than output page because that is what the strip
   * shows: turn page 3, then move it, and it is still page 3 that is turned.
   * qpdf's own --rotate ranges are OUTPUT-relative, so the mapping happens at
   * the point the command is built (verified: `--rotate=+90:1 --pages . 3,1`
   * turns output page 1, i.e. source page 3).
   */
  rotate?: Record<number, number>
}

export interface PdfMergeRequest {
  path: string
  /** appended after `path`, in this order */
  append: string[]
  dest: DocDest
}

export interface PdfResult {
  ok: boolean
  out?: string
  /** page count of what was actually written — verified, not assumed */
  pages?: number
  error?: string
}

/**
 * What a pdfseparate+pdfunite rebuild costs. Poppler's page tools carry the
 * page content and nothing else, and the user has to be told BEFORE the write,
 * not discover it when the bookmarks are gone.
 */
export const PDF_REBUILD_WARNING =
  'Rebuilding drops the outline (bookmarks), form fields, annotations that '
  + 'point across pages, and any encryption. The page content itself is copied '
  + 'as-is, not re-rendered.'

/**
 * Does this mime name a file the text editor can open?
 *
 * ONE definition, imported by both the Doc page and the tab strip that decides
 * whether the Doc tab is even offered. They had a copy each, which is how
 * broadening one of them changed nothing: the editor would happily have opened
 * a .nemo_action, but the strip kept the tab greyed out so it was never asked.
 *
 * The `application/` list is not decoration — plain-text formats are routinely
 * given an application/* type by shared-mime-info. The case that forced it was
 * this app's own extensions (application/nemo-action), which "New extension…"
 * creates and the user immediately wants to edit.
 */
const TEXTUAL = new RegExp('^(text/'
  + '|application/(json|xml|x-sh|javascript|toml|yaml|x-yaml|x-shellscript'
  + '|nemo-action|x-desktop|x-perl|x-python|x-ruby|x-awk|x-m4|sql)'
  + '|application/[\\w.+-]+\\+(json|xml))')

export function isTextualMime(mime: string): boolean {
  return TEXTUAL.test(mime || '')
}
