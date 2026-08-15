// The extension store: search Cinnamon Spices, install actions, remove them.
//
// WHY MAIN DOES ALL THE NETWORKING. The renderer's CSP is
// `default-src 'self' liqicon: liqthumb:` with no https anywhere, so the browse
// panel cannot fetch the index or an icon even if it wanted to. That is the
// right posture and it is kept: every request happens here, icons are cached to
// disk and handed over as liqfile:// URLs, exactly as PDF page thumbnails are.
//
// THE DANGEROUS PART IS THE ZIP, NOT THE DOWNLOAD. A Spices package is a zip
// containing `<uuid>.nemo_action` and a `<uuid>/` folder of shell scripts the
// action calls. Extracting an archive from the internet into a directory whose
// contents the app will later EXECUTE is the whole risk, and it has two edges:
//
//   * Path traversal. An entry named `../../.bashrc` would land outside the
//     extensions folder. Every entry is checked before anything is written, and
//     one bad name rejects the entire package rather than the entry — a
//     half-installed extension is worse than none.
//   * Consent. The action's Exec runs with the user's privileges. Nothing is
//     installed until the caller has been given previewExtension()'s answer —
//     the exact command, the scripts, the dependencies — and come back to ask
//     for it.
//
// Everything is verified from what actually landed on disk rather than from an
// exit code, the rule the rest of this codebase already follows.
import { BrowserWindow, dialog, ipcMain } from 'electron'
import { spawn } from 'node:child_process'
import * as fs from 'node:fs'
import * as fsp from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { CH } from '../../shared/ipc'
import { STORE, type ExtensionPreview, type InstallResult, type StoreEntry, type StoreIndex } from '../../shared/extstore'
import { previewURL } from '../../shared/preview'
import { extensionsDir, forgetActionCache, nemoActionsDir } from './nemoactions'
import { resolveTools } from './tools'
import { STATE_DIR, TEST_PROFILE, TEST_ROOT } from '../state/settings'

// ------------------------------------------------------------------ fetching

/**
 * A GET with a deadline and a size cap, using Node's own http stack.
 *
 * Electron's net module would also work; node:https keeps this testable without
 * an app instance and is one less thing that behaves differently under a test
 * harness. Redirects are followed by hand (the registry serves 302s for files)
 * with a small hop limit, because an unbounded redirect chain is a hang.
 */
function httpGet(url: string, cap: number, hops = 4): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    if (hops < 0) { reject(new Error('too many redirects')); return }
    let mod: typeof import('node:https')
    try { mod = require(url.startsWith('http://') ? 'node:http' : 'node:https') } catch (e) { reject(e as Error); return }
    const req = mod.get(url, { timeout: STORE.timeoutMs, headers: { 'user-agent': 'LiqExplorer' } }, res => {
      const code = res.statusCode ?? 0
      const loc = res.headers.location
      if (code >= 300 && code < 400 && loc) {
        res.resume()
        resolve(httpGet(new URL(loc, url).toString(), cap, hops - 1))
        return
      }
      if (code !== 200) { res.resume(); reject(new Error(`the server answered ${code}`)); return }
      const chunks: Buffer[] = []
      let total = 0
      res.on('data', (c: Buffer) => {
        total += c.length
        if (total > cap) { req.destroy(); reject(new Error('that download is larger than this will accept')); return }
        chunks.push(c)
      })
      res.on('end', () => resolve(Buffer.concat(chunks)))
      res.on('error', reject)
    })
    req.on('timeout', () => { req.destroy(); reject(new Error('the server did not answer in time')) })
    req.on('error', reject)
  })
}

// -------------------------------------------------------------------- index

function indexCacheFile(): string { return path.join(STATE_DIR, 'spices-actions.json') }
function iconDir(): string { return path.join(STATE_DIR, 'spices-icons') }

interface RawEntry {
  uuid?: string
  name?: string
  description?: string
  author_user?: string
  score?: number
  last_edited?: number
  file_size?: number
  icon?: string
}

/** the shape the registry publishes, reduced to what is shown */
function normalise(raw: Record<string, RawEntry>): Omit<StoreEntry, 'installed' | 'updatable' | 'icon'>[] {
  const out: Omit<StoreEntry, 'installed' | 'updatable' | 'icon'>[] = []
  for (const [key, v] of Object.entries(raw ?? {})) {
    const uuid = String(v?.uuid || key || '')
    // a uuid becomes a FILE NAME below, so anything with a separator in it is
    // rejected here rather than sanitised into something that still resolves
    if (!uuid || uuid.includes('/') || uuid.includes('\\') || uuid.startsWith('.')) continue
    out.push({
      uuid,
      name: String(v?.name || uuid),
      description: String(v?.description || ''),
      author: String(v?.author_user || ''),
      score: Number(v?.score) || 0,
      lastEdited: Number(v?.last_edited) || 0,
      size: Number(v?.file_size) || 0,
    })
  }
  return out
}

/** which uuids are installed here, and when their action file was written */
async function installedMap(): Promise<Map<string, number>> {
  const out = new Map<string, number>()
  for (const dir of [extensionsDir(), nemoActionsDir()]) {
    let names: string[] = []
    try { names = await fsp.readdir(dir) } catch { continue }
    for (const n of names) {
      if (!n.endsWith('.nemo_action')) continue
      const uuid = n.slice(0, -'.nemo_action'.length)
      const st = await fsp.stat(path.join(dir, n)).catch(() => null)
      out.set(uuid, st ? Math.floor(st.mtimeMs / 1000) : 0)
    }
  }
  return out
}

/**
 * The registry index, from the network when it is due and from the cache
 * otherwise — and from the cache anyway when the network fails.
 *
 * A file manager that cannot reach the internet must still be able to open this
 * panel and see what it has installed, so a failed fetch is reported as stale
 * data rather than as an empty store.
 */
export async function storeIndex(force = false): Promise<StoreIndex> {
  const cacheFile = indexCacheFile()
  let cached: { at: number; raw: Record<string, RawEntry> } | null = null
  try { cached = JSON.parse(await fsp.readFile(cacheFile, 'utf8')) } catch { /* first run */ }

  const fresh = cached && Date.now() - cached.at < STORE.indexTtlMs
  let raw = cached?.raw ?? {}
  let stale = false
  let error: string | undefined

  if (force || !fresh) {
    try {
      const buf = await httpGet(STORE.indexUrl, STORE.maxDownloadBytes)
      raw = JSON.parse(buf.toString('utf8')) as Record<string, RawEntry>
      await fsp.mkdir(STATE_DIR, { recursive: true }).catch(() => {})
      await fsp.writeFile(cacheFile, JSON.stringify({ at: Date.now(), raw }))
      cached = { at: Date.now(), raw }
    } catch (e) {
      stale = !!cached
      error = cached
        ? `Could not reach the extension site, so this list may be out of date (${String((e as Error).message)}).`
        : `Could not reach the extension site: ${String((e as Error).message)}`
    }
  }

  const have = await installedMap()
  const entries: StoreEntry[] = normalise(raw).map(e => ({
    ...e,
    icon: cachedIconURL(e.uuid),
    installed: have.has(e.uuid),
    // mtime of the installed file vs the registry's last edit. Coarse on
    // purpose: it only has to be right about "there is something newer".
    updatable: have.has(e.uuid) && e.lastEdited > (have.get(e.uuid) ?? 0) + 60,
  }))
  entries.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))
  return { ok: !!entries.length || !error, entries, fetchedAt: cached?.at ?? 0, stale, error }
}

function cachedIconURL(uuid: string): string {
  const f = path.join(iconDir(), `${uuid}.png`)
  return fs.existsSync(f) ? previewURL(f) : ''
}

/**
 * Fetch icons for the entries the panel is actually showing.
 *
 * Pulled on demand rather than all 65 up front: the panel asks for the page it
 * is about to draw, so a search that matches three extensions costs three
 * requests instead of the whole catalogue.
 */
export async function storeIcons(uuids: string[]): Promise<Record<string, string>> {
  const dir = iconDir()
  await fsp.mkdir(dir, { recursive: true }).catch(() => {})
  const out: Record<string, string> = {}
  await Promise.all(uuids.slice(0, 40).map(async uuid => {
    if (!safeUuid(uuid)) return
    const file = path.join(dir, `${uuid}.png`)
    if (fs.existsSync(file)) { out[uuid] = previewURL(file); return }
    try {
      const buf = await httpGet(`${STORE.baseUrl}/files/actions/${encodeURIComponent(uuid)}.png`, 4 * 1024 * 1024)
      // a PNG or nothing: this is written somewhere the app will later render
      if (buf.length > 8 && buf[0] === 0x89 && buf[1] === 0x50) {
        await fsp.writeFile(file, buf)
        out[uuid] = previewURL(file)
      }
    } catch { /* an icon is decoration; its absence is not an error */ }
  }))
  return out
}

// ------------------------------------------------------------------ install

function safeUuid(uuid: string): boolean {
  return !!uuid && !/[/\\]/.test(uuid) && !uuid.startsWith('.') && uuid.length < 200
}

/** run a tool, capturing output, with a deadline */
function run(bin: string, args: string[], ms: number): Promise<{ code: number; stderr: string }> {
  return new Promise(resolve => {
    let done = false
    const finish = (code: number, stderr: string): void => { if (!done) { done = true; resolve({ code, stderr }) } }
    try {
      const c = spawn(bin, args, { stdio: ['ignore', 'ignore', 'pipe'] })
      let err = ''
      c.stderr?.on('data', d => { err += String(d) })
      const t = setTimeout(() => { try { c.kill('SIGKILL') } catch { /* gone */ } finish(-1, 'timed out') }, ms)
      c.on('error', e => { clearTimeout(t); finish(-1, String(e)) })
      c.on('close', code => { clearTimeout(t); finish(code ?? -1, err) })
    } catch (e) { finish(-1, String(e)) }
  })
}

/**
 * Every path inside the archive, for the traversal check.
 *
 * `7z l -ba -slt` is used rather than plain `l` because the plain listing is a
 * fixed-width table that has to be column-sliced, and a file name containing
 * two spaces would be read wrong — which is precisely the sort of name an
 * attacker would choose.
 */
async function zipEntries(zip: string): Promise<string[]> {
  const sevenZip = resolveTools().sevenZip
  if (!sevenZip) return []
  return new Promise(resolve => {
    const c = spawn(sevenZip, ['l', '-ba', '-slt', '--', zip], { stdio: ['ignore', 'pipe', 'ignore'] })
    let out = ''
    c.stdout.on('data', d => { out += String(d) })
    const t = setTimeout(() => { try { c.kill('SIGKILL') } catch { /* gone */ } resolve([]) }, 20_000)
    c.on('error', () => { clearTimeout(t); resolve([]) })
    c.on('close', () => {
      clearTimeout(t)
      resolve(out.split('\n')
        .filter(l => l.startsWith('Path = '))
        .map(l => l.slice('Path = '.length).trim())
        .filter(Boolean))
    })
  })
}

/**
 * Is every entry in this archive safe to extract into a directory?
 *
 * Rejects absolute paths, anything containing a `..` segment, and anything that
 * does not resolve back inside the target. Returns the offending name so the
 * refusal can say WHICH entry was the problem rather than just "unsafe".
 */
function unsafeEntry(names: string[], into: string): string {
  const root = path.resolve(into) + path.sep
  for (const n of names) {
    if (!n || path.isAbsolute(n) || n.startsWith('/') || /(^|[\\/])\.\.([\\/]|$)/.test(n)) return n
    const resolved = path.resolve(into, n)
    if (resolved !== path.resolve(into) && !resolved.startsWith(root)) return n
  }
  return ''
}

/** parse just enough of a .nemo_action to describe it */
function readAction(text: string): { exec: string; name: string; comment: string; deps: string[]; conds: string[] } {
  const get = (k: string): string => {
    const m = new RegExp(`^${k}=(.*)$`, 'm').exec(text)
    return m ? m[1].trim() : ''
  }
  const strip = (v: string): string => (v.startsWith('<') && v.endsWith('>') ? v.slice(1, -1).trim() : v)
  const list = (v: string): string[] => v.split(';').map(s => s.trim()).filter(Boolean)
  return {
    exec: strip(get('Exec')),
    name: get('Name'),
    comment: get('Comment'),
    deps: list(get('Dependencies')),
    conds: list(get('Conditions')),
  }
}

/** download a package to a scratch dir and unpack it; caller removes the dir */
async function stage(uuid: string): Promise<{ dir: string; actionFile: string; names: string[] } | { error: string }> {
  if (!safeUuid(uuid)) return { error: 'That extension has a name this cannot install safely.' }
  if (!resolveTools().sevenZip) return { error: 'Installing needs 7-Zip, which is not installed.' }

  const scratch = await fsp.mkdtemp(path.join(os.tmpdir(), 'liqext-'))
  try {
    const buf = await httpGet(`${STORE.baseUrl}/files/actions/${encodeURIComponent(uuid)}.zip`, STORE.maxDownloadBytes)
    // PK\003\004 — refuse an HTML error page that arrived with a 200
    if (buf.length < 4 || buf[0] !== 0x50 || buf[1] !== 0x4b) {
      return { error: 'What came back was not an extension package.' }
    }
    const zip = path.join(scratch, 'pkg.zip')
    await fsp.writeFile(zip, buf)

    const names = await zipEntries(zip)
    if (!names.length) return { error: 'That package could not be read.' }
    const bad = unsafeEntry(names, scratch)
    if (bad) return { error: `That package tries to write outside the extensions folder ("${bad}"), so none of it was installed.` }

    const unpack = path.join(scratch, 'x')
    await fsp.mkdir(unpack, { recursive: true })
    const r = await run(resolveTools().sevenZip, ['x', `-o${unpack}`, '-y', '--', zip], 60_000)
    const actionFile = path.join(unpack, `${uuid}.nemo_action`)
    if (!fs.existsSync(actionFile)) {
      return { error: r.stderr.split('\n')[0] || 'That package does not contain an action file.' }
    }
    return { dir: unpack, actionFile, names }
  } catch (e) {
    await fsp.rm(scratch, { recursive: true, force: true }).catch(() => {})
    return { error: String((e as Error)?.message ?? e) }
  }
}

/** total bytes under a directory */
async function dirSize(dir: string): Promise<number> {
  let total = 0
  const walk = async (d: string): Promise<void> => {
    const ents = await fsp.readdir(d, { withFileTypes: true }).catch(() => [])
    for (const e of ents) {
      const p = path.join(d, e.name)
      if (e.isDirectory()) await walk(p)
      else { const st = await fsp.stat(p).catch(() => null); if (st) total += st.size }
    }
  }
  await walk(dir)
  return total
}

/**
 * What this extension would do, WITHOUT installing it.
 *
 * The package is downloaded and unpacked to a temp directory, described, and
 * thrown away. That costs one download that may be repeated on accept, and it
 * buys the only thing that makes installing arbitrary shell scripts reasonable:
 * the user sees the command before it is on their machine.
 */
export async function previewExtension(uuid: string): Promise<ExtensionPreview> {
  const empty: ExtensionPreview = {
    ok: false, uuid, name: '', comment: '', author: '', exec: '',
    scripts: [], dependencies: [], conditions: [], size: 0,
  }
  const staged = await stage(uuid)
  if ('error' in staged) return { ...empty, error: staged.error }
  try {
    const a = readAction(await fsp.readFile(staged.actionFile, 'utf8'))
    const scripts = staged.names.filter(n => /\.(sh|py|pl|rb|bash)$/i.test(n))
    let author = ''
    try {
      const meta = JSON.parse(await fsp.readFile(path.join(staged.dir, uuid, 'metadata.json'), 'utf8')) as { author?: string }
      author = String(meta?.author ?? '')
    } catch { /* not every package ships metadata */ }
    return {
      ok: true, uuid, name: a.name || uuid, comment: a.comment, author,
      exec: a.exec, scripts, dependencies: a.deps, conditions: a.conds,
      size: await dirSize(staged.dir),
    }
  } finally {
    await fsp.rm(path.dirname(staged.dir), { recursive: true, force: true }).catch(() => {})
  }
}

/**
 * Where this package has to live.
 *
 * Almost every action refers to its own scripts by a path relative to the
 * action file, and those work wherever they are put. Measured across all 65
 * actions in the registry, exactly ONE writes the install location into its
 * Exec by hand ($HOME/.local/share/nemo/actions/<uuid>/…) — and installing that
 * one into this app's own folder would produce an extension that appears in the
 * menu and then does nothing, which is the failure this whole area exists to
 * stop.
 *
 * So the destination follows the package: anything that names the Nemo actions
 * directory is installed there, where its author assumed it would be, and
 * everything else goes in ours where it is easy to see and remove. Both are
 * scanned, so either way it works; uninstall looks in both.
 */
function landingDir(actionText: string): string {
  return /nemo\/actions/.test(actionText) ? nemoActionsDir() : extensionsDir()
}

/** copy a staged package into the extensions folder */
async function land(stagedDir: string, uuid: string): Promise<InstallResult> {
  const actionText = await fsp.readFile(path.join(stagedDir, `${uuid}.nemo_action`), 'utf8').catch(() => '')
  const dest = landingDir(actionText)
  await fsp.mkdir(dest, { recursive: true })
  const action = `${uuid}.nemo_action`
  const payload = path.join(stagedDir, uuid)

  // replace any previous copy so an update does not merge two versions
  await fsp.rm(path.join(dest, uuid), { recursive: true, force: true }).catch(() => {})
  await fsp.cp(path.join(stagedDir, action), path.join(dest, action), { force: true })
  if (fs.existsSync(payload)) {
    await fsp.cp(payload, path.join(dest, uuid), { recursive: true, force: true })
    // the scripts the action calls arrive without the executable bit
    const ents = await fsp.readdir(path.join(dest, uuid), { withFileTypes: true }).catch(() => [])
    for (const e of ents) {
      if (e.isFile() && /\.(sh|py|pl|rb|bash)$/i.test(e.name)) {
        await fsp.chmod(path.join(dest, uuid, e.name), 0o755).catch(() => {})
      }
    }
  }
  forgetActionCache()
  const text = await fsp.readFile(path.join(dest, action), 'utf8').catch(() => '')
  return { ok: true, file: path.join(dest, action), name: readAction(text).name || uuid }
}

export async function installExtension(uuid: string): Promise<InstallResult> {
  const staged = await stage(uuid)
  if ('error' in staged) return { ok: false, error: staged.error }
  try {
    return await land(staged.dir, uuid)
  } catch (e) {
    return { ok: false, error: String((e as Error)?.message ?? e) }
  } finally {
    await fsp.rm(path.dirname(staged.dir), { recursive: true, force: true }).catch(() => {})
  }
}

/**
 * Install from a file the user already has: a bare .nemo_action, or a zip laid
 * out the way the registry lays them out.
 */
export async function installExtensionFile(file: string): Promise<InstallResult> {
  if (!file || !file.startsWith('/')) return { ok: false, error: 'Not a file on this computer.' }
  const dest = extensionsDir()
  await fsp.mkdir(dest, { recursive: true }).catch(() => {})

  if (file.endsWith('.nemo_action')) {
    const name = path.basename(file)
    const text = await fsp.readFile(file, 'utf8').catch(() => '')
    if (!/\[Nemo Action\]/.test(text)) return { ok: false, error: 'That file is not a Nemo action.' }
    await fsp.copyFile(file, path.join(dest, name))
    forgetActionCache()
    return { ok: true, file: path.join(dest, name), name: readAction(text).name || name }
  }

  if (!resolveTools().sevenZip) return { ok: false, error: 'Reading a package needs 7-Zip, which is not installed.' }
  const scratch = await fsp.mkdtemp(path.join(os.tmpdir(), 'liqext-'))
  try {
    const names = await zipEntries(file)
    if (!names.length) return { ok: false, error: 'That package could not be read.' }
    const bad = unsafeEntry(names, scratch)
    if (bad) return { ok: false, error: `That package tries to write outside the extensions folder ("${bad}").` }
    const action = names.find(n => n.endsWith('.nemo_action') && !n.includes('/'))
    if (!action) return { ok: false, error: 'That package does not contain an action file.' }
    const unpack = path.join(scratch, 'x')
    await fsp.mkdir(unpack, { recursive: true })
    await run(resolveTools().sevenZip, ['x', `-o${unpack}`, '-y', '--', file], 60_000)
    const uuid = action.slice(0, -'.nemo_action'.length)
    if (!fs.existsSync(path.join(unpack, action))) return { ok: false, error: 'That package could not be unpacked.' }
    return await land(unpack, uuid)
  } catch (e) {
    return { ok: false, error: String((e as Error)?.message ?? e) }
  } finally {
    await fsp.rm(scratch, { recursive: true, force: true }).catch(() => {})
  }
}

/** Remove an installed extension: the action file and its payload folder. */
export async function uninstallExtension(uuid: string): Promise<{ ok: boolean; error?: string }> {
  if (!safeUuid(uuid)) return { ok: false, error: 'That is not something this can remove.' }
  try {
    // both landing places, because landingDir() chose one of them at install
    for (const dest of [extensionsDir(), nemoActionsDir()]) {
      await fsp.rm(path.join(dest, `${uuid}.nemo_action`), { force: true })
      await fsp.rm(path.join(dest, uuid), { recursive: true, force: true })
    }
    forgetActionCache()
    return { ok: true }
  } catch (e) {
    return { ok: false, error: String((e as Error)?.message ?? e) }
  }
}

ipcMain.handle(CH('storePick'), async (e) => {
  const win = BrowserWindow.fromWebContents(e.sender)
  const r = await dialog.showOpenDialog(win!, {
    title: 'Install an extension',
    properties: ['openFile'],
    filters: [
      { name: 'Extensions', extensions: ['nemo_action', 'zip'] },
      { name: 'All files', extensions: ['*'] },
    ],
  })
  return r.canceled ? [] : r.filePaths
})
ipcMain.handle(CH('storeIndex'), (_e, force?: boolean) => storeIndex(!!force))
ipcMain.handle(CH('storeIcons'), (_e, uuids: string[]) => storeIcons(uuids ?? []))
ipcMain.handle(CH('storePreview'), (_e, uuid: string) => previewExtension(uuid))
ipcMain.handle(CH('storeInstall'), (_e, uuid: string) => installExtension(uuid))
ipcMain.handle(CH('storeInstallFile'), (_e, file: string) => installExtensionFile(file))
ipcMain.handle(CH('storeUninstall'), (_e, uuid: string) => uninstallExtension(uuid))
