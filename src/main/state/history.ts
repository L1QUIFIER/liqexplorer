// Activity history — a durable record of what the app did to the user's files.
//
// The undo stack answers "put that back" but only while the app is open and
// only 20 deep. This answers a different question: "what did I actually do to
// these files?" — after a mis-drag is noticed an hour later, or the next day.
// It is append-only, capped, and never holds file CONTENT, just what happened.
import * as fs from 'node:fs'
import * as fsp from 'node:fs/promises'
import * as path from 'node:path'
import { ipcMain } from 'electron'
import { CH } from '../../shared/ipc'
import { STATE_DIR, getSettings } from './settings'
import type { HistoryEntry } from '../../shared/history'

const FILE = () => path.join(STATE_DIR, 'history.jsonl')
/** keep the file small enough to read in one go */
const MAX_ENTRIES = 1000
const TRIM_AT = 1400

let writing: Promise<void> = Promise.resolve()

export function record(entry: Omit<HistoryEntry, 'at'>): void {
  // read the live setting rather than caching a flag: turning history off in
  // Options must stop the very next operation from being written
  if (!getSettings().historyEnabled) return
  const line = JSON.stringify({ ...entry, at: Date.now() }) + '\n'
  // serialize appends so two ops finishing together cannot interleave a line
  writing = writing.then(async () => {
    try {
      await fsp.mkdir(STATE_DIR, { recursive: true })
      await fsp.appendFile(FILE(), line, 'utf8')
      await trimIfHuge()
    } catch { /* history is a convenience: never fail an operation over it */ }
  }).catch(() => {})
}

async function trimIfHuge(): Promise<void> {
  let txt: string
  try { txt = await fsp.readFile(FILE(), 'utf8') } catch { return }
  const lines = txt.split('\n').filter(Boolean)
  if (lines.length <= TRIM_AT) return
  const keep = lines.slice(-MAX_ENTRIES).join('\n') + '\n'
  const tmp = FILE() + `.tmp-${process.pid}`
  await fsp.writeFile(tmp, keep, 'utf8')
  await fsp.rename(tmp, FILE())
}

export function list(limit = 300): HistoryEntry[] {
  let txt: string
  try { txt = fs.readFileSync(FILE(), 'utf8') } catch { return [] }
  const out: HistoryEntry[] = []
  const lines = txt.split('\n')
  for (let i = lines.length - 1; i >= 0 && out.length < limit; i--) {
    const l = lines[i].trim()
    if (!l) continue
    try { out.push(JSON.parse(l) as HistoryEntry) } catch { /* torn line */ }
  }
  return out                        // newest first
}

export async function clear(): Promise<void> {
  try { await fsp.rm(FILE(), { force: true }) } catch { /* already gone */ }
}

ipcMain.handle(CH('listHistory'), (_e, limit?: number) => list(limit ?? 300))
ipcMain.handle(CH('clearHistory'), () => clear())
