// Explorer's "Send to" submenu, translated to Linux.
//
// Windows builds this from a SendTo folder full of shortcuts. There is no
// freedesktop equivalent, so the list is assembled from things that actually
// exist on this machine: the desktop, the removable drives that are mounted
// right now, and the XDG user directories. The two Windows entries with no
// sane Linux analogue (Mail recipient, Fax) are dropped rather than faked.
//
// Removable drives are the reason this menu is worth having at all: copying to
// a USB stick otherwise means finding it in the tree first.
import * as fs from 'node:fs'
import * as fsp from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { ipcMain } from 'electron'
import { CH } from '../../shared/ipc'
import { mountPoints } from '../fs/list'
import { getPlaces } from './places'

export interface SendToTarget {
  id: string
  label: string
  icons: string[]
  /** destination directory, or '' for the actions that need no path */
  path: string
  /** copy = drop a copy there; symlink = leave a shortcut; zip = compress */
  action: 'copy' | 'symlink' | 'zip'
}

/** XDG dirs worth offering, in Explorer's rough order */
const XDG = [
  ['XDG_DOCUMENTS_DIR', 'Documents', 'folder-documents'],
  ['XDG_DOWNLOAD_DIR', 'Downloads', 'folder-download'],
  ['XDG_PICTURES_DIR', 'Pictures', 'folder-pictures'],
  ['XDG_MUSIC_DIR', 'Music', 'folder-music'],
  ['XDG_VIDEOS_DIR', 'Videos', 'folder-videos'],
] as const

/**
 * Mount points that are someone's storage rather than the operating system's
 * plumbing. /media/<user>/… and /run/media/<user>/… are where udisks puts
 * removable drives; /mnt is where people put their own.
 */
function isUserVolume(m: string): boolean {
  return m.startsWith('/media/') || m.startsWith('/run/media/') || m.startsWith('/mnt/')
}

async function xdgDirs(): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  const cfg = path.join(os.homedir(), '.config/user-dirs.dirs')
  let txt = ''
  try { txt = await fsp.readFile(cfg, 'utf8') } catch { return out }
  for (const line of txt.split('\n')) {
    const m = /^\s*(XDG_[A-Z_]+_DIR)\s*=\s*"(.*)"\s*$/.exec(line)
    if (!m) continue
    out.set(m[1], m[2].replace(/^\$HOME/, os.homedir()))
  }
  return out
}

/** true only for a directory we can actually write into */
function usableDir(p: string): boolean {
  try {
    if (!fs.statSync(p).isDirectory()) return false
    fs.accessSync(p, fs.constants.W_OK)
    return true
  } catch {
    return false
  }
}

export async function sendToTargets(): Promise<SendToTarget[]> {
  const out: SendToTarget[] = []
  const home = os.homedir()

  const desktop = (await xdgDirs()).get('XDG_DESKTOP_DIR') || path.join(home, 'Desktop')
  if (usableDir(desktop)) {
    out.push({
      id: 'desktop-link',
      label: 'Desktop (create shortcut)',
      icons: ['user-desktop', 'desktop'],
      path: desktop,
      action: 'symlink',
    })
  }

  out.push({
    id: 'zip',
    label: 'Compressed (zipped) folder',
    icons: ['package-x-generic', 'application-zip'],
    path: '',
    action: 'zip',
  })

  const dirs = await xdgDirs()
  for (const [key, label, icon] of XDG) {
    const p = dirs.get(key) || path.join(home, label)
    if (usableDir(p)) out.push({ id: 'xdg:' + key, label, icons: [icon, 'folder'], path: p, action: 'copy' })
  }

  // Drives last, as Explorer does — and only ones mounted right now, because an
  // entry pointing at an unplugged stick would fail at the moment it is used.
  // Labels come from the places list so a drive reads the same here as it does
  // in the navigation pane, rather than showing its raw mount directory.
  let mounts: string[] = []
  try { mounts = mountPoints() } catch { /* no mount table: skip drives */ }
  const byPath = new Map<string, { label: string; icons: string[] }>()
  try {
    for (const pl of await getPlaces()) {
      if (pl.path) byPath.set(pl.path.replace(/\/+$/, ''), { label: pl.label, icons: pl.icons })
    }
  } catch { /* fall back to the mount directory's own name */ }
  // One directory can appear twice in /proc/mounts — an autofs trigger and the
  // cifs mount that replaced it both claim /mnt/share/files — and two identical
  // rows in the menu tell the user nothing about which is which
  const emitted = new Set<string>()
  for (const m of mounts) {
    if (!isUserVolume(m) || !usableDir(m)) continue
    const key = m.replace(/\/+$/, '')
    if (emitted.has(key)) continue
    emitted.add(key)
    const known = byPath.get(key)
    out.push({
      id: 'vol:' + m,
      label: known?.label || path.basename(m) || m,
      icons: known?.icons?.length ? known.icons : ['drive-removable-media', 'drive-harddisk'],
      path: m,
      action: 'copy',
    })
  }
  return out
}

ipcMain.handle(CH('sendToTargets'), () => sendToTargets())
