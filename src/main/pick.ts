// File-picker mode. See src/shared/pick.ts for why this exists at all.
//
// Launched as:  bin/run.sh --pick /run/user/1000/liqexplorer-pick/<id>.json
//
// The JSON file holds a PickRequest, including the path of a UNIX socket the
// caller (helpers/filechooser-portal.py) is already listening on.
//
// WHY A SOCKET AND NOT AN EXIT CODE / STDOUT. The app takes a single-instance
// lock, so the SECOND launch forwards its argv to the running instance and
// exits immediately — the process the portal helper spawned is gone long before
// the user has picked anything, and its stdout with it. The socket is opened by
// whichever instance actually shows the window, and it is held open for the
// life of the picker: a result is one JSON line, and a close with no line means
// cancelled. That makes a crashed or killed picker indistinguishable from
// Cancel, which is exactly the behaviour the caller wants.

import { ipcMain, BrowserWindow } from 'electron'
import * as fs from 'node:fs'
import * as net from 'node:net'
import { execFile } from 'node:child_process'
import { CH } from '../shared/ipc'
import type { PickRequest, PickResult } from '../shared/pick'
import { createWindow } from './windows'

interface Session {
  req: PickRequest
  sock: net.Socket | null
  answered: boolean
}

/** window id -> the pick it is showing. Concurrent pickers are normal: two
 *  applications can both be asking for a file at the same time. */
const sessions = new Map<number, Session>()

/** True while any picker window is open — the app must not quit under one. */
export function hasPickers(): boolean { return sessions.size > 0 }

/**
 * Pull the pick request out of a command line.
 *
 * IT MUST BE `--pick=<file>`, ONE TOKEN. The separated form `--pick <file>`
 * looks equivalent and is not, because Chromium re-orders argv: it splits the
 * command line into switches and positional arguments and rebuilds it as
 * [program, ...switches, ...args]. A second instance launched as
 *
 *     electron /path/to/LiqExplorer --pick /run/.../request.json
 *
 * therefore reaches `second-instance` as
 *
 *     [electron, --pick, /path/to/LiqExplorer, /run/.../request.json]
 *
 * — the switch has jumped in front of the app directory, so "the token after
 * --pick" is that directory, reading it fails with EISDIR, and the request
 * silently degrades into an ordinary window opened on the folder holding
 * request.json. `--pick=<file>` is a single token and survives the reshuffle.
 *
 * The separated form is still accepted for hand-testing, but only when the
 * following token really does parse as a request.
 *
 * Returns null for an ordinary launch, and for a request that cannot be read:
 * a malformed file must never stop the app starting, and the portal helper
 * falls back to the GTK dialog when nothing connects.
 */
export function parsePickArgs(argv: string[]): PickRequest | null {
  const joined = argv.find(a => a.startsWith('--pick='))
  if (joined) return readRequest(joined.slice('--pick='.length))
  const i = argv.indexOf('--pick')
  return i >= 0 && i + 1 < argv.length ? readRequest(argv[i + 1]) : null
}

function readRequest(file: string): PickRequest | null {
  try {
    const req = JSON.parse(fs.readFileSync(file, 'utf8')) as PickRequest & { socket?: string }
    if (!req || typeof req !== 'object' || !req.mode) return null
    return req
  } catch {
    return null
  }
}

/**
 * Open a picker window for `req`.
 *
 * The socket is connected FIRST. If the caller has already gone away there is
 * nothing to answer, and putting a window on screen that can only be cancelled
 * would be worse than nothing.
 */
export function openPicker(req: PickRequest & { socket?: string }): void {
  const socketPath = req.socket
  let sock: net.Socket | null = null
  if (socketPath) {
    sock = net.connect(socketPath)
    // ECONNREFUSED / ENOENT: the helper is gone. Nothing to show.
    sock.on('error', () => { sock?.destroy() })
  }

  const win = createWindow({ open: startFolder(req) ?? undefined, pick: true })
  const session: Session = { req, sock, answered: false }
  sessions.set(win.id, session)

  // The caller's title is the only clue to WHICH application is asking, so it
  // has to outlive the document's own <title>, which fires once the renderer
  // loads and would otherwise put "LiqExplorer" back.
  win.setTitle(req.title || 'Open')
  win.on('page-title-updated', (e) => { e.preventDefault(); win.setTitle(req.title || 'Open') })
  if (req.modal !== false) win.setAlwaysOnTop(true)
  win.once('ready-to-show', () => { win.show(); win.focus(); setTransientFor(win, req.parentWindow) })

  // Closing the window IS cancelling — the ✕, Alt+F4 and a crash all land here.
  win.on('closed', () => {
    answer(win.id, { ok: false, paths: [] })
    sessions.delete(win.id)
  })

  // The helper hanging up (its caller withdrew the request via Request.Close)
  // must take the window with it, or the user is left picking for nobody.
  sock?.on('close', () => {
    const s = sessions.get(win.id)
    if (s && !s.answered && !win.isDestroyed()) win.destroy()
  })
}

/** Where the picker should land: the caller's folder if it still exists. */
function startFolder(req: PickRequest): string | null {
  const dir = req.currentFolder
    || (req.currentFile ? req.currentFile.slice(0, req.currentFile.lastIndexOf('/')) : '')
  if (!dir) return null
  try { return fs.statSync(dir).isDirectory() ? dir : null } catch { return null }
}

/**
 * Ask the window manager to stack the picker over the window that asked for it.
 *
 * Electron cannot parent a BrowserWindow to a FOREIGN X11 window, so the hint
 * is set on the property directly. Best-effort by design: without it the picker
 * is merely a normal always-on-top window, which is what every failure mode
 * here degrades to.
 */
function setTransientFor(win: BrowserWindow, parent: string | undefined): void {
  const m = /^x11:(0x[0-9a-fA-F]+|\d+)$/.exec(parent ?? '')
  if (!m) return
  let id: number
  try {
    const handle = win.getNativeWindowHandle()
    id = handle.length >= 4 ? handle.readUInt32LE(0) : 0
  } catch { return }
  if (!id) return
  execFile('xprop', [
    '-id', String(id), '-f', 'WM_TRANSIENT_FOR', '32x',
    '-set', 'WM_TRANSIENT_FOR', String(parseInt(m[1], m[1].startsWith('0x') ? 16 : 10)),
  ], () => { /* xprop may not be installed; the picker still works */ })
}

/** Send the result and hang up. Idempotent — 'closed' fires after an accept. */
function answer(winId: number, result: PickResult): void {
  const s = sessions.get(winId)
  if (!s || s.answered) return
  s.answered = true
  try { s.sock?.end(JSON.stringify(result) + '\n') } catch { /* caller is gone */ }
}

ipcMain.handle(CH('pickRequest'), (e) => {
  const win = BrowserWindow.fromWebContents(e.sender)
  return win ? (sessions.get(win.id)?.req ?? null) : null
})

ipcMain.handle(CH('pickResult'), (e, result: PickResult) => {
  const win = BrowserWindow.fromWebContents(e.sender)
  if (!win) return
  answer(win.id, result)
  sessions.delete(win.id)
  if (!win.isDestroyed()) win.destroy()
})

/** Save mode: does this path already exist? Drives the overwrite prompt. */
ipcMain.handle(CH('pickExists'), (_e, p: string) => {
  try { return fs.statSync(p).isFile() ? 'file' : 'dir' } catch { return null }
})
