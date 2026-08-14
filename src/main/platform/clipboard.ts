// File clipboard with real X11 interop.
//
// Copy/cut owns the CLIPBOARD selection through helpers/clipboard-owner.py
// (python3 + GTK3), offering x-special/gnome-copied-files,
// x-special/mate-copied-files, application/x-kde-cutselection, text/uri-list
// and text targets — so Nemo/Caja/Dolphin paste our files and vice versa.
// The helper prints OWNED when ready and LOST when another app takes the
// clipboard (then we re-read the external clipboard and broadcast).
// Paste reads through the same helper in --read mode.

import { app, clipboard } from 'electron'
import { execFile, spawn, type ChildProcess } from 'node:child_process'
import * as path from 'node:path'
import type { ClipboardFiles } from '../../shared/types'
import { broadcast } from '../windows'
import { PUSH } from '../../shared/ipc'

let state: ClipboardFiles | null = null
let helper: ChildProcess | null = null

/** short-lived cache of external clipboard reads (context menus poll this) */
let extCache: { value: ClipboardFiles | null; at: number } | null = null

function helperPath(): string {
  return path.join(app.getAppPath(), 'helpers', 'clipboard-owner.py')
}

/** GTK in the helper must not stall on the a11y bus handshake */
function helperEnv(): NodeJS.ProcessEnv {
  return { ...process.env, NO_AT_BRIDGE: '1' }
}

export function initClipboard(): void {
  app.on('will-quit', () => { killHelper() })
}

function killHelper(): void {
  if (helper) {
    try { helper.kill() } catch { /* already gone */ }
    helper = null
  }
}

function readExternal(): Promise<ClipboardFiles | null> {
  const now = Date.now()
  if (extCache && now - extCache.at < 1000) return Promise.resolve(extCache.value)
  return new Promise(resolve => {
    // generous: python+GTK cold start plus the owning app answering the
    // selection request can exceed a few hundred ms (extCache keeps polling cheap)
    execFile('python3', [helperPath(), '--read'], { timeout: 1200, encoding: 'utf8', env: helperEnv() },
      (err, stdout) => {
        let value: ClipboardFiles | null = null
        if (!err) {
          try {
            const v = JSON.parse(stdout.trim())
            if (v && (v.op === 'cut' || v.op === 'copy') && Array.isArray(v.paths) && v.paths.length) {
              value = { op: v.op, paths: v.paths }
            }
          } catch { /* not ours / empty */ }
        }
        extCache = { value, at: Date.now() }
        resolve(value)
      })
  })
}

function onLost(child: ChildProcess): void {
  if (helper === child) helper = null
  extCache = null
  // Another app owns the clipboard now — reflect whatever it holds.
  void readExternal().then(c => {
    state = c
    broadcast(PUSH.clipboardChanged, state)
  })
}

export async function setFiles(data: ClipboardFiles): Promise<void> {
  killHelper()
  extCache = null
  state = data
  await new Promise<void>(resolve => {
    let child: ChildProcess
    try {
      child = spawn('python3', [helperPath(), 'own', '-'], { stdio: ['pipe', 'pipe', 'ignore'], env: helperEnv() })
    } catch { resolve(); return }
    helper = child
    let settled = false
    const settle = () => { if (!settled) { settled = true; clearTimeout(timer); resolve() } }
    const timer = setTimeout(settle, 2500)
    child.stdin!.on('error', () => { /* helper died instantly (EPIPE); exit handler settles */ })
    try {
      child.stdin!.write(JSON.stringify(data))
      child.stdin!.end()
    } catch { /* helper died instantly; exit handler settles */ }
    child.stdout!.setEncoding('utf8')
    let buf = ''
    child.stdout!.on('data', (d: string) => {
      buf += d
      let i: number
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim()
        buf = buf.slice(i + 1)
        if (line === 'OWNED') settle()
        else if (line === 'LOST') onLost(child)
      }
    })
    child.on('error', () => { if (helper === child) helper = null; settle() })
    child.on('exit', () => { if (helper === child) helper = null; settle() })
  })
  broadcast(PUSH.clipboardChanged, state)
}

export async function getFiles(): Promise<ClipboardFiles | null> {
  if (helper) return state          // we own the clipboard; state is truth
  return readExternal()
}

export async function clear(): Promise<void> {
  killHelper()
  state = null
  extCache = null
  try { clipboard.clear() } catch { /* headless */ }
  broadcast(PUSH.clipboardChanged, null)
}

export async function copyText(text: string): Promise<void> {
  clipboard.writeText(text)
}
