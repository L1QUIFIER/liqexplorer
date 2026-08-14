// Trash integration via the `gio` CLI (gvfsd-trash) — full Nemo interop.
//
// The parser is written against the REAL output of `gio list` on this machine
// (verified 2026-08-11):
//   <raw-name>\t<size>\t(<type>)\t<attr>=<v> <attr>=<v> ...
// - raw-name is gvfsd-trash's item name: plain for home-trash items, a
//   backslash-joined percent-encoded path for foreign-volume items
//   (`\mnt\cifs\private\.Trash-1000\files\Full%20size%20of%20x.png`), and
//   uniquified on collision (second `foo.txt` becomes `foo.2.txt` while its
//   standard::display-name stays `foo.txt`).
// - Item URI = 'trash:///' + encodeURIComponent(rawName)  [verified working,
//   including literal `%` and `\` in foreign-volume names]
// - Attribute VALUES contain spaces, so key=value pairs cannot be split on
//   whitespace — we scan for the known `key=` tokens instead.
// - Restore = `gio move <uri> <full-orig-path>` [verified]: moving to the
//   parent dir would keep the uniquified trash name (`foo.2.txt`), moving to
//   the explicit path restores the original basename. gio move silently
//   OVERWRITES an existing target [verified], so existence is checked first.
import { spawn } from 'node:child_process'
import * as fsp from 'node:fs/promises'
import * as path from 'node:path'
import type { FileEntry } from '../../shared/types'

function gio(args: string[]): Promise<{ code: number; out: string; err: string }> {
  return new Promise(resolve => {
    const c = spawn('gio', args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    let err = ''
    c.stdout.on('data', d => { out += String(d) })
    c.stderr.on('data', d => { err += String(d) })
    c.on('error', e => resolve({ code: -1, out, err: String(e) }))
    c.on('close', code => resolve({ code: code ?? -1, out, err }))
  })
}

function uriForItemName(rawName: string): string {
  return 'trash:///' + encodeURIComponent(rawName)
}

/** accepts either a full trash:/// URI (our FileEntry.path) or a raw item name */
function asTrashUri(p: string): string {
  return p.startsWith('trash://') ? p : uriForItemName(p)
}

// ---------- listing ----------

const LIST_ATTRS =
  'standard::display-name,standard::type,standard::size,time::modified,trash::orig-path,trash::deletion-date'

const ATTR_KEYS = [
  'standard::display-name',
  'time::modified',
  'trash::orig-path',
  'trash::deletion-date',
] as const

/** Attr values may contain spaces: locate known `key=` tokens, slice between them. */
function parseAttrs(s: string): Record<string, string> {
  const hits: { key: string; idx: number }[] = []
  for (const key of ATTR_KEYS) {
    const needle = key + '='
    let from = 0
    for (;;) {
      const i = s.indexOf(needle, from)
      if (i < 0) break
      if (i === 0 || s[i - 1] === ' ') hits.push({ key, idx: i })
      from = i + needle.length
    }
  }
  hits.sort((a, b) => a.idx - b.idx)
  const out: Record<string, string> = {}
  for (let i = 0; i < hits.length; i++) {
    const h = hits[i]
    const start = h.idx + h.key.length + 1
    const end = i + 1 < hits.length ? hits[i + 1].idx - 1 : s.length
    out[h.key] = s.slice(start, end)
  }
  return out
}

/** 'YYYY-MM-DDThh:mm:ss' (local time per trash spec) -> epoch ms */
function parseDeletionDate(s: string | undefined): number | undefined {
  if (!s) return undefined
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})/.exec(s)
  if (!m) return undefined
  return new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]).getTime()
}

/** last path segment of a raw gvfsd-trash item name, decoded (fallback display name) */
function fallbackDisplayName(rawName: string): string {
  const seg = rawName.split('\\').pop() ?? rawName
  try { return decodeURIComponent(seg) } catch { return seg }
}

// small extension -> mime map for trash entries (best-effort; no sniffing)
const EXT_MIME: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
  webp: 'image/webp', bmp: 'image/bmp', svg: 'image/svg+xml', ico: 'image/vnd.microsoft.icon',
  avif: 'image/avif', heic: 'image/heif', tif: 'image/tiff', tiff: 'image/tiff',
  mp4: 'video/mp4', mkv: 'video/x-matroska', avi: 'video/x-msvideo', mov: 'video/quicktime',
  webm: 'video/webm', wmv: 'video/x-ms-wmv', m4v: 'video/mp4', mpg: 'video/mpeg',
  mp3: 'audio/mpeg', flac: 'audio/flac', ogg: 'audio/ogg', wav: 'audio/x-wav',
  m4a: 'audio/mp4', opus: 'audio/ogg', wma: 'audio/x-ms-wma',
  pdf: 'application/pdf', zip: 'application/zip', '7z': 'application/x-7z-compressed',
  rar: 'application/vnd.rar', tar: 'application/x-tar', gz: 'application/gzip',
  xz: 'application/x-xz', bz2: 'application/x-bzip2', iso: 'application/x-cd-image',
  deb: 'application/vnd.debian.binary-package', appimage: 'application/x-executable',
  txt: 'text/plain', md: 'text/markdown', log: 'text/plain', csv: 'text/csv',
  html: 'text/html', htm: 'text/html', css: 'text/css', js: 'text/javascript',
  ts: 'text/x-typescript', json: 'application/json', xml: 'application/xml',
  py: 'text/x-python', sh: 'application/x-shellscript', c: 'text/x-c', h: 'text/x-c',
  cpp: 'text/x-c++', rs: 'text/x-rust', go: 'text/x-go',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  odt: 'application/vnd.oasis.opendocument.text',
  ods: 'application/vnd.oasis.opendocument.spreadsheet',
  desktop: 'application/x-desktop', exe: 'application/x-ms-dos-executable',
  ttf: 'font/ttf', otf: 'font/otf', woff2: 'font/woff2',
}

function mimeForName(name: string, isDir: boolean): string {
  if (isDir) return 'inode/directory'
  const ext = path.extname(name).slice(1).toLowerCase()
  return EXT_MIME[ext] ?? 'application/octet-stream'
}

function iconsForMime(mime: string, isDir: boolean): string[] {
  if (isDir) return ['folder']
  const specific = mime.replace('/', '-')
  const cat = mime.split('/')[0]
  const generic =
    cat === 'image' ? 'image-x-generic' :
    cat === 'video' ? 'video-x-generic' :
    cat === 'audio' ? 'audio-x-generic' :
    cat === 'text' ? 'text-x-generic' :
    cat === 'font' ? 'font-x-generic' :
    'application-x-generic'
  return specific === generic ? [generic] : [specific, generic]
}

function parseListLine(line: string): FileEntry | null {
  const parts = line.split('\t')
  if (parts.length < 3) return null
  const rawName = parts[0]
  if (!rawName) return null
  const size = Number(parts[1])
  const isDir = parts[2] === '(directory)'
  const attrs = parseAttrs(parts.slice(3).join('\t'))
  const name = attrs['standard::display-name'] || fallbackDisplayName(rawName)
  const mtimeSec = Number(attrs['time::modified'])
  const mtime = Number.isFinite(mtimeSec) ? mtimeSec * 1000 : 0
  const mime = mimeForName(name, isDir)
  return {
    name,
    path: uriForItemName(rawName),
    isDir,
    isSymlink: false,
    size: isDir ? -1 : (Number.isFinite(size) ? size : 0),
    mtime,
    ctime: mtime,
    mime,
    icons: iconsForMime(mime, isDir),
    hidden: name.startsWith('.'),
    ext: isDir ? '' : path.extname(name).slice(1).toLowerCase(),
    trashOrigPath: attrs['trash::orig-path'] || undefined,
    trashDeletedAt: parseDeletionDate(attrs['trash::deletion-date']),
  }
}

export async function listTrash(): Promise<FileEntry[]> {
  const { code, out, err } = await gio(['list', '-a', LIST_ATTRS, 'trash:///'])
  if (code !== 0) throw new Error(err.trim() || 'Could not read the Recycle Bin')
  const entries: FileEntry[] = []
  for (const line of out.split('\n')) {
    if (!line.trim()) continue
    const e = parseListLine(line)
    if (e) entries.push(e)
  }
  return entries
}

// ---------- restore ----------

async function origPathFor(uri: string): Promise<string | null> {
  const { code, out } = await gio(['info', '-a', 'trash::orig-path', uri])
  if (code !== 0) return null
  const m = /^\s*trash::orig-path:\s*(.+)$/m.exec(out)
  return m ? m[1] : null
}

export interface RestoreResult { ok: boolean; error?: string }

/** Restore a single trash item (trash:/// URI or raw item name) to its original path. */
export async function restoreOne(pathOrUri: string): Promise<RestoreResult> {
  const uri = asTrashUri(pathOrUri)
  const orig = await origPathFor(uri)
  if (!orig) return { ok: false, error: 'The original location of this item is unknown.' }
  const parent = path.dirname(orig)
  await fsp.mkdir(parent, { recursive: true }).catch(() => { /* surfaced by the move below */ })
  // gio move silently overwrites [verified] — never let a restore clobber a newer file
  const occupied = await fsp.lstat(orig).then(() => true, () => false)
  if (occupied) {
    return { ok: false, error: `An item named "${path.basename(orig)}" already exists in ${parent}.` }
  }
  const { code, err } = await gio(['move', uri, orig])
  if (code !== 0) return { ok: false, error: err.trim() || `Could not restore "${path.basename(orig)}"` }
  return { ok: true }
}

export async function restoreTrash(paths: string[]): Promise<void> {
  const errors: string[] = []
  for (const p of paths) {
    const r = await restoreOne(p)
    if (!r.ok && r.error) errors.push(r.error)
  }
  if (errors.length) throw new Error(errors.join('\n'))
}

/**
 * trash:/// URIs for given original paths (latest deletion wins) — used by undo
 * of a trash op. gvfsd-trash indexes new items with a short async delay
 * (measured ~1s on this machine), so an instant Ctrl+Z after trashing would
 * miss them — retry until every path is matched or ~2.5s have passed.
 */
export async function urisForOrigPaths(origPaths: string[]): Promise<string[]> {
  const want = new Set(origPaths)
  const best = new Map<string, { uri: string; at: number }>()
  for (let attempt = 0; attempt < 5; attempt++) {
    if (attempt > 0) await new Promise(res => setTimeout(res, 500))
    for (const e of await listTrash().catch(() => [] as FileEntry[])) {
      const op = e.trashOrigPath
      if (!op || !want.has(op)) continue
      const at = e.trashDeletedAt ?? 0
      const cur = best.get(op)
      if (!cur || at > cur.at) best.set(op, { uri: e.path, at })
    }
    if (best.size === want.size) break
  }
  return origPaths.map(p => best.get(p)?.uri).filter((u): u is string => !!u)
}

// ---------- delete / empty ----------

/** Permanently delete a single item from the trash (`gio remove trash:///name` [verified]). */
export async function removeOne(pathOrUri: string): Promise<{ ok: boolean; error?: string }> {
  const uri = asTrashUri(pathOrUri)
  const { code, err } = await gio(['remove', uri])
  if (code !== 0) return { ok: false, error: err.trim() || 'Could not delete the item' }
  return { ok: true }
}

export async function emptyTrash(): Promise<void> {
  const { code, err } = await gio(['trash', '--empty'])
  if (code !== 0) throw new Error(err.trim() || 'Could not empty the Recycle Bin')
}

export async function itemCount(): Promise<number> {
  const { code, out } = await gio(['info', '-a', 'trash::item-count', 'trash:///'])
  if (code !== 0) return 0
  const m = /trash::item-count:\s*(\d+)/.exec(out)
  return m ? Number(m[1]) : 0
}
