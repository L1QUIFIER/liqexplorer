// Nemo actions: the file manager extensions this desktop already has.
//
// Cinnamon ships 15 of them on this machine and the user has added one of their
// own ("New folder with selection"), so honouring the format means the app
// inherits work that has already been done rather than asking for it again.
//
// The format is desktop-entry-shaped: an INI with a [Nemo Action] group, a
// localised Name, an Exec with %-tokens, and a set of rules deciding when the
// action applies at all. Getting those rules right is most of the job — an
// action offered for the wrong selection either fails or, worse, does something
// to the wrong files.
//
// NOTHING HERE GOES THROUGH A SHELL. Exec strings contain quoting that looks
// shell-like (`cinnamon-desktop-editor -mnemo-launcher -d"%P"`) and the values
// substituted into them are FILENAMES, which on this machine include quotes,
// spaces, semicolons and newlines. So Exec is tokenised once, the tokens are
// replaced inside the resulting argv entries, and the result is spawned
// directly. A filename can therefore never become a command.
import { ipcMain } from 'electron'
import { spawn } from 'node:child_process'
import * as fs from 'node:fs'
import * as fsp from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { CH } from '../../shared/ipc'
import type { ActionQuery, ExtensionInfo, NemoAction } from '../../shared/nemo'
import { STATE_DIR, TEST_PROFILE, TEST_ROOT } from '../state/settings'
import { packageManager } from './tools'

interface Parsed extends NemoAction {
  /** the action file's own directory, for resolving a relative Exec */
  dir: string
  dependencies: string[]
  conditions: string[]
  quote: string
  source: 'liq' | 'user' | 'system'
  /** `exec` conditions, unwrapped: a script whose exit status decides whether
   *  the action applies to this selection */
  execConditions: string[]
  /** dependencies not on PATH */
  missing: string[]
  /** '' when it can appear in a menu; otherwise why it cannot */
  blocked: '' | 'deps' | 'condition'
}

const SCAN_TTL_MS = 30_000
let cache: { at: number; actions: Parsed[] } | null = null

/** Installing or removing an extension must be visible immediately, not in up
 *  to SCAN_TTL_MS — the user is looking at the list when they do it. */
export function forgetActionCache(): void {
  cache = null
  condCache.clear()
}

/**
 * This app's own extension folder, scanned before the Nemo ones so a file here
 * overrides a system action of the same name.
 *
 * Deliberately the SAME FORMAT as a Nemo action rather than a new one. The
 * loader, the token substitution and the no-shell argv discipline below already
 * exist and are the hard parts; inventing a second format would mean writing
 * them again, and would cut the app off from every action anyone has already
 * written. Extensions here are simply actions that ship with, or are written
 * for, LiqExplorer.
 */
export function extensionsDir(): string {
  // a test run must not write extensions into the real profile, the same rule
  // STATE_DIR follows
  if (TEST_PROFILE) return path.join(TEST_ROOT, 'extensions')
  const dataHome = process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local/share')
  return path.join(dataHome, 'liqexplorer/extensions')
}

/**
 * The user's Nemo actions folder — the canonical home for this file format, and
 * where a store package that hardcodes its own install path has to go.
 *
 * Test-aware for the same reason extensionsDir() is, and more urgently: this
 * directory is SHARED with the desktop's own file manager, so anything a test
 * run leaves here outlives the test and turns up in Nemo's menus.
 */
export function nemoActionsDir(): string {
  if (TEST_PROFILE) return path.join(TEST_ROOT, 'nemo-actions')
  const dataHome = process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local/share')
  return path.join(dataHome, 'nemo/actions')
}

function actionDirs(): string[] {
  const dirs = [extensionsDir(), nemoActionsDir()]
  const sys = (process.env.XDG_DATA_DIRS || '/usr/local/share:/usr/share').split(':')
  for (const d of sys) if (d) dirs.push(path.join(d, 'nemo/actions'))
  return dirs
}

function sourceOf(dir: string): 'liq' | 'user' | 'system' {
  if (dir === extensionsDir()) return 'liq'
  return dir.startsWith(os.homedir()) ? 'user' : 'system'
}

// ---- enable/disable, persisted -------------------------------------------

/** ids the user has switched off in the Extensions manager */
let disabledSet: Set<string> | null = null

function disabledFile(): string { return path.join(STATE_DIR, 'extensions.json') }

function disabled(): Set<string> {
  if (disabledSet) return disabledSet
  try {
    const raw = JSON.parse(fs.readFileSync(disabledFile(), 'utf8')) as { disabled?: unknown }
    const list = Array.isArray(raw.disabled) ? raw.disabled.filter(x => typeof x === 'string') : []
    disabledSet = new Set(list as string[])
  } catch { disabledSet = new Set() }
  return disabledSet
}

async function setDisabled(id: string, off: boolean): Promise<void> {
  const set = disabled()
  if (off) set.add(id)
  else set.delete(id)
  await fsp.mkdir(STATE_DIR, { recursive: true }).catch(() => {})
  await fsp.writeFile(disabledFile(), JSON.stringify({ disabled: [...set] }, null, 1))
}

/** the locale suffixes to prefer, best first: en_GB, then en */
function localeKeys(): string[] {
  const raw = process.env.LC_MESSAGES || process.env.LC_ALL || process.env.LANG || ''
  const base = raw.split('.')[0].split('@')[0]
  if (!base || base === 'C' || base === 'POSIX') return []
  const short = base.split('_')[0]
  return short && short !== base ? [base, short] : [base]
}

/**
 * Parse the [Nemo Action] group. Deliberately not a general INI reader: these
 * files carry a hundred-odd localised Name[xx] lines each, and building a map
 * of every one of them for fifteen files on every menu open is waste.
 */
function parseAction(file: string, text: string): Parsed | null {
  const want = localeKeys()
  let inGroup = false
  const get: Record<string, string> = {}
  const localised: Record<string, Record<string, string>> = {}

  for (const line of text.split('\n')) {
    const s = line.trim()
    if (!s || s.startsWith('#')) continue
    if (s.startsWith('[')) { inGroup = s === '[Nemo Action]'; continue }
    if (!inGroup) continue
    const eq = s.indexOf('=')
    if (eq < 0) continue
    const rawKey = s.slice(0, eq).trim()
    const value = s.slice(eq + 1).trim()
    const m = /^([A-Za-z-]+)\[([^\]]+)\]$/.exec(rawKey)
    if (m) {
      if (!want.includes(m[2])) continue
      ;(localised[m[1]] ??= {})[m[2]] = value
      continue
    }
    get[rawKey] = value
  }

  const pick = (key: string): string => {
    for (const loc of want) {
      const v = localised[key]?.[loc]
      if (v) return v
    }
    return get[key] ?? ''
  }

  // Nemo allows the whole Exec to be wrapped in angle brackets — the user's own
  // action here reads `<new_folder_with_selection.sh %P %F>` — and strips them
  // before running. Without this the binary would be one literally named
  // "<new_folder_with_selection.sh", which spawns nothing.
  let exec = (get.Exec ?? '').trim()
  if (exec.startsWith('<') && exec.endsWith('>')) exec = exec.slice(1, -1).trim()
  // an action with no Exec cannot do anything; an action with no Name cannot be
  // shown. Either way there is nothing to offer.
  const name = pick('Name')
  if (!exec || !name) return null

  const list = (v: string): string[] =>
    v.split(';').map(x => x.trim()).filter(Boolean)

  return {
    id: file,
    dir: path.dirname(file),
    // Nemo marks the keyboard mnemonic with an underscore, as GTK does; there
    // is no mnemonic in this app's menus, so it would show as a stray character
    name: name.replace(/_(.)/g, '$1'),
    comment: pick('Comment'),
    icon: get['Icon-Name'] ?? '',
    exec,
    selection: (get.Selection ?? 'Any').trim(),
    extensions: list(get.Extensions ?? ''),
    mimetypes: list(get.Mimetypes ?? ''),
    dependencies: list(get.Dependencies ?? ''),
    conditions: list(get.Conditions ?? ''),
    separator: get.Separator ?? '',
    quote: (get.Quote ?? '').trim(),
    // filled in by scan(), which knows the directory and the PATH
    source: 'system',
    execConditions: [],
    missing: [],
    blocked: '',
  }
}

function onPath(bin: string): boolean {
  if (bin.includes('/')) return fs.existsSync(bin)
  for (const dir of (process.env.PATH || '').split(':')) {
    if (dir && fs.existsSync(path.join(dir, bin))) return true
  }
  return false
}

async function scan(): Promise<Parsed[]> {
  if (cache && Date.now() - cache.at < SCAN_TTL_MS) return cache.actions
  const out: Parsed[] = []
  const seen = new Set<string>()
  for (const dir of actionDirs()) {
    let names: string[]
    try { names = await fsp.readdir(dir) } catch { continue }
    for (const n of names.sort()) {
      if (!n.endsWith('.nemo_action')) continue
      // earlier directories win, the way XDG lookup does: a user's override of
      // a system action must not appear twice
      if (seen.has(n)) continue
      seen.add(n)
      const file = path.join(dir, n)
      try {
        const parsed = parseAction(file, await fsp.readFile(file, 'utf8'))
        if (!parsed) continue
        parsed.source = sourceOf(dir)
        // Dependencies name binaries the action needs; without them it would
        // appear in the menu and then fail.
        parsed.missing = parsed.dependencies.filter(d => !onPath(d))
        // ANY condition disqualifies the action, because none of them are
        // evaluated here. That is deliberate and it is not laziness: the
        // conditions in the wild include 'desktop' (this app is not the
        // desktop) and 'removable', and letting 'removable' through unchecked
        // put Cinnamon's "Format" — a DISK FORMATTING action — in the menu for
        // a text file. An action whose precondition we cannot verify is left
        // out; the file manager that owns the condition can still offer it.
        //
        // Blocked actions are KEPT here rather than dropped, and filtered at
        // the menu instead. Dropping them made "my extension does not show up"
        // unanswerable — the manager can now say which binary is missing.
        // An `exec` condition is the one kind this app CAN honour: it names a
        // script, and the script's exit status is the answer. That is how the
        // actions on Cinnamon Spices decide whether they apply, so blocking it
        // wholesale made a large part of the extension store install cleanly and
        // then never appear. The others stay blocked for the original reason —
        // 'desktop' and 'removable' cannot be evaluated here, and letting
        // 'removable' through once put a DISK FORMATTING action in the menu for
        // a text file.
        const unrunnable = parsed.conditions.filter(c => !/^exec\b/i.test(c.trim()))
        parsed.blocked = parsed.missing.length ? 'deps' : unrunnable.length ? 'condition' : ''
        parsed.execConditions = parsed.conditions
          .filter(c => /^exec\b/i.test(c.trim()))
          .map(c => c.trim().slice(4).trim())
          .map(c => (c.startsWith('<') && c.endsWith('>') ? c.slice(1, -1).trim() : c))
          .filter(Boolean)
        out.push(parsed)
      } catch { /* unreadable or malformed: skip this one, keep the rest */ }
    }
  }
  cache = { at: Date.now(), actions: out }
  return out
}

function selectionOK(a: Parsed, q: ActionQuery): boolean {
  const n = q.paths.length
  switch (a.selection.toLowerCase()) {
    case 'none': return n === 0
    case 'any': return true
    case 'notnone': return n > 0
    case 'multiple': return n > 1
    case 's': case 'single': return n === 1
    default: {
      const want = Number(a.selection)
      return Number.isFinite(want) ? n === want : n > 0
    }
  }
}

function extensionsOK(a: Parsed, q: ActionQuery): boolean {
  if (!a.extensions.length) return true
  const lower = a.extensions.map(e => e.toLowerCase())
  if (lower.includes('any')) return true
  if (lower.includes('dir')) return q.paths.length > 0 && q.dirs.every(Boolean)
  if (lower.includes('nodirs')) return q.paths.length > 0 && q.dirs.every(d => !d)
  if (lower.includes('none')) return q.paths.every(p => !path.extname(p))
  return q.paths.length > 0 && q.paths.every(p => {
    const ext = path.extname(p).replace(/^\./, '').toLowerCase()
    return lower.includes(ext)
  })
}

function mimesOK(a: Parsed, q: ActionQuery): boolean {
  if (!a.mimetypes.length) return true
  return q.mimes.length > 0 && q.mimes.every(m => a.mimetypes.some(want =>
    want === m || (want.endsWith('/*') && m.startsWith(want.slice(0, -1)))))
}

/**
 * Substitute the %-tokens that appear in a Name or Comment.
 *
 * Nemo does this too — one of the actions on this machine is literally called
 * "Test Custom Action applied to %N" — and without it the raw token shows in
 * the menu. Display only: the argv builder does its own substitution, and these
 * values are never executed.
 */
function labelTokens(text: string, q: ActionQuery): string {
  if (!text.includes('%')) return text
  const names = q.paths.map(p => path.basename(p))
  const first = names[0] ?? ''
  // three or more names would make an unreadable menu entry
  const many = names.length > 3 ? `${names.length} items` : names.join(', ')
  return text
    .replace(/%%/g, '\uE000')
    .replace(/%[NnFfUu]/g, (m) => (m === '%n' || m === '%f' || m === '%u' ? first : many))
    .replace(/%P/g, q.paths.length ? path.dirname(q.paths[0]) : '')
    .split('\uE000').join('%')
}

/** The actions that apply to this selection, in menu order. */
/**
 * Cache of `exec` condition results, keyed by action + selection.
 *
 * A right-click must not wait on a shell script, let alone several. The cheap
 * filters run first so only the handful of actions that could actually apply
 * are ever tested, the tests run concurrently with a hard deadline, and the
 * answer is remembered for a few seconds — long enough that reopening the same
 * menu is instant, short enough that a script whose answer depends on the file
 * is not wrong for long.
 */
const condCache = new Map<string, { at: number; ok: boolean }>()
const COND_TTL_MS = 4000

/** Run one `exec` condition. Exit 0 means the action applies. */
function runCondition(a: Parsed, cmd: string, q: ActionQuery): Promise<boolean> {
  const key = `${a.id} ${cmd} ${q.paths.join('')}`
  const hit = condCache.get(key)
  if (hit && Date.now() - hit.at < COND_TTL_MS) return Promise.resolve(hit.ok)

  const argv = buildArgv(cmd, q.paths, q.paths.length ? path.dirname(q.paths[0]) : os.homedir())
  if (!argv.length) return Promise.resolve(false)
  const bin = argv[0].startsWith('/') ? argv[0] : path.join(a.dir, argv[0])

  return new Promise<boolean>(resolve => {
    let done = false
    const finish = (ok: boolean): void => {
      if (done) return
      done = true
      condCache.set(key, { at: Date.now(), ok })
      resolve(ok)
    }
    try {
      const c = spawn(bin, argv.slice(1), { cwd: a.dir, stdio: 'ignore' })
      const t = setTimeout(() => { try { c.kill('SIGKILL') } catch { /* gone */ } finish(false) }, COND_TIMEOUT_MS)
      c.on('error', () => { clearTimeout(t); finish(false) })
      c.on('close', code => { clearTimeout(t); finish(code === 0) })
    } catch { finish(false) }
  })
}

/** a condition that has not answered by now is treated as "does not apply" */
const COND_TIMEOUT_MS = 1500

export async function nemoActions(q: ActionQuery): Promise<NemoAction[]> {
  const all = await scan()
  const cheap = all
    // blocked and switched-off actions are loaded but never offered
    .filter(a => !a.blocked && !disabled().has(a.id))
    .filter(a => selectionOK(a, q) && extensionsOK(a, q) && mimesOK(a, q))

  // only now, on the few that survived, pay for the scripts
  const verdicts = await Promise.all(cheap.map(async a => {
    if (!a.execConditions.length) return true
    const results = await Promise.all(a.execConditions.map(c => runCondition(a, c, q)))
    return results.every(Boolean)
  }))
  return cheap
    .filter((_, i) => verdicts[i])
    .map(({ id, name, comment, icon, exec, selection, extensions, mimetypes, separator }) =>
      ({
        id,
        name: labelTokens(name, q),
        comment: labelTokens(comment, q),
        icon, exec, selection, extensions, mimetypes, separator,
      }))
}

/**
 * Split an Exec line into argv the way a shell would for quoting purposes, but
 * WITHOUT any shell evaluation: no expansion, no substitution, no operators.
 * Tokens keep their surrounding text (`-d"%P"` stays one argument).
 */
export function tokenizeExec(exec: string): string[] {
  const out: string[] = []
  let cur = ''
  let quote: '"' | "'" | null = null
  let has = false
  for (let i = 0; i < exec.length; i++) {
    const c = exec[i]
    if (quote) {
      if (c === quote) quote = null
      else cur += c
      continue
    }
    if (c === '"' || c === "'") { quote = c; has = true; continue }
    if (c === ' ' || c === '\t') {
      if (cur || has) { out.push(cur); cur = ''; has = false }
      continue
    }
    cur += c
  }
  if (cur || has) out.push(cur)
  return out
}

const FILE_URI = (p: string): string =>
  'file://' + p.split('/').map(encodeURIComponent).join('/')

/**
 * Substitute the %-tokens. A token that stands for a LIST expands to several
 * argv entries; one that stands for a single value is replaced in place, so
 * `-d"%P"` becomes one argument and not two.
 */
export function buildArgv(exec: string, paths: string[], parent: string): string[] {
  const argv: string[] = []
  // A sentinel for an escaped %%, so the later single-token substitutions
  // cannot see it as the start of a real token. It is restored last. Using a
  // space here (the obvious choice) would be corrupted inside any quoted
  // argument that legitimately contains one, and paths on this machine do.
  const PCT = '\uE000'
  for (const tok of tokenizeExec(exec)) {
    // list tokens only expand when they are the WHOLE argument; embedded in a
    // longer string there is no sensible way to repeat the surrounding text
    if (tok === '%F' || tok === '%U') {
      for (const p of paths) argv.push(tok === '%U' ? FILE_URI(p) : p)
      continue
    }
    if (tok === '%N') {
      for (const p of paths) argv.push(path.basename(p))
      continue
    }
    const one = paths[0] ?? ''
    argv.push(tok
      .replace(/%%/g, PCT)
      .replace(/%f/g, one)
      .replace(/%u/g, one ? FILE_URI(one) : '')
      .replace(/%n/g, one ? path.basename(one) : '')
      .replace(/%P/g, parent)
      .replace(/%F/g, paths.join(' '))
      .replace(/%U/g, paths.map(FILE_URI).join(' '))
      .replace(/%N/g, paths.map(p => path.basename(p)).join(' '))
      .split(PCT).join('%'))
  }
  return argv
}

export async function runNemoAction(id: string, paths: string[], parent: string): Promise<boolean> {
  const all = await scan()
  const action = all.find(a => a.id === id)
  if (!action) return false
  const argv = buildArgv(action.exec, paths, parent)
  const [rawBin, ...args] = argv
  if (!rawBin) return false
  // A bare or relative command names a script shipped ALONGSIDE the action
  // file, which is how the user's own action refers to its shell script.
  // Resolving it against the action's directory first, then falling back to
  // PATH, matches what Nemo does — and keeps the current working directory out
  // of it, which is what makes a relative name safe.
  const beside = path.resolve(action.dir, rawBin)
  const bin = !rawBin.startsWith('/') && fs.existsSync(beside) ? beside : rawBin
  try {
    // detached: the action outlives this app, exactly as it would from Nemo
    const child = spawn(bin, args, {
      cwd: parent || os.homedir(),
      detached: true,
      stdio: 'ignore',
    })
    child.on('error', () => { /* the binary vanished between check and spawn */ })
    child.unref()
    return true
  } catch { return false }
}

// ---- the Extensions manager ----------------------------------------------

/** "PDF files, one at a time" — the rules in words, for the manager's list */
function appliesText(a: Parsed): string {
  const bits: string[] = []
  const ext = a.extensions.map(e => e.toLowerCase())
  if (ext.includes('dir')) bits.push('folders')
  else if (ext.includes('nodirs')) bits.push('files')
  else if (ext.length && !ext.includes('any')) bits.push(ext.map(e => '.' + e).join(', ') + ' files')
  else if (a.mimetypes.length) bits.push(a.mimetypes.join(', '))
  else bits.push('anything')
  const sel = a.selection.toLowerCase()
  if (sel === 'none') bits.push('right-click on empty space')
  else if (sel === 'multiple') bits.push('two or more selected')
  else if (sel === 's' || sel === 'single' || sel === '1') bits.push('one at a time')
  return bits.join(' · ')
}

/**
 * A SEARCH command, not an install one.
 *
 * The app's own dependencies have known package names (platform/tools.ts maps
 * them per distribution), but an extension names a BINARY, and the package
 * providing it is not derivable from it — `subl` comes from sublime-text,
 * `code` from a repository that is not in the archive at all. Emitting
 * "sudo apt install subl" would be a confident instruction that fails, which is
 * worse than no instruction. This finds the package instead.
 */
const FIND_CMD = { apt: 'apt search', pacman: 'pacman -Ss', dnf: 'dnf provides' }

export async function extensionList(): Promise<ExtensionInfo[]> {
  cache = null                                  // the manager must never show a stale list
  const all = await scan()
  const pm = packageManager()
  const off = disabled()
  return all.map(a => ({
    id: a.id,
    name: a.name,
    comment: a.comment,
    icon: a.icon,
    exec: a.exec,
    source: a.source,
    enabled: !off.has(a.id),
    blocked: a.blocked,
    missing: a.missing,
    install: a.missing.length && pm !== 'unknown' ? `${FIND_CMD[pm]} ${a.missing[0]}` : '',
    applies: appliesText(a),
  })).sort((x, y) =>
    // the user's own first: those are the ones they came here to manage
    (x.source === y.source ? 0 : x.source === 'liq' ? -1 : y.source === 'liq' ? 1 : x.source === 'user' ? -1 : 1)
    || x.name.localeCompare(y.name))
}

/** A starting point that runs, rather than an empty file to stare at. */
const TEMPLATE = `[Nemo Action]
# A LiqExplorer extension. Same format as a Nemo action, so anything written
# for Nemo works here and anything written here works in Nemo.
Name=My extension
Comment=What it does, shown as the tooltip
# %F = the selected files, %P = the folder, %f = the first file only.
# This is NOT run through a shell: no pipes, no redirects, no globbing.
Exec=<xdg-open %F>
# Any | None | NotNone | Multiple | S (exactly one)
Selection=NotNone
# any | dir | nodirs | a list like: txt;md;
Extensions=any
# Binaries this needs. If one is missing the extension is listed as blocked
# instead of quietly never appearing.
Dependencies=xdg-open
Icon-Name=application-x-executable
`

async function createExtension(): Promise<string> {
  const dir = extensionsDir()
  await fsp.mkdir(dir, { recursive: true })
  let file = path.join(dir, 'my-extension.nemo_action')
  for (let i = 2; fs.existsSync(file); i++) file = path.join(dir, `my-extension-${i}.nemo_action`)
  await fsp.writeFile(file, TEMPLATE)
  cache = null
  return file
}

ipcMain.handle(CH('extensionList'), () => extensionList())
ipcMain.handle(CH('extensionEnable'), async (_e, id: string, on: boolean) => {
  await setDisabled(id, !on)
  return true
})
ipcMain.handle(CH('extensionCreate'), () => createExtension())
ipcMain.handle(CH('extensionsDir'), async () => {
  const dir = extensionsDir()
  await fsp.mkdir(dir, { recursive: true }).catch(() => {})
  return dir
})

ipcMain.handle(CH('nemoActions'), (_e, q: ActionQuery) => nemoActions(q))
ipcMain.handle(CH('runNemoAction'), (_e, id: string, paths: string[], parent: string) =>
  runNemoAction(id, paths, parent))

export const __test = { parseAction, tokenizeExec, buildArgv, selectionOK, extensionsOK }
