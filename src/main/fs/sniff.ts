// What is this file, really?
//
// Extensions lie, and a few of them lie in ways that matter here. `.ts` is the
// worst on this machine: shared-mime-info maps it to text/vnd.trolltech.linguist
// (Qt Linguist translation source) purely by name, so an MPEG transport stream —
// a video — is listed as a Qt file and refuses to play. Mapping .ts to video
// instead would be exactly as wrong in the other direction, because this is a
// developer's machine full of TypeScript.
//
// So for the SMALL set of extensions that are genuinely ambiguous, the bytes
// decide. Everything else keeps the name-based answer, which is right nearly
// always and costs no I/O — sniffing every file in a listing would mean a read
// per row, which on a CIFS share is exactly the cost this app spends its time
// avoiding.
import { ipcMain } from 'electron'
import * as fsp from 'node:fs/promises'
import { CH } from '../../shared/ipc'
import type { Identified } from '../../shared/identify'

/**
 * Extensions where the name is not evidence. Keep this list SHORT: every entry
 * is a read per matching file in every listing.
 *
 *   ts      MPEG transport stream vs TypeScript vs Qt Linguist
 *   bin/dat/raw  vendor dumping ground; could be anything
 *   (no ext)     nothing to go on at all
 */
export const AMBIGUOUS_EXT = new Set(['ts', 'bin', 'dat', 'raw', 'img', ''])

/** enough for a transport-stream double sync (188-byte packets) and any magic */
const SNIFF_BYTES = 512

export interface Sniffed {
  /** the mime the bytes indicate, or '' when they say nothing useful */
  mime: string
  /** short human sentence for the "what is this?" panel */
  why: string
}

/** file signatures worth recognising, longest-first so a prefix cannot win */
const MAGIC: { sig: number[]; offset?: number; mime: string; why: string }[] = [
  { sig: [0x1a, 0x45, 0xdf, 0xa3], mime: 'video/x-matroska', why: 'Matroska/WebM container' },
  { sig: [0x52, 0x49, 0x46, 0x46], mime: 'video/x-msvideo', why: 'RIFF container (AVI or WAV)' },
  { sig: [0x66, 0x74, 0x79, 0x70], offset: 4, mime: 'video/mp4', why: 'ISO base media (MP4/MOV)' },
  { sig: [0x4f, 0x67, 0x67, 0x53], mime: 'video/ogg', why: 'Ogg container' },
  { sig: [0x46, 0x4c, 0x56, 0x01], mime: 'video/x-flv', why: 'Flash video' },
  { sig: [0x30, 0x26, 0xb2, 0x75], mime: 'video/x-ms-asf', why: 'ASF container (WMV/WMA)' },
  { sig: [0x00, 0x00, 0x01, 0xba], mime: 'video/mpeg', why: 'MPEG program stream' },
  { sig: [0x00, 0x00, 0x01, 0xb3], mime: 'video/mpeg', why: 'MPEG video' },
  { sig: [0x49, 0x44, 0x33], mime: 'audio/mpeg', why: 'MP3 with an ID3 tag' },
  { sig: [0x66, 0x4c, 0x61, 0x43], mime: 'audio/flac', why: 'FLAC audio' },
  { sig: [0x89, 0x50, 0x4e, 0x47], mime: 'image/png', why: 'PNG image' },
  { sig: [0xff, 0xd8, 0xff], mime: 'image/jpeg', why: 'JPEG image' },
  { sig: [0x47, 0x49, 0x46, 0x38], mime: 'image/gif', why: 'GIF image' },
  { sig: [0x25, 0x50, 0x44, 0x46], mime: 'application/pdf', why: 'PDF document' },
  { sig: [0x50, 0x4b, 0x03, 0x04], mime: 'application/zip', why: 'Zip container' },
  { sig: [0x37, 0x7a, 0xbc, 0xaf], mime: 'application/x-7z-compressed', why: '7-Zip archive' },
  { sig: [0x52, 0x61, 0x72, 0x21], mime: 'application/vnd.rar', why: 'RAR archive' },
  { sig: [0x1f, 0x8b], mime: 'application/gzip', why: 'gzip stream' },
  { sig: [0x7f, 0x45, 0x4c, 0x46], mime: 'application/x-executable', why: 'ELF binary' },
]

function matches(buf: Buffer, m: { sig: number[]; offset?: number }): boolean {
  const at = m.offset ?? 0
  if (buf.length < at + m.sig.length) return false
  for (let i = 0; i < m.sig.length; i++) if (buf[at + i] !== m.sig[i]) return false
  return true
}

/**
 * An MPEG transport stream has no magic number — it is identified by structure:
 * 0x47 sync bytes at a fixed 188-byte cadence. Checking three in a row is
 * enough that a text file starting with 'G' cannot pass by accident.
 */
function isTransportStream(buf: Buffer): boolean {
  if (buf.length < 377 || buf[0] !== 0x47) return false
  return buf[188] === 0x47 && buf[376] === 0x47
}

/** does this look like text? used to tell "unknown binary" from "unknown text" */
function looksTextual(buf: Buffer): boolean {
  if (!buf.length) return true
  let suspicious = 0
  for (const b of buf) {
    if (b === 0) return false                       // a NUL settles it
    // control characters other than tab/newline/carriage return/form feed/escape
    if (b < 0x09 || (b > 0x0d && b < 0x20 && b !== 0x1b)) suspicious++
  }
  return suspicious / buf.length < 0.05
}

/**
 * Read the head of a file and say what it is. Returns an empty mime when the
 * bytes are not conclusive — the caller keeps whatever the name suggested.
 */
export async function sniffFile(path: string): Promise<Sniffed> {
  let buf: Buffer
  try {
    const fh = await fsp.open(path, 'r')
    try {
      const b = Buffer.alloc(SNIFF_BYTES)
      const { bytesRead } = await fh.read(b, 0, SNIFF_BYTES, 0)
      buf = b.subarray(0, bytesRead)
    } finally { await fh.close() }
  } catch {
    return { mime: '', why: '' }
  }

  if (isTransportStream(buf)) {
    return { mime: 'video/mp2t', why: 'MPEG transport stream (188-byte packets)' }
  }
  for (const m of MAGIC) {
    if (matches(buf, m)) return { mime: m.mime, why: m.why }
  }
  if (!buf.length) return { mime: '', why: 'The file is empty' }
  if (looksTextual(buf)) return { mime: 'text/plain', why: 'Plain text' }
  return { mime: '', why: 'Binary data with no recognisable signature' }
}

/** Should this name be sniffed at all? */
export function worthSniffing(name: string): boolean {
  const dot = name.lastIndexOf('.')
  const ext = dot > 0 ? name.slice(dot + 1).toLowerCase() : ''
  return AMBIGUOUS_EXT.has(ext)
}

/**
 * "What is this, and what can I do with it?"
 *
 * For a file the system cannot name, showing "application/octet-stream" and
 * nothing else leaves the user stuck with a row they cannot act on. This
 * answers both halves: what the bytes look like, and the handful of things
 * worth trying — so the dead end becomes a decision.
 */
export async function identifyFile(p: string): Promise<Identified> {
  const s = await sniffFile(p)
  const out: Identified['suggestions'] = []
  const kind = s.mime.split('/')[0]

  if (kind === 'video' || kind === 'audio' || kind === 'image' || s.mime === 'application/pdf') {
    out.push({ id: 'view', label: `Open it as ${kind === 'application' ? 'a PDF' : kind}` })
    // the extension disagrees with the bytes, which is usually why it looked
    // broken in the first place
    out.push({ id: 'rename', label: 'Rename it so the extension matches' })
  } else if (s.mime === 'text/plain') {
    out.push({ id: 'text', label: 'Open it as text' })
  }
  out.push({ id: 'openwith', label: 'Choose an application' })
  out.push({ id: 'properties', label: 'Look at its properties' })
  return { mime: s.mime, why: s.why || 'Nothing in the file identifies it.', suggestions: out }
}

ipcMain.handle(CH('identifyFile'), (_e, p: string) => identifyFile(p))
