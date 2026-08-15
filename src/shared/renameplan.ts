// Rename planning: rules + entries -> the exact old->new list, and every reason
// a row cannot run.
//
// PURE on purpose. The bulk-rename dialog and the docked Rename tab both call
// this, so "what will happen" is worked out in exactly one place and the two
// surfaces cannot drift apart. Nothing here touches the DOM, IPC or the app
// singleton — the caller supplies the context (what else is in the folder, what
// "now" is), which is also what makes it testable with plain node.
//
// The rename itself is deliberately NOT here: it goes through
// liq.invoke('fixNames', ...), which owns deepest-first ordering, the CIFS
// case-only two-step, raw-byte paths for names that are not valid UTF-8, and —
// the reason nothing reimplements it — records the whole batch as ONE undo
// entry, so Ctrl+Z reverts the job rather than the last file.
import { warnForName, splitExt } from './names'

// ---------------------------------------------------------------- rules

export type RenameMode = 'replace' | 'pattern'
/** which part of the file name find-and-replace is applied to */
export type RenameScope = 'name' | 'ext' | 'full'
export type CaseRule = 'leave' | 'lower' | 'upper' | 'title' | 'sentence'
export type SpaceRule = 'leave' | 'underscore' | 'dash'

export interface RenameRules {
  mode: RenameMode
  // --- find and replace
  find: string
  replace: string
  useRegex: boolean
  matchCase: boolean
  scope: RenameScope
  // --- pattern
  pattern: string
  /** first value for {n} */
  start: number
  /** {n} increments by this per row — 10 leaves gaps to insert into later */
  step: number
  /** zero-padded width of {n} */
  pad: number
  // --- tidying, applied to the result of either mode
  caseRule: CaseRule
  trim: boolean
  collapseSpaces: boolean
  spaces: SpaceRule
}

export const DEFAULT_RENAME_RULES: RenameRules = {
  mode: 'replace',
  find: '', replace: '', useRegex: false, matchCase: false, scope: 'name',
  pattern: '{name}', start: 1, step: 1, pad: 1,
  caseRule: 'leave', trim: false, collapseSpaces: false, spaces: 'leave',
}

/** the rules are at their defaults, i.e. this plan cannot change anything */
export function rulesAreEmpty(r: RenameRules): boolean {
  const d = DEFAULT_RENAME_RULES
  return (r.mode === 'replace' ? !r.find : r.pattern === d.pattern)
    && r.caseRule === 'leave' && !r.trim && !r.collapseSpaces && r.spaces === 'leave'
}

// ---------------------------------------------------------------- entries

/**
 * The entry fields planning actually reads. FileEntry satisfies this, but a
 * plain object literal does too, which is the point: this module can be
 * exercised without constructing a listing.
 */
export interface PlanEntry {
  name: string
  path: string
  isDir: boolean
  size: number
  mtime: number
  ctime: number
  /** the location is visible to Windows — drives which name rules apply */
  remote?: boolean
}

export interface RenameRow<E extends PlanEntry = PlanEntry> {
  entry: E
  /** the new NAME (never a path) — exactly what fixNames() wants as `to` */
  to: string
  /** why this row cannot run; the row is shown but never submitted */
  problem?: string
  changed: boolean
}

export interface PlanContext {
  /**
   * Names that already exist in each folder, keyed by directory path. Without
   * this a rule that lands on an UNSELECTED sibling previews as fine and then
   * fails at run time: main's fixNames() lstats every destination before it
   * renames anything and fails that row with "there is already a file with the
   * same name". Passing the folder's names moves that discovery into the live
   * preview, where it can still be fixed by editing the rule.
   */
  folderNames?: ReadonlyMap<string, readonly string[]>
  /** value for {date}; injected so a plan is reproducible */
  now?: Date
  /** override the seeded {rand:N} source (a test, or a deliberate reroll) */
  random?: () => number
}

/**
 * Group names by containing folder — the shape PlanContext.folderNames wants.
 * Callers feed it the listing they already have in memory (tab.rows), which
 * costs nothing; it is therefore only as complete as that listing, so a hidden
 * sibling is missed when Show hidden is off. That fails safe: fixNames() still
 * refuses to overwrite, the row just reports its clash a step later.
 */
export function folderNamesFrom(entries: Iterable<PlanEntry>): Map<string, string[]> {
  const out = new Map<string, string[]>()
  for (const e of entries) {
    const dir = dirOf(e.path)
    const list = out.get(dir)
    if (list) list.push(e.name)
    else out.set(dir, [e.name])
  }
  return out
}

export interface RenamePlan<E extends PlanEntry = PlanEntry> {
  rows: RenameRow<E>[]
  /**
   * The rules themselves are broken — currently only a regex that does not
   * compile. Every row is left as identity so nothing can run, and the UI shows
   * this instead of a preview. Swallowing it (the old behaviour) made a
   * half-typed pattern look like a rule that simply matched nothing.
   */
  error?: string
}

// ---------------------------------------------------------------- tokens

export const RENAME_TOKENS: { token: string; help: string }[] = [
  { token: '{name}', help: 'original name without extension' },
  { token: '{ext}', help: 'extension without the dot' },
  { token: '{n}', help: 'counter (Start / Step / Digits)' },
  { token: '{parent}', help: 'name of the containing folder' },
  { token: '{date}', help: "today's date" },
  { token: '{mtime:YYYY-MM-DD}', help: 'date modified' },
  { token: '{ctime:YYYY-MM-DD}', help: 'date changed' },
  { token: '{size}', help: 'size in bytes' },
  { token: '{rand:4}', help: '4 random characters' },
]

// TODO(exif): {camera} {lens} {iso} {taken:…} and friends belong here, sourced
// from the fileFacts IPC. Left out on purpose while that handler is still being
// built — a token that silently expands to nothing is worse than no token.

/** longest alternative first, or {name} would be read as {n} followed by "ame}" */
const TOKEN_RE = /\{(name|ext|parent|date|mtime|ctime|size|rand|n)(?::([^}]*))?\}/g

const DEFAULT_DATE_FMT = 'YYYY-MM-DD'

/**
 * Local time, not UTC: someone filing photos by date means the date that was on
 * the wall, and a UTC {mtime:YYYY-MM-DD} silently files an evening shot under
 * the next day.
 */
function formatStamp(ms: number, fmt: string): string {
  const d = new Date(ms)
  if (!Number.isFinite(ms) || Number.isNaN(d.getTime())) return ''
  const p2 = (n: number): string => String(n).padStart(2, '0')
  return fmt.replace(/YYYY|YY|MM|DD|HH|mm|ss/g, (t) => {
    switch (t) {
      case 'YYYY': return String(d.getFullYear())
      case 'YY': return p2(d.getFullYear() % 100)
      case 'MM': return p2(d.getMonth() + 1)
      case 'DD': return p2(d.getDate())
      case 'HH': return p2(d.getHours())
      case 'mm': return p2(d.getMinutes())
      case 'ss': return p2(d.getSeconds())
    }
    return t
  })
}

const RAND_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789'

function hash32(s: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) }
  return h >>> 0
}

/** xorshift32 — enough for a filename tag, and reproducible from its seed */
function seededRandom(seed: number): () => number {
  let x = seed || 1
  return () => {
    x ^= x << 13; x >>>= 0
    x ^= x >>> 17
    x ^= x << 5; x >>>= 0
    return x / 0x1_0000_0000
  }
}

/** number with the sign kept outside the padding: -7 at 3 digits is -007 */
function padNumber(n: number, digits: number): string {
  const width = Math.min(12, Math.max(1, Math.floor(digits) || 1))
  const s = Math.abs(Math.trunc(n)).toString().padStart(width, '0')
  return n < 0 ? '-' + s : s
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function dirOf(p: string): string {
  const i = p.lastIndexOf('/')
  return i <= 0 ? '/' : p.slice(0, i)
}

// ---------------------------------------------------------------- tidying

function toTitleCase(s: string): string {
  // word-initial letters only, so "o'brien" and "wi-fi" keep their shape
  return s.replace(/(^|[\s_\-([{])(\p{L})/gu, (_m, lead: string, ch: string) => lead + ch.toUpperCase())
}

function toSentenceCase(s: string): string {
  const lower = s.toLowerCase()
  return lower.replace(/\p{L}/u, c => c.toUpperCase())
}

function applyCase(stem: string, rule: CaseRule): string {
  switch (rule) {
    case 'lower': return stem.toLowerCase()
    case 'upper': return stem.toUpperCase()
    case 'title': return toTitleCase(stem.toLowerCase())
    case 'sentence': return toSentenceCase(stem)
    default: return stem
  }
}

/**
 * The tidying rules, applied to the stem produced by either mode.
 *
 * Order matters: case runs while words are still separated by spaces (title
 * case over "my_file" would only reach the first word), and the space
 * substitution runs last.
 */
function tidyStem(stem: string, r: RenameRules): string {
  let s = stem
  if (r.trim) s = s.trim()
  if (r.collapseSpaces) s = s.replace(/\s+/g, ' ')
  s = applyCase(s, r.caseRule)
  if (r.spaces === 'underscore') s = s.replace(/ /g, '_')
  else if (r.spaces === 'dash') s = s.replace(/ /g, '-')
  return s
}

/**
 * Extensions follow lower/UPPER but not Title/Sentence. "make these lowercase"
 * always means the extension too — a leftover .JPG reads as a bug — while
 * title-casing one produces ".Jpg", which nobody has ever wanted.
 */
function tidyExt(extText: string, r: RenameRules): string {
  if (r.caseRule === 'lower') return extText.toLowerCase()
  if (r.caseRule === 'upper') return extText.toUpperCase()
  return extText
}

// ---------------------------------------------------------------- planning

/**
 * Turn rules into the old->new list.
 *
 * Numbering follows the ORDER OF `entries`, so the caller decides what "first"
 * means. The docked tab passes the entries in tab.rows order — the pane's
 * current sort — which is what makes "sort by date taken, then number them"
 * work; the dialog passes them in the order the selection arrived.
 *
 * The returned rows are what the caller must submit. Do not re-plan at submit
 * time: {rand:N} is seeded per entry rather than per call precisely so the
 * preview holds still, but any future non-deterministic token would make a
 * re-plan disagree with the rows the user approved.
 */
export function planRenames<E extends PlanEntry>(
  entries: readonly E[], rules: RenameRules, ctx: PlanContext = {},
): RenamePlan<E> {
  const identity = (): RenameRow<E>[] =>
    entries.map(entry => ({ entry, to: entry.name, changed: false }))

  // Compiled once, not per row: a half-typed pattern is a broken RULE, not a
  // per-file problem, and reporting it once is the difference between "your
  // regex is wrong" and fifty rows that quietly did nothing.
  let finder: RegExp | null = null
  if (rules.mode === 'replace' && rules.find) {
    const flags = rules.matchCase ? 'g' : 'gi'
    try {
      finder = new RegExp(rules.useRegex ? rules.find : escapeRegex(rules.find), flags)
    } catch (e) {
      return { rows: identity(), error: `Invalid pattern: ${(e as Error).message}` }
    }
  }
  // $& / $1 are the point of regex mode, and a hazard in plain mode: a literal
  // "$&" typed into Replace must stay two characters.
  const replacement = rules.useRegex ? rules.replace : rules.replace.replace(/\$/g, '$$$$')

  const today = formatStamp((ctx.now ?? new Date()).getTime(), DEFAULT_DATE_FMT)

  /** dir -> lowercased existing name -> the name as it really is (for the message) */
  const folderIndex = new Map<string, Map<string, string>>()
  const siblingsIn = (dir: string): Map<string, string> | null => {
    if (!ctx.folderNames) return null
    let idx = folderIndex.get(dir)
    if (idx) return idx
    const names = ctx.folderNames.get(dir)
    if (!names) return null
    idx = new Map()
    for (const n of names) idx.set(n.toLowerCase(), n)
    folderIndex.set(dir, idx)
    return idx
  }

  /** lowercased new name -> index of the row that claimed it first */
  const claimed = new Map<string, number>()
  const rows: RenameRow<E>[] = []

  entries.forEach((entry, i) => {
    // splitExt rather than FileEntry.ext, which is lowercased: reassembling
    // "photo.JPG" from it silently renamed the file to "photo.jpg".
    const { stem, ext } = splitExt(entry.name, entry.isDir)
    const extText = ext.replace(/^\./, '')

    let stemOut: string
    let extOut = extText
    let whole: string | null = null

    if (rules.mode === 'replace') {
      if (!finder) {
        stemOut = stem
      } else if (rules.scope === 'name') {
        stemOut = stem.replace(finder, replacement)
      } else if (rules.scope === 'ext') {
        stemOut = stem
        extOut = extText.replace(finder, replacement)
      } else {
        whole = entry.name.replace(finder, replacement)
        stemOut = stem
      }
    } else {
      const n = padNumber(rules.start + i * rules.step, rules.pad)
      const parent = dirOf(entry.path).split('/').pop() ?? ''
      const rnd = ctx.random ?? seededRandom(hash32(entry.path))
      // ONE pass, so an expansion can never be rescanned: a file literally
      // named "{n}.txt" used to have its own name substituted by the next
      // .replace() in the chain.
      const applied = rules.pattern.replace(TOKEN_RE, (_m, token: string, arg?: string) => {
        switch (token) {
          case 'name': return stem
          case 'ext': return extText
          case 'n': return n
          case 'parent': return parent
          case 'date': return today
          case 'mtime': return formatStamp(entry.mtime, arg || DEFAULT_DATE_FMT)
          case 'ctime': return formatStamp(entry.ctime, arg || DEFAULT_DATE_FMT)
          case 'size': return String(Math.max(0, entry.size))
          case 'rand': {
            const len = Math.min(32, Math.max(1, Number(arg) || 4))
            let out = ''
            for (let k = 0; k < len; k++) out += RAND_ALPHABET[Math.floor(rnd() * RAND_ALPHABET.length)]
            return out
          }
        }
        return _m as string
      })
      // A pattern that places {ext} itself owns the whole name, and so does one
      // applied to a file that has no extension to put back.
      if (/\{ext\}/.test(rules.pattern) || !extText) whole = applied
      stemOut = applied
    }

    let name: string
    if (whole !== null) {
      const w = splitExt(whole, entry.isDir)
      name = tidyStem(w.stem, rules) + (w.ext ? '.' + tidyExt(w.ext.slice(1), rules) : '')
    } else {
      const s = tidyStem(stemOut, rules)
      const x = tidyExt(extOut, rules)
      // an extension replaced with nothing leaves a name with no dot at all
      name = x ? `${s}.${x}` : s
    }

    // Unconditional, on top of the optional trim rule: Windows strips a leading
    // or trailing space from a name silently, after which the file cannot be
    // opened by name at all. Never worth previewing as if it would survive.
    name = name.trim()

    let problem: string | undefined
    const lower = name.toLowerCase()
    if (!name) {
      problem = 'The new name is empty.'
    } else if (name.includes('/')) {
      problem = 'A name cannot contain "/".'
    } else {
      const dup = claimed.get(lower)
      if (dup !== undefined) {
        problem = `Same new name as "${entries[dup].name}".`
      } else {
        // A sibling clash counts even when the sibling is itself in the batch:
        // fixNames() pre-checks every destination BEFORE it renames anything,
        // so a->b while b->c still fails on b already existing.
        const sib = lower !== entry.name.toLowerCase() ? siblingsIn(dirOf(entry.path))?.get(lower) : undefined
        problem = sib
          ? `"${sib}" is already in this folder.`
          : warnForName(name, { windows: !!entry.remote, fullPath: entry.path, isDir: entry.isDir }) ?? undefined
      }
    }
    if (lower) claimed.set(lower, i)
    rows.push({ entry, to: name, problem, changed: name !== entry.name })
  })

  return { rows }
}

// ---------------------------------------------------------------- summary

export interface PlanSummary {
  total: number
  /** rows that will actually be submitted */
  runnable: number
  /** rows with a problem — the collision/illegal-name count */
  blocked: number
}

export function summarizePlan(rows: readonly RenameRow[]): PlanSummary {
  let runnable = 0
  let blocked = 0
  for (const r of rows) {
    if (r.problem) blocked++
    else if (r.changed) runnable++
  }
  return { total: rows.length, runnable, blocked }
}

/** the rows a run submits — never the whole list */
export function runnableRows<E extends PlanEntry>(rows: readonly RenameRow<E>[]): RenameRow<E>[] {
  return rows.filter(r => r.changed && !r.problem)
}
