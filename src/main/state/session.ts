// Persisted session: which folders were open, and which tabs were pinned.
//
// Writes are debounced and atomic. The renderer calls saveSession on every
// navigation, so this would otherwise be one fsync per click; and a session
// file torn by a crash mid-write is worse than one that is a second stale,
// which is why it goes through a temp file and a rename.
import * as fs from 'node:fs'
import * as fsp from 'node:fs/promises'
import * as path from 'node:path'
import { ipcMain } from 'electron'
import { CH } from '../../shared/ipc'
import { STATE_DIR } from './settings'
import { sanitizeSession, type SessionState } from '../../shared/session'

const FILE = (): string => path.join(STATE_DIR, 'session.json')
const DEBOUNCE_MS = 800

let pending: SessionState | null = null
let timer: NodeJS.Timeout | null = null

export function read(): SessionState {
  try {
    return sanitizeSession(JSON.parse(fs.readFileSync(FILE(), 'utf8')))
  } catch {
    return sanitizeSession(null)
  }
}

async function flush(): Promise<void> {
  const s = pending
  pending = null
  timer = null
  if (!s) return
  try {
    await fsp.mkdir(STATE_DIR, { recursive: true })
    const tmp = FILE() + `.tmp-${process.pid}`
    await fsp.writeFile(tmp, JSON.stringify(s, null, 2), 'utf8')
    await fsp.rename(tmp, FILE())
  } catch { /* losing a session is a nuisance, never an error worth raising */ }
}

export function save(s: SessionState): void {
  pending = sanitizeSession(s)
  if (timer) return
  timer = setTimeout(() => { void flush() }, DEBOUNCE_MS)
  timer.unref?.()
}

/** Called on quit: the debounce must not swallow the final state. */
export function flushNow(): void {
  if (!pending) return
  const s = pending
  pending = null
  if (timer) { clearTimeout(timer); timer = null }
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true })
    const tmp = FILE() + `.tmp-${process.pid}`
    fs.writeFileSync(tmp, JSON.stringify(s, null, 2), 'utf8')
    fs.renameSync(tmp, FILE())
  } catch { /* quitting anyway */ }
}

ipcMain.handle(CH('saveSession'), (_e, s: SessionState) => { save(s) })
ipcMain.handle(CH('readSession'), () => read())
