import { app, BrowserWindow, nativeImage, nativeTheme } from 'electron'
import * as path from 'node:path'
import { pathToFileURL } from 'node:url'
import { PUSH } from '../shared/ipc'

const windows = new Set<BrowserWindow>()

export function allWindows(): BrowserWindow[] { return [...windows] }

export function windowForPath(_p: string): BrowserWindow | undefined {
  return [...windows][0]
}

export function broadcast(channel: string, payload: unknown): void {
  for (const w of windows) if (!w.isDestroyed()) w.webContents.send(channel, payload)
}

export interface OpenRequest {
  open?: string
  select?: string
  properties?: boolean
  /** file-picker mode: this window is answering another application's file
   *  dialog request, so it grows an accept/cancel bar and never restores the
   *  saved session. See main/pick.ts. */
  pick?: boolean
}

export function createWindow(request?: string | OpenRequest): BrowserWindow {
  const req: OpenRequest = typeof request === 'string' ? { open: request } : (request ?? {})
  const dark = nativeTheme.shouldUseDarkColors
  const win = new BrowserWindow({
    width: 1180,
    height: 740,
    minWidth: 480,
    minHeight: 320,
    frame: false,                      // Win11 chrome is custom-drawn
    backgroundColor: dark ? '#202020' : '#f3f3f3',  // no white flash in dark mode
    show: false,
    // taskbar / alt-tab / window list icon.
    // __dirname is dist/main after bundling; getAppPath() is the project root
    icon: path.join(app.getAppPath(), 'assets', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      sandbox: false,
      spellcheck: false,
    },
  })
  windows.add(win)
  // The BrowserWindow `icon` option alone does not populate _NET_WM_ICON on
  // X11 (verified with xprop), so set it explicitly — this is what puts the
  // real icon in alt-tab and the window list. The .desktop Icon= entry covers
  // the launcher/taskbar separately, matched by WM_CLASS 'liqexplorer'.
  const iconImg = nativeImage.createFromPath(path.join(app.getAppPath(), 'assets', 'icon.png'))
  if (!iconImg.isEmpty()) win.setIcon(iconImg)
  // The renderer must never navigate away from the app page: a file dropped on
  // an unhandled surface would otherwise load that file with window.liq attached.
  const appUrl = pathToFileURL(path.join(__dirname, '../renderer/index.html')).href
  win.webContents.on('will-navigate', (e, target) => {
    if (target.split(/[?#]/)[0] !== appUrl) e.preventDefault()
  })
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  win.on('closed', () => windows.delete(win))
  win.once('ready-to-show', () => win.show())

  // Renderer console -> the run log.
  //
  // Without this the window's own errors are visible only in devtools, which is
  // exactly where nobody is looking when the app has frozen on launch. Warnings
  // and errors only: routine logging would bury the thing worth finding.
  win.webContents.on('console-message', (_e, level, message, line, sourceId) => {
    if (level < 2) return                       // 0 verbose, 1 info, 2 warning, 3 error
    const where = sourceId ? ` (${sourceId.split('/').pop()}:${line})` : ''
    console.warn(`[renderer] ${message}${where}`)
  })
  const send = () => !win.isDestroyed() &&
    win.webContents.send(PUSH.windowState, { maximized: win.isMaximized() })
  win.on('maximize', send)
  win.on('unmaximize', send)

  win.loadFile(path.join(__dirname, '../renderer/index.html'), {
    query: {
      ...(req.open ? { open: req.open } : {}),
      // the item to highlight once that folder has listed, and whether to go
      // straight to its properties (FileManager1's ShowItemProperties)
      ...(req.select ? { select: req.select } : {}),
      ...(req.properties ? { properties: '1' } : {}),
      ...(req.pick ? { pick: '1' } : {}),
    },
  })
  return win
}
