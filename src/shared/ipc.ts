// IPC contract. Renderer calls main via `window.liq.<method>` (see preload.ts).
// Streaming/push data arrives on PUSH channels via `window.liq.on(channel, cb)`.
//
// Channel naming: invoke channels are 'liq:<area>.<method>'; push channels 'liqpush:<name>'.
// Adding a method = add it to LiqApi + wire it in preload.ts + handle it in main/ipc.ts.

import type {
  AppCandidate, AppSettings, ClipboardFiles, ConflictResolution, DirChunk,
  DriveDetail, FileEntry, FolderViewState, FsEvent, ListOptions, OpProgress,
  ConflictInfo, OpRequest, Place, PropertiesData, SearchChunk, SearchRequest, UndoInfo,
} from './types'

/** Push channels (main -> renderer). */
export const PUSH = {
  dirChunk: 'liqpush:dir-chunk',            // DirChunk
  fsEvent: 'liqpush:fs-event',              // FsEvent
  placesChanged: 'liqpush:places-changed',  // Place[]
  opProgress: 'liqpush:op-progress',        // OpProgress
  opConflict: 'liqpush:op-conflict',        // ConflictInfo
  undoChanged: 'liqpush:undo-changed',      // UndoInfo
  clipboardChanged: 'liqpush:clipboard-changed', // ClipboardFiles | null
  searchChunk: 'liqpush:search-chunk',      // SearchChunk
  propsSize: 'liqpush:props-size',          // { reqId, size, sizeOnDisk, files, dirs, done }
  themeChanged: 'liqpush:theme-changed',    // 'light' | 'dark'
  openPathRequest: 'liqpush:open-path',     // { path } (second instance / cli)
  windowState: 'liqpush:window-state',      // { maximized: boolean }
  favoritesChanged: 'liqpush:favorites-changed', // FavoriteEntry[]
  indexStatus: 'liqpush:index-status',      // IndexStatus
  opPassword: 'liqpush:op-password',        // PasswordRequest
} as const

/** The API surface preload exposes as window.liq */
export interface LiqApi {
  // --- directory listing (streams DirChunk on PUSH.dirChunk) ---
  listDir(path: string, opts: ListOptions): Promise<number>       // reqId
  cancelList(reqId: number): Promise<void>
  /** cheap dirs-only listing for the nav tree (returns directly, no streaming) */
  listChildDirs(path: string, showHidden: boolean): Promise<FileEntry[]>
  statEntries(paths: string[]): Promise<(FileEntry | null)[]>
  pathExists(path: string): Promise<boolean>
  homeDir(): Promise<string>
  userDirs(): Promise<Record<string, string>>                     // DESKTOP, DOWNLOAD, ...

  // --- watching ---
  watchDir(path: string): Promise<number>                         // watchId; events on PUSH.fsEvent
  unwatchDir(watchId: number): Promise<void>

  // --- places / drives ---
  getPlaces(): Promise<Place[]>
  getDriveDetails(): Promise<DriveDetail[]>
  pinPlace(path: string): Promise<void>
  unpinPlace(path: string): Promise<void>
  ejectDrive(placeId: string): Promise<{ ok: boolean; error?: string }>

  // --- file operations ---
  startOp(req: OpRequest): Promise<number>                        // opId
  pauseOp(opId: number): Promise<void>
  resumeOp(opId: number): Promise<void>
  cancelOp(opId: number): Promise<void>
  resolveConflict(res: ConflictResolution): Promise<void>
  getOps(): Promise<OpProgress[]>
  undo(): Promise<void>
  redo(): Promise<void>
  getUndoInfo(): Promise<UndoInfo>
  /** quick sync-ish helpers that bypass the op queue */
  renameOne(oldPath: string, newName: string): Promise<{ ok: boolean; error?: string; newPath?: string }>
  newFolder(parent: string): Promise<{ ok: boolean; path?: string; error?: string }>
  newFile(parent: string, template?: string): Promise<{ ok: boolean; path?: string; error?: string }>

  // --- clipboard ---
  clipboardSet(data: ClipboardFiles): Promise<void>
  clipboardGet(): Promise<ClipboardFiles | null>
  clipboardClear(): Promise<void>
  copyTextToClipboard(text: string): Promise<void>

  // --- trash ---
  listTrash(): Promise<FileEntry[]>
  restoreTrash(paths: string[]): Promise<void>
  emptyTrash(): Promise<void>
  trashItemCount(): Promise<number>

  // --- open / apps ---
  openPath(path: string): Promise<{ ok: boolean; error?: string }>
  openWith(path: string, appId: string): Promise<void>
  listAppsFor(mime: string): Promise<AppCandidate[]>
  listAllApps(): Promise<AppCandidate[]>
  setDefaultApp(mime: string, appId: string): Promise<void>
  openTerminalAt(path: string): Promise<void>
  showProperties(paths: string[]): Promise<number>                // reqId for PUSH.propsSize
  getProperties(paths: string[]): Promise<PropertiesData>

  // --- search ---
  startSearch(req: SearchRequest): Promise<number>
  cancelSearch(reqId: number): Promise<void>

  // --- view state / settings ---
  getViewState(path: string): Promise<FolderViewState | null>
  setViewState(path: string, state: FolderViewState): Promise<void>
  applyViewStateToAll(state: FolderViewState): Promise<void>
  getSettings(): Promise<AppSettings>
  setSettings(patch: Partial<AppSettings>): Promise<AppSettings>
  getTheme(): Promise<'light' | 'dark'>

  // --- windows / native ---
  newWindow(path?: string): Promise<void>
  windowControl(action: 'minimize' | 'maximize' | 'restore' | 'close'): Promise<void>
  isMaximized(): Promise<boolean>
  startNativeDrag(paths: string[]): Promise<void>
  /** resolve dropped File objects to fs paths (called with webUtils in preload) */
  archiveList?(path: string): Promise<FileEntry[]>

  // --- events ---
  on<T = unknown>(channel: string, cb: (payload: T) => void): () => void
}

/** invoke channel name for a LiqApi method */
export const CH = (method: string) => `liq:${method}`
