import { app, BrowserWindow, protocol } from 'electron'
import * as path from 'node:path'
import { createWindow, windowForPath } from './windows'
import { registerIpc } from './ipc'
import { registerProtocols, protocolPrivileges } from './platform/protocols'
import { initTheme } from './platform/theme'
import { loadSettings } from './state/settings'
import { initClipboard } from './platform/clipboard'

// Paths handed on the command line (first launch or forwarded by second
// instance). Relative paths are resolved against cwd — the SECOND instance's
// working directory for forwarded argv, not this process's.
function pathArgs(argv: string[], cwd: string): string[] {
  return argv.slice(1).filter(a => !a.startsWith('-') && a !== '.' && a !== path.resolve(__dirname, '../..'))
    .map(a => path.resolve(cwd, a))
    .filter(a => { try { return require('node:fs').existsSync(a) } catch { return false } })
}

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', (_e, argv, workingDirectory) => {
    const paths = pathArgs(argv, workingDirectory)
    const win = createWindow(paths[0])
    win.focus()
  })

  protocol.registerSchemesAsPrivileged(protocolPrivileges())

  app.whenReady().then(async () => {
    await loadSettings()
    initTheme()
    initClipboard()
    registerProtocols()
    registerIpc()
    const paths = pathArgs(process.argv, process.cwd())
    createWindow(paths[0])
  })

  app.on('window-all-closed', () => app.quit())
}
