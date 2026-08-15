// Freedesktop icon-theme lookup (icon-theme spec) without GTK.
//
// The theme name is whatever THIS desktop records it as — gsettings for
// Cinnamon/GNOME/MATE, kdeglobals for Plasma, GTK settings.ini for the bare
// window managers common on Arch — and the first candidate that proves it can
// resolve mimetype icons wins (see candidateThemes/buildChain). We parse
// index.theme of the theme plus its
// Inherits chain (implicit hicolor last) and resolve icon names to files:
// per theme: exact size match -> scalable -> closest size; extensions svg/png;
// absolute paths pass through; /usr/share/pixmaps is the final fallback.
// Results are cached per name+size; the cache clears itself when the icon
// theme gsettings key changes (long-lived `gsettings monitor` child).

import { app } from 'electron'
import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

interface ThemeDir {
  sub: string                                  // e.g. '48x48/mimetypes'
  size: number
  scale: number
  type: 'Fixed' | 'Scalable' | 'Threshold'
  minSize: number
  maxSize: number
  threshold: number
}

interface Theme {
  name: string
  /** absolute theme roots that exist, e.g. /usr/share/icons/Papirus */
  roots: string[]
  inherits: string[]
  dirs: ThemeDir[]
}

const EXTS = ['svg', 'png'] as const

function baseDirs(): string[] {
  const h = os.homedir()
  return [
    path.join(h, '.icons'),
    path.join(h, '.local/share/icons'),
    '/usr/local/share/icons',
    '/usr/share/icons',
  ]
}

// ---------- gsettings ----------

/** the gsettings schemas that carry an icon-theme key, most specific first */
const GS_SCHEMAS = [
  'org.cinnamon.desktop.interface',   // Cinnamon (Mint)
  'org.gnome.desktop.interface',      // GNOME, and most GTK desktops
  'org.mate.interface',               // MATE
]

function gsettingsGet(schema: string, key: string): string {
  try {
    return execFileSync('gsettings', ['get', schema, key], { encoding: 'utf8', timeout: 3000 })
  } catch { return '' }
}

/** value of `key=` in a section of an ini file; '' when absent */
function iniValue(file: string, section: string, key: string): string {
  let text: string
  try { text = fs.readFileSync(file, 'utf8') } catch { return '' }
  let inSection = section === ''
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (line.startsWith('[')) { inSection = line.slice(1, -1).trim() === section; continue }
    if (!inSection) continue
    const eq = line.indexOf('=')
    if (eq < 0) continue
    if (line.slice(0, eq).trim() === key) return line.slice(eq + 1).trim()
  }
  return ''
}

/**
 * Every place a desktop might record the icon theme, best first.
 *
 * This used to be one gsettings call against org.cinnamon.desktop.interface
 * with a hard-coded fallback to 'Papirus'. On anything that is not Cinnamon the
 * call throws (no such schema), and on a machine without Papirus installed the
 * fallback names a theme that is not there — so the chain came out empty but
 * for hicolor, which carries almost no mimetype icons. The symptom is a file
 * manager with no file icons at all, which is exactly what Arch showed.
 *
 * KDE does not use gsettings for this at all (kdeglobals), and bare window
 * managers — a large share of Arch installs — usually set it only in GTK's
 * settings.ini. Both are consulted here.
 */
function candidateThemes(): string[] {
  const out: string[] = []
  const push = (v: string): void => {
    const name = v.trim().replace(/^'+|'+$/g, '').replace(/^"+|"+$/g, '')
    if (name && !out.includes(name)) out.push(name)
  }
  const h = os.homedir()
  const fromGsettings = (): void => { for (const s of GS_SCHEMAS) push(gsettingsGet(s, 'icon-theme')) }
  const fromKde = (): void => {
    push(iniValue(path.join(h, '.config/kdeglobals'), 'Icons', 'Theme'))
    push(iniValue('/etc/xdg/kdeglobals', 'Icons', 'Theme'))
  }
  const fromGtk = (): void => {
    for (const f of [
      path.join(h, '.config/gtk-4.0/settings.ini'),
      path.join(h, '.config/gtk-3.0/settings.ini'),
      '/etc/gtk-3.0/settings.ini',
      '/usr/share/gtk-3.0/settings.ini',
    ]) push(iniValue(f, 'Settings', 'gtk-icon-theme-name'))
    // gtkrc-2.0 is not sectioned: gtk-icon-theme-name="Adwaita"
    push(iniValue(path.join(h, '.gtkrc-2.0'), '', 'gtk-icon-theme-name'))
  }

  const desktop = (process.env.XDG_CURRENT_DESKTOP || process.env.DESKTOP_SESSION || '').toLowerCase()
  if (/kde|plasma|lxqt/.test(desktop)) { fromKde(); fromGtk(); fromGsettings() }
  else { fromGsettings(); fromGtk(); fromKde() }

  // Last resort: name themes that are WIDELY INSTALLED rather than one guess.
  // Adwaita ships with GTK and breeze with Plasma, so on a desktop system one
  // of these is nearly always present even when nothing is configured.
  for (const n of ['Papirus', 'Adwaita', 'breeze', 'Numix', 'elementary', 'gnome', 'oxygen', 'hicolor']) push(n)
  return out
}

// ---------- index.theme parsing ----------

function parseIndexTheme(name: string): Theme | null {
  const roots: string[] = []
  let ini: string | null = null
  for (const base of baseDirs()) {
    const root = path.join(base, name)
    const idx = path.join(root, 'index.theme')
    let hasRoot = false
    try { hasRoot = fs.statSync(root).isDirectory() } catch { /* absent */ }
    if (!hasRoot) continue
    roots.push(root)
    if (ini === null) {
      try { ini = fs.readFileSync(idx, 'utf8') } catch { /* theme dir without index */ }
    }
  }
  if (!roots.length) return null

  const theme: Theme = { name, roots, inherits: [], dirs: [] }
  if (ini === null) return theme          // dir exists but no index.theme: usable for hicolor-style fallback? treat as empty
  let section = ''
  let dirNames: string[] = []
  const sections = new Map<string, Map<string, string>>()
  for (const rawLine of ini.split('\n')) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#') || line.startsWith(';')) continue
    if (line.startsWith('[') && line.endsWith(']')) {
      section = line.slice(1, -1)
      if (!sections.has(section)) sections.set(section, new Map())
      continue
    }
    const eq = line.indexOf('=')
    if (eq < 0 || !section) continue
    sections.get(section)!.set(line.slice(0, eq).trim(), line.slice(eq + 1).trim())
  }
  const main = sections.get('Icon Theme')
  if (main) {
    theme.inherits = (main.get('Inherits') ?? '').split(',').map(s => s.trim()).filter(Boolean)
    dirNames = (main.get('Directories') ?? '').split(',').map(s => s.trim()).filter(Boolean)
  }
  for (const dn of dirNames) {
    const sec = sections.get(dn)
    if (!sec) continue
    const size = parseInt(sec.get('Size') ?? '', 10)
    if (!Number.isFinite(size)) continue
    const typeRaw = sec.get('Type') ?? 'Threshold'
    const type: ThemeDir['type'] =
      typeRaw === 'Fixed' ? 'Fixed' : typeRaw === 'Scalable' ? 'Scalable' : 'Threshold'
    const threshold = parseInt(sec.get('Threshold') ?? '2', 10) || 2
    theme.dirs.push({
      sub: dn,
      size,
      scale: parseInt(sec.get('Scale') ?? '1', 10) || 1,
      type,
      minSize: parseInt(sec.get('MinSize') ?? String(size), 10) || size,
      maxSize: parseInt(sec.get('MaxSize') ?? String(size), 10) || size,
      threshold,
    })
  }
  return theme
}

// ---------- theme chain ----------

let chain: Theme[] | null = null
let monitor: ChildProcess | null = null

function chainFor(name: string): Theme[] {
  const out: Theme[] = []
  const seen = new Set<string>()
  const queue = [name]
  while (queue.length) {
    const n = queue.shift()!
    if (seen.has(n)) continue
    seen.add(n)
    const t = parseIndexTheme(n)
    if (t) {
      out.push(t)
      queue.push(...t.inherits)
    }
  }
  if (!seen.has('hicolor')) {
    const hi = parseIndexTheme('hicolor')
    if (hi) out.push(hi)
  }
  return out
}

/**
 * Can this chain actually draw a file listing?
 *
 * A theme directory can exist, parse, and still be useless here — hicolor is
 * the standard example, since packages drop application icons into it but it
 * carries no mimetype set. Resolving a configured-but-missing theme to "well,
 * hicolor is there" is what produced a window full of blank rows, so the chain
 * has to prove it can find the icons a file manager is made of before it is
 * accepted.
 */
function usableChain(themes: Theme[]): boolean {
  if (!themes.length) return false
  for (const probe of ['inode-directory', 'folder', 'text-x-generic', 'text-plain']) {
    for (const t of themes) if (lookupInTheme(t, probe, 48)) return true
  }
  return false
}

/** which theme the chain came from, and whether it was the one configured */
let chosenTheme = ''
let configuredTheme = ''

function buildChain(): Theme[] {
  const candidates = candidateThemes()
  configuredTheme = candidates[0] ?? ''
  for (const name of candidates) {
    const c = chainFor(name)
    if (usableChain(c)) { chosenTheme = name; return c }
  }
  // Nothing on this machine has mimetype icons. Report it rather than pretend:
  // iconReport() turns this into a named missing dependency in the UI.
  chosenTheme = ''
  return chainFor('hicolor')
}

export interface IconReport {
  /** the theme actually in use, '' when none could be found */
  theme: string
  /** what the desktop asked for, which may not be installed */
  configured: string
  /** theme names present under any icon base directory */
  installed: string[]
  ok: boolean
}

export function iconReport(): IconReport {
  ensureInit()
  const installed = new Set<string>()
  for (const base of baseDirs()) {
    let names: string[] = []
    try { names = fs.readdirSync(base) } catch { continue }
    for (const n of names) {
      try { if (fs.statSync(path.join(base, n, 'index.theme')).isFile()) installed.add(n) } catch { /* not a theme */ }
    }
  }
  return {
    theme: chosenTheme,
    configured: configuredTheme,
    installed: [...installed].sort(),
    ok: !!chosenTheme,
  }
}

function ensureInit(): Theme[] {
  if (chain) return chain
  chain = buildChain()
  startMonitor()
  return chain
}

function startMonitor(): void {
  if (monitor) return
  // Watch the schema this desktop actually has. Monitoring the Cinnamon one
  // unconditionally (what this did) exits immediately anywhere else, so a theme
  // change went unnoticed until the app was restarted.
  const schema = GS_SCHEMAS.find(s => gsettingsGet(s, 'icon-theme').trim())
  if (!schema) return
  try {
    monitor = spawn('gsettings',
      ['monitor', schema, 'icon-theme'],
      { stdio: ['ignore', 'pipe', 'ignore'] })
    monitor.stdout!.on('data', () => { chain = null; clearCache() })
    monitor.on('error', () => { monitor = null })
    monitor.on('exit', () => { monitor = null })
    monitor.unref()
    app.on('will-quit', () => { try { monitor?.kill() } catch { /* gone */ } monitor = null })
  } catch { monitor = null }
}

// ---------- size matching (icon-theme spec) ----------

function dirMatchesSize(d: ThemeDir, size: number): boolean {
  if (d.scale !== 1) return false
  switch (d.type) {
    case 'Fixed': return d.size === size
    case 'Scalable': return d.minSize <= size && size <= d.maxSize
    case 'Threshold': return Math.abs(d.size - size) <= d.threshold
  }
}

function dirSizeDistance(d: ThemeDir, size: number): number {
  const eff = size
  switch (d.type) {
    case 'Fixed': return Math.abs(d.size * d.scale - eff)
    case 'Scalable':
      if (eff < d.minSize * d.scale) return d.minSize * d.scale - eff
      if (eff > d.maxSize * d.scale) return eff - d.maxSize * d.scale
      return 0
    case 'Threshold':
      if (eff < (d.size - d.threshold) * d.scale) return d.minSize * d.scale - eff
      if (eff > (d.size + d.threshold) * d.scale) return eff - d.maxSize * d.scale
      return 0
  }
}

// ---------- lookup ----------

const cache = new Map<string, string | null>()

function fileInDir(theme: Theme, sub: string, name: string): string | null {
  for (const root of theme.roots) {
    for (const ext of EXTS) {
      const p = path.join(root, sub, `${name}.${ext}`)
      try { if (fs.statSync(p).isFile()) return p } catch { /* miss */ }
    }
  }
  return null
}

function lookupInTheme(theme: Theme, name: string, size: number): string | null {
  // 1. exact-size (Fixed/Threshold) dirs
  for (const d of theme.dirs) {
    if (d.type !== 'Scalable' && dirMatchesSize(d, size)) {
      const f = fileInDir(theme, d.sub, name)
      if (f) return f
    }
  }
  // 2. scalable dirs covering this size
  for (const d of theme.dirs) {
    if (d.type === 'Scalable' && dirMatchesSize(d, size)) {
      const f = fileInDir(theme, d.sub, name)
      if (f) return f
    }
  }
  // 3. closest size across all dirs
  let best: string | null = null
  let bestDist = Infinity
  for (const d of theme.dirs) {
    const dist = dirSizeDistance(d, size)
    if (dist >= bestDist) continue
    const f = fileInDir(theme, d.sub, name)
    if (f) { best = f; bestDist = dist }
  }
  return best
}

function lookupPixmaps(name: string): string | null {
  for (const ext of EXTS) {
    const p = `/usr/share/pixmaps/${name}.${ext}`
    try { if (fs.statSync(p).isFile()) return p } catch { /* miss */ }
  }
  return null
}

/**
 * Resolve the first icon name that maps to a file. Names may be absolute
 * paths (returned as-is when they exist). Returns null when nothing resolves.
 */
export function resolveIcon(names: string[], size: number): string | null {
  const themes = ensureInit()
  for (const name of names) {
    if (!name) continue
    if (name.startsWith('/')) {
      try { if (fs.statSync(name).isFile()) return name } catch { /* miss */ }
      continue
    }
    const key = `${name}@${size}`
    const hit = cache.get(key)
    if (hit !== undefined) {
      if (hit !== null) return hit
      continue
    }
    let found: string | null = null
    for (const t of themes) {
      found = lookupInTheme(t, name, size)
      if (found) break
    }
    if (!found) found = lookupPixmaps(name)
    cache.set(key, found)
    if (found) return found
  }
  return null
}

/** Drop all cached lookups and re-read the theme chain (icon theme changed). */
export function clearCache(): void {
  cache.clear()
  chain = null
}
