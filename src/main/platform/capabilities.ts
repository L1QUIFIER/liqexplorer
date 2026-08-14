// Probe optional/required host tools once at startup so features can soft-fail
// instead of crashing on Arch/Fedora/KDE/etc. where Mint packages aren't assumed.

import { execFileSync } from 'node:child_process'
import * as fsp from 'node:fs/promises'
import * as path from 'node:path'
import { availability as archiveAvailability } from '../ops/archive/backend'

export interface HostCapabilities {
  gio: boolean
  gsettings: boolean
  ripgrep: boolean
  python3: boolean
  pythonGi: boolean
  sevenZip: boolean
  unrar: boolean
  unar: boolean
  udisksctl: boolean
  xdgMime: boolean
  /** true when a Wayland session is active (X11 clipboard helper may be limited) */
  wayland: boolean
  /** true when DISPLAY is set (X11 or XWayland) */
  x11Display: boolean
  warnings: string[]
}

let cached: HostCapabilities | null = null

async function canExec(name: string): Promise<boolean> {
  if (name.includes('/')) {
    try {
      const st = await fsp.stat(name)
      return st.isFile() && (st.mode & 0o111) !== 0
    } catch { return false }
  }
  const dirs = (process.env.PATH || '/usr/local/bin:/usr/bin:/bin').split(':').filter(Boolean)
  for (const d of dirs) {
    try {
      const p = path.join(d, name)
      const st = await fsp.stat(p)
      if (st.isFile() && (st.mode & 0o111) !== 0) return true
    } catch { /* next */ }
  }
  return false
}

function hasPythonGi(): boolean {
  try {
    execFileSync('python3', ['-c', 'import gi; gi.require_version("Gtk", "3.0"); from gi.repository import Gtk'], {
      timeout: 5000,
      stdio: 'ignore',
    })
    return true
  } catch {
    return false
  }
}

/** Resolve (and cache) host capabilities. Safe to call repeatedly. */
export async function probeCapabilities(): Promise<HostCapabilities> {
  if (cached) return cached

  const [gio, gsettings, ripgrep, python3, udisksctl, xdgMime, archives] = await Promise.all([
    canExec('gio'),
    canExec('gsettings'),
    canExec('rg'),
    canExec('python3'),
    canExec('udisksctl'),
    canExec('xdg-mime'),
    archiveAvailability(),
  ])
  const pythonGi = python3 && hasPythonGi()
  const wayland = !!(process.env.WAYLAND_DISPLAY || process.env.XDG_SESSION_TYPE === 'wayland')
  const x11Display = !!process.env.DISPLAY

  const warnings: string[] = []
  if (!gio) warnings.push('gio (glib2/gvfs) missing — trash and some mounts will not work')
  if (!ripgrep) warnings.push('ripgrep (rg) missing — content search disabled')
  if (!archives.sevenZip) warnings.push('7-Zip (7z/7zz/7za) missing — archive list/extract/create limited')
  if (!pythonGi) warnings.push('python3 + PyGObject/GTK3 missing — desktop clipboard cut/copy interop limited')
  if (wayland && !x11Display) warnings.push('Wayland without X11 display — clipboard interop with other file managers is limited')
  else if (wayland) warnings.push('Wayland session detected — prefer X11/XWayland for best clipboard interop')

  cached = {
    gio, gsettings, ripgrep, python3, pythonGi,
    sevenZip: archives.sevenZip,
    unrar: archives.unrar,
    unar: archives.unar,
    udisksctl, xdgMime, wayland, x11Display, warnings,
  }
  return cached
}

export function getCapabilities(): HostCapabilities | null {
  return cached
}

export function logCapabilities(caps: HostCapabilities): void {
  if (!caps.warnings.length) {
    console.log('[liqexplorer] host capabilities OK')
    return
  }
  console.warn('[liqexplorer] host capability warnings:')
  for (const w of caps.warnings) console.warn('  -', w)
}
