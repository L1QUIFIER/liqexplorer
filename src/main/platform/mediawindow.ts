// Pop-out media window: the floating viewer's "make this a real window" button.
//
// Self-registered IPC (renderer: liq.invoke(...)), so main/ipc.ts stays
// untouched — same pattern as platform/preview.ts and ops/quick.ts:
//
//   mediaPopout(payload)          open a window showing that session
//   mediaPopoutPayload()          the new window asks for its own session
//   mediaWindowFullscreen(on)     -> the window's real fullscreen state
//
// Why a whole window rather than Element.requestFullscreen: the point of the
// pop-out is to move playback to ANOTHER MONITOR and keep browsing files in the
// main window. That needs a window the WM can manage, so this one is framed
// (the main app is frameless with custom chrome; here the OS frame is the
// feature — drag between monitors, snap, and a real fullscreen).
//
// The payload is renderer-supplied data, so it is sanitised here: absolute
// paths only, bounded item count, numbers clamped.
import { BrowserWindow, app, ipcMain, nativeTheme, screen, type IpcMainInvokeEvent } from 'electron'
import * as path from 'node:path'
import { pathToFileURL } from 'node:url'
import { CH } from '../../shared/ipc'

interface PopoutItem {
  path: string
  name: string
  ext: string
  mime: string
  size: number
}

interface PopoutPayload {
  items: PopoutItem[]
  index: number
  time: number
  playing: boolean
  volume: number
  muted: boolean
  rate: number
  /** where the floating panel was, in the sender page's CSS pixels */
  bounds?: { x: number; y: number; w: number; h: number }
  /** the pop-out page boots no app and cannot read settings, so the host
   *  stamps the wheel preferences into the hand-off */
  wheelNav?: boolean
  wheelInvert?: boolean
}

/** a folder of 50k photos would otherwise be copied across IPC in full */
const MAX_ITEMS = 5000
const MIN_W = 420
const MIN_H = 300

/** webContents id -> the session that window was opened with */
const sessions = new Map<number, PopoutPayload>()

function num(v: unknown, fallback: number, lo: number, hi: number): number {
  const n = typeof v === 'number' && Number.isFinite(v) ? v : fallback
  return Math.max(lo, Math.min(hi, n))
}

function sanitize(raw: unknown): PopoutPayload | null {
  const p = raw as Partial<PopoutPayload> | null
  if (!p || !Array.isArray(p.items)) return null
  const items: PopoutItem[] = []
  for (const it of p.items.slice(0, MAX_ITEMS)) {
    const i = it as Partial<PopoutItem>
    if (typeof i?.path !== 'string' || !i.path.startsWith('/')) continue
    items.push({
      path: i.path,
      name: typeof i.name === 'string' ? i.name : path.basename(i.path),
      ext: typeof i.ext === 'string' ? i.ext : '',
      mime: typeof i.mime === 'string' ? i.mime : '',
      size: typeof i.size === 'number' ? i.size : 0,
    })
  }
  if (!items.length) return null
  return {
    items,
    index: Math.max(0, Math.min(items.length - 1, Math.round(num(p.index, 0, 0, items.length)))),
    time: num(p.time, 0, 0, 24 * 3600),
    playing: !!p.playing,
    volume: num(p.volume, 1, 0, 1),
    muted: !!p.muted,
    rate: num(p.rate, 1, 0.25, 4),
    bounds: p.bounds && typeof p.bounds === 'object' ? p.bounds : undefined,
    // sanitize() rebuilds the object field by field, so anything not listed
    // here is silently dropped on the way through
    wheelNav: p.wheelNav !== false,
    wheelInvert: !!p.wheelInvert,
  }
}

/** Panel rect in page pixels -> screen rect, kept inside the display it lands on. */
function windowBounds(sender: Electron.WebContents, b?: PopoutPayload['bounds']): Electron.Rectangle {
  const parent = BrowserWindow.fromWebContents(sender)
  const content = parent?.getContentBounds()
  const w = Math.max(MIN_W, Math.round(b?.w ?? 900))
  const h = Math.max(MIN_H, Math.round(b?.h ?? 620))
  let x = Math.round((content?.x ?? 0) + (b?.x ?? 80))
  let y = Math.round((content?.y ?? 0) + (b?.y ?? 80))
  const area = screen.getDisplayMatching({ x, y, width: w, height: h }).workArea
  x = Math.max(area.x, Math.min(x, area.x + area.width - w))
  y = Math.max(area.y, Math.min(y, area.y + area.height - h))
  return { x, y, width: w, height: h }
}

function createPopout(sender: Electron.WebContents, payload: PopoutPayload): number {
  const bounds = windowBounds(sender, payload.bounds)
  const win = new BrowserWindow({
    ...bounds,
    minWidth: MIN_W,
    minHeight: MIN_H,
    // black, not the theme colour: a video letterboxes against it
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#0b0b0b' : '#101010',
    show: false,
    title: payload.items[payload.index]?.name ?? 'Media',
    icon: path.join(app.getAppPath(), 'assets', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      sandbox: false,
      spellcheck: false,
    },
  })
  const page = path.join(__dirname, '../renderer/media/popout.html')
  const pageUrl = pathToFileURL(page).href
  // same rule as the main window: this renderer holds window.liq, so it must
  // never be navigated to a file the user dropped or a link inside a PDF
  win.webContents.on('will-navigate', (e, target) => {
    if (target.split(/[?#]/)[0] !== pageUrl) e.preventDefault()
  })
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  sessions.set(win.webContents.id, payload)
  win.on('closed', () => sessions.delete(win.webContents.id))
  win.once('ready-to-show', () => win.show())
  void win.loadFile(page)
  return win.id
}

type Handler = (event: IpcMainInvokeEvent, ...args: any[]) => unknown

function handle(method: string, fn: Handler): void {
  try {
    ipcMain.handle(CH(method), fn)
  } catch (e) {
    // a duplicate registration must not take the main process down
    console.warn(`[mediawindow] could not register ${CH(method)}:`, (e as Error)?.message)
  }
}

let registered = false

export function registerMediaWindowIpc(): void {
  if (registered) return
  registered = true
  handle('mediaPopout', (e, raw: unknown) => {
    const payload = sanitize(raw)
    if (!payload) return 0
    return createPopout(e.sender, payload)
  })
  handle('mediaPopoutPayload', (e) => sessions.get(e.sender.id) ?? null)
  handle('mediaWindowPinned', (e, on: boolean) => {
    const win = BrowserWindow.fromWebContents(e.sender)
    if (!win) return false
    // 'screen-saver' rather than the default level: a plain always-on-top window
    // still loses to full-screen apps on some window managers, and a video you
    // pinned specifically to keep visible while you work is the one case where
    // being covered defeats the point.
    win.setAlwaysOnTop(!!on, 'screen-saver')
    return win.isAlwaysOnTop()
  })
  handle('mediaWindowFullscreen', (e, on: boolean) => {
    const win = BrowserWindow.fromWebContents(e.sender)
    if (!win) return false
    win.setFullScreen(!!on)
    return win.isFullScreen()
  })
}

registerMediaWindowIpc()
