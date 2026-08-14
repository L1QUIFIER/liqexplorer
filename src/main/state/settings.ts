// Global settings store: JSON in ~/.local/state/liqexplorer/settings.json
import * as fs from 'node:fs'
import * as fsp from 'node:fs/promises'
import * as path from 'node:path'
import * as os from 'node:os'
import { DEFAULT_SETTINGS, type AppSettings } from '../../shared/types'

const STATE_DIR = path.join(os.homedir(), '.local/state/liqexplorer')
const FILE = path.join(STATE_DIR, 'settings.json')
let cache: AppSettings = { ...DEFAULT_SETTINGS }

export async function loadSettings(): Promise<AppSettings> {
  try {
    cache = { ...DEFAULT_SETTINGS, ...JSON.parse(await fsp.readFile(FILE, 'utf8')) }
  } catch { cache = { ...DEFAULT_SETTINGS } }
  return cache
}

export function getSettings(): AppSettings { return cache }

export async function patchSettings(patch: Partial<AppSettings>): Promise<AppSettings> {
  cache = { ...cache, ...patch }
  await fsp.mkdir(STATE_DIR, { recursive: true })
  const tmp = FILE + '.tmp'
  await fsp.writeFile(tmp, JSON.stringify(cache, null, 2))
  await fsp.rename(tmp, FILE)
  return cache
}

export function stateDir(): string {
  fs.mkdirSync(STATE_DIR, { recursive: true })
  return STATE_DIR
}
