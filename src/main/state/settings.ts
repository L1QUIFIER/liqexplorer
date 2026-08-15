// Global settings store: JSON in ~/.local/state/liqexplorer/settings.json
import * as fs from 'node:fs'
import * as fsp from 'node:fs/promises'
import * as path from 'node:path'
import * as os from 'node:os'
import { DEFAULT_SETTINGS, type AppSettings } from '../../shared/types'
import { migrateSettings, SETTINGS_VERSION } from './migrations'

/** Root of every persistent app-state file: settings.json, folderviews.json,
 *  favorites.json and the search index (indexer.ts / viewstate.ts / favorites.ts
 *  all hang off this). LIQEXPLORER_TEST moves it beside Electron's scratch
 *  user-data dir — without that, a test run reads AND WRITES the user's real
 *  configuration, which is what docs/TESTING.md promises it never does. */
export const TEST_PROFILE = process.env.LIQEXPLORER_TEST === '1'   // same test bin/run.sh makes

/** Root of a test run's profile. Overridable because the app takes a
 *  single-instance lock PER user-data-dir: with one fixed test path, a second
 *  test instance exits silently while the first keeps the debugging port, so
 *  the newcomer ends up driving — and asserting against — the older build.
 *  Two people (or agents) testing at once need two directories. */
export const TEST_ROOT = process.env.LIQEXPLORER_TEST_DIR
  || path.join(os.homedir(), '.cache/liqexplorer-test')

export const STATE_DIR = TEST_PROFILE
  ? path.join(TEST_ROOT, 'state')
  : path.join(os.homedir(), '.local/state/liqexplorer')
const FILE = path.join(STATE_DIR, 'settings.json')
let cache: AppSettings = { ...DEFAULT_SETTINGS }

export async function loadSettings(): Promise<AppSettings> {
  try {
    const raw = JSON.parse(await fsp.readFile(FILE, 'utf8')) as Record<string, unknown>
    // Corrections to a shipped default only reach an existing profile through a
    // migration: the merge below would otherwise keep the stored value forever.
    const changed = migrateSettings(raw)
    cache = { ...DEFAULT_SETTINGS, ...(raw as Partial<AppSettings>) }
    if (changed) await patchSettings({})    // rewrite so the migration runs once
  } catch {
    cache = { ...DEFAULT_SETTINGS, settingsVersion: SETTINGS_VERSION }
  }
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
