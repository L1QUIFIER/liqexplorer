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
