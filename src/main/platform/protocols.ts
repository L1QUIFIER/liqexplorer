// Custom protocols.
//
//   liqicon://<name-or-comma-list>?size=N
//     -> freedesktop icon-theme lookup (icons.ts), served with long cache.
//
//   liqthumb://?path=<encodeURIComponent(abs path)>&size=normal|large|x-large|xx-large
//     -> freedesktop thumbnail cache (~/.cache/thumbnails). URI hashing is
//        byte-identical to GIO/Nemo (g_file_get_uri percent-encoding, verified
//        against 2000 live cache entries). On miss we run the matching
//        /usr/share/thumbnailers entry (max 4 concurrent, 10s timeout), inject
//        Thumb::URI/Thumb::MTime tEXt chunks, chmod 0600 and atomically rename
//        into the shared cache; failures get a marker in fail/liqexplorer/.
//
//   liqfile://file/?path=<encodeURIComponent(abs path)>[&type=<mime>]
//     -> raw bytes for the preview pane (<img>/<video>/<audio>/<embed>), with
//        real HTTP range support so media seeking works. UNLIKE the two schemes
//        above this one MUST be registered `standard: true` — see the note in
//        shared/preview.ts: a non-standard scheme makes Chromium reject every
//        resumed media range request, which preload="metadata" guarantees.

import { ipcMain, net, protocol } from 'electron'
import { spawn } from 'node:child_process'
import * as crypto from 'node:crypto'
import * as fs from 'node:fs'
import * as fsp from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import * as zlib from 'node:zlib'
import { Readable } from 'node:stream'
import { pathToFileURL } from 'node:url'
import { resolveIcon } from './icons'
import { mimeForName } from '../fs/mime'
import { getSettings } from '../state/settings'
import { FOLDER_ICON_DIR, customFolderIcon } from './foldericons'
import { composeFolderThumb, scanForMedia, TILES } from './folderthumb'

/** honours the View setting; a cached thumbnail is still served when off */
function thumbnailsRemoteEnabled(): boolean {
  try { return getSettings().thumbnailsRemote !== false } catch { return true }
}

function folderPreviewsEnabled(): boolean {
  try { return getSettings().folderPreviews !== false } catch { return true }
}
import { CH } from '../../shared/ipc'
import { LIQFILE_HOST } from '../../shared/preview'
import './preview'          // self-registers previewText / previewTags over IPC
import { registerPlayProtocol } from './transcode'
import './mediawindow'      // self-registers mediaPopout* (the floating viewer's separate window)
import '../fs/peek'         // self-registers peekDir / peekCancel over IPC

export function protocolPrivileges() {
  return [
    { scheme: 'liqicon', privileges: { standard: false, secure: true, supportFetchAPI: true } },
    { scheme: 'liqthumb', privileges: { standard: false, secure: true, supportFetchAPI: true } },
    {
      scheme: 'liqfile',
      privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true },
    },
    {
      // same privileges as liqfile: `stream` is what lets a <video> consume the
      // response progressively instead of waiting for it to finish
      scheme: 'liqplay',
      privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true },
    },
  ]
}

// ---------------------------------------------------------------------------
// GIO-exact file:// URI encoding.
// g_file_get_uri percent-encodes every byte EXCEPT unreserved
// (A-Za-z0-9 - . _ ~) and ! $ & ' ( ) * + , ; = : @ /  — uppercase hex,
// byte-wise over UTF-8. Verified: md5 of this URI matches the filenames of
// existing ~/.cache/thumbnails entries written by Nemo/GIO on this machine.
// ---------------------------------------------------------------------------

const URI_KEEP = (() => {
  const keep = new Uint8Array(256)
  const chars =
    'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789' +
    "-._~!$&'()*+,;=:@/"
  for (const c of chars) keep[c.charCodeAt(0)] = 1
  return keep
})()

export function gioEncodeFileUri(absPath: string): string {
  const bytes = Buffer.from(absPath, 'utf8')
  let out = ''
  for (const b of bytes) {
    out += URI_KEEP[b] ? String.fromCharCode(b) : '%' + b.toString(16).toUpperCase().padStart(2, '0')
  }
  return 'file://' + out
}

// ---------------------------------------------------------------------------
// Minimal PNG chunk reading/writing (tEXt) with CRC32.
// ---------------------------------------------------------------------------

const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1)
    t[n] = c >>> 0
  }
  return t
})()

function crc32(buf: Buffer): number {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

interface PngChunk { type: string; data: Buffer }

function pngChunks(buf: Buffer): PngChunk[] | null {
  if (buf.length < 8 || !buf.subarray(0, 8).equals(PNG_SIG)) return null
  const out: PngChunk[] = []
  let pos = 8
  while (pos + 12 <= buf.length) {
    const len = buf.readUInt32BE(pos)
    const type = buf.toString('latin1', pos + 4, pos + 8)
    if (pos + 12 + len > buf.length) return null
    out.push({ type, data: buf.subarray(pos + 8, pos + 8 + len) })
    pos += 12 + len
    if (type === 'IEND') break
  }
  return out
}

/** Read tEXt key/value pairs from a PNG buffer. */
function pngReadText(buf: Buffer): Record<string, string> {
  const out: Record<string, string> = {}
  const chunks = pngChunks(buf)
  if (!chunks) return out
  for (const c of chunks) {
    if (c.type !== 'tEXt') continue
    const nul = c.data.indexOf(0)
    if (nul < 0) continue
    out[c.data.toString('latin1', 0, nul)] = c.data.toString('latin1', nul + 1)
  }
  return out
}

function makeChunk(type: string, data: Buffer): Buffer {
  const head = Buffer.alloc(8)
  head.writeUInt32BE(data.length, 0)
  head.write(type, 4, 'latin1')
  const crcBuf = Buffer.alloc(4)
  crcBuf.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type, 'latin1'), data])), 0)
  return Buffer.concat([head, data, crcBuf])
}

/** Rewrite a PNG replacing/adding the given tEXt keys (inserted before IEND). */
function pngSetText(buf: Buffer, entries: Record<string, string>): Buffer | null {
  const chunks = pngChunks(buf)
  if (!chunks || !chunks.some(c => c.type === 'IEND')) return null
  const parts: Buffer[] = [PNG_SIG]
  for (const c of chunks) {
    if (c.type === 'tEXt') {
      const nul = c.data.indexOf(0)
      const key = nul >= 0 ? c.data.toString('latin1', 0, nul) : ''
      if (key in entries) continue                    // replaced below
    }
    if (c.type === 'IEND') {
      for (const [k, v] of Object.entries(entries)) {
        parts.push(makeChunk('tEXt', Buffer.concat([
          Buffer.from(k, 'latin1'), Buffer.from([0]), Buffer.from(v, 'latin1'),
        ])))
      }
    }
    parts.push(makeChunk(c.type, c.data))
  }
  return Buffer.concat(parts)
}

/** 1x1 grey PNG carrying the given tEXt entries (fail marker). */
function makeMarkerPng(entries: Record<string, string>): Buffer {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(1, 0)      // width
  ihdr.writeUInt32BE(1, 4)      // height
  ihdr[8] = 8                   // bit depth
  ihdr[9] = 0                   // color type: greyscale
  const idat = zlib.deflateSync(Buffer.from([0, 0x80]))  // filter 0 + one pixel
  const base = Buffer.concat([
    PNG_SIG, makeChunk('IHDR', ihdr), makeChunk('IDAT', idat), makeChunk('IEND', Buffer.alloc(0)),
  ])
  return pngSetText(base, entries) ?? base
}

// ---------------------------------------------------------------------------
// Extension -> MIME via shared-mime-info globs2 (suffix globs only — enough to
// pick a thumbnailer; full mime detection lives in the listing pipeline).
// ---------------------------------------------------------------------------

let extMime: Map<string, { mime: string; weight: number }> | null = null

function mimeForExt(filePath: string): string | null {
  if (!extMime) {
    extMime = new Map()
    for (const f of ['/usr/share/mime/globs2', path.join(os.homedir(), '.local/share/mime/globs2')]) {
      let txt = ''
      try { txt = fs.readFileSync(f, 'utf8') } catch { continue }
      for (const line of txt.split('\n')) {
        if (!line || line.startsWith('#')) continue
        const parts = line.split(':')
        if (parts.length < 3) continue
        const weight = parseInt(parts[0], 10) || 0
        const mime = parts[1]
        const glob = parts[2]
        if (!glob.startsWith('*.') || glob.includes('[') || glob.slice(2).includes('*')) continue
        const ext = glob.slice(2).toLowerCase()
        const prev = extMime.get(ext)
        if (!prev || weight > prev.weight) extMime.set(ext, { mime, weight })
      }
    }
  }
  const ext = path.extname(filePath).slice(1).toLowerCase()
  if (!ext) return null
  return extMime.get(ext)?.mime ?? null
}

// ---------------------------------------------------------------------------
// Thumbnailer registry (/usr/share/thumbnailers + ~/.local/share/thumbnailers)
// ---------------------------------------------------------------------------

interface Thumbnailer { argv: string[] }

let thumbnailers: Map<string, Thumbnailer> | null = null   // mime -> entry

function execInPath(cmd: string): boolean {
  if (cmd.startsWith('/')) { try { fs.accessSync(cmd, fs.constants.X_OK); return true } catch { return false } }
  for (const dir of (process.env.PATH ?? '/usr/bin:/bin').split(':')) {
    try { fs.accessSync(path.join(dir, cmd), fs.constants.X_OK); return true } catch { /* next */ }
  }
  return false
}

function splitExec(exec: string): string[] {
  const out: string[] = []
  let cur = ''
  let q: string | null = null
  for (let i = 0; i < exec.length; i++) {
    const ch = exec[i]
    if (q) {
      if (ch === q) q = null
      else if (ch === '\\' && q === '"' && i + 1 < exec.length) cur += exec[++i]
      else cur += ch
    } else if (ch === '"' || ch === "'") q = ch
    else if (ch === ' ' || ch === '\t') { if (cur) { out.push(cur); cur = '' } }
    else cur += ch
  }
  if (cur) out.push(cur)
  return out
}

function loadThumbnailers(): Map<string, Thumbnailer> {
  if (thumbnailers) return thumbnailers
  thumbnailers = new Map()
  const dirs = ['/usr/share/thumbnailers', path.join(os.homedir(), '.local/share/thumbnailers')]
  for (const dir of dirs) {
    let names: string[] = []
    try { names = fs.readdirSync(dir) } catch { continue }
    for (const n of names) {
      if (!n.endsWith('.thumbnailer')) continue
      let txt = ''
      try { txt = fs.readFileSync(path.join(dir, n), 'utf8') } catch { continue }
      let inEntry = false
      let exec = ''
      let tryExec = ''
      let mimes: string[] = []
      for (const raw of txt.split('\n')) {
        const line = raw.trim()
        if (line.startsWith('[')) { inEntry = line === '[Thumbnailer Entry]'; continue }
        if (!inEntry) continue
        const eq = line.indexOf('=')
        if (eq < 0) continue
        const k = line.slice(0, eq).trim()
        const v = line.slice(eq + 1).trim()
        if (k === 'Exec') exec = v
        else if (k === 'TryExec') tryExec = v
        else if (k === 'MimeType') mimes = v.split(';').map(s => s.trim()).filter(Boolean)
      }
      if (!exec || !mimes.length) continue
      const argv = splitExec(exec)
      if (!argv.length) continue
      if (tryExec && !execInPath(tryExec)) continue
      if (!execInPath(argv[0])) continue
      for (const m of mimes) if (!thumbnailers.has(m)) thumbnailers.set(m, { argv })
    }
  }
  return thumbnailers
}

// ---------------------------------------------------------------------------
// Remote-mount detection (cifs/nfs prefixes from /proc/self/mountinfo)
// ---------------------------------------------------------------------------

let remotePrefixes: string[] = []
let remoteReadAt = 0

function unescapeMountPath(s: string): string {
  return s.replace(/\\(\d{3})/g, (_, oct: string) => String.fromCharCode(parseInt(oct, 8)))
}

export function isRemotePath(p: string): boolean {
  const now = Date.now()
  if (now - remoteReadAt > 5000) {
    remoteReadAt = now
    remotePrefixes = []
    try {
      const txt = fs.readFileSync('/proc/self/mountinfo', 'utf8')
      for (const line of txt.split('\n')) {
        const sep = line.indexOf(' - ')
        if (sep < 0) continue
        const fstype = line.slice(sep + 3).split(' ')[0]
        if (fstype === 'cifs' || fstype === 'smb3' || fstype.startsWith('nfs') || fstype === 'fuse.sshfs') {
          const mp = unescapeMountPath(line.split(' ')[4] ?? '')
          if (mp) remotePrefixes.push(mp.endsWith('/') ? mp : mp + '/')
        }
      }
    } catch { /* keep empty */ }
  }
  return remotePrefixes.some(pre => (p + '/').startsWith(pre))
}

// ---------------------------------------------------------------------------
// Thumbnail cache + generation
// ---------------------------------------------------------------------------

type ThumbSize = 'normal' | 'large' | 'x-large' | 'xx-large'
const SIZE_ORDER: ThumbSize[] = ['normal', 'large', 'x-large', 'xx-large']
const SIZE_PX: Record<ThumbSize, number> = { normal: 128, large: 256, 'x-large': 512, 'xx-large': 1024 }
// Size limits for GENERATING a thumbnail of a file on a network mount (a
// cached thumbnail is always served regardless). One blanket 50MB cap used to
// apply, which silently killed previews for exactly the files people most want
// them for — a folder of videos on the SMB share. Measured on this machine:
// ffmpegthumbnailer SEEKS to a frame, so a video thumbnail off the share takes
// ~0.1s no matter how big the file is, while an image must be read whole.
// Hence per-type limits rather than one number.
const REMOTE_LIMITS = {
  video: 16 * 1024 * 1024 * 1024,   // seek-based: size is irrelevant
  image: 512 * 1024 * 1024,         // read whole; still generous
  other: 128 * 1024 * 1024,         // pdf/office/etc: read whole, usually small
}

function remoteLimitFor(mime: string): number {
  if (mime.startsWith('video/')) return REMOTE_LIMITS.video
  if (mime.startsWith('image/')) return REMOTE_LIMITS.image
  return REMOTE_LIMITS.other
}

function cacheRoot(): string {
  return process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache')
}

/** in-memory negative cache: md5 -> file mtime (seconds) that failed */
const negCache = new Map<string, number>()
/** de-dupe concurrent generation per md5 */
const inflight = new Map<string, Promise<Buffer | null>>()

// generation queue: max 4 thumbnailer processes at once
let running = 0
const queue: (() => void)[] = []

// Thumbnailers are short-lived and mostly I/O bound;
// 4 at a time left a big folder trickling in. Bounded so a pathological folder
// still cannot fork-bomb the machine.
const MAX_THUMB_JOBS = Math.max(4, Math.min(8, os.cpus().length >> 2))

/**
 * BACKPRESSURE WHILE A VIDEO IS STARTING.
 *
 * The grid thumbnailer and the media player read the same CIFS share, and the
 * thumbnailer wins by weight of numbers: eight processes each pulling frames
 * out of files the user is scrolling past, against one player trying to fill
 * its buffer. The player is the thing the user is looking at, so for a short
 * window it gets the share to itself and the thumbnail backlog waits.
 *
 * A HOLD IS A LEASE, NOT A LOCK. It expires on its own, because the alternative
 * is that one dropped release (a crashed renderer, a media element that never fires
 * its event) silently stops thumbnails for the rest of the session.
 */
const HOLD_MS = 4_000
let holdUntil = 0
let holdTimer: NodeJS.Timeout | null = null

export function holdThumbnails(ms = HOLD_MS): void {
  holdUntil = Math.max(holdUntil, Date.now() + ms)
  if (holdTimer) clearTimeout(holdTimer)
  holdTimer = setTimeout(() => { holdTimer = null; drainQueue() }, Math.max(0, holdUntil - Date.now()))
  holdTimer.unref?.()
}

export function releaseThumbnails(): void {
  holdUntil = 0
  if (holdTimer) { clearTimeout(holdTimer); holdTimer = null }
  drainQueue()
}

/** let the backlog through in a trickle rather than all at once: eight probes
 *  starting the instant a video reaches steady state would stutter it again */
function drainQueue(): void {
  let n = 0
  while (running < MAX_THUMB_JOBS && queue.length && n < 2) {
    const next = queue.pop()
    if (!next) break
    next()
    n++
  }
  if (queue.length) setTimeout(drainQueue, 120).unref?.()
}

function acquireSlot(): Promise<void> {
  const held = Date.now() < holdUntil
  if (!held && running < MAX_THUMB_JOBS) { running++; return Promise.resolve() }
  return new Promise(res => queue.push(() => { running++; res() }))
}

function releaseSlot(): void {
  running--
  if (Date.now() < holdUntil) return   // a video is loading; the backlog waits
  // LIFO, not FIFO: while scrolling, the newest requests are the tiles actually
  // on screen. Served oldest-first, a fast scroll through a large folder spends
  // its budget rendering rows the user has already passed.
  const next = queue.pop()
  if (next) next()
}

function runThumbnailer(t: Thumbnailer, filePath: string, uri: string, outPath: string, px: number): Promise<boolean> {
  const argv = t.argv.map(a => a
    .replace(/%%/g, '\0PCT\0')
    .replace(/%s/g, String(px))
    .replace(/%u/g, uri)
    .replace(/%i/g, filePath)
    .replace(/%o/g, outPath)
    .replace(/\0PCT\0/g, '%'))
  return new Promise(resolve => {
    let done = false
    const child = spawn(argv[0], argv.slice(1), { stdio: 'ignore' })
    const timer = setTimeout(() => {
      if (!done) { done = true; try { child.kill('SIGKILL') } catch { /* gone */ } resolve(false) }
    }, 10_000)
    child.on('error', () => { if (!done) { done = true; clearTimeout(timer); resolve(false) } })
    child.on('exit', code => { if (!done) { done = true; clearTimeout(timer); resolve(code === 0) } })
  })
}

let tmpCounter = 0

async function writeAtomic(finalPath: string, data: Buffer): Promise<void> {
  await fsp.mkdir(path.dirname(finalPath), { recursive: true, mode: 0o700 })
  const tmp = `${finalPath}.liqtmp-${process.pid}-${tmpCounter++}`
  await fsp.writeFile(tmp, data, { mode: 0o600 })
  await fsp.rename(tmp, finalPath)
}

async function readValidThumb(file: string, uri: string, mtimeSec: number): Promise<Buffer | null> {
  let buf: Buffer
  try { buf = await fsp.readFile(file) } catch { return null }
  const text = pngReadText(buf)
  if (text['Thumb::MTime'] !== String(mtimeSec)) return null
  if (text['Thumb::URI'] !== undefined && text['Thumb::URI'] !== uri) return null
  return buf
}

/**
 * A folder's thumbnail: what is inside it, inlaid into a folder shape.
 *
 * Shares everything with the file path above — the same cache directory, the
 * same Thumb::URI/Thumb::MTime validation, the same concurrency slot, the same
 * inflight de-duplication and the same fail marker. Only the generation step
 * differs, so a folder cannot become a second, separately-broken thumbnail
 * system.
 *
 * The fail marker matters more here than anywhere else: most folders on a
 * machine hold no pictures at all, and without it every listing would rescan
 * every one of them. With it, a folder is looked at once and then left alone
 * until its mtime changes.
 */
/** the biggest already-cached thumbnail for a file, or null if it has none */
async function cachedThumbPath(file: string): Promise<string | null> {
  const hash = crypto.createHash('md5').update(gioEncodeFileUri(file), 'utf8').digest('hex')
  for (let i = SIZE_ORDER.length - 1; i >= 0; i--) {
    const p = path.join(cacheRoot(), 'thumbnails', SIZE_ORDER[i], `${hash}.png`)
    try { await fsp.stat(p); return p } catch { /* next size down */ }
  }
  return null
}

async function generateFolderThumb(dir: string, uri: string, hash: string, size: ThumbSize, mtimeSec: number): Promise<Buffer | null> {
  const existing = inflight.get(hash)
  if (existing) return existing
  const p = (async (): Promise<Buffer | null> => {
    const failDir = path.join(cacheRoot(), 'thumbnails', 'fail', 'liqexplorer')
    const fail = async (): Promise<null> => {
      negCache.set(hash, mtimeSec)
      if (negCache.size > 10_000) negCache.clear()
      try {
        await writeAtomic(path.join(failDir, `${hash}.png`),
          makeMarkerPng({ 'Thumb::URI': uri, 'Thumb::MTime': String(mtimeSec) }))
      } catch { /* marker is best-effort */ }
      return null
    }
    await acquireSlot()
    try {
      const { images, videos } = await scanForMedia(dir)
      // Prefer the cached thumbnail of each picture over the picture itself.
      // This is what makes a browsed folder nearly free: the thumbnails were
      // made on the way past, they are already small, and ImageMagick then
      // reads four 256px PNGs instead of four 40-megapixel raws.
      const files: string[] = []
      for (const f of images) {
        if (files.length >= TILES) break
        files.push(await cachedThumbPath(f) ?? f)
      }
      for (const f of videos) {
        if (files.length >= TILES) break
        // a video contributes ONLY if it is already thumbnailed; spawning a
        // video thumbnailer to illustrate a folder is not worth the wait
        const c = await cachedThumbPath(f)
        if (c) files.push(c)
      }
      if (!files.length) return fail()
      const outDir = path.join(cacheRoot(), 'thumbnails', size)
      await fsp.mkdir(outDir, { recursive: true, mode: 0o700 })
      const rawOut = path.join(outDir, `${hash}.raw-${process.pid}-${tmpCounter++}.png`)
      const ok = await composeFolderThumb(files, SIZE_PX[size], rawOut)
      let raw: Buffer | null = null
      if (ok) { try { raw = await fsp.readFile(rawOut) } catch { raw = null } }
      try { await fsp.unlink(rawOut) } catch { /* may not exist */ }
      if (!raw) return fail()
      const withText = pngSetText(raw, { 'Thumb::URI': uri, 'Thumb::MTime': String(mtimeSec) })
      if (!withText) return fail()
      try { await writeAtomic(path.join(outDir, `${hash}.png`), withText) } catch { /* still serve */ }
      return withText
    } finally {
      releaseSlot()
    }
  })()
  inflight.set(hash, p)
  try { return await p } finally { inflight.delete(hash) }
}

async function generateThumb(filePath: string, uri: string, hash: string, size: ThumbSize, mtimeSec: number): Promise<Buffer | null> {
  const existing = inflight.get(hash)
  if (existing) return existing
  const p = (async (): Promise<Buffer | null> => {
    const mime = mimeForExt(filePath)
    const t = mime ? loadThumbnailers().get(mime) : undefined
    const failDir = path.join(cacheRoot(), 'thumbnails', 'fail', 'liqexplorer')
    const fail = async (): Promise<null> => {
      negCache.set(hash, mtimeSec)
      if (negCache.size > 10_000) negCache.clear()
      try {
        await writeAtomic(path.join(failDir, `${hash}.png`),
          makeMarkerPng({ 'Thumb::URI': uri, 'Thumb::MTime': String(mtimeSec) }))
      } catch { /* marker is best-effort */ }
      return null
    }
    if (!t) return fail()

    await acquireSlot()
    try {
      const outDir = path.join(cacheRoot(), 'thumbnails', size)
      await fsp.mkdir(outDir, { recursive: true, mode: 0o700 })
      const rawOut = path.join(outDir, `${hash}.raw-${process.pid}-${tmpCounter++}.png`)
      const ok = await runThumbnailer(t, filePath, uri, rawOut, SIZE_PX[size])
      let raw: Buffer | null = null
      if (ok) { try { raw = await fsp.readFile(rawOut) } catch { raw = null } }
      try { await fsp.unlink(rawOut) } catch { /* may not exist */ }
      if (!raw) return fail()
      const withText = pngSetText(raw, { 'Thumb::URI': uri, 'Thumb::MTime': String(mtimeSec) })
      if (!withText) return fail()               // thumbnailer produced non-PNG
      const finalPath = path.join(outDir, `${hash}.png`)
      try { await writeAtomic(finalPath, withText) } catch { /* cache write failed; still serve */ }
      return withText
    } finally {
      releaseSlot()
    }
  })()
  inflight.set(hash, p)
  try { return await p } finally { inflight.delete(hash) }
}

async function handleThumb(reqUrl: string): Promise<Response> {
  const qIdx = reqUrl.indexOf('?')
  const params = new URLSearchParams(qIdx >= 0 ? reqUrl.slice(qIdx + 1) : '')
  const filePath = params.get('path') ?? ''
  const sizeParam = params.get('size') ?? 'large'
  const size: ThumbSize = (SIZE_ORDER as string[]).includes(sizeParam) ? sizeParam as ThumbSize : 'large'
  if (!filePath.startsWith('/')) return new Response('', { status: 404 })

  let st: fs.Stats
  try { st = await fsp.stat(filePath) } catch { return new Response('', { status: 404 }) }
  const isDir = st.isDirectory()
  if (isDir) {
    // three reasons a folder is served the plain icon instead, all of them the
    // user's own decision rather than a limitation:
    if (!folderPreviewsEnabled()) return new Response('', { status: 404 })
    // an icon they chose by hand outranks anything generated
    if (customFolderIcon(filePath)) return new Response('', { status: 404 })
    // a remote folder means a dirent scan across the network per tile
    if (isRemotePath(filePath) && !thumbnailsRemoteEnabled()) return new Response('', { status: 404 })
  }
  const mtimeSec = Math.floor(st.mtimeMs / 1000)
  const uri = gioEncodeFileUri(filePath)
  const hash = crypto.createHash('md5').update(uri, 'utf8').digest('hex')

  if (negCache.get(hash) === mtimeSec) return new Response('', { status: 404 })

  const serve = (buf: Buffer) => new Response(new Uint8Array(buf), {
    status: 200,
    headers: { 'content-type': 'image/png', 'cache-control': 'private, max-age=60' },
  })

  // 1. requested size dir, then bigger sizes
  const startIdx = SIZE_ORDER.indexOf(size)
  for (let i = startIdx; i < SIZE_ORDER.length; i++) {
    const f = path.join(cacheRoot(), 'thumbnails', SIZE_ORDER[i], `${hash}.png`)
    const buf = await readValidThumb(f, uri, mtimeSec)
    if (buf) return serve(buf)
  }

  // 2. our own fail marker (with matching mtime) -> negative
  const failFile = path.join(cacheRoot(), 'thumbnails', 'fail', 'liqexplorer', `${hash}.png`)
  const marker = await readValidThumb(failFile, uri, mtimeSec)
  if (marker) { negCache.set(hash, mtimeSec); return new Response('', { status: 404 }) }

  if (isDir) {
    const buf = await generateFolderThumb(filePath, uri, hash, size, mtimeSec)
    return buf ? serve(buf) : new Response('', { status: 404 })
  }

  // 3. generation policy: skip large remote files
  if (isRemotePath(filePath)) {
    if (!thumbnailsRemoteEnabled()) return new Response('', { status: 404 })
    if (st.size > remoteLimitFor(mimeForName(path.basename(filePath), false))) {
      negCache.set(hash, mtimeSec)
      return new Response('', { status: 404 })
    }
  }

  const buf = await generateThumb(filePath, uri, hash, size, mtimeSec)
  if (buf) return serve(buf)
  return new Response('', { status: 404 })
}

// ---------------------------------------------------------------------------
// liqicon handler
// ---------------------------------------------------------------------------

/** Absolute icon names (from .desktop Icon=/abs/path) may only point into the
 *  standard icon roots — resolveIcon's pass-through would otherwise let a
 *  compromised renderer fetch() arbitrary readable files via liqicon://. */
function iconFileRoots(): string[] {
  const h = os.homedir()
  return [
    '/usr/share/icons/',
    '/usr/local/share/icons/',
    '/usr/share/pixmaps/',
    path.join(h, '.icons') + '/',
    path.join(h, '.local/share/icons') + '/',
    FOLDER_ICON_DIR + '/',        // icons the user picked for folders
  ]
}

function allowedIconPath(p: string): boolean {
  const norm = path.normalize(p)          // collapse ../ before prefix check
  return iconFileRoots().some(root => norm.startsWith(root))
}

async function handleIcon(reqUrl: string): Promise<Response> {
  // manual parse: non-standard scheme; URL would lowercase/normalize
  let rest = reqUrl.replace(/^liqicon:\/*/, '')
  let size = 32
  const qIdx = rest.indexOf('?')
  if (qIdx >= 0) {
    const params = new URLSearchParams(rest.slice(qIdx + 1))
    const s = parseInt(params.get('size') ?? '', 10)
    if (Number.isFinite(s) && s > 0 && s <= 1024) size = s
    rest = rest.slice(0, qIdx)
  }
  rest = rest.replace(/\/+$/, '')
  const rawNames = rest.split(',').map(s => { try { return decodeURIComponent(s) } catch { return s } }).filter(Boolean)
  const names = rawNames.filter(n => !n.startsWith('/') || allowedIconPath(n))
  if (rawNames.length && !names.length) return new Response('', { status: 404 })
  const file = resolveIcon(names, size)
    ?? resolveIcon(['text-x-generic', 'application-x-generic'], size)
  if (!file) return new Response('', { status: 404 })
  const res = await net.fetch(pathToFileURL(file).toString())
  if (!res.ok) return new Response('', { status: 404 })
  const type = file.endsWith('.svg') ? 'image/svg+xml' : file.endsWith('.png') ? 'image/png' : 'application/octet-stream'
  return new Response(res.body, {
    status: 200,
    headers: { 'content-type': type, 'cache-control': 'public, max-age=604800, immutable' },
  })
}

// ---------------------------------------------------------------------------
// liqfile handler — raw file bytes for the preview pane
// ---------------------------------------------------------------------------

/** stat() on a dead CIFS mount blocks forever; the request must not. */
function statDeadline(p: string, ms: number): Promise<fs.Stats | null> {
  return new Promise(resolve => {
    let done = false
    const timer = setTimeout(() => { if (!done) { done = true; resolve(null) } }, ms)
    fsp.stat(p).then(
      st => { if (!done) { done = true; clearTimeout(timer); resolve(st) } },
      () => { if (!done) { done = true; clearTimeout(timer); resolve(null) } },
    )
  })
}

const RANGE_RE = /^bytes=(\d*)-(\d*)$/

async function handleFile(reqUrl: string, rangeHeader: string | null): Promise<Response> {
  // standard scheme, so the URL always carries the fixed host segment
  if (!reqUrl.startsWith(`liqfile://${LIQFILE_HOST}/`)) return new Response('', { status: 400 })
  const qIdx = reqUrl.indexOf('?')
  const hIdx = reqUrl.indexOf('#')
  const query = qIdx < 0 ? '' : reqUrl.slice(qIdx + 1, hIdx > qIdx ? hIdx : undefined)
  const params = new URLSearchParams(query)
  const filePath = params.get('path') ?? ''
  if (!filePath.startsWith('/')) return new Response('', { status: 400 })

  const st = await statDeadline(filePath, 5000)
  if (!st || !st.isFile()) return new Response('', { status: 404 })
  const size = st.size
  const type = params.get('type') || mimeForName(path.basename(filePath), false) || 'application/octet-stream'

  let start = 0
  let end = size - 1
  let status = 200
  if (rangeHeader) {
    const m = RANGE_RE.exec(rangeHeader.trim())
    if (m) {
      if (m[1] === '') {
        // suffix range: bytes=-N (last N bytes)
        const n = Number(m[2] || 0)
        start = n > 0 ? Math.max(0, size - n) : size
      } else {
        start = Number(m[1])
        if (m[2] !== '') end = Math.min(end, Number(m[2]))
      }
      if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= size) {
        return new Response('', { status: 416, headers: { 'content-range': `bytes */${size}` } })
      }
      status = 206
    }
  }

  const headers: Record<string, string> = {
    'content-type': type,
    'accept-ranges': 'bytes',
    'content-length': String(end - start + 1),
    // the pane re-reads on every selection; a stale preview would be worse than
    // a re-read, and Chromium keeps its own media buffer anyway
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  }
  if (status === 206) headers['content-range'] = `bytes ${start}-${end}/${size}`
  if (size === 0) return new Response('', { status, headers })

  const stream = fs.createReadStream(filePath, { start, end })
  // a cancelled request (seek, pane closed) destroys the stream — never crash
  stream.on('error', () => { /* the body just ends */ })
  return new Response(Readable.toWeb(stream) as unknown as ReadableStream, { status, headers })
}

ipcMain.handle(CH('holdThumbnails'), (_e: unknown, ms?: number) => { holdThumbnails(typeof ms === 'number' ? ms : undefined); return true })
ipcMain.handle(CH('releaseThumbnails'), () => { releaseThumbnails(); return true })

export function registerProtocols(): void {
  protocol.handle('liqicon', (req) => handleIcon(req.url).catch(() => new Response('', { status: 404 })))
  protocol.handle('liqthumb', (req) => handleThumb(req.url).catch(() => new Response('', { status: 404 })))
  protocol.handle('liqfile', (req) =>
    handleFile(req.url, req.headers.get('range')).catch(() => new Response('', { status: 404 })))
  registerPlayProtocol()
}

/** internals exposed for tests only — not part of the module contract */
export const __test = { pngReadText, pngSetText, makeMarkerPng, mimeForExt, handleThumb, crc32 }
