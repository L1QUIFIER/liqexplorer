// Per-folder view state: JSON LRU (5000 folders) in ~/.local/state/liqexplorer/folderviews.json
// AGENT C hardens: debounced writes, LRU eviction, apply-to-all template semantics.
import * as fsp from 'node:fs/promises'
import * as path from 'node:path'
import type { FolderViewState } from '../../shared/types'
import { stateDir } from './settings'

const FILE = () => path.join(stateDir(), 'folderviews.json')
let map: Record<string, FolderViewState & { _used?: number }> | null = null

async function load() {
  if (map) return map
  try { map = JSON.parse(await fsp.readFile(FILE(), 'utf8')) } catch { map = {} }
  return map!
}

let writeTimer: NodeJS.Timeout | null = null
function scheduleWrite() {
  if (writeTimer) return
  writeTimer = setTimeout(async () => {
    writeTimer = null
    const m = await load()
    const keys = Object.keys(m)
    if (keys.length > 5000) {
      keys.sort((a, b) => (m[a]._used ?? 0) - (m[b]._used ?? 0))
      for (const k of keys.slice(0, keys.length - 5000)) delete m[k]
    }
    const tmp = FILE() + '.tmp'
    await fsp.writeFile(tmp, JSON.stringify(m))
    await fsp.rename(tmp, FILE())
  }, 800)
}

export async function get(p: string): Promise<FolderViewState | null> {
  const m = await load()
  const st = m[p]
  if (st) { st._used = Date.now(); scheduleWrite() }
  return st ?? null
}

export async function set(p: string, state: FolderViewState): Promise<void> {
  const m = await load()
  m[p] = { ...state, _used: Date.now() }
  scheduleWrite()
}

export async function applyToAll(state: FolderViewState): Promise<void> {
  map = {}
  const { patchSettings } = await import('./settings')
  await patchSettings({ defaultView: state })
  scheduleWrite()
}
