// Archive create/extract via the file-roller CLI (installed: file-roller 43).
// Both run as queue operations in engine.ts with indeterminate progress
// (bytesTotal 0, itemsTotal = source count); the engine owns the Op object and
// hands us a narrow context. file-roller may show its own progress window —
// same behavior as Nemo's nemo-fileroller extension, accepted for v1.
//
//   compress: file-roller --add-to=<dest>/<name>.<ext> -- <sources...>
//   extract:  file-roller --extract-to=<dest> -- <archive>   (one spawn per archive)
import { spawn, type ChildProcess } from 'node:child_process'
import * as fsp from 'node:fs/promises'
import * as path from 'node:path'

/** What the engine exposes to archive operations. */
export interface ArchiveCtx {
  sources: string[]
  /** destination directory */
  dest: string
  format?: 'zip' | 'tar.gz' | '7z'
  isCancelled(): boolean
  setCurrent(file: string): void
  itemDone(): void
  fail(path: string, error: string): void
  /** engine kills/pauses this child on cancelOp/pauseOp */
  setChild(c: ChildProcess | null): void
}

const FORMAT_EXT: Record<string, string> = { zip: '.zip', 'tar.gz': '.tar.gz', '7z': '.7z' }

async function exists(p: string): Promise<boolean> {
  return fsp.lstat(p).then(() => true, () => false)
}

function tail(stderr: string): string {
  return stderr.trim().split('\n').slice(-3).join(' ').slice(0, 300)
}

function run(ctx: ArchiveCtx, args: string[]): Promise<{ code: number; stderr: string }> {
  return new Promise(resolve => {
    const child = spawn('file-roller', args, { stdio: ['ignore', 'ignore', 'pipe'] })
    ctx.setChild(child)
    let err = ''
    child.stderr?.on('data', d => { if (err.length < 65536) err += String(d) })
    child.on('error', e => {
      ctx.setChild(null)
      const noBin = (e as NodeJS.ErrnoException)?.code === 'ENOENT'
      resolve({ code: -1, stderr: noBin ? 'file-roller is not installed' : String(e) })
    })
    child.on('close', code => { ctx.setChild(null); resolve({ code: code ?? -1, stderr: err }) })
  })
}

/**
 * Create an archive in ctx.dest. Name: single source's basename (extension
 * stripped for files, kept whole for dirs), else 'Archive'; name collisions get
 * the Explorer ' (2)' suffix (lowest unused).
 */
export async function runCompress(ctx: ArchiveCtx): Promise<{ created?: string; error?: string }> {
  const ext = FORMAT_EXT[ctx.format ?? 'zip'] ?? '.zip'
  let stem = 'Archive'
  if (ctx.sources.length === 1) {
    const base = path.basename(ctx.sources[0])
    const isDir = await fsp.lstat(ctx.sources[0]).then(s => s.isDirectory(), () => false)
    if (isDir) stem = base
    else {
      const i = base.lastIndexOf('.')
      stem = i > 0 ? base.slice(0, i) : base
    }
  }
  let dest = path.join(ctx.dest, stem + ext)
  for (let i = 2; await exists(dest); i++) dest = path.join(ctx.dest, `${stem} (${i})${ext}`)

  ctx.setCurrent(dest)
  const r = await run(ctx, ['--add-to=' + dest, '--', ...ctx.sources])
  for (let i = 0; i < ctx.sources.length; i++) ctx.itemDone()
  if (ctx.isCancelled()) {
    await fsp.rm(dest, { force: true }).catch(() => {})   // never leave a partial archive
    return {}
  }
  if (r.code !== 0) {
    return { error: `Could not create "${path.basename(dest)}"${r.stderr ? ': ' + tail(r.stderr) : ` (file-roller exited with code ${r.code})`}` }
  }
  if (!await exists(dest)) return { error: `Could not create "${path.basename(dest)}"` }
  return { created: dest }
}

/**
 * Extract each source archive into ctx.dest; per-archive failures are
 * collected, not fatal. Caveat (measured): on a corrupt archive file-roller
 * shows its OWN error dialog and then exits 0 once dismissed — so a zero exit
 * does not guarantee success; file-roller's dialog is the user-facing error
 * surface in that case, and the op row stays 'running' until it is dismissed.
 * Nonzero exits (killed, crashed, missing binary) are still recorded here.
 */
export async function runExtract(ctx: ArchiveCtx): Promise<void> {
  for (const src of ctx.sources) {
    if (ctx.isCancelled()) return
    ctx.setCurrent(src)
    const r = await run(ctx, ['--extract-to=' + ctx.dest, '--', src])
    if (ctx.isCancelled()) return
    if (r.code !== 0) {
      ctx.fail(src, `Could not extract "${path.basename(src)}"${r.stderr ? ': ' + tail(r.stderr) : ` (file-roller exited with code ${r.code})`}`)
    }
    ctx.itemDone()
  }
}
