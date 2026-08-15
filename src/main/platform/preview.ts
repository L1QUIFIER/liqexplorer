// Preview-pane helpers that must run in the main process, self-registered as
// IPC methods (renderer: liq.invoke('previewText', …) / liq.invoke('previewTags', …)),
// following the ops/quick.ts + ops/archive.ts pattern — main/ipc.ts stays untouched.
//
//   previewText(path, maxBytes?)  -> PreviewTextResult
//   previewTags(path)             -> PreviewTags | null   (audio title/artist/cover)
//
// Everything here is bounded, because the project's own share is a hard-mounted
// CIFS where a single read can block for minutes:
//
//   * at most MAX_CONCURRENT reads are in flight at once, so a hung mount can
//     never occupy the whole libuv threadpool;
//   * every request resolves after PREVIEW.readTimeoutMs whatever the fs does
//     (the orphaned read still closes its own fd when/if it returns);
//   * a text preview reads at most PREVIEW.textMaxBytes, a tag scan at most
//     TAG_BUDGET bytes, and both use positional reads — never a full file slurp.
//
// No native modules: the ID3v2/ID3v1/FLAC/Ogg/MP4 tag readers below are plain
// buffer walks (~200 lines) rather than a dependency.
import { ipcMain, type IpcMainInvokeEvent } from 'electron'
import * as fsp from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import { CH } from '../../shared/ipc'
import { PREVIEW, type PreviewCover, type PreviewTags, type PreviewTextResult } from '../../shared/preview'

// ---------------------------------------------------------------- scheduling

const MAX_CONCURRENT = 2
let running = 0
const waiting: (() => void)[] = []

function acquire(): Promise<void> {
  if (running < MAX_CONCURRENT) { running++; return Promise.resolve() }
  return new Promise(res => waiting.push(() => { running++; res() }))
}

function release(): void {
  running--
  waiting.shift()?.()
}

/**
 * Resolve with `fallback()` after `ms` no matter what the filesystem does. The
 * underlying work is NOT cancellable (no fs syscall is) — it is abandoned, and
 * its own finally-block closes the fd if it ever comes back.
 */
function withDeadline<T>(work: Promise<T>, ms: number, fallback: () => T): Promise<T> {
  return new Promise(resolve => {
    let settled = false
    const timer = setTimeout(() => { if (!settled) { settled = true; resolve(fallback()) } }, ms)
    const finish = (v: T) => { if (!settled) { settled = true; clearTimeout(timer); resolve(v) } }
    work.then(finish, () => finish(fallback()))
  })
}

// ---------------------------------------------------------------- text

function emptyText(over: Partial<PreviewTextResult> = {}): PreviewTextResult {
  return { ok: false, text: '', bytes: 0, size: 0, truncated: false, binary: false, timedOut: false, ...over }
}

/** Explorer-style wording rather than a raw errno string. */
function errText(e: unknown): string {
  switch ((e as NodeJS.ErrnoException)?.code) {
    case 'ENOENT': return 'The item is no longer in this location.'
    case 'EACCES':
    case 'EPERM': return 'You do not have permission to read this file.'
    case 'EISDIR': return 'Not a file.'
    case 'EIO': return 'The location could not be read.'
  }
  return String((e as Error)?.message ?? e)
}

/** Heuristic: NUL in the sample, or >10% C0 control bytes outside \t\r\n\f. */
function looksBinary(buf: Buffer): boolean {
  const n = Math.min(buf.length, 8192)
  let ctrl = 0
  for (let i = 0; i < n; i++) {
    const b = buf[i]
    if (b === 0) return true
    if (b < 0x09 || (b > 0x0d && b < 0x20)) ctrl++
  }
  return n > 0 && ctrl / n > 0.1
}

function decodeText(buf: Buffer): string {
  let s: string
  try {
    s = new TextDecoder('utf-8', { fatal: true }).decode(buf)
  } catch {
    // not valid UTF-8 (or cut mid-sequence): retry lenient, then latin1 if the
    // result is mostly replacement characters (legacy 8-bit logs)
    const lenient = new TextDecoder('utf-8').decode(buf)
    const bad = (lenient.match(/�/g) ?? []).length
    s = bad > lenient.length / 64 ? buf.toString('latin1') : lenient
  }
  if (s.charCodeAt(0) === 0xfeff) s = s.slice(1)
  return s.replace(/\r\n/g, '\n')
}

async function readTextInner(p: string, maxBytes: number): Promise<PreviewTextResult> {
  const st = await fsp.stat(p)
  if (st.isDirectory()) return emptyText({ error: 'Not a file.' })
  const want = Math.max(0, Math.min(maxBytes, st.size))
  if (want === 0) {
    return { ok: true, text: '', bytes: 0, size: st.size, truncated: false, binary: false, timedOut: false }
  }
  const buf = Buffer.alloc(want)
  const fh = await fsp.open(p, 'r')
  let got = 0
  try {
    while (got < want) {
      const { bytesRead } = await fh.read(buf, got, want - got, got)
      if (bytesRead <= 0) break
      got += bytesRead
    }
  } finally {
    await fh.close().catch(() => {})
  }
  const slice = buf.subarray(0, got)
  if (looksBinary(slice)) {
    return { ok: true, text: '', bytes: got, size: st.size, truncated: false, binary: true, timedOut: false }
  }
  let text = decodeText(slice)
  const truncated = st.size > got
  // a truncated read almost always ends mid-line; drop the fragment so the
  // block never shows half a token as if it were the file's last line
  if (truncated) {
    const nl = text.lastIndexOf('\n')
    if (nl > text.length - 4096 && nl > 0) text = text.slice(0, nl + 1)
  }
  return { ok: true, text, bytes: got, size: st.size, truncated, binary: false, timedOut: false }
}

export async function previewText(p: string, maxBytes: number = PREVIEW.textMaxBytes): Promise<PreviewTextResult> {
  if (!p || !p.startsWith('/')) return emptyText({ error: 'Invalid path.' })
  // the deadline covers the queue wait too: if a hung mount is holding both
  // slots, later requests must still answer (with timedOut) instead of pending
  const work = (async () => {
    await acquire()
    try {
      return await readTextInner(p, Math.min(maxBytes, PREVIEW.textMaxBytes))
    } catch (e) {
      return emptyText({ error: errText(e) })
    } finally {
      release()
    }
  })()
  return withDeadline(work, PREVIEW.readTimeoutMs, () => emptyText({ timedOut: true }))
}

// ---------------------------------------------------------------- tag reading

const TAG_BUDGET = 6 * 1024 * 1024      // total bytes any one tag scan may read

/** Bounded positional reader — every read is charged against a byte budget. */
class Slice {
  private spent = 0
  constructor(private fh: FileHandle, readonly size: number) {}
  async at(pos: number, len: number): Promise<Buffer> {
    if (pos < 0 || len <= 0 || pos >= this.size) return Buffer.alloc(0)
    const want = Math.min(len, this.size - pos, Math.max(0, TAG_BUDGET - this.spent))
    if (want <= 0) return Buffer.alloc(0)
    const buf = Buffer.alloc(want)
    let got = 0
    while (got < want) {
      const { bytesRead } = await this.fh.read(buf, got, want - got, pos + got)
      if (bytesRead <= 0) break
      got += bytesRead
    }
    this.spent += got
    return buf.subarray(0, got)
  }
}

function clean(s: string | undefined): string | undefined {
  if (s === undefined) return undefined
  const out = s.replace(/\0.*$/s, '').trim()
  return out.length ? out.slice(0, 300) : undefined
}

function coverFrom(mime: string, data: Buffer): PreviewCover | undefined {
  if (!data.length || data.length > PREVIEW.coverMaxBytes) return undefined
  const m = mime.toLowerCase()
  // Chromium only decodes real image types here; PNG/JPEG/GIF/WEBP cover it all
  const type = m.includes('png') ? 'image/png'
    : m.includes('gif') ? 'image/gif'
      : m.includes('webp') ? 'image/webp'
        : m.includes('jp') ? 'image/jpeg'
          : m.startsWith('image/') ? m
            : data[0] === 0x89 ? 'image/png' : 'image/jpeg'
  return { mime: type, data: data.toString('base64') }
}

// ---- ID3v2 (mp3, aiff, wav-with-id3) ----

function synchsafe(b: Buffer, off: number): number {
  return ((b[off] & 0x7f) << 21) | ((b[off + 1] & 0x7f) << 14) | ((b[off + 2] & 0x7f) << 7) | (b[off + 3] & 0x7f)
}

function id3Text(buf: Buffer): string {
  if (!buf.length) return ''
  const enc = buf[0]
  const body = buf.subarray(1)
  if (enc === 0) return body.toString('latin1')
  if (enc === 3) return body.toString('utf8')
  if (enc === 1) {
    if (body.length >= 2 && body[0] === 0xff && body[1] === 0xfe) return body.subarray(2).toString('utf16le')
    if (body.length >= 2 && body[0] === 0xfe && body[1] === 0xff) return swapUtf16(body.subarray(2))
    return body.toString('utf16le')
  }
  if (enc === 2) return swapUtf16(body)
  return body.toString('latin1')
}

function swapUtf16(b: Buffer): string {
  const c = Buffer.from(b)
  c.swap16()
  return c.toString('utf16le')
}

async function readId3v2(sl: Slice, head: Buffer): Promise<PreviewTags | null> {
  const ver = head[3]
  const flags = head[5]
  const tagSize = synchsafe(head, 6)
  if (tagSize <= 0) return null
  const body = await sl.at(10, Math.min(tagSize, TAG_BUDGET))
  if (!body.length) return null
  let pos = 0
  if (flags & 0x40) {                                  // extended header
    if (ver === 4) pos += synchsafe(body, 0)
    else pos += body.readUInt32BE(0) + 4
  }
  const idLen = ver === 2 ? 3 : 4
  const hdrLen = ver === 2 ? 6 : 10
  const tags: PreviewTags = {}
  while (pos + hdrLen <= body.length) {
    const id = body.toString('latin1', pos, pos + idLen)
    if (!/^[A-Z0-9]{3,4}$/.test(id)) break             // padding / garbage
    let size: number
    if (ver === 2) size = (body[pos + 3] << 16) | (body[pos + 4] << 8) | body[pos + 5]
    else if (ver === 4) size = synchsafe(body, pos + 4)
    else size = body.readUInt32BE(pos + 4)
    const start = pos + hdrLen
    if (size <= 0 || start + size > body.length) break
    const frame = body.subarray(start, start + size)
    switch (id) {
      case 'TIT2': case 'TT2': tags.title = clean(id3Text(frame)); break
      case 'TPE1': case 'TP1': tags.artist = clean(id3Text(frame)); break
      case 'TALB': case 'TAL': tags.album = clean(id3Text(frame)); break
      case 'TYER': case 'TYE': case 'TDRC': tags.year = clean(id3Text(frame)); break
      case 'TRCK': case 'TRK': tags.track = clean(id3Text(frame)); break
      case 'APIC': case 'PIC': {
        if (tags.cover) break
        const enc = frame[0]
        let p = 1
        let mime = 'image/jpeg'
        if (id === 'PIC') { mime = frame.toString('latin1', 1, 4); p = 4 }
        else {
          const nul = frame.indexOf(0, 1)
          if (nul < 0) break
          mime = frame.toString('latin1', 1, nul)
          p = nul + 1
        }
        p += 1                                          // picture type byte
        // description, terminated by 1 (or 2 for UTF-16) NUL bytes
        if (enc === 1 || enc === 2) {
          while (p + 1 < frame.length && !(frame[p] === 0 && frame[p + 1] === 0)) p += 2
          p += 2
        } else {
          const nul = frame.indexOf(0, p)
          p = nul < 0 ? frame.length : nul + 1
        }
        tags.cover = coverFrom(mime, frame.subarray(p))
        break
      }
    }
    pos = start + size
  }
  return tags
}

async function readId3v1(sl: Slice): Promise<PreviewTags | null> {
  if (sl.size < 128) return null
  const b = await sl.at(sl.size - 128, 128)
  if (b.length !== 128 || b.toString('latin1', 0, 3) !== 'TAG') return null
  return {
    title: clean(b.toString('latin1', 3, 33)),
    artist: clean(b.toString('latin1', 33, 63)),
    album: clean(b.toString('latin1', 63, 93)),
    year: clean(b.toString('latin1', 93, 97)),
  }
}

// ---- Vorbis comments (FLAC, Ogg Vorbis/Opus) ----

function parseVorbisComment(b: Buffer, tags: PreviewTags): void {
  if (b.length < 8) return
  let p = 0
  const vendorLen = b.readUInt32LE(p); p += 4 + vendorLen
  if (p + 4 > b.length) return
  const count = b.readUInt32LE(p); p += 4
  for (let i = 0; i < Math.min(count, 256) && p + 4 <= b.length; i++) {
    const len = b.readUInt32LE(p); p += 4
    if (len <= 0 || p + len > b.length) break
    const kv = b.toString('utf8', p, p + len)
    p += len
    const eq = kv.indexOf('=')
    if (eq <= 0) continue
    const key = kv.slice(0, eq).toUpperCase()
    const val = kv.slice(eq + 1)
    if (key === 'TITLE' && !tags.title) tags.title = clean(val)
    else if (key === 'ARTIST' && !tags.artist) tags.artist = clean(val)
    else if (key === 'ALBUM' && !tags.album) tags.album = clean(val)
    else if ((key === 'DATE' || key === 'YEAR') && !tags.year) tags.year = clean(val)
    else if (key === 'TRACKNUMBER' && !tags.track) tags.track = clean(val)
    else if (key === 'METADATA_BLOCK_PICTURE' && !tags.cover) {
      try { tags.cover = parseFlacPicture(Buffer.from(val, 'base64')) } catch { /* bad base64 */ }
    }
  }
}

function parseFlacPicture(b: Buffer): PreviewCover | undefined {
  if (b.length < 32) return undefined
  let p = 4                                            // picture type
  const mimeLen = b.readUInt32BE(p); p += 4
  if (mimeLen > 255 || p + mimeLen > b.length) return undefined
  const mime = b.toString('latin1', p, p + mimeLen); p += mimeLen
  const descLen = b.readUInt32BE(p); p += 4
  if (p + descLen > b.length) return undefined
  p += descLen + 16                                    // w/h/depth/colors
  if (p + 4 > b.length) return undefined
  const dataLen = b.readUInt32BE(p); p += 4
  if (dataLen <= 0 || p + dataLen > b.length) return undefined
  return coverFrom(mime, b.subarray(p, p + dataLen))
}

async function readFlac(sl: Slice): Promise<PreviewTags | null> {
  const tags: PreviewTags = {}
  let pos = 4
  for (let i = 0; i < 64; i++) {
    const h = await sl.at(pos, 4)
    if (h.length < 4) break
    const last = (h[0] & 0x80) !== 0
    const type = h[0] & 0x7f
    const len = (h[1] << 16) | (h[2] << 8) | h[3]
    if (type === 4) parseVorbisComment(await sl.at(pos + 4, len), tags)
    else if (type === 6 && !tags.cover) tags.cover = parseFlacPicture(await sl.at(pos + 4, len))
    pos += 4 + len
    if (last) break
  }
  return tags
}

async function readOgg(sl: Slice): Promise<PreviewTags | null> {
  // walk the first pages and concatenate their payloads; the comment header
  // ("\x03vorbis" / "OpusTags" / "\x7fFLAC") lives in the second logical packet
  const chunks: Buffer[] = []
  let pos = 0
  for (let page = 0; page < 12; page++) {
    const h = await sl.at(pos, 27)
    if (h.length < 27 || h.toString('latin1', 0, 4) !== 'OggS') break
    const nsegs = h[26]
    const table = await sl.at(pos + 27, nsegs)
    if (table.length < nsegs) break
    let payload = 0
    for (let i = 0; i < nsegs; i++) payload += table[i]
    chunks.push(await sl.at(pos + 27 + nsegs, payload))
    pos += 27 + nsegs + payload
    if (chunks.reduce((n, c) => n + c.length, 0) > 512 * 1024) break
  }
  const all = Buffer.concat(chunks)
  const tags: PreviewTags = {}
  const vorbis = all.indexOf(Buffer.from([0x03, 0x76, 0x6f, 0x72, 0x62, 0x69, 0x73]))   // \x03vorbis
  if (vorbis >= 0) parseVorbisComment(all.subarray(vorbis + 7), tags)
  else {
    const opus = all.indexOf('OpusTags', 0, 'latin1')
    if (opus >= 0) parseVorbisComment(all.subarray(opus + 8), tags)
    else {
      const oflac = all.indexOf('\x7fFLAC', 0, 'latin1')
      if (oflac >= 0) parseVorbisComment(all.subarray(oflac + 13), tags)
    }
  }
  return tags
}

// ---- MP4 / M4A (moov > udta > meta > ilst) ----

/** Body of the first child atom of `want` inside `buf` (offsets are relative). */
function child(buf: Buffer, want: string, skip = 0): Buffer | null {
  let p = 0
  while (p + 8 <= buf.length) {
    let size = buf.readUInt32BE(p)
    let hdr = 8
    if (size === 1) { if (p + 16 > buf.length) break; size = Number(buf.readBigUInt64BE(p + 8)); hdr = 16 }
    else if (size === 0) size = buf.length - p
    if (size < 8) break
    const end = Math.min(p + size, buf.length)
    if (buf.toString('latin1', p + 4, p + 8) === want) return buf.subarray(p + hdr + skip, end)
    p += size
  }
  return null
}

async function readMp4(sl: Slice): Promise<PreviewTags | null> {
  // top-level walk over 16-byte header reads — 'moov' is often at the very end
  let pos = 0
  let moovBody = 0
  let moovLen = 0
  for (let i = 0; i < 64 && pos < sl.size; i++) {
    const h = await sl.at(pos, 16)
    if (h.length < 8) break
    let size = h.readUInt32BE(0)
    let hdr = 8
    if (size === 1) { if (h.length < 16) break; size = Number(h.readBigUInt64BE(8)); hdr = 16 }
    else if (size === 0) size = sl.size - pos
    if (size < 8) break
    if (h.toString('latin1', 4, 8) === 'moov') { moovBody = pos + hdr; moovLen = size - hdr; break }
    pos += size
  }
  if (!moovLen || moovLen > 4 * 1024 * 1024) return null
  const body = await sl.at(moovBody, moovLen)
  if (!body.length) return null
  const udta = child(body, 'udta')
  const meta = udta ? child(udta, 'meta', 4) : null      // meta has 4 version/flags bytes
  const ilst = meta ? child(meta, 'ilst') : null
  if (!ilst) return null
  const tags: PreviewTags = {}
  let p = 0
  while (p + 8 <= ilst.length) {
    const size = ilst.readUInt32BE(p)
    if (size < 8 || p + size > ilst.length) break
    const type = ilst.toString('latin1', p + 4, p + 8)
    const item = ilst.subarray(p, p + size)
    const dataBody = item.subarray(8)
    const v = mp4Data(dataBody)
    if (type === '\xa9nam') tags.title = v.text
    else if (type === '\xa9ART' || type === 'aART') tags.artist ??= v.text
    else if (type === '\xa9alb') tags.album = v.text
    else if (type === '\xa9day') tags.year = v.text
    else if (type === 'trkn' && v.raw && v.raw.length >= 4) tags.track = String(v.raw.readUInt16BE(2))
    else if (type === 'covr' && !tags.cover) tags.cover = v.cover
    p += size
  }
  return tags
}

function mp4Data(b: Buffer): { text?: string; cover?: PreviewCover; raw?: Buffer } {
  if (b.length < 16) return {}
  const size = b.readUInt32BE(0)
  if (b.toString('latin1', 4, 8) !== 'data' || size < 16) return {}
  const flags = b.readUInt32BE(8) & 0xffffff
  const payload = b.subarray(16, Math.min(size, b.length))
  if (flags === 1) return { text: clean(payload.toString('utf8')) }
  if (flags === 13) return { cover: coverFrom('image/jpeg', payload) }
  if (flags === 14) return { cover: coverFrom('image/png', payload) }
  return { raw: payload }
}

async function readTagsInner(p: string): Promise<PreviewTags | null> {
  const st = await fsp.stat(p)
  if (!st.isFile() || st.size < 16) return null
  const fh = await fsp.open(p, 'r')
  try {
    const sl = new Slice(fh, st.size)
    const head = await sl.at(0, 16)
    if (head.length < 12) return null
    const magic4 = head.toString('latin1', 0, 4)
    let tags: PreviewTags | null = null
    if (head.toString('latin1', 0, 3) === 'ID3') tags = await readId3v2(sl, head)
    else if (magic4 === 'fLaC') tags = await readFlac(sl)
    else if (magic4 === 'OggS') tags = await readOgg(sl)
    else if (head.toString('latin1', 4, 8) === 'ftyp') tags = await readMp4(sl)
    if (!tags || (!tags.title && !tags.artist && !tags.album && !tags.cover)) {
      const v1 = await readId3v1(sl)
      if (v1 && (v1.title || v1.artist || v1.album)) tags = { ...v1, ...(tags ?? {}) }
    }
    if (!tags) return null
    const any = tags.title || tags.artist || tags.album || tags.year || tags.track || tags.cover
    return any ? tags : null
  } finally {
    await fh.close().catch(() => {})
  }
}

export async function previewTags(p: string): Promise<PreviewTags | null> {
  if (!p || !p.startsWith('/')) return null
  const work = (async () => {
    await acquire()
    try { return await readTagsInner(p) } catch { return null } finally { release() }
  })()
  return withDeadline(work, PREVIEW.readTimeoutMs, () => null)
}

// ---------------------------------------------------------------- IPC

type Handler = (event: IpcMainInvokeEvent, ...args: any[]) => unknown

function handle(method: string, fn: Handler): void {
  try {
    ipcMain.handle(CH(method), fn)
  } catch (e) {
    // a duplicate registration must not take the main process down
    console.warn(`[preview] could not register ${CH(method)}:`, (e as Error)?.message)
  }
}

let registered = false

/** Idempotent; called from registerProtocols() and on module load. */
export function registerPreviewIpc(): void {
  if (registered) return
  registered = true
  handle('previewText', (_e, p: string, maxBytes?: number) => previewText(p, maxBytes))
  handle('previewTags', (_e, p: string) => previewTags(p))
}

registerPreviewIpc()
