import { contextBridge, ipcRenderer, webUtils } from 'electron'
import { CH } from '../shared/ipc'

// Every LiqApi method except `on` is a straight invoke passthrough.
const METHODS = [
  'listDir', 'cancelList', 'listChildDirs', 'statEntries', 'pathExists', 'homeDir', 'userDirs',
  'watchDir', 'unwatchDir',
  'getPlaces', 'getDriveDetails', 'pinPlace', 'unpinPlace', 'ejectDrive',
  'startOp', 'pauseOp', 'resumeOp', 'cancelOp', 'resolveConflict', 'getOps',
  'undo', 'redo', 'getUndoInfo', 'renameOne', 'newFolder', 'newFile',
  'clipboardSet', 'clipboardGet', 'clipboardClear', 'copyTextToClipboard',
  'listTrash', 'restoreTrash', 'emptyTrash', 'trashItemCount',
  'openPath', 'openWith', 'listAppsFor', 'listAllApps', 'setDefaultApp',
  'openTerminalAt', 'showProperties', 'getProperties',
  'startSearch', 'cancelSearch',
  'getViewState', 'setViewState', 'applyViewStateToAll',
  'getSettings', 'setSettings', 'getTheme',
  'newWindow', 'windowControl', 'isMaximized', 'startNativeDrag', 'archiveList',
] as const

const api: Record<string, unknown> = {}
for (const m of METHODS) {
  api[m] = (...args: unknown[]) => ipcRenderer.invoke(CH(m), ...args)
}

api.on = (channel: string, cb: (payload: unknown) => void) => {
  if (!channel.startsWith('liqpush:')) throw new Error('not a push channel: ' + channel)
  const listener = (_e: unknown, payload: unknown) => cb(payload)
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

/** map a DataTransfer File (external drop) to its filesystem path */
api.pathForFile = (file: File) => webUtils.getPathForFile(file)

/** generic escape hatch so modules can add IPC methods without editing this file */
api.invoke = (method: string, ...args: unknown[]) => ipcRenderer.invoke(CH(method), ...args)

contextBridge.exposeInMainWorld('liq', api)
