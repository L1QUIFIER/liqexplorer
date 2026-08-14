// Password candidate discovery — the SILENT half of encrypted-archive support.
// Ported from Sean's "Ultimate Extractor" (password_filename.py,
// password_textfile.py, password_common.py, utils.is_valid_password): the same
// markers, the same validity rules, the same ordering by confidence.
//
// This module ONLY guesses at things a human would have written down next to
// the archive. There is deliberately NO cracking: no dictionaries, no brute
// force, no mutation engine, no bkcrack/hashcat/john, and no web lookup. If the
// obvious candidates miss, the user is asked.
//
// Nothing here logs, and callers must keep candidates out of OpProgress.
import * as fsp from 'node:fs/promises'
import * as path from 'node:path'

export interface Candidate {
  password: string
  /** 0..1, highest first; only used for ordering */
  confidence: number
}

/** utils.INVALID_PASSWORD_WORDS */
const INVALID_WORDS = new Set([
  'rar', 'zip', '7z', 'archive', 'file', 'download', 'part',
  'setup', 'install', 'final', 'version', 'v1', 'v2', 'v3',
  'game', 'crack', 'keygen', 'patch', 'update', 'dlc',
  'none', 'null', 'n/a', 'na', 'nil', 'nothing', 'empty',
  'required', 'needed', 'unknown', 'see', 'below', 'above',
])

/** utils.is_valid_password — length 3..50, no junk words, no URLs, no bare short numbers. */
export function isValidPassword(pw: string): boolean {
  if (typeof pw !== 'string') return false
  if (pw.length < 3 || pw.length > 50) return false
  if (INVALID_WORDS.has(pw.toLowerCase())) return false
  if (/[<>{}[\]|\\]/.test(pw)) return false
  if (/^(https?|ftp|file:\/\/|www\.|\/\/)/i.test(pw)) return false
  if (/^\d+$/.test(pw) && pw.length < 4) return false
  return true
}

/** password_common.CommonPasswordDatabase — the short list, minus the site names. */
const COMMON_PASSWORDS = [
  'password', '123456', '12345678', 'qwerty', '1234',
  'password123', 'pass', 'admin', 'root', 'test',
  'archive', 'extract', 'unlock', 'open', 'letmein',
]

/** password_filename.FilenamePasswordParser.patterns (explicit markers first) */
const FILENAME_PATTERNS: [RegExp, number][] = [
  [/(?:password|pwd|pass|pw)\s*[=:]\s*([^\s.]+)/gi, 0.95],
  [/(?:password|pwd|pass|pw)[_-]([a-zA-Z0-9]+)/gi, 0.90],
  [/[[({]([^\])}]+)[\])}]/g, 0.90],
  [/[_-]([a-zA-Z0-9]+)[_-](?:rar|zip|7z|tar)$/gi, 0.80],
  [/_([a-zA-Z0-9]+)\.(?:rar|zip|7z|tar)/gi, 0.70],
  [/-([a-zA-Z0-9]+)\.(?:rar|zip|7z|tar)$/gi, 0.60],
]

/** password_textfile.TextFileScanner.password_patterns */
const TEXT_PATTERNS: [RegExp, number][] = [
  [/password\s*[:=]?\s*([^\s\n]+)/gi, 0.85],
  [/pass\s*[:=]?\s*([^\s\n]+)/gi, 0.80],
  [/pwd\s*[:=]?\s*([^\s\n]+)/gi, 0.75],
  [/pw\s*[:=]?\s*([^\s\n]+)/gi, 0.75],
  [/extract\s+(?:with|using)\s*[:=]?\s*([^\s\n]+)/gi, 0.85],
  [/unlock\s*[:=]?\s*([^\s\n]+)/gi, 0.80],
  [/key\s*[:=]?\s*([^\s\n]+)/gi, 0.70],
]

const TEXT_EXTS = ['.txt', '.nfo', '.info', '.readme', '.diz', '.md', '.text']
const MAX_TEXT_BYTES = 1024 * 1024
const MAX_TEXT_FILES = 10

/** Strip the volume suffix so 'foo.part01.rar' and 'foo.7z.001' both give 'foo'. */
function stemOf(name: string): string {
  let s = name
  s = s.replace(/\.(\d{3,})$/, '')
  s = s.replace(/\.part\d+\.rar$/i, '')
  s = s.replace(/\.r\d{2,}$/i, '')
  s = s.replace(/\.z\d{2,}$/i, '')
  s = s.replace(/\.(tar\.(gz|bz2|xz|zst)|tgz|tbz2?|txz)$/i, '')
  const i = s.lastIndexOf('.')
  if (i > 0) s = s.slice(0, i)
  return s.replace(/\.part\d+$/i, '').replace(/\.r\d+$/i, '').replace(/\.\d+$/, '')
}

function push(out: Candidate[], password: string, confidence: number): void {
  const pw = password.replace(/^[\s"']+|[\s"'.,;:!?]+$/g, '')
  if (!isValidPassword(pw)) return
  out.push({ password: pw, confidence })
}

/** password_filename: explicit markers in the archive's own name. */
export function fromFilename(name: string): Candidate[] {
  const out: Candidate[] = []
  for (const [re, conf] of FILENAME_PATTERNS) {
    re.lastIndex = 0
    for (const m of name.matchAll(re)) push(out, m[1], conf)
  }
  return out
}

/** password_filename._extract_compound_patterns + password_common.generate_context_passwords. */
export function fromNameParts(archivePath: string): Candidate[] {
  const out: Candidate[] = []
  const stem = stemOf(path.basename(archivePath))
  push(out, stem, 0.5)

  for (const sep of ['_', '-', '.', ' ']) {
    if (!stem.includes(sep)) continue
    const parts = stem.split(sep).filter(Boolean)
    if (parts.length < 2) continue
    push(out, parts[parts.length - 1], 0.6)
    push(out, parts[0], 0.4)
    push(out, parts.join(''), 0.45)
    for (let i = 1; i < parts.length - 1; i++) push(out, parts[i], 0.35)
    for (const to of [' ', '-', '']) {
      if (sep !== to) push(out, stem.split(sep).join(to), 0.4)
    }
  }
  // the parent folder name is the single most productive guess in practice
  const folder = path.basename(path.dirname(archivePath))
  push(out, folder, 0.35)
  return out
}

/** password_textfile: sibling .txt/.nfo/.diz/.readme files next to the archive. */
export async function fromSiblingText(archivePath: string): Promise<Candidate[]> {
  const dir = path.dirname(archivePath)
  const stem = stemOf(path.basename(archivePath)).toLowerCase()
  let names: string[]
  try { names = await fsp.readdir(dir) } catch { return [] }

  const cands: { file: string; size: number; related: boolean }[] = []
  for (const n of names) {
    const ext = path.extname(n).toLowerCase()
    if (!TEXT_EXTS.includes(ext)) continue
    const full = path.join(dir, n)
    const st = await fsp.stat(full).catch(() => null)
    if (!st || !st.isFile() || st.size > MAX_TEXT_BYTES) continue
    const base = path.basename(n, ext).toLowerCase()
    cands.push({ file: full, size: st.size, related: base.includes(stem) || stem.includes(base) || /pass|readme|info/.test(base) })
  }
  // related names first, then smallest — same ordering as the python scanner
  cands.sort((a, b) => (a.related === b.related ? a.size - b.size : a.related ? -1 : 1))

  const out: Candidate[] = []
  for (const c of cands.slice(0, MAX_TEXT_FILES)) {
    let text: string
    try { text = await fsp.readFile(c.file, 'latin1') } catch { continue }
    for (const [re, conf] of TEXT_PATTERNS) {
      re.lastIndex = 0
      for (const m of text.matchAll(re)) {
        // a mention of the archive nearby raises confidence (python does +0.10)
        const around = text.slice(Math.max(0, m.index - 100), m.index + 100).toLowerCase()
        push(out, m[1], around.includes(stem) ? Math.min(0.95, conf + 0.1) : conf)
      }
    }
  }
  return out
}

/**
 * Every silent candidate for one archive, best-first and de-duplicated.
 * `extra` (a password already accepted earlier in the same operation) always
 * goes first — a folder of archives usually shares one password.
 */
export async function candidatesFor(archivePath: string, extra: string[] = []): Promise<string[]> {
  const all: Candidate[] = []
  for (const e of extra) all.push({ password: e, confidence: 2 })
  all.push(...fromFilename(path.basename(archivePath)))
  all.push(...fromNameParts(archivePath))
  all.push(...await fromSiblingText(archivePath))
  for (const p of COMMON_PASSWORDS) all.push({ password: p, confidence: 0.25 })

  const best = new Map<string, number>()
  for (const c of all) {
    const prev = best.get(c.password)
    if (prev === undefined || c.confidence > prev) best.set(c.password, c.confidence)
  }
  return [...best.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(e => e[0])
}

/** Hard ceiling on silent attempts — this is guessing, not cracking. */
export const MAX_SILENT_ATTEMPTS = 60

/**
 * Wall-clock ceiling for the silent phase. Probing one member of a *solid*
 * encrypted 7z means decoding its whole block, so a handful of candidates can
 * cost seconds each; past this we stop guessing and ask the user rather than
 * leaving the op apparently hung.
 */
export const MAX_SILENT_MS = 15_000
