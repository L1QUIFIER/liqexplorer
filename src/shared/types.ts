// Shared data types — the single vocabulary for main, preload and renderer.
// Everything crossing IPC must be plain JSON-serializable data.

export type ViewMode =
  | 'extra-large' | 'large' | 'medium' | 'small'   // icon grids (256/96/48/16 base)
  | 'list' | 'details' | 'tiles' | 'content'

export type SortKey =
  | 'name' | 'mtime' | 'ctime' | 'atime' | 'type' | 'size' | 'ext'
  | 'dateTaken' | 'dimensions' | 'duration' | 'origPath' | 'deletedAt'
  | 'rating'

import type { SmartViewRules } from './foldertype'
import { DEFAULT_SMART_RULES } from './foldertype'
export { DEFAULT_SMART_RULES } from './foldertype'
export type { FolderKind, SmartViewRule, SmartViewRules } from './foldertype'

export type GroupKey = SortKey | 'none'
export type SortDir = 'asc' | 'desc'

export interface FileEntry {
  name: string
  /** absolute path (or virtual URI for trash://, computer://) */
  path: string
  isDir: boolean
  isSymlink: boolean
  /** symlink target if isSymlink */
  target?: string
  size: number          // bytes; -1 = unknown
  mtime: number         // epoch ms
  ctime: number         // inode change / best-effort created, epoch ms
  btime?: number        // birth time if the fs provides it
  atime?: number        // last access, epoch ms (absent on fast-path listings)
  mime: string          // e.g. 'text/plain', 'inode/directory'
  /** human type name from shared-mime-info ("PNG image"); falls back to '<EXT> File' */
  typeLabel?: string
  /** freedesktop icon names, best-first (renderer resolves via liqicon://) */
  icons: string[]
  hidden: boolean
  /** lowercase extension without dot, '' for none/dirs */
  ext: string
  /** entry is on a network mount (affects thumbnails/polling) */
  remote?: boolean
  writable?: boolean
  // trash view extras
  trashOrigPath?: string
  trashDeletedAt?: number
  /** computer:// only: which of Explorer's This PC sections this row belongs to
   *  ("Folders", "Devices and drives", "Network locations"). Set by the
   *  renderer when it builds the virtual listing; grouping uses it directly
   *  instead of deriving a bucket, because these sections are editorial rather
   *  than computed from any field. */
  section?: string
  /** 0..5 stars; absent/0 = unrated. Filled from the ratings index during
   *  listing (a Map lookup — never an xattr read, which would cost an SMB
   *  round-trip per file on a share). */
  rating?: number
}

export interface DirChunk {
  reqId: number
  path: string
  entries: FileEntry[]
  /** true on the final chunk */
  done: boolean
  /** set with done when enumeration failed */
  error?: string
  errorCode?: 'ENOENT' | 'EACCES' | 'ENOTDIR' | 'TIMEOUT' | 'OTHER'
}

export interface ListOptions {
  showHidden: boolean
  /** directories only (nav tree) */
  dirsOnly?: boolean
}

export type FsEventKind = 'changed' | 'created' | 'deleted' | 'renamed' | 'overflow'
export interface FsEvent {
  watchId: number
  path: string
  kind: FsEventKind
  /** affected entry name when known */
  name?: string
}

// ---------- navigation pane ----------

export type PlaceKind =
  | 'home' | 'user-dir' | 'pinned' | 'drive' | 'network-drive' | 'gvfs'
  | 'trash' | 'recent' | 'computer' | 'network'

export interface Place {
  id: string
  kind: PlaceKind
  label: string
  /** absolute path; for gvfs the fuse path */
  path: string
  icons: string[]
  /** drives only */
  capacity?: { total: number; free: number }
  ejectable?: boolean
  pinned?: boolean
}

// ---------- file operations ----------

export type OpKind = 'copy' | 'move' | 'trash' | 'delete' | 'rename' | 'mkdir'
  | 'mkfile' | 'restoreTrash' | 'emptyTrash' | 'compress' | 'extract' | 'symlink'

export interface OpRequest {
  kind: OpKind
  sources: string[]
  /** destination directory (copy/move/extract/compress) or full new path (rename/mkdir/mkfile) */
  dest?: string
  /** compress: archive format */
  format?: 'zip' | 'tar.gz' | '7z'
  /** extract: 'auto' applies single-root policy (one top-level entry extracts
   *  in place, several get wrapped), 'named' always makes <archive>/, 'to'
   *  uses dest verbatim ("Extract All...") */
  extractMode?: 'auto' | 'named' | 'to'
  /** extract: password supplied up-front (e.g. remembered for this set) */
  password?: string
}

export type OpStatus = 'queued' | 'enumerating' | 'running' | 'paused'
  | 'conflict' | 'password' | 'done' | 'error' | 'cancelled'

/** An encrypted archive needs a password mid-operation (mirrors ConflictInfo). */
export interface PasswordRequest {
  opId: number
  reqId: number
  archivePath: string
  archiveName: string
  /** 1 on the first ask; higher after a wrong password */
  attempt: number
}

export interface PasswordResolution {
  opId: number
  reqId: number
  /** null = skip this archive; the engine records it as a failure */
  password: string | null
  applyToAll: boolean
}

export interface OpProgress {
  opId: number
  kind: OpKind
  status: OpStatus
  bytesDone: number
  bytesTotal: number
  itemsDone: number
  itemsTotal: number
  /** bytes/sec, smoothed */
  speed: number
  etaSec: number
  currentFile: string
  /** last ~30 speed samples for the graph */
  speedHistory: number[]
  error?: string
  /** paths that failed with per-file errors (skip-continue model) */
  failures?: { path: string; error: string }[]
  /** source-folder display name for the ops header */
  srcLabel?: string
  /** destination display name */
  destLabel?: string
  /** destination dir (copy/move/extract/compress) or full new path (rename/mkdir) */
  dest?: string
}

export interface ConflictInfo {
  opId: number
  conflictId: number
  source: { path: string; size: number; mtime: number; isDir: boolean }
  dest: { path: string; size: number; mtime: number; isDir: boolean }
}

export type ConflictChoice = 'replace' | 'skip' | 'keepBoth' | 'merge' | 'cancel'
export interface ConflictResolution {
  opId: number
  conflictId: number
  choice: ConflictChoice
  applyToAll: boolean
}

export interface UndoInfo {
  /** human label, e.g. 'Undo Move (3 items)' */
  undoLabel: string | null
  redoLabel: string | null
}

// ---------- clipboard ----------

export interface ClipboardFiles {
  op: 'cut' | 'copy'
  paths: string[]
}

// ---------- properties / apps ----------

export interface AppCandidate {
  id: string          // desktop file id, e.g. 'org.gnome.gedit.desktop'
  name: string
  icons: string[]
  isDefault: boolean
}

export interface PropertiesData {
  paths: string[]
  name: string
  dir: string
  mime: string
  typeLabel: string
  icons: string[]
  isDir: boolean
  isSymlink: boolean
  target?: string
  size: number            // immediate known size; dirs stream via props:size events
  sizeOnDisk: number
  itemCount?: { files: number; dirs: number }
  mtime: number
  ctime: number
  btime?: number
  atime: number
  owner: string
  group: string
  /** rwxrwxrwx string + octal */
  perms: { text: string; octal: string; readonly: boolean }
  /** chmod is a fiction here (CIFS) — grey out perms UI */
  permsImmutable?: boolean
  openWith?: AppCandidate[]
  capacity?: { total: number; free: number }   // drives
}

// ---------- search ----------

export interface SearchRequest {
  root: string
  query: string
  /** search file contents too (ripgrep) */
  contents: boolean
  subfolders: boolean
  showHidden: boolean
  /**
   * Skip every index and walk the tree. Slow but current — the escape hatch
   * behind the results banner when an index answered from a stale snapshot.
   */
  live?: boolean
}

/** which source actually answered a search — drives the results banner */
export type SearchSource = 'filefinder' | 'index' | 'walk'

export interface SearchChunk {
  reqId: number
  entries: FileEntry[]
  done: boolean
  error?: string
  /** set on the final chunk: results were capped, so this is not the whole answer */
  truncated?: boolean
  /** set on the final chunk */
  source?: SearchSource
  /** final chunk, FileFinder only: how stale the server index is, in hours */
  indexAgeHours?: number
}

// ---------- per-folder view state & settings ----------

export interface ColumnSpec {
  key: SortKey
  width: number
}

export interface FolderViewState {
  mode: ViewMode
  sortKey: SortKey
  sortDir: SortDir
  groupKey: GroupKey
  groupDir: SortDir
  columns: ColumnSpec[]
  iconSize?: number
  /** show only items rated this many stars and up; 0/absent = show everything.
   *  Lives here so it persists per folder and rides setViewState's existing
   *  recompute — sortEntries applies it (see shared/sort.ts). */
  minRating?: number
}

/** file kinds the floating media viewer can take over from the default app */
export type MediaViewerKind = 'image' | 'video' | 'audio' | 'pdf' | 'text'

export interface AppSettings {
  /** which settings migrations have run (main/state/migrations.ts). Absent or 0
   *  means a profile written before migrations existed. */
  settingsVersion?: number
  theme: 'system' | 'light' | 'dark'
  showHidden: boolean
  showExtensions: boolean
  showStatusBar: boolean
  showNavPane: boolean
  showDetailsPane: boolean
  showPreviewPane: boolean
  compactView: boolean
  checkboxes: boolean
  singleClickOpen: boolean
  foldersFirst: boolean
  defaultView: FolderViewState
  navExpandToCurrent: boolean
  /** 'home' = the Home page (home://), 'homeFolder' = ~, 'lastSession', or a path */
  openTo: 'home' | 'homeFolder' | 'lastSession' | string
  confirmDelete: boolean          // for permanent delete
  confirmTrash: boolean           // Windows default: off
  /** ask before a drag-and-drop move/copy actually runs (Windows: never asks,
   *  which is how files get moved by accident) */
  confirmDrop: boolean
  /** ask before moving items with cut/paste across folders */
  confirmMove: boolean
  /** Safe mode: ask only when a move looks like an accident — a system folder,
   *  a whole drive, your home or a hidden settings folder is involved, or the
   *  operation covers an unusually large number of items at once. */
  safeMode: boolean
  /** item count at which safe mode speaks up (0 = never on count alone) */
  safeModeBulk: number
  /** keep a durable log of file operations (Activity history) */
  historyEnabled: boolean
  rememberPerFolder: boolean
  // --- smart view (folder-content-driven view mode) ---
  /** pick the view mode from what the folder contains (Windows: folder templates) */
  smartView: boolean
  /** share of files one category must reach before it wins, 0..1 */
  smartViewThreshold: number
  /** per content kind: which view mode, and whether to open the preview pane */
  smartViewRules: SmartViewRules
  /** generate thumbnails for files on network mounts. Nemo defaults this OFF,
   *  but measured here a video thumbnail off the SMB share takes ~0.1s
   *  (ffmpegthumbnailer seeks rather than reading the file) and 60 uncached
   *  mixed media filled in 1.8s — and this user's media lives on the share,
   *  so it ships on with a setting to turn it off. */
  thumbnailsRemote: boolean
  // --- live (animated) previews in the icon/tile views ---
  /** 'hover' plays the tile under the pointer, 'always' plays every tile that
   *  is actually on screen. Nothing plays in details/list/small: those show a
   *  16px icon, not a thumbnail. */
  liveMedia: 'off' | 'hover' | 'always'
  /** moving the pointer left/right across a tile seeks through the video */
  liveMediaScrub: boolean
  /** animate GIF/WebP/APNG by overlaying the real file (no decoder involved) */
  liveMediaAnimated: boolean
  /** stand down entirely while the desktop asks for reduced motion */
  liveMediaReduceMotion: boolean
  /** hard cap on <video> elements alive at once (animated images get 2x this) */
  liveMediaMax: number
  // --- floating media viewer (renderer: media/overlay.ts) ---
  /** double-click shows media in the floating in-app viewer instead of handing
   *  the file straight to the desktop's default application */
  mediaViewer: boolean
  /** which kinds the viewer claims. Anything not listed keeps opening in its
   *  own app. ALL media kinds are claimed by default, video included: anything
   *  Chromium cannot decode is streamed through ffmpeg instead
   *  (main/platform/transcode.ts), so opening a file here no longer risks the
   *  dead-play-button panel that made video opt-in for a while. Untick a kind
   *  to hand it back to the desktop's own application. */
  mediaViewerKinds: MediaViewerKind[]
  /** start playing video/audio as soon as the viewer opens */
  mediaViewerAutoplay: boolean
  /** frosted translucent panel. backdrop-filter is the expensive part of the
   *  effect on a machine with no GPU acceleration, hence the switch. */
  mediaViewerTranslucent: boolean
  /** plain mouse wheel moves between photos. Ctrl+wheel always zooms, and a
   *  zoomed-in image keeps the wheel for zoom so an overshoot cannot navigate
   *  away mid-gesture. */
  mediaViewerWheelNav: boolean
  /** flip the wheel direction */
  mediaViewerWheelInvert: boolean
  /** After streaming a video Chromium cannot decode, convert it properly in the
   *  background so seeking becomes instant (measured 58-97 ms against 368-409 ms
   *  on the live stream). Costs disk: the cache is capped at 20 GB and files
   *  over 4 GB are never converted. Off leaves everything on the live stream,
   *  which already plays. */
  mediaTranscodeCache: boolean
  /** show the storyboard frame + timestamp when hovering the scrub bar */
  mediaSeekPreview: boolean
  /** remember where you were up to in long videos */
  mediaResume: boolean
  /** play the next item in the folder when one finishes */
  mediaAutoAdvance: boolean
  /** frames in the scene-select grid (G) */
  mediaSheetFrames: number
  /** tallest picture the transcoder will produce; lower is faster and smaller */
  mediaMaxHeight: number
  /** turn on the first text subtitle track automatically when one exists */
  subtitleAutoEnable: boolean
  /** how many neighbouring photos to decode ahead in the viewer */
  preloadNeighbours: number
  // --- presentation ---
  /** lines of filename shown under an unselected icon before it ellipsises */
  gridLabelLines: number
  /** 1 KB = 1000 bytes (decimal, like Explorer) or 1024 (binary) */
  sizeUnits: 'decimal' | 'binary'
  // --- peek popover (renderer: views/peek.ts) ---
  /** open a peek when the pointer rests on an item. Off still leaves Space,
   *  which is the shortcut people who dislike hover surfaces actually want. */
  hoverPeek: boolean
  /** dwell before a hover peek opens, ms (clamped to PEEK.min/maxDelayMs) */
  peekDelayMs: number
  // --- Home page (Win11 Folder Options > Privacy) ---
  showRecent: boolean             // list recent files on Home
  showFrequent: boolean           // auto-promote frequently used folders into Quick access
  // --- search index (all opt-in; plocate cannot cover the CIFS share) ---
  indexEnabled: boolean
  /** folders to index; empty = home only */
  indexRoots: string[]
  /** glob-ish substrings to skip (node_modules, .git, .cache ...) */
  indexExcludes: string[]
  indexHidden: boolean
  /** use the index for search when it covers the searched folder */
  searchUseIndex: boolean
  /** re-scan interval in minutes; 0 = only on demand */
  indexRefreshMins: number
  // --- FileFinder: an index served by a server on the LAN (opt-in, off by
  // default — this ships publicly and nobody else has one of these) ---
  filefinderEnabled: boolean
  /** base URL of the FileFinder service, e.g. http://127.0.0.1:8090 */
  filefinderUrl: string
  /**
   * Override the server-path -> local-mount mapping, '<server root>=<local mount>'
   * per entry. Empty = derive it from /proc/mounts by share name, which is right
   * whenever the shares are mounted under their own names.
   */
  filefinderMounts: string[]
}

export const DEFAULT_VIEW_STATE: FolderViewState = {
  mode: 'details',
  sortKey: 'name',
  sortDir: 'asc',
  groupKey: 'none',
  groupDir: 'asc',
  columns: [
    { key: 'name', width: 300 },
    { key: 'mtime', width: 160 },
    { key: 'type', width: 140 },
    { key: 'size', width: 100 },
  ],
}

export const DEFAULT_SETTINGS: AppSettings = {
  theme: 'system',
  showHidden: false,
  showExtensions: true,
  showStatusBar: true,
  showNavPane: true,
  showDetailsPane: false,
  showPreviewPane: false,
  compactView: false,
  checkboxes: false,
  singleClickOpen: false,
  foldersFirst: true,
  defaultView: DEFAULT_VIEW_STATE,
  navExpandToCurrent: true,
  openTo: 'home',
  confirmDelete: true,
  confirmTrash: false,
  confirmDrop: false,
  confirmMove: false,
  safeMode: true,
  safeModeBulk: 100,
  historyEnabled: true,
  rememberPerFolder: true,
  thumbnailsRemote: true,
  // Hover-to-play rather than 'always': sweeping the pointer over a folder of
  // 200 clips must not put 200 decoders on a CIFS share. 10 concurrent players
  // is the measured knee on a typical desktop (see views/livemedia.ts).
  liveMedia: 'hover',
  liveMediaScrub: true,
  liveMediaAnimated: true,
  liveMediaReduceMotion: true,
  liveMediaMax: 10,
  smartView: true,
  smartViewThreshold: 0.6,
  smartViewRules: DEFAULT_SMART_RULES,
  mediaViewer: true,
  mediaViewerKinds: ['image', 'video', 'audio', 'pdf', 'text'],
  mediaViewerAutoplay: true,
  mediaViewerTranslucent: true,
  mediaViewerWheelNav: true,
  mediaViewerWheelInvert: false,
  mediaTranscodeCache: true,
  mediaSeekPreview: true,
  mediaResume: true,
  mediaAutoAdvance: true,
  mediaSheetFrames: 12,
  mediaMaxHeight: 720,
  subtitleAutoEnable: false,
  preloadNeighbours: 2,
  gridLabelLines: 2,
  sizeUnits: 'decimal',
  hoverPeek: true,
  // 1.4 s: long enough that crossing a list never flashes popovers, short
  // enough that resting on a folder feels like it answered you
  peekDelayMs: 1400,
  showRecent: true,
  showFrequent: true,
  indexEnabled: false,
  indexRoots: [],
  indexExcludes: ['/node_modules/', '/.git/', '/.cache/', '/.local/share/Trash/'],
  indexHidden: false,
  searchUseIndex: true,
  indexRefreshMins: 60,
  // Off by default: a file manager that talks to the network on every keystroke
  // is a change in character, and this only helps someone who runs a FileFinder
  // server. The URL is prefilled with the one this was developed against, so
  // turning the checkbox on is the whole setup for that machine.
  filefinderEnabled: false,
  filefinderUrl: 'http://127.0.0.1:8090',
  filefinderMounts: [],
}

// ---------- misc ----------

export interface DriveDetail {
  device: string
  fsType: string
  mountPoint: string
  label: string
  total: number
  free: number
  isNetwork: boolean
  isRemovable: boolean
}

/** Sort comparator contract: natural sort, case-insensitive, digit runs numeric. */
export const VIRTUAL_SCHEMES = ['home://', 'trash://', 'computer://', 'search://', 'archive://', 'finder://'] as const

/** archive://<absolute archive path>!/<inner path> — Explorer's zip-as-folder */
export const ARCHIVE_SCHEME = 'archive://'

/**
 * The whole server index as a destination. Deliberately NOT a listing: it has no
 * contents of its own, only search results, which is why it is its own scheme
 * rather than the declared-but-unused search:// (shared/session.ts drops that one
 * from a restored session on purpose — correct for a result set, wrong for a
 * place you navigated to).
 */
export const FINDER_URI = 'finder://'

// ---------- Home page (Quick access / Favorites / Recent) ----------

/** A user-favorited file or folder. Folders also appear in Quick access. */
export interface FavoriteEntry {
  path: string
  /** display name (defaults to basename, user-renamable later) */
  name: string
  isDir: boolean
  addedAt: number
}

/** An entry from ~/.local/share/recently-used.xbel (shared with Nemo/GTK). */
export interface RecentEntry {
  path: string
  name: string
  mime: string
  /** epoch ms of the last visit */
  visitedAt: number
  /** parent folder, for the "Folder path" column */
  dir: string
}

// ---------- search index ----------

export type IndexState = 'off' | 'idle' | 'scanning' | 'ready' | 'error'

export interface IndexStatus {
  state: IndexState
  /** roots currently covered by the index */
  roots: string[]
  files: number
  dirs: number
  /** epoch ms of the last completed build */
  lastBuilt: number
  /** on-disk size of the index database */
  dbBytes: number
  /** live scan progress (present while state === 'scanning') */
  scanning?: { root: string; seen: number }
  error?: string
}
