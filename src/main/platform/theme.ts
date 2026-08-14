// Light/dark theme — portable across Cinnamon (XApp portal), GNOME, and
// Electron's nativeTheme fallback for KDE/other DEs.

import { app, nativeTheme } from 'electron'
import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { broadcast } from '../windows'
import { PUSH } from '../../shared/ipc'

let current: 'light' | 'dark' = 'light'
const monitors: ChildProcess[] = []

export function currentTheme(): 'light' | 'dark' {
  return current
}

function parseScheme(out: string): 'light' | 'dark' | null {
  if (out.includes('prefer-dark')) return 'dark'
  if (out.includes('prefer-light') || out.includes("'default'") || out.includes('"default"')) {
    // 'default' usually means follow the light/dark of the DE; treat as light
    // unless nativeTheme already says dark (handled by caller).
    return out.includes('prefer-light') ? 'light' : null
  }
  return null
}

function readGsettings(schema: string, key: string): string | null {
  try {
    return execFileSync('gsettings', ['get', schema, key], {
      encoding: 'utf8', timeout: 3000,
    })
  } catch {
    return null
  }
}

/** Prefer XApp (Cinnamon/Mint), then GNOME color-scheme, else null. */
function readPortal(): 'light' | 'dark' | null {
  for (const [schema, key] of [
    ['org.x.apps.portal', 'color-scheme'],
    ['org.gnome.desktop.interface', 'color-scheme'],
  ] as const) {
    const out = readGsettings(schema, key)
    if (!out) continue
    const parsed = parseScheme(out)
    if (parsed) return parsed
    // default / unknown → let nativeTheme decide
    if (out.includes('default')) return null
  }
  // Older GNOME: gtk-theme name containing "-dark"
  const gtk = readGsettings('org.gnome.desktop.interface', 'gtk-theme')
  if (gtk && /dark/i.test(gtk)) return 'dark'
  if (gtk) return 'light'
  return null
}

function apply(t: 'light' | 'dark'): void {
  if (t === current) return
  current = t
  broadcast(PUSH.themeChanged, t)
}

function startMonitor(schema: string, key: string): void {
  try {
    const monitor = spawn('gsettings', ['monitor', schema, key], {
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    monitor.stdout!.setEncoding('utf8')
    let buf = ''
    monitor.stdout!.on('data', (d: string) => {
      buf += d
      let i: number
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i)
        buf = buf.slice(i + 1)
        if (!line.includes(key) && !line.includes('color-scheme') && !line.includes('gtk-theme')) continue
        const next = readPortal() ?? (nativeTheme.shouldUseDarkColors ? 'dark' : 'light')
        apply(next)
      }
    })
    monitor.on('error', () => { /* binary missing */ })
    monitor.on('exit', () => {
      const idx = monitors.indexOf(monitor)
      if (idx >= 0) monitors.splice(idx, 1)
    })
    monitor.unref()
    monitors.push(monitor)
  } catch {
    /* ignore */
  }
}

export function initTheme(): void {
  current = readPortal() ?? (nativeTheme.shouldUseDarkColors ? 'dark' : 'light')

  startMonitor('org.x.apps.portal', 'color-scheme')
  startMonitor('org.gnome.desktop.interface', 'color-scheme')

  nativeTheme.on('updated', () => {
    const t = readPortal() ?? (nativeTheme.shouldUseDarkColors ? 'dark' : 'light')
    apply(t)
  })

  app.on('will-quit', () => {
    for (const m of monitors) {
      try { m.kill() } catch { /* gone */ }
    }
    monitors.length = 0
  })
}
