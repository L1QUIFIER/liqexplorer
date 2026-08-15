import { app, BrowserWindow, protocol } from 'electron'
import * as path from 'node:path'
import { createWindow, windowForPath } from './windows'
import { registerIpc } from './ipc'
import { registerProtocols, protocolPrivileges } from './platform/protocols'
import { initTheme } from './platform/theme'
import { loadSettings } from './state/settings'
import { initClipboard } from './platform/clipboard'
import { probeCapabilities, logCapabilities } from './platform/capabilities'
import './platform/names'      // self-registers scanNames/fixNames/checkName
import './platform/duplicates' // self-registers startDupScan/cancelDupScan/getDupPrefs/setDupPrefs
import './platform/sendto'     // self-registers sendToTargets
import './platform/mediawindow' // self-registers mediaPopout/mediaPopoutPayload/mediaWindowFullscreen
import * as session from './state/session'   // self-registers saveSession/readSession
import './state/resume'                      // self-registers get/set/clearResume
import { stopAllTranscodes } from './platform/transcode'
import { stopCaching } from './platform/mediacache'   // also self-registers mediaCache* over IPC
import './platform/tracks'                   // self-registers mediaTracks / subtitleVtt
import './platform/contactsheet'             // self-registers contactSheet
import './platform/nemoactions'              // self-registers nemoActions / runNemoAction
import './fs/sniff'                          // self-registers identifyFile
import './platform/tools'                    // self-registers toolReport
import './ops/imageedit'   // self-registers applyEdit
import './ops/dropbins'     // self-registers binsGet/binsSet/convertImages/checksumsRun
import './platform/mediainfo' // self-registers fileFacts/fileFactsMany (Details tab)
import './ops/textfile'     // self-registers textRead/textWrite (Doc tab)
import './ops/pdfops'       // self-registers pdfDocInfo/pdfThumbs/pdfApplyPages/pdfMerge/pdfPick

// Paths handed on the command line (first launch or forwarded by second
// instance). Relative paths are resolved against cwd — the SECOND instance's
// working directory for forwarded argv, not this process's.
/** file:// URI -> path. Percent-decoded, because real filenames here contain
 *  spaces and '#', and a naive prefix strip mangles both. */
function fileUriToPath(uri: string): string | null {
  try {
    const u = new URL(uri)
    if (u.protocol !== 'file:') return null
    return decodeURIComponent(u.pathname) || null
  } catch { return null }
}

interface CliRequest {
  /** folder to open */
  open?: string
  /** item to reveal inside that folder */
  select?: string
  /** reveal it AND open its properties */
  properties?: boolean
}

/**
 * What the command line is asking for.
 *
 * Two shapes matter. A bare path is "open this", and if it names a FILE that
 * means its folder with the file selected — nobody typing a filename wants a
 * file manager to show them the parent and make them hunt. `--select` /
 * `--properties` are the same request from org.freedesktop.FileManager1, which
 * is how every other application's "Show in folder" reaches us
 * (helpers/filemanager1.py).
 *
 * Flags used to be dropped by a blanket `!a.startsWith('-')` filter, which
 * silently turned "reveal this file" into "open this file".
 */
function parseCli(argv: string[], cwd: string): CliRequest {
  const fs = require('node:fs') as typeof import('node:fs')
  const self = path.resolve(__dirname, '../..')
  const out: CliRequest = {}
  let wantSelect = false
  let wantProps = false

  for (const raw of argv.slice(1)) {
    if (raw === '--select') { wantSelect = true; continue }
    if (raw === '--properties') { wantSelect = true; wantProps = true; continue }
    // every other flag belongs to Electron/Chromium, not to us
    if (raw.startsWith('-')) continue
    if (raw === '.' || raw === self) continue

    // The app is registered for x-scheme-handler/file and /trash, so callers
    // hand us URIs, not paths — and a URI fails statSync, which would have
    // silently opened the default folder instead of the one asked for.
    if (/^trash:/i.test(raw)) { out.open ??= 'trash://'; continue }
    const arg = /^file:\/\//i.test(raw) ? fileUriToPath(raw) : raw
    if (!arg) continue

    const abs = path.resolve(cwd, arg)
    let st: import('node:fs').Stats
    try { st = fs.statSync(abs) } catch { continue }

    if (st.isDirectory() && !wantSelect) {
      out.open ??= abs
    } else {
      // a file — show the folder that holds it, with it selected
      out.open ??= path.dirname(abs)
      out.select ??= abs
      if (wantProps) out.properties = true
    }
    wantSelect = false
    wantProps = false
  }
  return out
}

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', (_e, argv, workingDirectory) => {
    const win = createWindow(parseCli(argv, workingDirectory))
    win.focus()
  })

  protocol.registerSchemesAsPrivileged(protocolPrivileges())

  app.whenReady().then(async () => {
    await loadSettings()
    initTheme()
    initClipboard()
    registerProtocols()
    registerIpc()
    createWindow(parseCli(process.argv, process.cwd()))
  })

  app.on('window-all-closed', () => app.quit())
  // the session write is debounced; quitting must not swallow the last one
  app.on('before-quit', () => session.flushNow())
  // an ffmpeg spawned for playback is not a child that dies with us: without
  // this a quit mid-stream leaves it transcoding to a pipe nobody reads
  app.on('before-quit', () => { stopAllTranscodes(); stopCaching() })
}
