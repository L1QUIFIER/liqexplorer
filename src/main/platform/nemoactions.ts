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
import type { ActionQuery, NemoAction } from '../../shared/nemo'

interface Parsed extends NemoAction {
  /** the action file's own directory, for resolving a relative Exec */
  dir: string
  dependencies: string[]
  conditions: string[]
  quote: string
}

const SCAN_TTL_MS = 30_000
let cache: { at: number; actions: Parsed[] } | null = null

function actionDirs(): string[] {
  const home = os.homedir()
  const dataHome = process.env.XDG_DATA_HOME || path.join(home, '.local/share')
  const dirs = [path.join(dataHome, 'nemo/actions')]
  const sys = (process.env.XDG_DATA_DIRS || '/usr/local/share:/usr/share').split(':')
  for (const d of sys) if (d) dirs.push(path.join(d, 'nemo/actions'))
  return dirs
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
        // Dependencies name binaries the action needs; without them it would
        // appear in the menu and then fail
        if (parsed.dependencies.some(d => !onPath(d))) continue
        // ANY condition disqualifies the action, because none of them are
        // evaluated here. That is deliberate and it is not laziness: the
        // conditions in the wild include 'desktop' (this app is not the
        // desktop) and 'removable', and letting 'removable' through unchecked
        // put Cinnamon's "Format" — a DISK FORMATTING action — in the menu for
        // a text file. An action whose precondition we cannot verify is left
        // out; the file manager that owns the condition can still offer it.
        if (parsed.conditions.length) continue
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
export async function nemoActions(q: ActionQuery): Promise<NemoAction[]> {
  const all = await scan()
  return all
    .filter(a => selectionOK(a, q) && extensionsOK(a, q) && mimesOK(a, q))
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

ipcMain.handle(CH('nemoActions'), (_e, q: ActionQuery) => nemoActions(q))
ipcMain.handle(CH('runNemoAction'), (_e, id: string, paths: string[], parent: string) =>
  runNemoAction(id, paths, parent))

export const __test = { parseAction, tokenizeExec, buildArgv, selectionOK, extensionsOK }
