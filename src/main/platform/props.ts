// Properties dialog data: full stat (symlink-aware), owner/group names,
// Windows-style friendly type labels, Open With candidates, drive capacity,
// and the streamed recursive size scan (PUSH.propsSize) that makes the
// "Size / Contains" rows tick upward like Explorer's.

import type { WebContents } from 'electron'
import * as fs from 'node:fs'
import * as fsp from 'node:fs/promises'
import * as path from 'node:path'
import type { PropertiesData } from '../../shared/types'
import { PUSH } from '../../shared/ipc'
import { mimeForName, iconsForMime, folderIcons } from '../fs/mime'
import { listAppsFor } from './apps'
import { isRemotePath } from './protocols'
import { isMountPoint } from './places'

// ---------------------------------------------------------------------------
// owner / group name resolution (/etc/passwd, /etc/group; 60s cache)
// ---------------------------------------------------------------------------

let idsAt = 0
const uidNames = new Map<number, string>()
const gidNames = new Map<number, string>()

function loadIds(): void {
  if (Date.now() - idsAt < 60_000) return
  idsAt = Date.now()
  uidNames.clear()
  gidNames.clear()
  for (const [file, map] of [['/etc/passwd', uidNames], ['/etc/group', gidNames]] as const) {
    let txt = ''
    try { txt = fs.readFileSync(file, 'utf8') } catch { continue }
    for (const line of txt.split('\n')) {
      const parts = line.split(':')
      if (parts.length < 3) continue
      const id = parseInt(parts[2], 10)
      if (Number.isFinite(id) && !map.has(id)) map.set(id, parts[0])
    }
  }
}

function ownerName(uid: number): string { loadIds(); return uidNames.get(uid) ?? String(uid) }
function groupName(gid: number): string { loadIds(); return gidNames.get(gid) ?? String(gid) }

// ---------------------------------------------------------------------------
// permissions
// ---------------------------------------------------------------------------

function permText(mode: number): string {
  let s = ''
  const bits = [
    [0o400, 'r'], [0o200, 'w'], [0o100, 'x'],
    [0o040, 'r'], [0o020, 'w'], [0o010, 'x'],
    [0o004, 'r'], [0o002, 'w'], [0o001, 'x'],
  ] as const
  for (const [b, c] of bits) s += (mode & b) ? c : '-'
  if (mode & 0o4000) s = s.slice(0, 2) + ((mode & 0o100) ? 's' : 'S') + s.slice(3)
  if (mode & 0o2000) s = s.slice(0, 5) + ((mode & 0o010) ? 's' : 'S') + s.slice(6)
  if (mode & 0o1000) s = s.slice(0, 8) + ((mode & 0o001) ? 't' : 'T')
  return s
}

function permOctal(mode: number): string {
  return (mode & 0o7777).toString(8).padStart(3, '0')
}

// ---------------------------------------------------------------------------
// friendly type labels (Windows Explorer "Type of file" wording)
// ---------------------------------------------------------------------------

const TYPE_NAMES: Record<string, string> = {
  'inode/directory': 'File folder',
  'inode/symlink': 'Shortcut',
  'text/plain': 'Text Document',
  'text/markdown': 'Markdown Document',
  'text/html': 'HTML Document',
  'text/css': 'CSS Document',
  'text/csv': 'CSV File',
  'text/x-python': 'Python File',
  'application/pdf': 'PDF Document',
  'image/png': 'PNG File',
  'image/jpeg': 'JPEG File',
  'image/gif': 'GIF File',
  'image/webp': 'WebP File',
  'image/bmp': 'BMP File',
  'image/tiff': 'TIFF File',
  'image/avif': 'AVIF File',
  'image/svg+xml': 'SVG Image',
  'image/vnd.microsoft.icon': 'Icon',
  'video/mp4': 'MP4 Video',
  'video/x-matroska': 'MKV Video',
  'video/webm': 'WebM Video',
  'video/quicktime': 'QuickTime Video',
  'video/x-msvideo': 'AVI Video',
  'video/x-ms-wmv': 'WMV Video',
  'video/mpeg': 'MPEG Video',
  'audio/mpeg': 'MP3 Audio',
  'audio/flac': 'FLAC Audio',
  'audio/x-wav': 'WAV Audio',
  'audio/ogg': 'OGG Audio',
  'audio/mp4': 'M4A Audio',
  'audio/x-m4a': 'M4A Audio',
  'application/zip': 'Compressed (zipped) Folder',
  'application/x-7z-compressed': '7Z Archive',
  'application/vnd.rar': 'RAR Archive',
  'application/x-rar': 'RAR Archive',
  'application/x-tar': 'TAR Archive',
  'application/gzip': 'GZ Archive',
  'application/x-xz': 'XZ Archive',
  'application/x-bzip2': 'BZ2 Archive',
  'application/zstd': 'ZST Archive',
  'application/x-iso9660-image': 'Disc Image File',
  'application/json': 'JSON File',
  'application/xml': 'XML Document',
  'application/javascript': 'JavaScript File',
  'text/javascript': 'JavaScript File',
  'application/x-shellscript': 'Shell Script',
  'application/x-desktop': 'Desktop Configuration File',
  'application/x-executable': 'Executable',
  'application/x-pie-executable': 'Executable',
  'application/x-sharedlib': 'Shared Library',
  'application/x-ms-dos-executable': 'Application',
  'application/msword': 'Microsoft Word 97-2003 Document',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'Microsoft Word Document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'Microsoft Excel Worksheet',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'Microsoft PowerPoint Presentation',
  'application/vnd.oasis.opendocument.text': 'OpenDocument Text',
  'application/vnd.oasis.opendocument.spreadsheet': 'OpenDocument Spreadsheet',
  'font/ttf': 'TrueType Font file',
  'font/otf': 'OpenType Font file',
  'application/octet-stream': 'File',
}

function typeLabelFor(mime: string, ext: string, isDir: boolean): string {
  if (isDir) return 'File folder'
  const known = TYPE_NAMES[mime]
  const base = known
    ?? (ext ? `${ext.toUpperCase()} File`
      : mime.startsWith('text/') ? 'Text Document' : 'File')
  return ext ? `${base} (.${ext})` : base
}

// ---------------------------------------------------------------------------
// getProperties
// ---------------------------------------------------------------------------

async function isReadonly(p: string): Promise<boolean> {
  try { await fsp.access(p, fs.constants.W_OK); return false } catch { return true }
}

async function statfsCapacity(p: string): Promise<{ total: number; free: number } | undefined> {
  try {
    const st = await Promise.race([
      fsp.statfs(p),
      new Promise<null>(res => setTimeout(() => res(null), 2000).unref()),
    ])
    if (!st) return undefined
    return { total: st.bsize * st.blocks, free: st.bsize * st.bavail }
  } catch { return undefined }
}

function countLabel(files: number, dirs: number): string {
  const parts: string[] = []
  if (files) parts.push(`${files} File${files === 1 ? '' : 's'}`)
  if (dirs) parts.push(`${dirs} Folder${dirs === 1 ? '' : 's'}`)
  return parts.join(', ') || '0 Files'
}

export async function getProperties(paths: string[]): Promise<PropertiesData> {
  if (paths.length > 1) return getMultiProperties(paths)
  const p = paths[0]
  const lst = await fsp.lstat(p)
  const isSymlink = lst.isSymbolicLink()
  let st = lst
  let target: string | undefined
  if (isSymlink) {
    try { target = await fsp.readlink(p) } catch { /* broken link */ }
    try { st = await fsp.stat(p) } catch { st = lst }
  }
  const isDir = st.isDirectory()
  const name = path.basename(p) || p
  const ext = isDir ? '' : path.extname(name).slice(1).toLowerCase()
  const mime = mimeForName(name, isDir)
  const remote = isRemotePath(p)

  const data: PropertiesData = {
    paths,
    name,
    dir: path.dirname(p),
    mime,
    typeLabel: typeLabelFor(mime, ext, isDir),
    icons: isDir ? folderIcons(p) : iconsForMime(mime),
    isDir,
    isSymlink,
    target,
    size: isDir ? 0 : st.size,
    sizeOnDisk: isDir ? 0 : st.blocks * 512,
    mtime: st.mtimeMs,
    ctime: st.ctimeMs,
    btime: st.birthtimeMs > 0 ? st.birthtimeMs : undefined,
    atime: st.atimeMs,
    owner: ownerName(st.uid),
    group: groupName(st.gid),
    perms: {
      text: permText(st.mode),
      octal: permOctal(st.mode),
      readonly: await isReadonly(p),
    },
  }
  if (remote) data.permsImmutable = true          // chmod is a fiction on CIFS
  if (!isDir) {
    try { data.openWith = await listAppsFor(mime) } catch { /* leave unset */ }
  }
  if (isDir && isMountPoint(p)) {
    data.capacity = await statfsCapacity(p)
  }
  return data
}

async function getMultiProperties(paths: string[]): Promise<PropertiesData> {
  let files = 0
  let dirs = 0
  let size = 0
  let sizeOnDisk = 0
  let newestMtime = 0
  const mimes = new Set<string>()
  let firstStat: fs.Stats | null = null
  for (const p of paths) {
    try {
      const st = await fsp.lstat(p)
      if (!firstStat) firstStat = st
      if (st.isDirectory()) {
        dirs++
        mimes.add('inode/directory')
      } else {
        files++
        size += st.size
        sizeOnDisk += st.blocks * 512
        mimes.add(mimeForName(path.basename(p), false))
      }
      if (st.mtimeMs > newestMtime) newestMtime = st.mtimeMs
    } catch { /* vanished mid-select */ }
  }
  const uniform = mimes.size === 1 ? [...mimes][0] : null
  const firstName = path.basename(paths[0])
  const firstIsDir = dirs > 0 && files === 0
  const ext = uniform && !firstIsDir ? path.extname(firstName).slice(1).toLowerCase() : ''
  const typeLabel = uniform
    ? `All of type ${typeLabelFor(uniform, ext, uniform === 'inode/directory')}`
    : 'Multiple Types'
  const st = firstStat
  return {
    paths,
    name: countLabel(files, dirs),
    dir: path.dirname(paths[0]),
    mime: uniform ?? '',
    typeLabel,
    icons: uniform && uniform !== 'inode/directory' ? iconsForMime(uniform) : ['folder'],
    isDir: firstIsDir,
    isSymlink: false,
    size,
    sizeOnDisk,
    itemCount: { files, dirs },
    mtime: newestMtime,
    ctime: st?.ctimeMs ?? 0,
    atime: st?.atimeMs ?? 0,
    owner: st ? ownerName(st.uid) : '',
    group: st ? groupName(st.gid) : '',
    perms: {
      text: st ? permText(st.mode) : '---------',
      octal: st ? permOctal(st.mode) : '000',
      readonly: false,
    },
    permsImmutable: paths.some(p => isRemotePath(p)) || undefined,
  }
}

// ---------------------------------------------------------------------------
// streamed recursive size scan
// ---------------------------------------------------------------------------

let nextReq = 1
const scanByWc = new Map<WebContents, { cancelled: boolean }>()

export async function startSizeScan(wc: WebContents, paths: string[]): Promise<number> {
  const reqId = nextReq++
  const prev = scanByWc.get(wc)
  if (prev) prev.cancelled = true                 // a new scan supersedes the old
  const ctl = { cancelled: false }
  scanByWc.set(wc, ctl)
  void runScan(wc, paths, reqId, ctl)
  return reqId
}

async function runScan(
  wc: WebContents, paths: string[], reqId: number, ctl: { cancelled: boolean },
): Promise<void> {
  let size = 0
  let sizeOnDisk = 0
  let files = 0
  let dirs = 0
  const pending: string[] = []

  const send = (done: boolean) => {
    if (wc.isDestroyed()) { ctl.cancelled = true; return }
    wc.send(PUSH.propsSize, { reqId, size, sizeOnDisk, files, dirs, done })
  }

  for (const p of paths) {
    if (ctl.cancelled) return
    try {
      const st = await fsp.lstat(p)
      if (st.isDirectory()) {
        pending.push(p)
      } else {
        files++
        size += st.size
        sizeOnDisk += st.blocks * 512
      }
    } catch { /* vanished */ }
  }

  let lastSend = Date.now()
  const CONCURRENCY = 32

  await new Promise<void>(resolve => {
    let active = 0
    let resolved = false
    const finish = () => { if (!resolved) { resolved = true; resolve() } }

    const processDir = async (dir: string): Promise<void> => {
      let entries: fs.Dirent[]
      try { entries = await fsp.readdir(dir, { withFileTypes: true }) } catch { return }
      for (const de of entries) {
        if (ctl.cancelled) return
        const full = path.join(dir, de.name)
        if (de.isDirectory()) {
          dirs++
          pending.push(full)
        } else {
          files++
          try {
            const st = await fsp.lstat(full)
            size += st.size
            sizeOnDisk += st.blocks * 512
          } catch { /* unreadable entry still counts */ }
        }
      }
    }

    const pump = (): void => {
      if (ctl.cancelled) { if (active === 0) finish(); return }
      while (active < CONCURRENCY && pending.length) {
        const dir = pending.pop()!
        active++
        void processDir(dir).finally(() => {
          active--
          const now = Date.now()
          if (now - lastSend >= 250) { lastSend = now; send(false) }
          pump()
        })
      }
      if (active === 0 && !pending.length) finish()
    }
    pump()
  })

  if (ctl.cancelled) return
  send(true)
  if (scanByWc.get(wc) === ctl) scanByWc.delete(wc)
}
