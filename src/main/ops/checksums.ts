// Checksums for the Drop Bins "Checksums" bin. Self-registers its IPC:
//     checksumsRun(ChecksumRequest) -> ChecksumResult, progress on CHECKSUM_PROGRESS
//     checksumsCancel(runId)
//
// Shells out to coreutils md5sum/sha1sum/sha256sum rather than hashing in
// process: they are already installed (project rule — OS work goes through CLI
// helpers), they stream without pulling files into the renderer's heap, and
// their OUTPUT FORMAT is the point. Lines come back byte-identical to
//     <hash>  <path relative to the common root>
// so saving them as SHA256SUMS in that root makes `sha256sum -c SHA256SUMS`
// verify the set — which is the only reason anyone wants checksums of several
// files at once. Paths are passed relative with cwd=root and terminated by
// `--`, so a file named "-n" cannot turn into an option.
//
// Folders are walked (that is the useful gesture: verify a whole tree), capped
// at CHECKSUM_FILE_CAP files so one careless drop cannot hash a drive.
import { ipcMain, type WebContents } from 'electron'
import { spawn, type ChildProcess } from 'node:child_process'
import * as fsp from 'node:fs/promises'
import * as path from 'node:path'
import { CH } from '../../shared/ipc'
import {
  CHECKSUM_FILE_CAP, CHECKSUM_PROGRESS,
  type ChecksumAlgo, type ChecksumProgress, type ChecksumRequest, type ChecksumResult,
} from '../../shared/bins'

const BIN: Record<ChecksumAlgo, string> = {
  md5: 'md5sum', sha1: 'sha1sum', sha256: 'sha256sum',
}
const WALK_DEPTH = 16
/** keep each argv comfortably under ARG_MAX even with long CIFS paths */
const CHUNK_BYTES = 96 * 1024
const CHUNK_FILES = 400

interface Run { cancelled: boolean; children: Set<ChildProcess> }
const runs = new Map<number, Run>()

/** deepest directory containing every path */
function commonRoot(files: string[]): string {
  if (!files.length) return '/'
  let parts = path.dirname(files[0]).split('/')
  for (const f of files.slice(1)) {
    const p = path.dirname(f).split('/')
    let i = 0
    while (i < parts.length && i < p.length && parts[i] === p[i]) i++
    parts = parts.slice(0, i)
  }
  return parts.join('/') || '/'
}

async function collect(paths: string[]): Promise<{ files: string[]; skipped: string[] }> {
  const files: string[] = []
  const skipped: string[] = []
  const seen = new Set<string>()
  const walk = async (p: string, depth: number): Promise<void> => {
    if (files.length >= CHECKSUM_FILE_CAP) return
    let st
    try { st = await fsp.lstat(p) } catch { skipped.push(p); return }
    if (st.isDirectory()) {
      if (depth >= WALK_DEPTH) { skipped.push(p); return }
      const names = await fsp.readdir(p).catch(() => null)
      if (!names) { skipped.push(p); return }
      for (const n of names.sort()) {
        await walk(path.join(p, n), depth + 1)
        if (files.length >= CHECKSUM_FILE_CAP) return
      }
      return
    }
    // symlinks are hashed as their target's content (what `sha256sum` does);
    // a dangling one simply fails in the child and lands in `skipped`
    if (!st.isFile() && !st.isSymbolicLink()) { skipped.push(p); return }
    if (seen.has(p)) return
    seen.add(p)
    files.push(p)
  }
  for (const p of paths) {
    await walk(p, 0)
    if (files.length >= CHECKSUM_FILE_CAP) break
  }
  return { files, skipped }
}

function hashChunk(
  algo: ChecksumAlgo, root: string, rels: string[], r: Run,
): Promise<{ lines: string[]; failed: string[] }> {
  return new Promise(resolve => {
    let child: ChildProcess
    try {
      child = spawn(BIN[algo], ['--', ...rels], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (e) {
      resolve({ lines: [], failed: rels })
      void e
      return
    }
    r.children.add(child)
    let out = ''
    let err = ''
    child.stdout?.on('data', (d: Buffer) => { out += d.toString() })
    child.stderr?.on('data', (d: Buffer) => { if (err.length < 8192) err += d.toString() })
    const finish = (): void => {
      r.children.delete(child)
      const lines = out.split('\n').map(s => s.replace(/\r$/, '')).filter(Boolean)
      // coreutils keeps going after an unreadable file and reports it on stderr;
      // work out which names produced no line rather than trusting the exit code.
      // A name containing '\' or a newline comes back ESCAPED behind a leading
      // '\' — undo that or those files look like failures when they hashed fine
      // (the escaped form is what `-c` expects, so `lines` is kept verbatim).
      const got = new Set(lines.map(l => {
        const escaped = l.startsWith('\\')
        const name = l.slice(l.indexOf('  ') + 2)
        return escaped ? name.replace(/\\n/g, '\n').replace(/\\\\/g, '\\') : name
      }))
      const failed = rels.filter(rel => !got.has(rel))
      resolve({ lines, failed })
    }
    child.on('error', finish)
    child.on('close', finish)
  })
}

export async function checksumsRun(wc: WebContents, req: ChecksumRequest): Promise<ChecksumResult> {
  const algo: ChecksumAlgo = BIN[req.algo] ? req.algo : 'sha256'
  const runId = req.runId
  const r: Run = { cancelled: false, children: new Set() }
  runs.set(runId, r)
  try {
    const { files, skipped } = await collect(req.paths ?? [])
    const root = commonRoot(files)
    const result: ChecksumResult = {
      runId, algo, lines: [], root, files: files.length, skipped: [...skipped],
    }
    if (!files.length) return result
    if (files.length >= CHECKSUM_FILE_CAP) {
      result.skipped.push(`(stopped at the ${CHECKSUM_FILE_CAP}-file limit)`)
    }

    let done = 0
    let chunk: string[] = []
    let bytes = 0
    const flush = async (): Promise<void> => {
      if (!chunk.length || r.cancelled) return
      const current = chunk[0]
      const p: ChecksumProgress = { runId, done, total: files.length, current }
      if (!wc.isDestroyed()) wc.send(CHECKSUM_PROGRESS, p)
      const res = await hashChunk(algo, root, chunk, r)
      result.lines.push(...res.lines)
      for (const f of res.failed) result.skipped.push(path.join(root, f))
      done += chunk.length
      chunk = []
      bytes = 0
    }
    for (const f of files) {
      const rel = path.relative(root, f)
      chunk.push(rel)
      bytes += Buffer.byteLength(rel) + 1
      if (chunk.length >= CHUNK_FILES || bytes >= CHUNK_BYTES) await flush()
      if (r.cancelled) break
    }
    await flush()
    if (r.cancelled) result.cancelled = true
    if (!wc.isDestroyed()) {
      wc.send(CHECKSUM_PROGRESS, { runId, done: result.lines.length, total: files.length, current: '' })
    }
    return result
  } catch (e) {
    return {
      runId, algo, lines: [], root: '/', files: 0, skipped: [],
      error: String((e as Error)?.message ?? e),
    }
  } finally {
    runs.delete(runId)
  }
}

export function checksumsCancel(runId: number): void {
  const r = runs.get(runId)
  if (!r) return
  r.cancelled = true
  for (const c of r.children) { try { c.kill('SIGKILL') } catch { /* already gone */ } }
}

/** Write the sums beside the files they describe. 'wx' never clobbers an
 *  existing SHA256SUMS — a second run gets "SHA256SUMS (2)" rather than
 *  silently replacing a manifest the user may have been checking against. */
export async function checksumsSave(
  req: { dir: string; name: string; text: string },
): Promise<{ ok: boolean; path?: string; error?: string }> {
  const base = path.basename(req.name || 'SUMS').replace(/\//g, '_')
  for (let i = 1; i < 100; i++) {
    const p = path.join(req.dir, i === 1 ? base : `${base} (${i})`)
    try {
      await fsp.writeFile(p, req.text, { flag: 'wx' })
      return { ok: true, path: p }
    } catch (e) {
      const code = (e as NodeJS.ErrnoException)?.code
      if (code === 'EEXIST') continue
      if (code === 'EACCES' || code === 'EPERM') return { ok: false, error: 'You do not have permission to write there.' }
      if (code === 'EROFS') return { ok: false, error: 'That location is read-only.' }
      return { ok: false, error: String((e as Error)?.message ?? e) }
    }
  }
  return { ok: false, error: 'Too many files with that name.' }
}

// ------------------------------------------------------- self-registered IPC

ipcMain.handle(CH('checksumsRun'), (e, req: ChecksumRequest) => checksumsRun(e.sender, req))
ipcMain.handle(CH('checksumsCancel'), (_e, runId: number) => { checksumsCancel(runId) })
ipcMain.handle(CH('checksumsSave'), (_e, req: { dir: string; name: string; text: string }) => checksumsSave(req))
