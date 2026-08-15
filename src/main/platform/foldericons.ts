// Custom folder icons, the way Explorer's "Change icon…" works.
//
// Two stores are written on purpose:
//  1. Ours — a JSON map in the state dir, consulted synchronously while listing
//     a directory. Reading GIO metadata per folder would mean one `gio` call per
//     row, which is far too slow for a listing.
//  2. GIO's `metadata::custom-icon` — the same key Nemo and Nautilus read, so a
//     folder customised here looks customised in Nemo too. Written best-effort:
//     if gvfsd-metadata is unavailable the app still works from store 1.
//
// A chosen image is COPIED into the state dir. The liqicon:// handler only
// serves absolute paths under known icon roots (a deliberate restriction so a
// compromised renderer cannot read arbitrary files), and this directory is one
// of them — pointing at the user's original file would be refused.
import { execFile } from 'node:child_process'
import * as crypto from 'node:crypto'
import * as fs from 'node:fs'
import * as fsp from 'node:fs/promises'
import * as path from 'node:path'
import { ipcMain, dialog, BrowserWindow, type IpcMainInvokeEvent } from 'electron'
import { CH, PUSH } from '../../shared/ipc'
import { STATE_DIR } from '../state/settings'
import { broadcast } from '../windows'

/** where copied icon images live; also allow-listed by the liqicon handler */
export const FOLDER_ICON_DIR = path.join(STATE_DIR, 'foldericons')
const MAP_FILE = path.join(STATE_DIR, 'foldericons.json')
/** a themed icon name, or an absolute path under FOLDER_ICON_DIR */
type IconSpec = string

let map: Record<string, IconSpec> | null = null

function load(): Record<string, IconSpec> {
  if (map) return map
  try {
    const raw = fs.readFileSync(MAP_FILE, 'utf8')
    const parsed = JSON.parse(raw) as Record<string, IconSpec>
    map = parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    map = {}                       // missing or unreadable: no custom icons
  }
  return map
}

async function save(): Promise<void> {
  const data = JSON.stringify(load(), null, 1)
  await fsp.mkdir(STATE_DIR, { recursive: true })
  const tmp = `${MAP_FILE}.tmp-${process.pid}`
  await fsp.writeFile(tmp, data, 'utf8')
  await fsp.rename(tmp, MAP_FILE)
}

/** icon names for a folder, best-first — called by fs/mime.ts while listing */
export function customFolderIcon(dir: string): string | undefined {
  const hit = load()[dir.replace(/\/+$/, '') || '/']
  if (!hit) return undefined
  // a copied file may have been removed by hand; fall back to the theme icon
  if (hit.startsWith('/') && !fs.existsSync(hit)) return undefined
  return hit
}

/** mirror into GIO so Nemo/Nautilus show the same icon (best effort) */
function writeGioMetadata(dir: string, spec: IconSpec | null): void {
  const bus = process.env.DBUS_SESSION_BUS_ADDRESS
    || `unix:path=/run/user/${typeof process.getuid === 'function' ? process.getuid() : 1000}/bus`
  const env = { ...process.env, DBUS_SESSION_BUS_ADDRESS: bus }
  const args = spec === null
    ? ['set', '-t', 'unset', dir, 'metadata::custom-icon']
    : spec.startsWith('/')
      ? ['set', dir, 'metadata::custom-icon', 'file://' + spec.split('/').map(encodeURIComponent).join('/')]
      : ['set', dir, 'metadata::custom-icon-name', spec]
  execFile('gio', args, { env, timeout: 5000 }, () => { /* nemo interop is a bonus */ })
}

export async function setFolderIcon(dir: string, source: string | null): Promise<{ ok: boolean; error?: string }> {
  const key = dir.replace(/\/+$/, '') || '/'
  const m = load()
  try {
    if (source === null) {
      delete m[key]
      writeGioMetadata(key, null)
    } else if (source.startsWith('/')) {
      // copy the image in, keyed by content so the same picture is stored once
      const buf = await fsp.readFile(source)
      if (buf.length > 8 * 1024 * 1024) return { ok: false, error: 'That image is too large (8 MB maximum).' }
      const ext = (path.extname(source) || '.png').toLowerCase()
      const name = crypto.createHash('sha1').update(buf).digest('hex').slice(0, 16) + ext
      const dest = path.join(FOLDER_ICON_DIR, name)
      await fsp.mkdir(FOLDER_ICON_DIR, { recursive: true })
      if (!fs.existsSync(dest)) await fsp.writeFile(dest, buf)
      m[key] = dest
      writeGioMetadata(key, dest)
    } else {
      m[key] = source                     // a themed icon name
      writeGioMetadata(key, source)
    }
    await save()
    broadcast(PUSH.folderIconsChanged, { path: key })
    return { ok: true }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

ipcMain.handle(CH('setFolderIcon'), (_e, dir: string, source: string | null) => setFolderIcon(dir, source))
ipcMain.handle(CH('getFolderIcon'), (_e, dir: string) => customFolderIcon(dir) ?? null)

/** image picker for the Change-icon dialog */
ipcMain.handle(CH('pickImage'), async (e: IpcMainInvokeEvent) => {
  const win = BrowserWindow.fromWebContents(e.sender) ?? undefined
  const opts = {
    title: 'Choose an icon',
    filters: [{ name: 'Images', extensions: ['png', 'svg', 'jpg', 'jpeg', 'webp', 'ico', 'bmp'] }],
    properties: ['openFile' as const],
  }
  const r = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
  return r.canceled || !r.filePaths.length ? null : r.filePaths[0]
})
