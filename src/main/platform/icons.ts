// Freedesktop icon-theme lookup (icon-theme spec) without GTK.
//
// Theme comes from `gsettings get org.cinnamon.desktop.interface icon-theme`
// (Papirus on this machine). We parse index.theme of the theme plus its
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

function readThemeName(): string {
  try {
    const out = execFileSync('gsettings',
      ['get', 'org.cinnamon.desktop.interface', 'icon-theme'],
      { encoding: 'utf8', timeout: 3000 })
    const name = out.trim().replace(/^'+|'+$/g, '')
    if (name) return name
  } catch { /* fall through */ }
  return 'Papirus'
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

function buildChain(): Theme[] {
  const out: Theme[] = []
  const seen = new Set<string>()
  const queue = [readThemeName()]
  while (queue.length) {
    const name = queue.shift()!
    if (seen.has(name)) continue
    seen.add(name)
    const t = parseIndexTheme(name)
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

function ensureInit(): Theme[] {
  if (chain) return chain
  chain = buildChain()
  startMonitor()
  return chain
}

function startMonitor(): void {
  if (monitor) return
  try {
    monitor = spawn('gsettings',
      ['monitor', 'org.cinnamon.desktop.interface', 'icon-theme'],
      { stdio: ['ignore', 'pipe', 'ignore'] })
    monitor.stdout!.on('data', () => clearCache())
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
