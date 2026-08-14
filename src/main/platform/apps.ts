// Default apps / Open With / launching (freedesktop desktop-entry + mime-apps).
//
// Candidates come from mimeinfo.cache ([MIME Cache]) in both application dirs,
// filtered/ordered by mimeapps.list ([Default Applications] > [Added
// Associations] > cache order; [Removed Associations] excluded) with the
// user's ~/.config/mimeapps.list taking precedence over the system file.
// Launching goes through `gio launch <desktop-file> <file>` (verified present)
// so Exec field codes, Terminal=true and startup notification are GIO's
// problem, not ours.

import { execFile, spawn } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import type { AppCandidate, FileEntry } from '../../shared/types'

interface DesktopApp {
  id: string
  file: string
  name: string
  icon: string
  exec: string
  noDisplay: boolean
  hidden: boolean
  terminal: boolean
  mimes: string[]
}

interface Db {
  apps: Map<string, DesktopApp>
  cacheIds: Map<string, string[]>          // mime -> ids from mimeinfo.cache
  userDefaults: Map<string, string[]>
  userAdded: Map<string, string[]>
  userRemoved: Map<string, Set<string>>
  systemDefaults: Map<string, string[]>
  at: number
}

let db: Db | null = null

function appDirs(): string[] {
  // system first; user last so user entries override by id
  return ['/usr/share/applications', path.join(os.homedir(), '.local/share/applications')]
}

function parseDesktopFile(file: string, id: string): DesktopApp | null {
  let txt = ''
  try { txt = fs.readFileSync(file, 'utf8') } catch { return null }
  let inEntry = false
  const kv = new Map<string, string>()
  for (const raw of txt.split('\n')) {
    const line = raw.trim()
    if (line.startsWith('[')) { inEntry = line === '[Desktop Entry]'; continue }
    if (!inEntry || !line || line.startsWith('#')) continue
    const eq = line.indexOf('=')
    if (eq < 0) continue
    const k = line.slice(0, eq).trim()
    if (kv.has(k)) continue
    kv.set(k, line.slice(eq + 1).trim())
  }
  const name = kv.get('Name') ?? ''
  if (!name) return null
  if ((kv.get('Type') ?? 'Application') !== 'Application') return null
  return {
    id,
    file,
    name,
    icon: kv.get('Icon') ?? '',
    exec: kv.get('Exec') ?? '',
    noDisplay: kv.get('NoDisplay') === 'true',
    hidden: kv.get('Hidden') === 'true',
    terminal: kv.get('Terminal') === 'true',
    mimes: (kv.get('MimeType') ?? '').split(';').map(s => s.trim()).filter(Boolean),
  }
}

function parseListFile(file: string, section: string): Map<string, string[]> {
  const out = new Map<string, string[]>()
  let txt = ''
  try { txt = fs.readFileSync(file, 'utf8') } catch { return out }
  let inSection = false
  for (const raw of txt.split('\n')) {
    const line = raw.trim()
    if (line.startsWith('[')) { inSection = line === `[${section}]`; continue }
    if (!inSection || !line || line.startsWith('#')) continue
    const eq = line.indexOf('=')
    if (eq < 0) continue
    const mime = line.slice(0, eq).trim()
    const ids = line.slice(eq + 1).split(';').map(s => s.trim()).filter(Boolean)
    if (!out.has(mime)) out.set(mime, ids)
  }
  return out
}

function loadDb(): Db {
  if (db && Date.now() - db.at < 60_000) return db

  const apps = new Map<string, DesktopApp>()
  const cacheIds = new Map<string, string[]>()

  for (const dir of appDirs()) {
    let names: string[] = []
    try { names = fs.readdirSync(dir) } catch { continue }
    for (const n of names) {
      if (!n.endsWith('.desktop')) continue
      const app = parseDesktopFile(path.join(dir, n), n)
      if (app && !app.hidden) apps.set(n, app)
    }
    // [MIME Cache] — user dir entries are appended after system ones
    const mc = parseListFile(path.join(dir, 'mimeinfo.cache'), 'MIME Cache')
    for (const [mime, ids] of mc) {
      const prev = cacheIds.get(mime) ?? []
      cacheIds.set(mime, [...prev, ...ids.filter(i => !prev.includes(i))])
    }
  }

  const userList = path.join(os.homedir(), '.config', 'mimeapps.list')
  const systemList = '/usr/share/applications/mimeapps.list'
  const userRemoved = new Map<string, Set<string>>()
  for (const [mime, ids] of parseListFile(userList, 'Removed Associations')) {
    userRemoved.set(mime, new Set(ids))
  }

  db = {
    apps,
    cacheIds,
    userDefaults: parseListFile(userList, 'Default Applications'),
    userAdded: parseListFile(userList, 'Added Associations'),
    userRemoved,
    systemDefaults: parseListFile(systemList, 'Default Applications'),
    at: Date.now(),
  }
  return db
}

// ---------------------------------------------------------------------------
// MIME subclassing (shared-mime-info `subclasses` file): candidates for a type
// include handlers of its ancestors — this is GIO's "fallback" tier and what
// fills Open With for types like text/markdown that no app registers directly.
// ---------------------------------------------------------------------------

let subclassParents: Map<string, string[]> | null = null

function mimeAncestors(mime: string): string[] {
  if (!subclassParents) {
    subclassParents = new Map()
    for (const f of ['/usr/share/mime/subclasses', path.join(os.homedir(), '.local/share/mime/subclasses')]) {
      let txt = ''
      try { txt = fs.readFileSync(f, 'utf8') } catch { continue }
      for (const line of txt.split('\n')) {
        const sp = line.indexOf(' ')
        if (sp < 0) continue
        const child = line.slice(0, sp).trim()
        const parent = line.slice(sp + 1).trim()
        if (!child || !parent) continue
        const list = subclassParents.get(child) ?? []
        if (!list.includes(parent)) list.push(parent)
        subclassParents.set(child, list)
      }
    }
  }
  const out: string[] = []
  const queue = [mime]
  const seen = new Set(queue)
  while (queue.length) {
    const m = queue.shift()!
    for (const parent of subclassParents.get(m) ?? []) {
      if (seen.has(parent)) continue
      seen.add(parent)
      out.push(parent)
      queue.push(parent)
    }
    // spec: all text/* is-a text/plain even without an explicit entry
    if (m.startsWith('text/') && !seen.has('text/plain')) {
      seen.add('text/plain')
      out.push('text/plain')
      queue.push('text/plain')
    }
  }
  return out.filter(m => m !== 'application/octet-stream')   // too broad to be useful
}

function toCandidate(app: DesktopApp, isDefault: boolean): AppCandidate {
  return {
    id: app.id,
    name: app.name,
    icons: app.icon ? [app.icon, 'application-x-executable'] : ['application-x-executable'],
    isDefault,
  }
}

export async function listAppsFor(mime: string): Promise<AppCandidate[]> {
  const d = loadDb()
  const removed = d.userRemoved.get(mime) ?? new Set<string>()
  const types = [mime, ...mimeAncestors(mime)]     // exact type first, then supertypes

  // default = first entry of user defaults (then system defaults) that exists,
  // walking up the subclass chain like GIO does
  let defaultId: string | null = null
  outer: for (const t of types) {
    for (const id of [...(d.userDefaults.get(t) ?? []), ...(d.systemDefaults.get(t) ?? [])]) {
      if (removed.has(id)) continue
      if (d.apps.has(id)) { defaultId = id; break outer }
    }
  }

  const explicit = new Set<string>([...(d.userAdded.get(mime) ?? [])])
  if (defaultId) explicit.add(defaultId)

  const ordered: string[] = []
  if (defaultId) ordered.push(defaultId)
  for (const t of types) {
    for (const id of [...(d.userAdded.get(t) ?? []), ...(d.cacheIds.get(t) ?? [])]) {
      if (!ordered.includes(id)) ordered.push(id)
    }
  }

  const out: AppCandidate[] = []
  for (const id of ordered) {
    if (removed.has(id)) continue
    const app = d.apps.get(id)
    if (!app || !app.exec) continue
    if (app.noDisplay && !explicit.has(id)) continue
    out.push(toCandidate(app, id === defaultId))
  }
  return out
}

export async function listAllApps(): Promise<AppCandidate[]> {
  const d = loadDb()
  const out: AppCandidate[] = []
  for (const app of d.apps.values()) {
    if (app.noDisplay || !app.exec) continue
    out.push(toCandidate(app, false))
  }
  out.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }))
  return out
}

export async function openPath(p: string): Promise<{ ok: boolean; error?: string }> {
  try {
    spawn('gio', ['open', p], { detached: true, stdio: 'ignore' }).unref()
    return { ok: true }
  } catch (e: any) {
    return { ok: false, error: String(e?.message ?? e) }
  }
}

export async function openWith(p: string, appId: string): Promise<void> {
  const d = loadDb()
  const app = d.apps.get(appId)
  if (!app) throw new Error(`Unknown application: ${appId}`)
  // gio launch handles %u/%f substitution, Terminal=true and D-Bus activation
  spawn('gio', ['launch', app.file, p], { detached: true, stdio: 'ignore' }).unref()
}

export async function setDefaultApp(mime: string, appId: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    execFile('xdg-mime', ['default', appId, mime], { timeout: 5000 }, (err, _o, stderr) => {
      if (err) reject(new Error((stderr || err.message).trim()))
      else resolve()
    })
  })
  if (db) db.at = 0            // force re-read on next query
}

export async function archiveList(_p: string): Promise<FileEntry[]> {
  return []                    // browse-archive-as-folder: v2 (gvfs archive:// / libarchive)
}
