// Which external tools this machine actually has, and what they are called here.
//
// The app carries no runtime npm dependencies and shells out to system tools
// for everything, which makes it portable in principle and fragile in practice:
// the same capability has a different command name on different distributions,
// and a missing one produced a confusing failure deep inside a feature rather
// than an answer up front.
//
// THE ONE THAT ACTUALLY BROKE. ImageMagick 7 (Arch, Fedora) ships a single
// `magick` driver and no longer installs `convert`/`identify`; ImageMagick 6
// (Mint, Debian, Ubuntu) ships `convert`/`identify` and no `magick`. Three
// separate places in this codebase resolved that independently, and one of them
// — mediainfo.ts — simply spawned `identify`, so on an Arch box image
// dimensions would have gone quietly missing with no error anyone would see.
// One probe, one answer, no drift.
//
// Everything here is cached for the life of the process. Probing costs a
// process per tool and the answer cannot change while the app runs.
import { ipcMain } from 'electron'
import { spawn } from 'node:child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { CH } from '../../shared/ipc'
import type { ToolReport, ToolStatus } from '../../shared/tools'
import { iconReport } from './icons'

/** on PATH? cheap, synchronous, no process spawned */
function onPath(bin: string): boolean {
  if (bin.includes('/')) return fs.existsSync(bin)
  for (const dir of (process.env.PATH || '/usr/bin:/bin').split(':')) {
    if (dir && fs.existsSync(path.join(dir, bin))) return true
  }
  return false
}

/** first name that exists, or '' */
function firstOnPath(...names: string[]): string {
  for (const n of names) if (onPath(n)) return n
  return ''
}

export interface Resolved {
  /** argv prefix, e.g. ['magick'] or ['convert']; empty when unavailable */
  convert: string[]
  identify: string[]
  ffmpeg: string
  ffprobe: string
  /** 7z-compatible extractor, whatever it is called here */
  sevenZip: string
  rar: string
  gio: string
  qpdf: string
  exiftool: string
  ripgrep: string
  pdfinfo: string
  pdftoppm: string
  pdftotext: string
  python: string
}

let cached: Resolved | null = null

export function resolveTools(): Resolved {
  if (cached) return cached
  // magick FIRST: on a system with both, IM7's driver is the maintained one
  const magick = onPath('magick')
  cached = {
    convert: magick ? ['magick'] : onPath('convert') ? ['convert'] : [],
    identify: magick ? ['magick', 'identify'] : onPath('identify') ? ['identify'] : [],
    ffmpeg: firstOnPath('ffmpeg'),
    ffprobe: firstOnPath('ffprobe'),
    // Debian/Mint call it 7z (p7zip-full), Arch 7z (p7zip) or 7zz (7-zip),
    // Fedora 7za. Any of them takes the same 'x'/'l' verbs this app uses.
    sevenZip: firstOnPath('7z', '7zz', '7za'),
    rar: firstOnPath('unrar', 'unar', 'bsdtar'),
    gio: firstOnPath('gio'),
    qpdf: firstOnPath('qpdf'),
    exiftool: firstOnPath('exiftool'),
    ripgrep: firstOnPath('rg'),
    pdfinfo: firstOnPath('pdfinfo'),
    pdftoppm: firstOnPath('pdftoppm'),
    pdftotext: firstOnPath('pdftotext'),
    python: firstOnPath('python3', 'python'),
  }
  return cached
}

// ---------------------------------------------------------------- the report

/**
 * Which package to suggest, per family. The package NAME differs even where the
 * binary does not — poppler-utils on Debian is poppler on Arch — so a single
 * "install poppler-utils" hint would be wrong half the time.
 */
interface Need {
  key: string
  label: string
  /** what stops working without it */
  needed: string
  optional: boolean
  have: () => boolean
  pkg: { apt: string; pacman: string; dnf: string }
}

const NEEDS: Need[] = [
  {
    key: 'ffmpeg', label: 'ffmpeg / ffprobe',
    needed: 'Playing video the browser cannot decode, video thumbnails, scene select, durations',
    optional: false,
    have: () => !!resolveTools().ffmpeg && !!resolveTools().ffprobe,
    pkg: { apt: 'ffmpeg', pacman: 'ffmpeg', dnf: 'ffmpeg' },
  },
  {
    key: 'imagemagick', label: 'ImageMagick',
    needed: 'Cropping, rotating and converting images; image dimensions in Details',
    optional: false,
    have: () => resolveTools().convert.length > 0,
    pkg: { apt: 'imagemagick', pacman: 'imagemagick', dnf: 'ImageMagick' },
  },
  {
    key: 'gio', label: 'gio',
    needed: 'Moving files to the recycle bin and reading trash metadata',
    optional: false,
    have: () => !!resolveTools().gio,
    pkg: { apt: 'libglib2.0-bin', pacman: 'glib2', dnf: 'glib2' },
  },
  {
    key: 'poppler', label: 'poppler-utils',
    needed: 'PDF previews, page thumbnails and page operations',
    optional: true,
    have: () => !!resolveTools().pdfinfo && !!resolveTools().pdftoppm,
    pkg: { apt: 'poppler-utils', pacman: 'poppler', dnf: 'poppler-utils' },
  },
  {
    key: 'sevenzip', label: '7-Zip',
    needed: 'Browsing and extracting most archive formats',
    optional: true,
    have: () => !!resolveTools().sevenZip,
    pkg: { apt: 'p7zip-full', pacman: '7zip', dnf: 'p7zip' },
  },
  {
    key: 'rar', label: 'unrar',
    needed: 'Extracting RAR archives',
    optional: true,
    have: () => !!resolveTools().rar,
    pkg: { apt: 'unrar', pacman: 'unrar', dnf: 'unrar' },
  },
  {
    key: 'ripgrep', label: 'ripgrep',
    needed: 'Searching inside file contents (name search works without it)',
    optional: true,
    have: () => !!resolveTools().ripgrep,
    pkg: { apt: 'ripgrep', pacman: 'ripgrep', dnf: 'ripgrep' },
  },
  {
    key: 'qpdf', label: 'qpdf',
    needed: 'Reordering, deleting, extracting and merging PDF pages',
    optional: true,
    have: () => !!resolveTools().qpdf,
    pkg: { apt: 'qpdf', pacman: 'qpdf', dnf: 'qpdf' },
  },
  {
    key: 'exiftool', label: 'exiftool',
    needed: 'Richer camera metadata than ImageMagick reports',
    optional: true,
    have: () => !!resolveTools().exiftool,
    pkg: { apt: 'libimage-exiftool-perl', pacman: 'perl-image-exiftool', dnf: 'perl-Image-ExifTool' },
  },
  {
    key: 'dbus', label: 'python3-dbus',
    needed: '"Show in folder" from other applications (org.freedesktop.FileManager1)',
    optional: true,
    have: () => {
      const py = resolveTools().python
      if (!py) return false
      try {
        const r = spawnSyncish(py, ['-c', 'import dbus, gi'])
        return r
      } catch { return false }
    },
    pkg: { apt: 'python3-dbus python3-gi', pacman: 'python-dbus python-gobject', dnf: 'python3-dbus python3-gobject' },
  },
]

/** tiny synchronous "does this run" without pulling in execSync's shell */
function spawnSyncish(bin: string, args: string[]): boolean {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const cp = require('node:child_process') as typeof import('node:child_process')
    const r = cp.spawnSync(bin, args, { stdio: 'ignore', timeout: 4000 })
    return r.status === 0
  } catch { return false }
}

/**
 * Which package manager to name in the hint.
 *
 * /etc/os-release ID_LIKE is the reliable signal — 'arch' covers Manjaro and
 * EndeavourOS, 'debian' covers Mint, Ubuntu and Pop, without listing every
 * derivative by hand.
 */
export function packageManager(): 'apt' | 'pacman' | 'dnf' | 'unknown' {
  let text = ''
  try { text = fs.readFileSync('/etc/os-release', 'utf8') } catch { return 'unknown' }
  // case-INSENSITIVE: os-release keys are upper case (ID=arch), and a
  // case-sensitive `^id=` matched nothing on every distribution. The bug hid
  // because the on-PATH fallback below still guessed right on Debian machines.
  const field = (k: string): string =>
    (new RegExp(`^${k}=(.*)$`, 'mi').exec(text)?.[1] ?? '').replace(/"/g, '').toLowerCase()
  const hay = `${field('id')} ${field('id_like')}`
  if (/\barch\b|manjaro|endeavour/.test(hay)) return 'pacman'
  if (/debian|ubuntu|linuxmint|mint|pop/.test(hay)) return 'apt'
  if (/fedora|rhel|centos|suse/.test(hay)) return 'dnf'
  // fall back to whichever manager is actually installed
  if (onPath('pacman')) return 'pacman'
  if (onPath('apt-get')) return 'apt'
  if (onPath('dnf')) return 'dnf'
  return 'unknown'
}

const INSTALL: Record<string, string> = {
  apt: 'sudo apt install',
  pacman: 'sudo pacman -S',
  dnf: 'sudo dnf install',
}

/** icon themes are packaged, so a missing one has an install command too */
const ICON_PKG = { apt: 'papirus-icon-theme', pacman: 'papirus-icon-theme', dnf: 'papirus-icon-theme' }

function iconStatus(pm: ReturnType<typeof packageManager>): ToolReport['icons'] {
  const r = iconReport()
  return {
    theme: r.theme,
    configured: r.configured,
    ok: r.ok,
    installedCount: r.installed.length,
    install: r.ok || pm === 'unknown' ? '' : `${INSTALL[pm]} ${ICON_PKG[pm]}`,
  }
}

export function toolReport(): ToolReport {
  const pm = packageManager()
  const t = resolveTools()
  const items: ToolStatus[] = NEEDS.map(n => {
    const have = n.have()
    const pkg = pm === 'unknown' ? '' : n.pkg[pm]
    return {
      key: n.key,
      label: n.label,
      needed: n.needed,
      optional: n.optional,
      present: have,
      // what it resolved to, so a surprising choice is visible rather than guessed at
      found: have ? foundName(n.key, t) : '',
      install: have || !pkg ? '' : `${INSTALL[pm]} ${pkg}`,
    }
  })
  return {
    distro: distroName(),
    desktop: process.env.XDG_CURRENT_DESKTOP || process.env.DESKTOP_SESSION || 'unknown',
    packageManager: pm,
    items,
    icons: iconStatus(pm),
  }
}

function foundName(key: string, t: Resolved): string {
  switch (key) {
    case 'ffmpeg': return `${t.ffmpeg}, ${t.ffprobe}`
    case 'imagemagick': return t.convert.join(' ')
    case 'gio': return t.gio
    case 'poppler': return `${t.pdfinfo}, ${t.pdftoppm}`
    case 'sevenzip': return t.sevenZip
    case 'rar': return t.rar
    case 'ripgrep': return t.ripgrep
    case 'qpdf': return t.qpdf
    case 'exiftool': return t.exiftool
    case 'dbus': return t.python
    default: return ''
  }
}

function distroName(): string {
  try {
    const text = fs.readFileSync('/etc/os-release', 'utf8')
    return (/^PRETTY_NAME=(.*)$/m.exec(text)?.[1] ?? '').replace(/"/g, '') || 'Linux'
  } catch { return 'Linux' }
}

ipcMain.handle(CH('toolReport'), () => toolReport())
