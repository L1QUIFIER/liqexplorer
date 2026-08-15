// DROP BINS configuration + Stack contents.
//
// Stored as JSON in the app state dir (state/settings.ts owns its location, so
// LIQEXPLORER_TEST isolates this exactly like settings/favorites do) — NEVER
// beside the code, which lives on a CIFS share shared with Windows.
//
// Writes are atomic: temp file -> fsync -> rename. Without the fsync an unclean
// shutdown can leave a zero-length dropbins.json behind the renamed name, which
// would silently wipe the user's bin layout AND their collected Stack.
//
// Every window gets BINS_CHANGED after a write, so a second window's tray and
// Stack badge stay in step.
import { ipcMain } from 'electron'
import * as fsp from 'node:fs/promises'
import * as path from 'node:path'
import { CH } from '../../shared/ipc'
import { BINS_CHANGED, defaultBinsConfig, type BinsConfig } from '../../shared/bins'
import { STATE_DIR } from './settings'
import { broadcast } from '../windows'

const FILE = path.join(STATE_DIR, 'dropbins.json')
/** Refuse to load an absurd Stack: a runaway writer must not make the tray unusable. */
const STACK_CAP = 2000

let cache: BinsConfig | null = null
let tmpCounter = 0

function sanitize(raw: unknown): BinsConfig {
  const def = defaultBinsConfig()
  if (!raw || typeof raw !== 'object') return def
  const r = raw as Partial<BinsConfig>
  const bins = Array.isArray(r.bins)
    ? r.bins.filter(b => !!b && typeof b === 'object' && typeof b.id === 'string' && typeof b.action === 'string')
    : def.bins
  const stack = Array.isArray(r.stack)
    ? [...new Set(r.stack.filter(p => typeof p === 'string' && p.startsWith('/')))].slice(0, STACK_CAP)
    : []
  return {
    version: 1,
    pinned: r.pinned === true,
    // an empty bins array would leave a dock with nothing in it and no way back
    bins: bins.length ? bins : def.bins,
    stack,
    clearStackAfterUse: r.clearStackAfterUse !== false,
  }
}

export async function load(): Promise<BinsConfig> {
  if (cache) return cache
  try {
    cache = sanitize(JSON.parse(await fsp.readFile(FILE, 'utf8')))
  } catch {
    cache = defaultBinsConfig()
  }
  return cache
}

async function writeAtomic(txt: string): Promise<void> {
  await fsp.mkdir(STATE_DIR, { recursive: true })
  const tmp = `${FILE}.liqtmp-${process.pid}-${tmpCounter++}`
  try {
    const fh = await fsp.open(tmp, 'w', 0o600)
    try {
      await fh.writeFile(txt, 'utf8')
      await fh.sync()
    } finally {
      await fh.close()
    }
    await fsp.rename(tmp, FILE)
  } catch (err) {
    await fsp.unlink(tmp).catch(() => {})
    throw err
  }
}

export async function save(patch: Partial<BinsConfig>): Promise<BinsConfig> {
  const cur = await load()
  cache = sanitize({ ...cur, ...patch })
  await writeAtomic(JSON.stringify(cache, null, 2))
  broadcast(BINS_CHANGED, cache)
  return cache
}

// ------------------------------------------------------- self-registered IPC

ipcMain.handle(CH('binsGet'), () => load())
ipcMain.handle(CH('binsSet'), (_e, patch: Partial<BinsConfig>) => save(patch))

// ------------------------------------------------------------- custom icons
//
// A bin can show a picture the user chose. The file is COPIED into the profile
// rather than referenced where it sits: a tile that goes blank because the
// original was moved or the drive was unplugged is worse than no custom icon,
// and this is a 20KB copy, once.

const ICON_DIR = path.join(STATE_DIR, 'binicons')

/** the magic bytes of the formats Chromium will actually draw in a tile */
function imageKind(buf: Buffer): string {
  if (buf.length > 8 && buf[0] === 0x89 && buf[1] === 0x50) return 'png'
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8) return 'jpg'
  if (buf.length > 12 && buf.subarray(0, 4).toString() === 'RIFF' && buf.subarray(8, 12).toString() === 'WEBP') return 'webp'
  if (buf.length > 4 && buf.subarray(0, 5).toString('utf8').toLowerCase() === '<?xml') return 'svg'
  if (buf.subarray(0, 200).toString('utf8').toLowerCase().includes('<svg')) return 'svg'
  if (buf.length > 6 && buf.subarray(0, 6).toString() === 'GIF89a') return 'gif'
  if (buf.length > 6 && buf.subarray(0, 6).toString() === 'GIF87a') return 'gif'
  return ''
}

export function binIconsDir(): string { return ICON_DIR }

/**
 * Copy an image into the profile and return the name to store on the bin.
 *
 * The extension is decided by the BYTES, not by the name it arrived with: a
 * .png that is really an HTML error page would otherwise be stored as a png and
 * silently fail to draw, which looks like the feature is broken.
 */
export async function importBinIcon(src: string, binId: string): Promise<{ ok: boolean; value?: string; error?: string }> {
  if (!src || !src.startsWith('/')) return { ok: false, error: 'Not a file on this computer.' }
  try {
    const st = await fsp.stat(src)
    if (!st.isFile()) return { ok: false, error: 'That is not a file.' }
    if (st.size > 4 * 1024 * 1024) return { ok: false, error: 'That image is larger than 4 MB.' }
    const buf = await fsp.readFile(src)
    const kind = imageKind(buf)
    if (!kind) return { ok: false, error: 'That is not an image this can draw (PNG, JPEG, WebP, GIF or SVG).' }
    await fsp.mkdir(ICON_DIR, { recursive: true })
    // the bin id keeps one icon per bin, so replacing an icon does not leave
    // the old file behind for ever
    const safeId = binId.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 60) || 'bin'
    for (const old of await fsp.readdir(ICON_DIR).catch(() => [])) {
      if (old.startsWith(safeId + '.')) await fsp.rm(path.join(ICON_DIR, old), { force: true }).catch(() => {})
    }
    const name = `${safeId}.${kind}`
    await fsp.writeFile(path.join(ICON_DIR, name), buf)
    return { ok: true, value: name }
  } catch (e) {
    return { ok: false, error: String((e as Error)?.message ?? e) }
  }
}

ipcMain.handle(CH('binIconsDir'), () => ICON_DIR)
ipcMain.handle(CH('binIconImport'), (_e, src: string, binId: string) => importBinIcon(src, binId))
ipcMain.handle(CH('binIconPick'), async (e) => {
  const { BrowserWindow, dialog } = require('electron') as typeof import('electron')
  const win = BrowserWindow.fromWebContents(e.sender)
  const r = await dialog.showOpenDialog(win!, {
    title: 'Choose a picture for this bin',
    properties: ['openFile'],
    filters: [{ name: 'Pictures', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'svg'] }],
  })
  return r.canceled ? [] : r.filePaths
})
