// Small synchronous-ish operations that bypass the op queue: inline rename,
// New folder / New file (+ ~/Templates listing). All record into undo on
// success. Name validation mirrors Explorer's messages; case-only renames go
// through a temp name because the CIFS share is case-insensitive (a direct
// rename can no-op or clobber there).
import { ipcMain } from 'electron'
import * as fs from 'node:fs'
import * as fsp from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { CH } from '../../shared/ipc'
import * as undo from './undo'

/** Explorer-style name validation. Returns an error message, or null when valid. */
export function validateName(name: string): string | null {
  if (!name || !name.trim()) return 'You must type a file name.'
  if (name === '.' || name === '..') return 'The specified name is not valid.'
  if (name.includes('/')) return "A file name can't contain any of the following characters: /"
  if (name.includes('\0')) return 'The specified name contains an invalid character.'
  if (Buffer.byteLength(name, 'utf8') > 255) return 'The file name is too long.'
  return null
}

function errText(e: unknown): string {
  const err = e as NodeJS.ErrnoException
  switch (err?.code) {
    case 'EACCES':
    case 'EPERM': return 'You do not have permission to perform this action.'
    case 'ENOENT': return 'The item is no longer in this location.'
    case 'ENOSPC': return 'There is not enough space on the drive.'
    case 'EROFS': return 'This location is read-only.'
    case 'EEXIST': return 'There is already a file with the same name in this location.'
  }
  return String(err?.message ?? e)
}

async function existsL(p: string): Promise<boolean> {
  return fsp.lstat(p).then(() => true, () => false)
}

export async function renameOne(oldPath: string, newName: string): Promise<{ ok: boolean; error?: string; newPath?: string }> {
  const invalid = validateName(newName)
  if (invalid) return { ok: false, error: invalid }
  const dir = path.dirname(oldPath)
  const oldName = path.basename(oldPath)
  const newPath = path.join(dir, newName)
  if (newName === oldName) return { ok: true, newPath }

  const caseOnly = newName.toLowerCase() === oldName.toLowerCase()
  if (caseOnly) {
    // On a case-SENSITIVE fs (ext4 home) both casings can legally coexist:
    // newPath resolving to a different dev+ino than oldPath is a distinct
    // file the two-step rename below would silently clobber — collide instead.
    const srcSt = await fsp.lstat(oldPath).catch(() => null)
    if (!srcSt) return { ok: false, error: 'The item is no longer in this location.' }
    const dstSt = await fsp.lstat(newPath).catch(() => null)
    if (dstSt && (dstSt.dev !== srcSt.dev || dstSt.ino !== srcSt.ino)) {
      return { ok: false, error: 'There is already a file with the same name in this location.' }
    }
    // Two-step through a temp name: on a case-insensitive mount (CIFS here) the
    // destination "exists" (it IS the source) and a direct rename may no-op.
    let tmp: string
    do {
      tmp = path.join(dir, `.liq-rename-${process.pid}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`)
    } while (await existsL(tmp))
    try {
      await fsp.rename(oldPath, tmp)
    } catch (e) {
      return { ok: false, error: errText(e) }
    }
    // with the source parked at tmp, newPath must not exist on ANY fs type —
    // anything there now is a distinct entry rename() would clobber
    if (await existsL(newPath)) {
      await fsp.rename(tmp, oldPath).catch(() => {})
      return { ok: false, error: 'There is already a file with the same name in this location.' }
    }
    try {
      await fsp.rename(tmp, newPath)
    } catch (e) {
      await fsp.rename(tmp, oldPath).catch(() => {})   // roll back, never strand the temp name
      return { ok: false, error: errText(e) }
    }
    undo.record({ kind: 'rename', count: 1, pairs: [{ from: oldPath, to: newPath }] })
    return { ok: true, newPath }
  }

  // lstat does a case-insensitive lookup on CIFS, so "README.md vs readme.md"
  // conflicts exactly where the filesystem would clobber — and not on ext4.
  if (await existsL(newPath)) {
    return { ok: false, error: 'There is already a file with the same name in this location.' }
  }
  try {
    await fsp.rename(oldPath, newPath)
  } catch (e) {
    return { ok: false, error: errText(e) }
  }
  undo.record({ kind: 'rename', count: 1, pairs: [{ from: oldPath, to: newPath }] })
  return { ok: true, newPath }
}

export async function newFolder(parent: string): Promise<{ ok: boolean; path?: string; error?: string }> {
  let name = 'New folder'
  for (let i = 2; ; i++) {
    const p = path.join(parent, name)
    try {
      await fsp.mkdir(p)
      undo.record({ kind: 'mkdir', count: 1, created: [p] })
      return { ok: true, path: p }
    } catch (e) {
      if ((e as NodeJS.ErrnoException)?.code !== 'EEXIST') return { ok: false, error: errText(e) }
      name = `New folder (${i})`
    }
  }
}

/**
 * template semantics:
 * - absolute path to an existing file (a ~/Templates entry): copy its content,
 *   name after its basename;
 * - bare file name: create empty with that name;
 * - omitted: 'New Text Document.txt' (Explorer default).
 */
export async function newFile(parent: string, template?: string): Promise<{ ok: boolean; path?: string; error?: string }> {
  let base = 'New Text Document.txt'
  let content: Buffer | null = null
  if (template) {
    if (path.isAbsolute(template)) {
      try {
        content = await fsp.readFile(template)
        base = path.basename(template)
      } catch {
        base = path.basename(template)     // unreadable template -> empty file with its name
      }
    } else {
      base = template
    }
  }
  const invalid = validateName(base)
  if (invalid) return { ok: false, error: invalid }
  const ext = path.extname(base)
  const stem = base.slice(0, base.length - ext.length)
  let name = base
  for (let i = 2; ; i++) {
    const p = path.join(parent, name)
    try {
      await fsp.writeFile(p, content ?? '', { flag: 'wx' })
      undo.record({ kind: 'mkfile', count: 1, created: [p] })
      return { ok: true, path: p }
    } catch (e) {
      if ((e as NodeJS.ErrnoException)?.code !== 'EEXIST') return { ok: false, error: errText(e) }
      name = `${stem} (${i})${ext}`
    }
  }
}

// ---------------- templates (New > submenu) ----------------

function templatesDir(): string {
  const home = os.homedir()
  try {
    const txt = fs.readFileSync(path.join(home, '.config/user-dirs.dirs'), 'utf8')
    const m = /XDG_TEMPLATES_DIR="([^"]+)"/.exec(txt)
    if (m) return m[1].replace('$HOME', home)
  } catch { /* default below */ }
  return path.join(home, 'Templates')
}

export async function templatesList(): Promise<{ name: string; path: string }[]> {
  const dir = templatesDir()
  let names: string[] = []
  try { names = await fsp.readdir(dir) } catch { return [] }
  const out: { name: string; path: string }[] = []
  for (const n of names) {
    if (n.startsWith('.')) continue
    const p = path.join(dir, n)
    const st = await fsp.lstat(p).catch(() => null)
    if (st?.isFile()) out.push({ name: n, path: p })
  }
  out.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }))
  return out
}

// self-registered IPC method (renderer: liq.invoke('templatesList'))
ipcMain.handle(CH('templatesList'), () => templatesList())
