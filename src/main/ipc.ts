// Central IPC router: every LiqApi method maps to exactly one module function.
// Module files own their domain; this file only wires.
import { ipcMain, BrowserWindow } from 'electron'
import { CH } from '../shared/ipc'
import * as fsList from './fs/list'
import * as fsWatch from './fs/watch'
import * as ops from './ops/engine'
import * as undo from './ops/undo'
import * as quick from './ops/quick'
import * as places from './platform/places'
import * as trash from './platform/trash'
import * as clipboard from './platform/clipboard'
import * as apps from './platform/apps'
import * as terminal from './platform/terminal'
import * as props from './platform/props'
import * as search from './platform/search'
import * as theme from './platform/theme'
import * as settings from './state/settings'
import * as viewstate from './state/viewstate'
import * as drag from './platform/drag'
import './platform/favorites'   // self-registers listFavorites/addFavorite/listRecent/...
import * as archive from './ops/archive'
import { createWindow } from './windows'

type Handler = (...args: any[]) => unknown

const routes: Record<string, Handler> = {
  // fs
  listDir: (e, p, opts) => fsList.startListing(sender(e), p, opts),
  cancelList: (_e, reqId) => fsList.cancelListing(reqId),
  listChildDirs: (_e, p, showHidden) => fsList.listChildDirs(p, showHidden),
  statEntries: (_e, paths) => fsList.statEntries(paths),
  pathExists: (_e, p) => fsList.pathExists(p),
  mountPoints: () => fsList.mountPoints(),
  homeDir: () => fsList.homeDir(),
  userDirs: () => fsList.userDirs(),
  watchDir: (e, p) => fsWatch.watchDir(sender(e), p),
  unwatchDir: (_e, id) => fsWatch.unwatchDir(id),
  // places
  getPlaces: () => places.getPlaces(),
  getDriveDetails: () => places.getDriveDetails(),
  pinPlace: (_e, p) => places.pinPlace(p),
  unpinPlace: (_e, p) => places.unpinPlace(p),
  ejectDrive: (_e, id) => places.ejectDrive(id),
  // ops
  startOp: (e, req) => ops.startOp(sender(e), req),
  pauseOp: (_e, id) => ops.pauseOp(id),
  resumeOp: (_e, id) => ops.resumeOp(id),
  cancelOp: (_e, id) => ops.cancelOp(id),
  resolveConflict: (_e, res) => ops.resolveConflict(res),
  getOps: () => ops.getOps(),
  undo: () => undo.doUndo(),
  redo: () => undo.doRedo(),
  getUndoInfo: () => undo.getUndoInfo(),
  renameOne: (_e, oldPath, newName) => quick.renameOne(oldPath, newName),
  newFolder: (_e, parent) => quick.newFolder(parent),
  newFile: (_e, parent, template) => quick.newFile(parent, template),
  // clipboard
  clipboardSet: (_e, data) => clipboard.setFiles(data),
  clipboardGet: () => clipboard.getFiles(),
  clipboardClear: () => clipboard.clear(),
  copyTextToClipboard: (_e, text) => clipboard.copyText(text),
  // trash
  listTrash: () => trash.listTrash(),
  restoreTrash: (_e, paths) => trash.restoreTrash(paths),
  emptyTrash: () => trash.emptyTrash(),
  trashItemCount: () => trash.itemCount(),
  // apps / open
  openPath: (_e, p) => apps.openPath(p),
  openWith: (_e, p, appId) => apps.openWith(p, appId),
  listAppsFor: (_e, mime) => apps.listAppsFor(mime),
  listAllApps: () => apps.listAllApps(),
  setDefaultApp: (_e, mime, appId) => apps.setDefaultApp(mime, appId),
  openTerminalAt: (_e, p) => terminal.openAt(p),
  showProperties: (e, paths) => props.startSizeScan(sender(e), paths),
  getProperties: (_e, paths) => props.getProperties(paths),
  // search
  startSearch: (e, req) => search.startSearch(sender(e), req),
  cancelSearch: (_e, id) => search.cancelSearch(id),
  // state
  getViewState: (_e, p) => viewstate.get(p),
  setViewState: (_e, p, st) => viewstate.set(p, st),
  applyViewStateToAll: (_e, st) => viewstate.applyToAll(st),
  getSettings: () => settings.getSettings(),
  setSettings: (_e, patch) => settings.patchSettings(patch),
  getTheme: () => theme.currentTheme(),
  // windows / native
  newWindow: (_e, p) => { createWindow(p) },
  windowControl: (e, action) => {
    const w = BrowserWindow.fromWebContents(e.sender); if (!w) return
    if (action === 'minimize') w.minimize()
    else if (action === 'maximize') w.maximize()
    else if (action === 'restore') w.unmaximize()
    else if (action === 'close') w.close()
  },
  isMaximized: (e) => BrowserWindow.fromWebContents(e.sender)?.isMaximized() ?? false,
  startNativeDrag: (e, paths) => drag.startDrag(e.sender, paths),
  // real listing from the 7z backend (apps.archiveList was a [] stub)
  archiveList: (_e, p) => archive.listArchive(p),
}

function sender(e: Electron.IpcMainInvokeEvent) { return e.sender }

export function registerIpc(): void {
  for (const [method, fn] of Object.entries(routes)) {
    ipcMain.handle(CH(method), (e, ...args) => fn(e, ...args))
  }
}
