// Open a terminal at a path — portable across Cinnamon/GNOME/KDE/XFCE/Arch.
//
// Resolution order:
//   1. xdg-terminal-exec (freedesktop, when installed)
//   2. $TERMINAL env override
//   3. DE gsettings (Cinnamon, then GNOME)
//   4. Common binaries on PATH
//   5. x-terminal-emulator / xterm last resorts

import { spawn, execFileSync } from 'node:child_process'
import * as fsp from 'node:fs/promises'
import * as path from 'node:path'

const COMMON_TERMS = [
  'kitty', 'alacritty', 'wezterm', 'ghostty',
  'gnome-terminal', 'kgx', 'konsole', 'xfce4-terminal',
  'mate-terminal', 'lxterminal', 'tilix', 'terminator',
  'foot', 'xterm',
]

async function onPath(bin: string): Promise<boolean> {
  const dirs = (process.env.PATH || '/usr/local/bin:/usr/bin:/bin').split(':').filter(Boolean)
  for (const d of dirs) {
    try {
      const st = await fsp.stat(path.join(d, bin))
      if (st.isFile() && (st.mode & 0o111) !== 0) return true
    } catch { /* next */ }
  }
  return false
}

function gsettingsStr(schema: string, key: string): string | null {
  try {
    const out = execFileSync('gsettings', ['get', schema, key], {
      encoding: 'utf8', timeout: 2000,
    }).trim()
    const m = /^['"](.*)['"]$/.exec(out)
    return (m ? m[1] : out).trim() || null
  } catch {
    return null
  }
}

function spawnDetached(cmd: string, args: string[], cwd: string): boolean {
  try {
    const child = spawn(cmd, args, { cwd, detached: true, stdio: 'ignore' })
    child.on('error', () => { /* ignore ENOENT */ })
    child.unref()
    return true
  } catch {
    return false
  }
}

export async function openAt(dir: string): Promise<void> {
  if (await onPath('xdg-terminal-exec')) {
    if (spawnDetached('xdg-terminal-exec', [], dir)) return
  }

  const envTerm = process.env.TERMINAL?.trim()
  if (envTerm) {
    const parts = envTerm.split(/\s+/).filter(Boolean)
    const bin = parts[0]!
    if (await onPath(bin)) {
      if (spawnDetached(bin, parts.slice(1), dir)) return
    }
  }

  const cinnamon = gsettingsStr('org.cinnamon.desktop.default-applications.terminal', 'exec')
  if (cinnamon && await onPath(cinnamon)) {
    if (spawnDetached(cinnamon, [], dir)) return
  }
  const gnome = gsettingsStr('org.gnome.desktop.default-applications.terminal', 'exec')
  if (gnome && await onPath(gnome)) {
    if (spawnDetached(gnome, [], dir)) return
  }

  for (const term of COMMON_TERMS) {
    if (!(await onPath(term))) continue
    if (term === 'gnome-terminal' || term === 'kgx') {
      if (spawnDetached(term, [`--working-directory=${dir}`], dir)) return
    } else if (term === 'xfce4-terminal' || term === 'mate-terminal' || term === 'tilix') {
      if (spawnDetached(term, [`--working-directory=${dir}`], dir)) return
    } else if (term === 'konsole') {
      if (spawnDetached(term, ['--workdir', dir], dir)) return
    } else if (spawnDetached(term, [], dir)) {
      return
    }
  }

  if (await onPath('x-terminal-emulator')) {
    spawnDetached('x-terminal-emulator', [], dir)
    return
  }

  spawnDetached('xterm', [], dir)
}
