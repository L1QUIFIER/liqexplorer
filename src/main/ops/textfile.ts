// Lossless read/write of a text file for the Doc tab.
//
// NOT previewText. platform/preview.ts's previewText is deliberately a lossy
// 256 KB preview — it drops the BOM, rewrites every CRLF to LF and guesses
// latin-1 the moment a byte does not decode. That is right for showing a file
// and catastrophic for saving one, so this is a second, separate reader.
//
// Everything here exists to make "open it, change nothing, save it" produce the
// SAME BYTES:
//
//   * the encoding is not merely detected, it is PROVEN. A candidate is only
//     accepted if re-encoding the decoded text reproduces the file's bytes
//     exactly (the Buffer.from(s).equals(buf) trick platform/names.ts uses for
//     filenames). If none does, the pane says so instead of quietly mangling.
//   * line endings travel as DATA, not as a normalisation. A <textarea> hands
//     back \n whatever you put in it, so the file's real ending is remembered
//     and re-applied on save. An editor that silently rewrites 4000 line
//     endings is how someone loses a diff.
//   * a missing final newline stays missing; a present one stays present.
//   * the BOM is remembered and re-emitted.
//
// The save is an optimistic-lock + temp + fchmod + fsync + rename, and writes a
// <name>~ backup on the first save of a session (the gedit/Nemo convention) —
// which is the ONLY physical undo a text save has, because it does not go
// through the ops engine. The UI says so.
//
// Transcoding is glibc `iconv` in a killable child, not an npm dependency.
import { ipcMain } from 'electron'
import { spawn } from 'node:child_process'
import * as fsp from 'node:fs/promises'
import * as path from 'node:path'
import { CH } from '../../shared/ipc'
import { DOC, type TextEol, type TextFile, type TextWriteOpts, type TextWriteResult } from '../../shared/doc'
import * as history from '../state/history'

// ---------------------------------------------------------------- scheduling

// Same shape as platform/preview.ts: a hung mount must never own the whole
// libuv threadpool, and every request answers on a deadline whatever fs does.
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

/** Resolve with `fallback()` after `ms` whatever the filesystem does. The work
 *  is abandoned, not cancelled — no fs syscall is cancellable. */
function withDeadline<T>(work: Promise<T>, ms: number, fallback: () => T): Promise<T> {
  return new Promise(resolve => {
    let settled = false
    const timer = setTimeout(() => { if (!settled) { settled = true; resolve(fallback()) } }, ms)
    const finish = (v: T) => { if (!settled) { settled = true; clearTimeout(timer); resolve(v) } }
    work.then(finish, () => finish(fallback()))
  })
}

/** Explorer-style wording rather than a raw errno string (as in preview.ts). */
function errText(e: unknown): string {
  switch ((e as NodeJS.ErrnoException)?.code) {
    case 'ENOENT': return 'The item is no longer in this location.'
    case 'EACCES':
    case 'EPERM': return 'You do not have permission to write to this file.'
    case 'EISDIR': return 'Not a file.'
    case 'EIO': return 'The location could not be read.'
    case 'ENOSPC': return 'There is not enough space on the drive.'
    case 'EROFS': return 'This location is read-only.'
  }
  return String((e as Error)?.message ?? e)
}

function empty(over: Partial<TextFile> = {}): TextFile {
  return {
    ok: false, text: '', encoding: 'UTF-8', bom: false, lossless: true,
    eol: 'lf', mixedEol: false, hadFinalNewline: false,
    bytes: 0, size: 0, mtime: 0, mode: 0o644, ...over,
  }
}

// ---------------------------------------------------------------- transcoding

/** iconv in a child: stdin -> stdout, SIGKILLed on the deadline. Returns null
 *  on any failure, INCLUDING a byte the source encoding does not define —
 *  which is the signal to try the next candidate. */
function iconv(buf: Buffer, from: string, to: string): Promise<Buffer | null> {
  return new Promise(resolve => {
    let child
    try {
      child = spawn('iconv', ['-f', from, '-t', to], { stdio: ['pipe', 'pipe', 'pipe'] })
    } catch { resolve(null); return }
    const out: Buffer[] = []
    let done = false
    const finish = (v: Buffer | null) => { if (!done) { done = true; clearTimeout(timer); resolve(v) } }
    const timer = setTimeout(() => { try { child.kill('SIGKILL') } catch { /* gone */ } finish(null) }, DOC.childTimeoutMs)
    child.stdout?.on('data', (d: Buffer) => out.push(d))
    child.stderr?.resume()
    child.on('error', () => finish(null))
    child.on('close', code => finish(code === 0 ? Buffer.concat(out) : null))
    child.stdin?.on('error', () => { /* killed before the write drained */ })
    child.stdin?.end(buf)
  })
}

/** `file -bi` as a HINT only — whatever it says still has to round-trip. */
function charsetHint(p: string): Promise<string | null> {
  return new Promise(resolve => {
    let child
    try {
      child = spawn('file', ['-bi', '--', p], { stdio: ['ignore', 'pipe', 'ignore'] })
    } catch { resolve(null); return }
    let s = ''
    let done = false
    const finish = (v: string | null) => { if (!done) { done = true; clearTimeout(timer); resolve(v) } }
    const timer = setTimeout(() => { try { child.kill('SIGKILL') } catch { /* gone */ } finish(null) }, 5000)
    child.stdout?.on('data', (d: Buffer) => { s += d.toString() })
    child.on('error', () => finish(null))
    child.on('close', () => {
      const m = /charset=([\w.:-]+)/i.exec(s)
      finish(m ? m[1].toLowerCase() : null)
    })
  })
}

/** file(1)'s charset names -> iconv names. 'binary' and 'us-ascii' are dropped:
 *  a real binary never reaches here, and pure ASCII already passed as UTF-8. */
function hintToIconv(h: string | null): string | null {
  if (!h) return null
  switch (h) {
    case 'iso-8859-1': return 'ISO-8859-1'
    case 'iso-8859-2': return 'ISO-8859-2'
    case 'iso-8859-15': return 'ISO-8859-15'
    case 'windows-1252': case 'cp1252': return 'WINDOWS-1252'
    case 'windows-1251': case 'cp1251': return 'WINDOWS-1251'
    case 'koi8-r': return 'KOI8-R'
    case 'utf-16le': return 'UTF-16LE'
    case 'utf-16be': return 'UTF-16BE'
    case 'ebcdic': return 'EBCDIC-US'
    // 'unknown-8bit' is file(1) saying "8-bit, no idea": the Windows default is
    // the likeliest source of such a file on this user's share
    case 'unknown-8bit': return 'WINDOWS-1252'
  }
  return null
}

/** ISO-8859-1 is byte-identity in Node ('latin1'), so this needs no child and
 *  can never fail — which is what makes the candidate loop always terminate. */
function latin1(buf: Buffer): string { return buf.toString('latin1') }

interface Decoded { text: string; encoding: string; bom: boolean; lossless: boolean }

async function decode(buf: Buffer, p: string): Promise<Decoded> {
  // 1. A BOM is an explicit statement of the encoding — it wins outright.
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    const body = buf.subarray(3)
    const s = body.toString('utf8')
    return { text: s, encoding: 'UTF-8', bom: true, lossless: Buffer.from(s, 'utf8').equals(body) }
  }
  for (const [b0, b1, enc] of [[0xff, 0xfe, 'UTF-16LE'], [0xfe, 0xff, 'UTF-16BE']] as const) {
    if (buf.length >= 2 && buf[0] === b0 && buf[1] === b1) {
      const body = buf.subarray(2)
      const u8 = await iconv(body, enc, 'UTF-8')
      if (u8) {
        const s = u8.toString('utf8')
        const back = await iconv(Buffer.from(s, 'utf8'), 'UTF-8', enc)
        return { text: s, encoding: enc, bom: true, lossless: !!back && back.equals(body) }
      }
      return { text: latin1(buf), encoding: 'ISO-8859-1', bom: false, lossless: true }
    }
  }

  // 2. Strict UTF-8: decode and re-encode. Node substitutes U+FFFD for invalid
  //    sequences, so a file that is not valid UTF-8 cannot survive this — and a
  //    file that genuinely contains U+FFFD does.
  const s8 = buf.toString('utf8')
  if (Buffer.from(s8, 'utf8').equals(buf)) {
    return { text: s8, encoding: 'UTF-8', bom: false, lossless: true }
  }

  // 3. file(1)'s guess first, then the two 8-bit codepages worth trying. Each
  //    candidate must reproduce the original bytes or it does not count.
  const hinted = hintToIconv(await charsetHint(p))
  const seen = new Set<string>()
  for (const enc of [hinted, 'WINDOWS-1252'].filter(Boolean) as string[]) {
    if (seen.has(enc)) continue
    seen.add(enc)
    if (enc === 'ISO-8859-1') break             // handled below without a child
    const u8 = await iconv(buf, enc, 'UTF-8')
    if (!u8) continue
    const s = u8.toString('utf8')
    const back = await iconv(Buffer.from(s, 'utf8'), 'UTF-8', enc)
    if (back && back.equals(buf)) return { text: s, encoding: enc, bom: false, lossless: true }
  }

  // 4. Every byte is a character in latin-1, so this always round-trips. It may
  //    show mojibake for a file that is really cp1251, but saving it back is
  //    still byte-exact, which is the property that matters.
  return { text: latin1(buf), encoding: 'ISO-8859-1', bom: false, lossless: true }
}

// ---------------------------------------------------------------- line endings

function eolOf(text: string): { eol: TextEol; mixed: boolean } {
  const crlf = (text.match(/\r\n/g) ?? []).length
  const lone = text.replace(/\r\n/g, '').match(/[\r\n]/g) ?? []
  const lf = lone.filter(c => c === '\n').length
  const cr = lone.length - lf
  const kinds = (crlf ? 1 : 0) + (lf ? 1 : 0) + (cr ? 1 : 0)
  const eol: TextEol = crlf >= lf && crlf >= cr && crlf > 0 ? 'crlf'
    : cr > lf ? 'cr' : 'lf'
  return { eol, mixed: kinds > 1 }
}

function toLf(text: string): string {
  return text.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
}

function applyEol(text: string, eol: TextEol): string {
  if (eol === 'crlf') return text.replace(/\n/g, '\r\n')
  if (eol === 'cr') return text.replace(/\n/g, '\r')
  return text
}

/** NUL anywhere is the one unambiguous "this is not text" signal. The looser
 *  control-character heuristic preview.ts uses is deliberately NOT copied: this
 *  file is about to be written back, so a false positive costs the user nothing
 *  while a false negative would rewrite a binary.
 *
 *  UTF-16 is why this runs on the DECODED text and not on the raw bytes: half
 *  of a UTF-16 ASCII file is NUL bytes, and testing the buffer refused every
 *  such file as binary. */
function hasNulBytes(buf: Buffer): boolean {
  return buf.includes(0)
}

function hasNul(s: string): boolean {
  return s.includes('\u0000')
}

/** true for the two UTF-16 byte-order marks, whose bytes cannot be judged
 *  before they are decoded */
function isUtf16Bom(buf: Buffer): boolean {
  return buf.length >= 2
    && ((buf[0] === 0xff && buf[1] === 0xfe) || (buf[0] === 0xfe && buf[1] === 0xff))
}

// ---------------------------------------------------------------- read

async function readInner(p: string): Promise<TextFile> {
  const st = await fsp.stat(p)
  if (st.isDirectory()) return empty({ error: 'Not a file.', refusal: 'not-a-file' })
  if (!st.isFile()) return empty({ error: 'Not a file.', refusal: 'not-a-file' })
  if (st.size > DOC.textMaxBytes) {
    return empty({
      size: st.size, mtime: Math.round(st.mtimeMs), mode: st.mode,
      refusal: 'too-big',
      error: `This file is ${Math.round(st.size / 1024 / 1024 * 10) / 10} MB. `
        + 'The editor here holds the whole document in memory (undo included), '
        + 'so it stops at 2 MB.',
    })
  }

  const buf = await fsp.readFile(p)
  const refuseBinary = () => empty({
    size: st.size, bytes: buf.length, mtime: Math.round(st.mtimeMs), mode: st.mode,
    refusal: 'binary',
    error: 'This file contains binary data, so editing it as text would destroy it.',
  })
  // A UTF-16 file is half NUL bytes, so it has to be decoded before it can be
  // judged; everything else is judged first, because decoding a 2 MB binary is
  // work with no possible use.
  const utf16 = isUtf16Bom(buf)
  if (!utf16 && hasNulBytes(buf)) return refuseBinary()

  const d = await decode(buf, p)
  if (utf16 && hasNul(d.text)) return refuseBinary()
  const { eol, mixed } = eolOf(d.text)
  const hadFinalNewline = /[\r\n]$/.test(d.text)
  // realpath so a save replaces the symlink's TARGET: renaming over a symlink
  // would silently turn the link into a regular file
  const realPath = await fsp.realpath(p).catch(() => p)

  return {
    ok: true,
    text: toLf(d.text),
    encoding: d.encoding,
    bom: d.bom,
    lossless: d.lossless,
    eol, mixedEol: mixed, hadFinalNewline,
    bytes: buf.length,
    size: st.size,
    mtime: Math.round(st.mtimeMs),
    mode: st.mode,
    realPath: realPath === p ? undefined : realPath,
  }
}

export async function textRead(p: string): Promise<TextFile> {
  if (!p || !p.startsWith('/')) return empty({ error: 'Not a file on this computer.', refusal: 'not-a-file' })
  const work = (async () => {
    await acquire()
    try { return await readInner(p) } catch (e) {
      return empty({ error: errText(e), refusal: 'unreadable' })
    } finally { release() }
  })()
  return withDeadline(work, DOC.readTimeoutMs, () => empty({
    refusal: 'timeout',
    error: 'That file did not answer in time — the drive it is on may be disconnected.',
  }))
}

// ---------------------------------------------------------------- write

/** Encode for the target encoding, or explain what cannot be represented. */
async function encodeFor(text: string, encoding: string, bom: boolean): Promise<Buffer | { bad: string }> {
  let body: Buffer
  if (encoding === 'UTF-8') {
    body = Buffer.from(text, 'utf8')
  } else if (encoding === 'ISO-8859-1') {
    // Buffer.from(s,'latin1') TRUNCATES anything above U+00FF to its low byte,
    // which would silently turn a pasted '€' into some other character
    const bad = [...text].find(c => c.codePointAt(0)! > 0xff)
    if (bad) return { bad }
    body = Buffer.from(text, 'latin1')
  } else {
    const enc = await iconv(Buffer.from(text, 'utf8'), 'UTF-8', encoding)
    // iconv exits non-zero on the first character the target cannot hold
    if (!enc) return { bad: '' }
    body = enc
  }
  if (!bom) return body
  const mark = encoding === 'UTF-16LE' ? Buffer.from([0xff, 0xfe])
    : encoding === 'UTF-16BE' ? Buffer.from([0xfe, 0xff])
      : Buffer.from([0xef, 0xbb, 0xbf])
  return Buffer.concat([mark, body])
}

async function writeInner(p: string, text: string, o: TextWriteOpts): Promise<TextWriteResult> {
  // the symlink's target, so a rename never replaces the link itself
  const target = await fsp.realpath(p).catch(() => p)
  const dir = path.dirname(target)
  const name = path.basename(target)

  // Optimistic lock: re-stat NOW, not when the file was opened. Another window,
  // another app, or a git checkout may have written it in between.
  const st = await fsp.stat(target).catch(() => null)
  if (!st) return { ok: false, error: 'The item is no longer in this location.' }
  if (!o.force && (Math.round(st.mtimeMs) !== o.expectMtime || st.size !== o.expectSize)) {
    return {
      ok: false, conflict: true,
      error: 'This file changed on disk after it was opened here.',
    }
  }

  let body = text
  if (o.finalNewline && !body.endsWith('\n')) body += '\n'
  body = applyEol(body, o.eol)
  const enc = await encodeFor(body, o.encoding, o.bom)
  if ('bad' in enc) {
    return {
      ok: false, unrepresentable: true,
      error: enc.bad
        ? `"${enc.bad}" cannot be written in ${o.encoding}. Save as UTF-8 instead.`
        : `Some characters cannot be written in ${o.encoding}. Save as UTF-8 instead.`,
    }
  }

  // The backup is written from the file ON DISK, not from what was read, so it
  // is a true copy of what is about to be replaced.
  let backup: string | undefined
  let backupError: string | undefined
  if (o.backup) {
    backup = path.join(dir, `${name}~`)
    try { await fsp.copyFile(target, backup) } catch (e) {
      backup = undefined
      backupError = errText(e)
    }
  }

  const tmp = path.join(dir, `.${name}.liqtmp`)
  try {
    const fh = await fsp.open(tmp, 'w', 0o600)
    try {
      await fh.write(enc)
      await fh.chmod(st.mode & 0o7777)
      // best effort: only root can change the owner, but a setgid directory's
      // group is worth keeping when the process is allowed to set it
      await fh.chown(st.uid, st.gid).catch(() => {})
      // the rename below is atomic, but only against a crash — fsync is what
      // makes the CONTENT durable before the name starts pointing at it
      await fh.sync()
    } finally {
      await fh.close().catch(() => {})
    }

    // never trust the write alone: verify the bytes actually landed
    const ts = await fsp.stat(tmp)
    if (ts.size !== enc.length) {
      await fsp.rm(tmp, { force: true }).catch(() => {})
      return { ok: false, error: `Only ${ts.size} of ${enc.length} bytes were written, so nothing was changed.` }
    }

    await fsp.rename(tmp, target)
    // a rename is only durable once the DIRECTORY entry is on disk too
    await fsp.open(dir, 'r').then(async d => { await d.sync().catch(() => {}); await d.close() }).catch(() => {})
  } catch (e) {
    await fsp.rm(tmp, { force: true }).catch(() => {})
    return { ok: false, error: errText(e) }
  }

  const after = await fsp.stat(target).catch(() => null)
  history.record({ kind: 'edit', count: 1, sources: [target], dest: target, status: 'done' })
  return {
    ok: true,
    backup, backupError,
    mtime: after ? Math.round(after.mtimeMs) : 0,
    size: after ? after.size : enc.length,
  }
}

export async function textWrite(p: string, text: string, o: TextWriteOpts): Promise<TextWriteResult> {
  if (!p || !p.startsWith('/')) return { ok: false, error: 'Not a file on this computer.' }
  const work = (async () => {
    await acquire()
    try { return await writeInner(p, text, o) } catch (e) {
      return { ok: false, error: errText(e) }
    } finally { release() }
  })()
  return withDeadline<TextWriteResult>(work, DOC.writeTimeoutMs, () => ({
    ok: false,
    error: 'The save did not finish in time — the drive it is on may be disconnected.',
  }))
}

ipcMain.handle(CH('textRead'), (_e, p: string) => textRead(p))
ipcMain.handle(CH('textWrite'), (_e, p: string, text: string, o: TextWriteOpts) => textWrite(p, text, o))
