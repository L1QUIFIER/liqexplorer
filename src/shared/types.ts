// Shared data types — the single vocabulary for main, preload and renderer.
// Everything crossing IPC must be plain JSON-serializable data.

export type ViewMode =
  | 'extra-large' | 'large' | 'medium' | 'small'   // icon grids (256/96/48/16 base)
  | 'list' | 'details' | 'tiles' | 'content'

export type SortKey =
  | 'name' | 'mtime' | 'ctime' | 'atime' | 'type' | 'size' | 'ext'
  | 'dateTaken' | 'dimensions' | 'duration' | 'origPath' | 'deletedAt'

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
  mime: string          // e.g. 'text/plain', 'inode/directory'
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
}

export type OpStatus = 'queued' | 'enumerating' | 'running' | 'paused'
  | 'conflict' | 'done' | 'error' | 'cancelled'

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
}

export interface SearchChunk {
  reqId: number
  entries: FileEntry[]
  done: boolean
  error?: string
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
}

export interface AppSettings {
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
  openTo: 'home' | 'lastSession' | string
  confirmDelete: boolean          // for permanent delete
  confirmTrash: boolean           // Windows default: off
  rememberPerFolder: boolean
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
  rememberPerFolder: true,
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
export const VIRTUAL_SCHEMES = ['trash://', 'computer://', 'search://'] as const
