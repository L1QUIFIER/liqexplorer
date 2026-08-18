// Windows shortcuts (.lnk), read and followed.
//
// This share is used from Windows as well as Linux, so it is full of them — 91
// under /mnt/share/files alone — and every one of them was a dead file here: a
// double-click opened a binary blob, and the thing it pointed at could only be
// found by hand.
//
// PARSED HERE, not shelled out. exiftool can read a .lnk and is even installed
// on this machine, but it is optional (the System tab lists it as such) and a
// core "can I open this file" answer must not depend on an optional package.
// The format (MS-SHLLINK) is small and stable, and only three of its pieces
// matter for following a link.
//
// FOLLOWING IS THE HARD PART, not parsing. A shortcut records a WINDOWS path,
// and most of them name somewhere that does not exist on Linux at all
// (C:\Windows\Minidump, AppData, an Android SDK). So resolution is layered,
// cheapest and most reliable first, and it is honest when nothing works:
//
//   1. RELATIVE_PATH against the shortcut's own folder. This is the one that
//      actually works, because a shortcut that travelled with its tree still
//      points inside it — measured: 10 of 26 on this share resolve this way and
//      NONE of them by their absolute path.
//   2. A UNC path (\\server\share\…) matched against the mounts this machine
//      actually has, read from /proc/mounts. No configuration: if the share is
//      mounted, the answer is derivable.
//   3. Drive letters via user-configured mappings (C: -> /mnt/c, and so on).
//   4. Nothing. Say what it points at and that the target is not on this
//      machine, which is a real answer — pretending a shortcut is broken when
//      its target simply lives on another computer is not.
import { ipcMain } from 'electron'
import * as fsp from 'node:fs/promises'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { CH } from '../../shared/ipc'
import type { LnkTarget } from '../../shared/lnk'
import { getSettings } from '../state/settings'

/** a .lnk always starts with this header size and this CLSID */
const HEADER_SIZE = 0x4c
const CLSID = '0114020000000000c000000000000046'

const F_HAS_ID_LIST = 1 << 0
const F_HAS_LINK_INFO = 1 << 1
const F_HAS_NAME = 1 << 2
const F_HAS_RELATIVE = 1 << 3
const F_HAS_WORKDIR = 1 << 4
const F_HAS_ARGS = 1 << 5
const F_HAS_ICON = 1 << 6
const F_UNICODE = 1 << 7

interface Parsed {
  relative: string
  workingDir: string
  localBasePath: string
  commonPathSuffix: string
  /** \\server\share — set only for a network link */
  netShare: string
  /** the target is a directory according to the file-attributes field */
  isDir: boolean
}

/** StringData: a 2-byte character count, then that many chars */
function readString(buf: Buffer, at: number, unicode: boolean): { text: string; next: number } {
  if (at + 2 > buf.length) return { text: '', next: at }
  const chars = buf.readUInt16LE(at)
  const bytes = unicode ? chars * 2 : chars
  const start = at + 2
  if (start + bytes > buf.length) return { text: '', next: buf.length }
  const raw = buf.subarray(start, start + bytes)
  return { text: unicode ? raw.toString('utf16le') : raw.toString('latin1'), next: start + bytes }
}

export function parseLnk(buf: Buffer): Parsed | null {
  if (buf.length < HEADER_SIZE) return null
  if (buf.readUInt32LE(0) !== HEADER_SIZE) return null
  if (buf.subarray(4, 20).toString('hex') !== CLSID) return null

  const flags = buf.readUInt32LE(20)
  const attrs = buf.readUInt32LE(24)
  const unicode = !!(flags & F_UNICODE)
  const out: Parsed = {
    relative: '', workingDir: '', localBasePath: '', commonPathSuffix: '', netShare: '',
    isDir: !!(attrs & 0x10),            // FILE_ATTRIBUTE_DIRECTORY
  }

  let at = HEADER_SIZE
  if (flags & F_HAS_ID_LIST) {
    // the shell item id list describes the target in shell terms; the paths
    // below say the same thing in a form that can be used, so it is skipped
    if (at + 2 > buf.length) return out
    at += 2 + buf.readUInt16LE(at)
  }

  if (flags & F_HAS_LINK_INFO && at + 4 <= buf.length) {
    const infoStart = at
    const infoSize = buf.readUInt32LE(at)
    if (infoSize > 0 && infoStart + infoSize <= buf.length) {
      const infoFlags = buf.readUInt32LE(infoStart + 8)
      const readAt = (off: number): string => {
        if (off <= 0 || infoStart + off >= buf.length) return ''
        const end = buf.indexOf(0, infoStart + off)
        return buf.subarray(infoStart + off, end < 0 ? buf.length : end).toString('latin1')
      }
      // bit 0: the link has a local path; bit 1: it has a network share
      if (infoFlags & 1) out.localBasePath = readAt(buf.readUInt32LE(infoStart + 0x10))
      out.commonPathSuffix = readAt(buf.readUInt32LE(infoStart + 0x18))
      if (infoFlags & 2) {
        const netOff = buf.readUInt32LE(infoStart + 0x14)
        if (netOff > 0 && infoStart + netOff + 0x14 <= buf.length) {
          const shareOff = buf.readUInt32LE(infoStart + netOff + 0x08)
          if (shareOff > 0) {
            const abs = infoStart + netOff + shareOff
            const end = buf.indexOf(0, abs)
            out.netShare = buf.subarray(abs, end < 0 ? buf.length : end).toString('latin1')
          }
        }
      }
    }
    at = infoStart + (infoSize || 0)
  }

  // StringData, always in this order, each present only if its flag is set
  if (flags & F_HAS_NAME) at = readString(buf, at, unicode).next
  if (flags & F_HAS_RELATIVE) { const r = readString(buf, at, unicode); out.relative = r.text; at = r.next }
  if (flags & F_HAS_WORKDIR) { const r = readString(buf, at, unicode); out.workingDir = r.text; at = r.next }
  if (flags & F_HAS_ARGS) at = readString(buf, at, unicode).next
  if (flags & F_HAS_ICON) at = readString(buf, at, unicode).next
  return out
}

// ------------------------------------------------------------- resolution

function winToPosix(p: string): string {
  return p.replace(/\\/g, '/')
}

/** every cifs/smb mount this machine has, as `//server/share` -> mountpoint */
function networkMounts(): { unc: string; at: string }[] {
  const out: { unc: string; at: string }[] = []
  let text = ''
  try { text = fs.readFileSync('/proc/mounts', 'utf8') } catch { return out }
  for (const line of text.split('\n')) {
    const [src, mnt, type] = line.split(' ')
    if (!src || !mnt) continue
    if (type !== 'cifs' && type !== 'smb3' && type !== 'nfs' && type !== 'nfs4') continue
    // /proc/mounts escapes spaces as \040
    out.push({ unc: src.replace(/\\040/g, ' ').toLowerCase(), at: mnt.replace(/\\040/g, ' ') })
  }
  return out
}

/** does this path exist, and is it what the link said it was? */
async function exists(p: string): Promise<boolean> {
  try { await fsp.stat(p); return true } catch { return false }
}

/**
 * Where does this shortcut actually point on THIS machine?
 *
 * Returns the Windows target either way, so a link that cannot be followed can
 * still show what it names.
 */
export async function resolveLnk(file: string): Promise<LnkTarget> {
  const out: LnkTarget = { ok: false, lnk: file, target: '', winTarget: '', isDir: false }
  let buf: Buffer
  try { buf = await fsp.readFile(file) } catch (e) {
    return { ...out, error: String((e as Error)?.message ?? e) }
  }
  const p = parseLnk(buf)
  if (!p) return { ...out, error: 'That is not a Windows shortcut.' }

  out.isDir = p.isDir
  out.winTarget = p.localBasePath
    ? p.localBasePath + (p.commonPathSuffix ? '\\' + p.commonPathSuffix : '')
    : p.netShare
      ? p.netShare + (p.commonPathSuffix ? '\\' + p.commonPathSuffix : '')
      : p.relative
  const dir = path.dirname(file)

  // 1. the relative path, against the shortcut's own folder — the one that
  //    actually works when a tree was copied across
  if (p.relative) {
    const rel = winToPosix(p.relative).replace(/^\.\//, '')
    const guess = path.resolve(dir, rel)
    if (await exists(guess)) return { ...out, ok: true, target: guess, how: 'relative' }
  }

  // 2. a UNC target, matched against what is actually mounted
  if (p.netShare) {
    const unc = winToPosix(p.netShare).toLowerCase()          // //server/share
    for (const m of networkMounts()) {
      if (unc === m.unc || unc === m.unc.replace(/\/$/, '')) {
        const guess = path.join(m.at, winToPosix(p.commonPathSuffix))
        if (await exists(guess)) return { ...out, ok: true, target: guess, how: 'unc' }
      }
    }
  }

  // 3. user-configured drive mappings, longest prefix first so C:\Users\me\X
  //    can be mapped more specifically than C:\
  const maps = Object.entries(getSettings().lnkMappings ?? {})
    .sort((a, b) => b[0].length - a[0].length)
  const win = out.winTarget
  for (const [from, to] of maps) {
    if (!from || !to) continue
    if (win.toLowerCase().startsWith(from.toLowerCase())) {
      const rest = winToPosix(win.slice(from.length)).replace(/^\//, '')
      const guess = path.join(to, rest)
      if (await exists(guess)) return { ...out, ok: true, target: guess, how: 'mapping' }
    }
  }

  return {
    ...out,
    error: win
      ? 'That shortcut points somewhere this computer does not have.'
      : 'That shortcut does not name a target.',
  }
}

ipcMain.handle(CH('resolveLnk'), (_e, file: string) => resolveLnk(file))
