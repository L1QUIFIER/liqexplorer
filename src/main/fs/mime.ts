// MIME detection + freedesktop icon names, from the shared-mime-info database.
// Parses globs2 (weighted glob table) and generic-icons once, on first use.
// No native deps: plain file parsing of /usr/share/mime (+ ~/.local/share/mime).
//
// globs2 line format:  weight:mime/type:pattern[:flags]   (flags: 'cs' = case-sensitive)
// Selection rule (xdgmime): highest weight wins; ties broken by longest pattern.
// A pattern of literally __NOGLOBS__ discards lower-precedence globs for that mime.

import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { customFolderIcon } from '../platform/foldericons'

interface GlobEntry {
  mime: string
  weight: number
  pattern: string
  patLen: number
  cs: boolean
}
interface CompiledGlob extends GlobEntry {
  re: RegExp
}

/** literal '*.ext' patterns, keyed by lowercased extension (may contain dots: 'tar.gz') */
const extMap = new Map<string, GlobEntry[]>()
/** everything else, compiled to anchored RegExp */
const globList: CompiledGlob[] = []
const genericIcons = new Map<string, string>()

let loaded = false

// ---------------------------------------------------------------- parsing

function globToRegExp(pattern: string, cs: boolean): RegExp {
  let out = ''
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i]
    if (c === '*') out += '.*'
    else if (c === '?') out += '.'
    else if (c === '[') {
      // copy a glob character class through ']' ('!' negation -> '^')
      let j = i + 1
      let cls = '['
      if (pattern[j] === '!') { cls += '^'; j++ }
      let closed = false
      for (; j < pattern.length; j++) {
        if (pattern[j] === ']' && cls.length > 1) { closed = true; break }
        cls += pattern[j] === '\\' || pattern[j] === '^' ? '\\' + pattern[j] : pattern[j]
      }
      if (closed) { out += cls + ']'; i = j } else out += '\\['
    } else {
      out += /[.+^${}()|\\\]]/.test(c) ? '\\' + c : c
    }
  }
  return new RegExp('^' + out + '$', cs ? '' : 'i')
}

/** literal extension glob: '*.' followed by no wildcard/class chars */
const LITERAL_EXT = /^\*\.[^*?[\]]+$/

function dropMime(mime: string): void {
  for (const [key, list] of extMap) {
    const kept = list.filter(e => e.mime !== mime)
    if (kept.length === 0) extMap.delete(key)
    else if (kept.length !== list.length) extMap.set(key, kept)
  }
  for (let i = globList.length - 1; i >= 0; i--) {
    if (globList[i].mime === mime) globList.splice(i, 1)
  }
}

function parseGlobs2(file: string): void {
  let txt: string
  try { txt = fs.readFileSync(file, 'utf8') } catch { return }
  for (const raw of txt.split('\n')) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const parts = line.split(':')
    if (parts.length < 3) continue
    const weight = parseInt(parts[0], 10)
    if (Number.isNaN(weight)) continue
    const mime = parts[1]
    let cs = false
    let end = parts.length
    if (parts.length >= 4 && parts[parts.length - 1].split(',').includes('cs')) { cs = true; end-- }
    const pattern = parts.slice(2, end).join(':')
    if (!pattern) continue
    if (pattern === '__NOGLOBS__') { dropMime(mime); continue }
    const entry: GlobEntry = { mime, weight, pattern, patLen: pattern.length, cs }
    if (LITERAL_EXT.test(pattern)) {
      const key = pattern.slice(2).toLowerCase()
      const list = extMap.get(key)
      if (list) list.push(entry)
      else extMap.set(key, [entry])
    } else {
      globList.push({ ...entry, re: globToRegExp(pattern, cs) })
    }
  }
}

function parseGenericIcons(file: string): void {
  let txt: string
  try { txt = fs.readFileSync(file, 'utf8') } catch { return }
  for (const raw of txt.split('\n')) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const i = line.indexOf(':')
    if (i <= 0) continue
    genericIcons.set(line.slice(0, i), line.slice(i + 1))
  }
}

function ensureLoaded(): void {
  if (loaded) return
  loaded = true
  const home = os.homedir()
  // system first, then user (user entries can override / __NOGLOBS__ system ones)
  parseGlobs2('/usr/share/mime/globs2')
  parseGlobs2(path.join(home, '.local/share/mime/globs2'))
  parseGenericIcons('/usr/share/mime/generic-icons')
  parseGenericIcons(path.join(home, '.local/share/mime/generic-icons'))
}

// ---------------------------------------------------------------- lookup

/** MIME type from filename globs alone (no content sniffing — fast path only). */
export function mimeForName(name: string, isDir: boolean): string {
  if (isDir) return 'inode/directory'
  ensureLoaded()
  let best: GlobEntry | null = null
  let bestExact = false
  // ties (same weight + length) go to the exact-case match — the db ships
  // '*.C':cs AND '*.C' side by side, so 'x.c' must prefer the exact '*.c' hit
  const consider = (e: GlobEntry, exact: boolean) => {
    if (!best
        || e.weight > best.weight
        || (e.weight === best.weight && (e.patLen > best.patLen
            || (e.patLen === best.patLen && exact && !bestExact)))) {
      best = e
      bestExact = exact
    }
  }
  // literal-extension fast map: try every dot-suffix ('a.tar.gz' -> 'tar.gz', 'gz')
  let idx = name.indexOf('.')
  while (idx !== -1 && idx < name.length - 1) {
    const suffix = name.slice(idx + 1)
    const list = extMap.get(suffix.toLowerCase())
    if (list) {
      for (const e of list) {
        const exact = suffix === e.pattern.slice(2)
        if (e.cs && !exact) continue
        consider(e, exact)
      }
    }
    idx = name.indexOf('.', idx + 1)
  }
  // general globs
  for (const g of globList) {
    if (g.re.test(name)) consider(g, g.cs)
  }
  return best ? (best as GlobEntry).mime : 'application/octet-stream'
}

const ARCHIVE_HINT = /zip|tar|7z|rar|archive|compress|bzip|gzip|lzma|[-.]xz|zstd|cpio|cab$|[-.]iso|squashfs|stuffit/
const EXEC_HINT = /x-(pie-)?executable|x-sharedlib|x-msdos-program|x-ms-dos-executable|x-msdownload/

/** freedesktop icon names for a mime type, best-first. */
// ---------------------------------------------------------------- type names
//
// The human name for a type ("PNG image", not "PNG File") is the <comment> in
// /usr/share/mime/<type>.xml. Explorer shows the registry's friendly name in
// its Type column and groups by it; this is the freedesktop equivalent. Read
// lazily and cached: a listing only ever touches a few dozen distinct types.

const labelCache = new Map<string, string | undefined>()

/** first locale-less <comment> of the type's XML description, if any */
export function mimeLabel(mime: string): string | undefined {
  const hit = labelCache.get(mime)
  if (hit !== undefined || labelCache.has(mime)) return hit
  let label: string | undefined
  for (const base of [path.join(os.homedir(), '.local/share/mime'), '/usr/share/mime']) {
    let xml: string
    try { xml = fs.readFileSync(path.join(base, mime + '.xml'), 'utf8') } catch { continue }
    // the untranslated comment comes first; xml:lang variants follow
    const m = /<comment>([^<]+)<\/comment>/.exec(xml)
    if (m) {
      label = m[1].replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
      break
    }
  }
  labelCache.set(mime, label)
  return label
}

export function iconsForMime(mime: string): string[] {
  ensureLoaded()
  const icons: string[] = [mime.replace('/', '-')]
  const gen = genericIcons.get(mime)
  if (gen) icons.push(gen)
  const major = mime.split('/')[0]
  let cat: string | null = null
  if (major === 'text') cat = 'text-x-generic'
  else if (major === 'image') cat = 'image-x-generic'
  else if (major === 'video') cat = 'video-x-generic'
  else if (major === 'audio') cat = 'audio-x-generic'
  else if (major === 'font') cat = 'font-x-generic'
  else if (major === 'application') {
    if (ARCHIVE_HINT.test(mime)) cat = 'package-x-generic'
    else if (EXEC_HINT.test(mime)) cat = 'application-x-executable'
  }
  if (cat) icons.push(cat)
  icons.push('text-x-generic')
  return [...new Set(icons)]
}

// ---------------------------------------------------------------- folders

let userDirsCache: Record<string, string> | null = null

/** XDG user dirs (DESKTOP, DOWNLOAD, ...) with $HOME expanded + defaults filled. */
export function xdgUserDirs(): Record<string, string> {
  if (userDirsCache) return userDirsCache
  const home = os.homedir()
  const out: Record<string, string> = {}
  try {
    const txt = fs.readFileSync(path.join(home, '.config/user-dirs.dirs'), 'utf8')
    for (const m of txt.matchAll(/^\s*XDG_(\w+)_DIR\s*=\s*"([^"]+)"/gm)) {
      out[m[1]] = m[2].replace(/^\$HOME/, home)
    }
  } catch { /* defaults below */ }
  const defaults: Record<string, string> = {
    DESKTOP: 'Desktop', DOWNLOAD: 'Downloads', DOCUMENTS: 'Documents',
    PICTURES: 'Pictures', MUSIC: 'Music', VIDEOS: 'Videos',
  }
  for (const [k, v] of Object.entries(defaults)) {
    if (!out[k]) out[k] = path.join(home, v)
  }
  userDirsCache = out
  return out
}

const SPECIAL_FOLDER_ICON: Record<string, string> = {
  DESKTOP: 'user-desktop',
  DOWNLOAD: 'folder-download',
  DOCUMENTS: 'folder-documents',
  PICTURES: 'folder-pictures',
  MUSIC: 'folder-music',
  VIDEOS: 'folder-videos',
  PUBLICSHARE: 'folder-publicshare',
  TEMPLATES: 'folder-templates',
}

let specialFolderMap: Map<string, string> | null = null

function specialFolders(): Map<string, string> {
  if (specialFolderMap) return specialFolderMap
  const home = os.homedir()
  const map = new Map<string, string>()
  map.set(home, 'user-home')
  const dirs = xdgUserDirs()
  for (const [key, icon] of Object.entries(SPECIAL_FOLDER_ICON)) {
    const p = dirs[key]
    if (p && p !== home) map.set(p.replace(/\/+$/, '') || '/', icon)
  }
  specialFolderMap = map
  return map
}

/** icon names for a directory: special XDG folders get their own icon, else 'folder'. */
export function folderIcons(dirPath: string): string[] {
  // a user-chosen icon wins over the special-folder mapping
  const custom = customFolderIcon(dirPath)
  if (custom) return [custom, 'folder']
  const norm = dirPath.replace(/\/+$/, '') || '/'
  const special = specialFolders().get(norm)
  return special ? [special, 'folder'] : ['folder']
}
