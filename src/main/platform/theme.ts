// Light/dark theme tracking for Cinnamon.
//
// Source of truth: the xdg-desktop-portal-xapp key
// `gsettings get org.x.apps.portal color-scheme` -> 'prefer-dark' | 'prefer-light'
// | 'default'. nativeTheme does not follow Cinnamon reliably, so we watch the
// gsettings key with a long-lived `gsettings monitor` child and keep
// nativeTheme's 'updated' event only as a deduped backup signal.

import { app, nativeTheme } from 'electron'
import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { broadcast } from '../windows'
import { PUSH } from '../../shared/ipc'

let current: 'light' | 'dark' = 'light'
let monitor: ChildProcess | null = null

export function currentTheme(): 'light' | 'dark' {
  return current
}

function readPortal(): 'light' | 'dark' | null {
  try {
    const out = execFileSync('gsettings', ['get', 'org.x.apps.portal', 'color-scheme'],
      { encoding: 'utf8', timeout: 3000 })
    return out.includes('prefer-dark') ? 'dark' : 'light'
  } catch {
    return null
  }
}

function apply(t: 'light' | 'dark'): void {
  if (t === current) return          // dedupe: gsettings monitor + nativeTheme both fire
  current = t
  broadcast(PUSH.themeChanged, t)
}

export function initTheme(): void {
  current = readPortal() ?? (nativeTheme.shouldUseDarkColors ? 'dark' : 'light')

  try {
    monitor = spawn('gsettings', ['monitor', 'org.x.apps.portal', 'color-scheme'],
      { stdio: ['ignore', 'pipe', 'ignore'] })
    monitor.stdout!.setEncoding('utf8')
    let buf = ''
    monitor.stdout!.on('data', (d: string) => {
      buf += d
      let i: number
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i)
        buf = buf.slice(i + 1)
        if (!line.includes('color-scheme')) continue
        apply(line.includes('prefer-dark') ? 'dark' : 'light')
      }
    })
    monitor.on('error', () => { monitor = null })
    monitor.on('exit', () => { monitor = null })
    monitor.unref()
  } catch {
    monitor = null
  }

  // Backup: Electron's own theme signal (fires on some GTK theme changes).
  nativeTheme.on('updated', () => {
    const t = readPortal() ?? (nativeTheme.shouldUseDarkColors ? 'dark' : 'light')
    apply(t)
  })

  app.on('will-quit', () => { try { monitor?.kill() } catch { /* gone */ } monitor = null })
}
