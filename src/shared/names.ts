// Problem file names — detection + safe-replacement suggestions.
//
// Files may live on a CIFS share that both Linux and Windows read, so a name
// that is perfectly legal on ext4 ("Report: Q3?.txt") is unreachable from
// Windows and comes back through Samba as private-use garbage. This module is
// the single source of truth for "what is wrong with this name" and "what
// should it be instead".
//
// PURE and dependency-free on purpose: main (scanner + IPC) and renderer
// (Fix problem names dialog, inline rename warning) both import it, and it can
// be unit-tested with plain node. Nothing here touches the filesystem — the
// caller supplies the context (is this location visible to Windows? what is the
// full path? do the raw bytes decode as UTF-8? does a sibling collide by case?).
//
// Emoji and other astral characters are deliberately NOT problems.

// ---------------------------------------------------------------- codes

export type NameIssueCode =
  | 'reservedChar'      // < > : " / \ | ? *
  | 'trailingDot'       // "notes." — Windows drops the dot
  | 'trailingSpace'     // "notes " — Windows drops the space
  | 'leadingSpace'      // " notes"
  | 'reservedDevice'    // CON, PRN, AUX, NUL, COM1-9, LPT1-9 (with or without extension)
  | 'dotsOnly'          // "..." / "."
  | 'controlChar'       // 0x00-0x1F, 0x7F (newlines and tabs included)
  | 'nameTooLong'       // > 255 bytes
  | 'pathTooLong'       // full path >= MAX_PATH characters
  | 'invalidEncoding'   // raw bytes are not valid UTF-8
  | 'caseCollision'     // a.txt + A.txt in one folder

export interface NameIssue {
  code: NameIssueCode
  /** plain-English explanation, ready to show in the UI */
  message: string
  /** the offending characters / measured length / colliding sibling */
  detail?: string
}

export interface NameIssueInfo {
  /** short column label, e.g. 'Illegal character' */
  label: string
  /** static explanation of the rule (the per-issue `message` is specific) */
  explain: string
  /** true when the name only breaks on a filesystem Windows reads */
  windowsOnly: boolean
}

/** UI-facing descriptions; keyed by code so the dialog never hard-codes text. */
export const ISSUE_INFO: Record<NameIssueCode, NameIssueInfo> = {
  reservedChar: {
    label: 'Illegal character',
    explain: 'Windows forbids < > : " / \\ | ? * in file names.',
    windowsOnly: true,
  },
  trailingDot: {
    label: 'Ends with a dot',
    explain: 'Windows silently strips a trailing dot, so the file can no longer be opened by name.',
    windowsOnly: true,
  },
  trailingSpace: {
    label: 'Ends with a space',
    explain: 'Windows silently strips a trailing space, so the file can no longer be opened by name.',
    windowsOnly: true,
  },
  leadingSpace: {
    label: 'Starts with a space',
    explain: 'A leading space is dropped or mishandled by most Windows tools.',
    windowsOnly: true,
  },
  reservedDevice: {
    label: 'Reserved device name',
    explain: 'CON, PRN, AUX, NUL, COM1-COM9 and LPT1-LPT9 are device names on Windows, with or without an extension.',
    windowsOnly: true,
  },
  dotsOnly: {
    label: 'Only dots',
    explain: 'A name made only of dots is not a valid Windows file name.',
    windowsOnly: true,
  },
  controlChar: {
    label: 'Control character',
    explain: 'Control characters (including tabs and newlines) cannot be displayed or typed.',
    windowsOnly: false,
  },
  nameTooLong: {
    label: 'Name too long',
    explain: 'A single name is limited to 255 bytes.',
    windowsOnly: false,
  },
  pathTooLong: {
    label: 'Path too long',
    explain: 'Windows cannot open paths of 260 characters or more (MAX_PATH).',
    windowsOnly: true,
  },
  invalidEncoding: {
    label: 'Invalid encoding',
    explain: 'The raw bytes are not valid UTF-8. Samba maps them into Unicode private-use characters, so the name shows as garbage everywhere.',
    windowsOnly: false,
  },
  caseCollision: {
    label: 'Differs only by case',
    explain: 'Two names in one folder that differ only by case collide on Windows and on SMB shares.',
    windowsOnly: true,
  },
}

// ---------------------------------------------------------------- constants

/** characters Windows refuses in a file name */
export const WINDOWS_RESERVED_CHARS = '<>:"/\\|?*'

/** conservative, reversible replacements (Explorer-ish, never lossy to nothing) */
export const CHAR_FIXES: Readonly<Record<string, string>> = {
  '<': '(',
  '>': ')',
  ':': '-',
  '"': "'",
  '/': '-',
  '\\': '-',
  '|': '-',
  '?': '_',
  '*': '_',
}

/** POSIX per-component limit (NAME_MAX), in bytes */
export const MAX_NAME_BYTES = 255

/** Windows MAX_PATH: a full path must fit in 260 chars INCLUDING the NUL */
export const MAX_PATH = 260

const RESERVED_DEVICE = /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i

/** longest suffix still treated as an extension when truncating */
const MAX_EXT_BYTES = 24

/** replacement fallback when sanitising empties the name completely */
export const FALLBACK_NAME = 'unnamed'

// ---------------------------------------------------------------- options

export interface NameOptions {
  /**
   * Apply the Windows/SMB rules. Callers derive this from the location:
   * main uses fs/list.isRemotePath(), the renderer uses FileEntry.remote.
   * Defaults to true — pass false for a purely local ext4 folder so a `:` in
   * ~/Documents is never nagged about.
   */
  windows?: boolean
  /** absolute path the name lives (or will live) at — enables the MAX_PATH check */
  fullPath?: string
  /** override the 255-byte name limit (0 disables the check) */
  maxNameBytes?: number
  /** override MAX_PATH (0 disables the check) */
  maxPath?: number
  /** the entry is a directory (no extension is preserved when truncating) */
  isDir?: boolean
  /** the scanner read the raw bytes and they are not valid UTF-8 */
  encodingInvalid?: boolean
  /** a sibling in the same folder differs from this name only by case */
  caseCollidesWith?: string
}

// ------------------------------------------------------- IPC payload shapes
// (kept here, not in shared/types.ts, so this feature owns its whole contract:
//  main/platform/names.ts implements it, renderer/dialogs/fixnames.ts calls it
//  through liq.invoke('scanNames' | 'fixNames' | 'checkName', ...).)

/** how the Windows rules are decided: by mount type, or forced on/off */
export type WindowsRule = 'auto' | 'always' | 'never'

export interface ScanNamesRequest {
  /** folder to scan (ignored when `paths` is given) */
  root?: string
  /** explicit items to check instead of a whole folder (a selection) */
  paths?: string[]
  /** descend into subfolders */
  recursive?: boolean
  /** default 'auto' = Windows rules only where isRemotePath() says so */
  windows?: WindowsRule
  /** include dot-files / dot-folders (default false) */
  showHidden?: boolean
  /** stop after this many problems (default 5000) */
  limit?: number
}

export interface NameProblem {
  /** display path — LOSSY when encodingInvalid, so never usable with fs */
  path: string
  dir: string
  name: string
  isDir: boolean
  issues: NameIssue[]
  /** proposed replacement name, already de-collided against the folder */
  suggested: string
  /** the raw bytes are not valid UTF-8 — renaming needs pathHex */
  encodingInvalid: boolean
  /** hex of the raw byte path; present only when encodingInvalid */
  pathHex?: string
  /** false when this row's location is not checked against the Windows rules */
  windows: boolean
}

export interface ScanNamesResult {
  problems: NameProblem[]
  /** entries examined */
  scanned: number
  /** folders that could not be read */
  errors: { path: string; error: string }[]
  /** the limit was hit — more problems exist */
  truncated: boolean
  /** at least one scanned location is checked against the Windows rules */
  windowsChecked: boolean
}

export interface FixNameRequest {
  /** current full path (lossy when the name has invalid bytes — pass fromHex too) */
  from: string
  /** the new NAME, or a full new path */
  to: string
  /** hex of the raw byte path, straight from NameProblem.pathHex */
  fromHex?: string
}

export interface FixNameResult {
  from: string
  to: string
  ok: boolean
  error?: string
  /** false for invalid-UTF-8 sources: those are renamed outside the undo stack */
  undoable: boolean
}

export interface FixNamesResult {
  results: FixNameResult[]
  fixed: number
  failed: number
  /** a single batch entry was pushed onto the undo stack */
  undoRecorded: boolean
}

// ---------------------------------------------------------------- helpers

/** UTF-8 byte length without Buffer (renderer-safe) */
export function byteLength(s: string): number {
  let n = 0
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    if (c < 0x80) n += 1
    else if (c < 0x800) n += 2
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
      const lo = s.charCodeAt(i + 1)
      if (lo >= 0xdc00 && lo <= 0xdfff) { n += 4; i++ } else n += 3
    } else n += 3
  }
  return n
}

function isControl(code: number): boolean {
  return code < 0x20 || code === 0x7f
}

/** 'tab', 'newline', 'carriage return', 'U+0007' — for the explanation text */
function controlLabel(ch: string): string {
  switch (ch) {
    case '\t': return 'tab'
    case '\n': return 'newline'
    case '\r': return 'carriage return'
    case '\0': return 'NUL'
  }
  return 'U+' + ch.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0')
}

/** the part Windows tests against its device names: everything before the first dot */
function deviceStem(name: string): string {
  const i = name.indexOf('.')
  return (i === -1 ? name : name.slice(0, i)).trim()
}

/** split off a real-looking extension; directories and dotfiles keep the whole name */
export function splitExt(name: string, isDir = false): { stem: string; ext: string } {
  if (isDir) return { stem: name, ext: '' }
  const i = name.lastIndexOf('.')
  if (i <= 0) return { stem: name, ext: '' }
  const ext = name.slice(i)
  if (byteLength(ext) > MAX_EXT_BYTES) return { stem: name, ext: '' }
  return { stem: name.slice(0, i), ext }
}

/** true when the name is a Windows device name, with or without an extension */
export function isReservedDeviceName(name: string): boolean {
  return RESERVED_DEVICE.test(deviceStem(name))
}

// ---------------------------------------------------------------- analysis

/**
 * Every problem with `name`, in report order. Pure: `opts` supplies all the
 * context (Windows-visible location, full path, raw-byte validity, case twin).
 */
export function analyzeName(name: string, opts: NameOptions = {}): NameIssue[] {
  const windows = opts.windows !== false
  const maxNameBytes = opts.maxNameBytes ?? MAX_NAME_BYTES
  const maxPath = opts.maxPath ?? MAX_PATH
  const out: NameIssue[] = []

  // --- broken everywhere, regardless of destination filesystem

  if (opts.encodingInvalid || name.includes('�')) {
    out.push({
      code: 'invalidEncoding',
      message: 'The name is not valid UTF-8. Samba turns the stray bytes into private-use characters, so it shows as garbage on Windows and in most Linux apps.',
    })
  }

  const ctrl: string[] = []
  for (const ch of name) {
    const c = ch.codePointAt(0) ?? 0
    if (isControl(c) && !ctrl.includes(ch)) ctrl.push(ch)
  }
  if (ctrl.length) {
    const which = ctrl.map(controlLabel).join(', ')
    out.push({
      code: 'controlChar',
      message: `The name contains a control character (${which}) that cannot be displayed or typed.`,
      detail: which,
    })
  }

  const bytes = byteLength(name)
  if (maxNameBytes > 0 && bytes > maxNameBytes) {
    out.push({
      code: 'nameTooLong',
      message: `The name is ${bytes} bytes long; the limit for one name is ${maxNameBytes} bytes.`,
      detail: `${bytes} bytes`,
    })
  }

  if (!windows) return out

  // --- only matter where Windows will read the file

  if (maxPath > 0 && opts.fullPath && opts.fullPath.length >= maxPath) {
    out.push({
      code: 'pathTooLong',
      message: `The full path is ${opts.fullPath.length} characters; Windows cannot open a path of ${maxPath} characters or more.`,
      detail: `${opts.fullPath.length} characters`,
    })
  }

  const badChars: string[] = []
  for (const ch of name) {
    if (WINDOWS_RESERVED_CHARS.includes(ch) && !badChars.includes(ch)) badChars.push(ch)
  }
  if (badChars.length) {
    out.push({
      code: 'reservedChar',
      message: `Windows cannot use ${badChars.join(' ')} in a file name.`,
      detail: badChars.join(' '),
    })
  }

  if (/^\.+$/.test(name)) {
    out.push({ code: 'dotsOnly', message: 'A name made only of dots is not valid on Windows.' })
  } else {
    if (name.endsWith('.')) {
      out.push({
        code: 'trailingDot',
        message: 'The name ends with a dot. Windows strips it silently, and the file can then no longer be opened by name.',
      })
    }
    if (/\s$/.test(name)) {
      out.push({
        code: 'trailingSpace',
        message: 'The name ends with a space. Windows strips it silently, and the file can then no longer be opened by name.',
      })
    }
  }
  if (/^\s/.test(name)) {
    out.push({
      code: 'leadingSpace',
      message: 'The name starts with a space, which Windows tools drop or mishandle.',
    })
  }

  if (isReservedDeviceName(name)) {
    out.push({
      code: 'reservedDevice',
      message: `"${deviceStem(name)}" is a reserved device name on Windows and cannot be used, even with an extension.`,
      detail: deviceStem(name).toUpperCase(),
    })
  }

  if (opts.caseCollidesWith) {
    out.push({
      code: 'caseCollision',
      message: `Another item here is named "${opts.caseCollidesWith}" — the two differ only by case, so they collide on Windows and on SMB shares.`,
      detail: opts.caseCollidesWith,
    })
  }

  return out
}

/**
 * Cheap synchronous check for the inline rename editor / New-folder path:
 * the first problem with the typed name, or null. Safe to call per keystroke.
 */
export function firstIssue(name: string, opts: NameOptions = {}): NameIssue | null {
  return analyzeName(name, opts)[0] ?? null
}

/** The first problem's message, or null — the string an inline warning shows. */
export function warnForName(name: string, opts: NameOptions = {}): string | null {
  return firstIssue(name, opts)?.message ?? null
}

/** True when the name has at least one problem. */
export function isProblemName(name: string, opts: NameOptions = {}): boolean {
  return analyzeName(name, opts).length > 0
}

/** One-line reason text for a list row. */
export function describeIssues(issues: NameIssue[]): string {
  return issues.map(i => i.message).join(' ')
}

/** Short labels for a compact column, e.g. 'Illegal character, Ends with a dot'. */
export function labelIssues(issues: NameIssue[]): string {
  return issues.map(i => ISSUE_INFO[i.code].label).join(', ')
}

// ---------------------------------------------------------------- suggestions

/**
 * A conservative, reversible replacement name. Never returns an empty string,
 * never returns a name that still trips analyzeName() for the same options.
 * Does NOT de-collide against siblings — call uniqueName() for that.
 */
export function suggestName(name: string, opts: NameOptions = {}): string {
  const windows = opts.windows !== false
  let s = ''
  for (const ch of name) {
    const c = ch.codePointAt(0) ?? 0
    if (ch === '\t' || ch === '\n' || ch === '\r') { s += ' '; continue }
    if (isControl(c)) { s += '_'; continue }
    if (ch === '�') { s += '_'; continue }
    if (windows && Object.prototype.hasOwnProperty.call(CHAR_FIXES, ch)) { s += CHAR_FIXES[ch]; continue }
    s += ch
  }

  if (windows) {
    // trailing dots AND spaces in any order ("note. . ." -> "note"); a
    // dots-only name is left with nothing, which the fallback below covers
    s = s.replace(/[. ]+$/, '').replace(/^ +/, '')
  }
  if (!s) s = FALLBACK_NAME

  if (windows && isReservedDeviceName(s)) {
    // the underscore belongs on the device part itself: lpt1.a.b -> lpt1_.a.b
    const i = s.indexOf('.')
    s = i === -1 ? s + '_' : s.slice(0, i) + '_' + s.slice(i)
  }

  let out = truncateName(s, opts)
  if (windows && out !== s) {
    // truncation can expose a fresh trailing dot/space ("v1. final" -> "v1.")
    const { stem, ext } = splitExt(out, opts.isDir)
    const trimmed = stem.replace(/[. ]+$/, '')
    if (trimmed !== stem) out = (trimmed || '_') + ext
  }
  return out
}

/**
 * Shorten a name so it fits both the byte limit and (when fullPath is given)
 * MAX_PATH, keeping the extension. Returns the name unchanged when it fits.
 */
export function truncateName(name: string, opts: NameOptions = {}): string {
  const maxNameBytes = opts.maxNameBytes ?? MAX_NAME_BYTES
  const maxPath = opts.maxPath ?? MAX_PATH
  // chars available for the name itself: MAX_PATH counts the NUL, so a path of
  // exactly maxPath characters is already too long.
  let charBudget = Infinity
  if (opts.windows !== false && maxPath > 0 && opts.fullPath) {
    const dirLen = Math.max(0, opts.fullPath.length - lastSegment(opts.fullPath).length)
    charBudget = maxPath - 1 - dirLen
  }
  const fits = (s: string): boolean =>
    (maxNameBytes <= 0 || byteLength(s) <= maxNameBytes) && s.length <= charBudget
  if (fits(name)) return name

  const { stem, ext } = splitExt(name, opts.isDir)
  const chars = [...stem]
  while (chars.length > 1 && !fits(chars.join('') + ext)) chars.pop()
  const out = chars.join('') + ext
  if (fits(out)) return out
  // pathological: even one character plus the extension does not fit — drop it
  const bare = [...name]
  while (bare.length > 1 && !fits(bare.join(''))) bare.pop()
  return bare.join('')
}

function lastSegment(p: string): string {
  const i = p.lastIndexOf('/')
  return i === -1 ? p : p.slice(i + 1)
}

/**
 * Explorer's " (2)" de-collision. `taken` is compared case-INSENSITIVELY —
 * the whole point is that the destination behaves like Windows/CIFS.
 */
export function uniqueName(name: string, taken: Iterable<string>, isDir = false): string {
  const used = new Set<string>()
  for (const t of taken) used.add(t.toLowerCase())
  if (!used.has(name.toLowerCase())) return name
  const { stem, ext } = splitExt(name, isDir)
  for (let i = 2; ; i++) {
    const cand = `${stem} (${i})${ext}`
    if (!used.has(cand.toLowerCase())) return cand
  }
}

/**
 * Groups of names in one folder that differ only by case (each group has >= 2).
 * Each group is sorted by code unit so the result never depends on readdir
 * order: the FIRST entry is the one treated as keeping its name.
 */
export function caseCollisionGroups(names: Iterable<string>): string[][] {
  const byLower = new Map<string, string[]>()
  for (const n of names) {
    const k = n.toLowerCase()
    const g = byLower.get(k)
    if (g) g.push(n)
    else byLower.set(k, [n])
  }
  return [...byLower.values()]
    .filter(g => g.length > 1)
    .map(g => g.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)))
}
