// The small tools: each one a single job, each one a shell-out to something
// platform/tools.ts has already found and reported on.
//
// They live together because they share exactly one thing — none of them is
// big enough to earn a module, and every one of them was previously impossible
// from the UI despite the machinery being present and paid for.
//
// Every write goes BESIDE the original with a free name, never over it. These
// are conveniences run from a menu, sometimes on a whole selection, and a
// convenience that overwrites is a convenience you have to think carefully
// before using — which defeats it.
import { ipcMain } from 'electron'
import { spawn } from 'node:child_process'
import * as fs from 'node:fs'
import * as fsp from 'node:fs/promises'
import * as path from 'node:path'
import { CH } from '../../shared/ipc'
import type { CleanupResult, ToolboxResult } from '../../shared/toolbox'
import { walkTree } from '../platform/treewalk'
import { resolveTools } from '../platform/tools'

/** run and keep stdout too — only the exiftool query needs the output */
function runOut(bin: string, args: string[], ms = 10 * 60_000): Promise<{ code: number; out: string }> {
  return new Promise(resolve => {
    let done = false
    const finish = (code: number, out: string): void => { if (!done) { done = true; resolve({ code, out }) } }
    try {
      const c = spawn(bin, args, { stdio: ['ignore', 'pipe', 'ignore'] })
      let out = ''
      c.stdout?.on('data', d => { out += String(d) })
      const t = setTimeout(() => { try { c.kill('SIGKILL') } catch { /* gone */ } finish(-1, out) }, ms)
      c.on('error', () => { clearTimeout(t); finish(-1, '') })
      c.on('close', code => { clearTimeout(t); finish(code ?? -1, out) })
    } catch { finish(-1, '') }
  })
}

function run(bin: string, args: string[], ms = 10 * 60_000): Promise<{ code: number; err: string }> {
  return new Promise(resolve => {
    let done = false
    const finish = (code: number, err: string): void => { if (!done) { done = true; resolve({ code, err }) } }
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

/** `name (2).ext`, `name (3).ext`… — never overwrite */
async function freeName(dir: string, base: string, ext: string): Promise<string> {
  let p = path.join(dir, `${base}${ext}`)
  for (let i = 2; fs.existsSync(p); i++) p = path.join(dir, `${base} (${i})${ext}`)
  return p
}

// -------------------------------------------------------------- cleanup

/**
 * Empty folders and broken symlinks — the two kinds of debris a file manager
 * can identify with certainty.
 *
 * Nothing is deleted here. It reports, and the user acts on the list in the
 * file view, because "empty" is a judgement (a folder holding only a
 * .gitkeep is not empty to its owner) and a tool that deletes on a judgement
 * is a tool that eventually deletes something wanted.
 */
export async function findCleanup(root: string): Promise<CleanupResult> {
  const out: CleanupResult = { ok: false, root, emptyDirs: [], brokenLinks: [] }
  if (!root?.startsWith('/')) return { ...out, error: 'Not a folder on this computer.' }

  const dirEntries = new Map<string, number>()
  await walkTree([root], {
    onDir: (dir, entries) => { dirEntries.set(dir, entries) },
    onFile: () => { /* counted by onDir's entry count */ },
    maxDirs: 8000,
  })
  for (const [dir, n] of dirEntries) if (n === 0 && dir !== root) out.emptyDirs.push(dir)

  // walkTree deliberately never follows links, so broken ones are found with a
  // separate shallow pass rather than by teaching the walker to chase them
  const stack = [root]
  let visited = 0
  while (stack.length && visited < 8000) {
    const dir = stack.pop()!
    visited++
    const ents = await fsp.readdir(dir, { withFileTypes: true }).catch(() => [])
    for (const e of ents) {
      const p = path.join(dir, e.name)
      if (e.isDirectory()) { stack.push(p); continue }
      if (!e.isSymbolicLink()) continue
      const target = await fsp.stat(p).catch(() => null)      // stat FOLLOWS the link
      if (!target) out.brokenLinks.push(p)
    }
  }
  out.ok = true
  return out
}

// ---------------------------------------------------------------- media

/** Pull the audio track out, without re-encoding it. */
export async function extractAudio(files: string[]): Promise<ToolboxResult> {
  const ff = resolveTools().ffmpeg
  if (!ff) return { ok: false, done: [], failed: [], error: 'This needs ffmpeg, which is not installed.' }
  const done: string[] = []
  const failed: { path: string; error: string }[] = []
  for (const f of files) {
    const dir = path.dirname(f)
    const base = path.basename(f, path.extname(f))
    // -vn drops video, -acodec copy keeps the original audio bytes: extracting
    // should not silently re-encode and lose quality. The container follows the
    // codec, so probe it rather than guessing .mp3 and producing a broken file.
    const codec = await audioCodec(f)
    if (!codec) { failed.push({ path: f, error: 'no audio track' }); continue }
    const ext = { aac: '.m4a', mp3: '.mp3', opus: '.opus', vorbis: '.ogg', flac: '.flac', ac3: '.ac3' }[codec] ?? '.mka'
    const out = await freeName(dir, base, ext)
    const r = await run(ff, ['-v', 'error', '-i', f, '-vn', '-acodec', 'copy', '-y', out])
    if (r.code === 0 && fs.existsSync(out)) done.push(out)
    else { failed.push({ path: f, error: r.err.split('\n').find(Boolean) || 'ffmpeg failed' }); await fsp.rm(out, { force: true }).catch(() => {}) }
  }
  return { ok: !!done.length, done, failed }
}

function audioCodec(file: string): Promise<string> {
  const probe = resolveTools().ffprobe
  if (!probe) return Promise.resolve('')
  return new Promise(resolve => {
    const c = spawn(probe, ['-v', 'error', '-select_streams', 'a:0',
      '-show_entries', 'stream=codec_name', '-of', 'default=nw=1:nk=1', '--', file],
    { stdio: ['ignore', 'pipe', 'ignore'] })
    let out = ''
    c.stdout.on('data', d => { out += String(d) })
    const t = setTimeout(() => { try { c.kill('SIGKILL') } catch { /* gone */ } resolve('') }, 15_000)
    c.on('error', () => { clearTimeout(t); resolve('') })
    c.on('close', () => { clearTimeout(t); resolve(out.trim()) })
  })
}

/**
 * Put the existing streams in an MP4 container without re-encoding.
 *
 * This is the cheap fix for the commonest "it will not play" case: the codecs
 * are fine and only the container is wrong (an MKV of h264+aac, say). Seconds
 * instead of an hour, and not one pixel is re-compressed.
 */
export async function remuxToMp4(files: string[]): Promise<ToolboxResult> {
  const ff = resolveTools().ffmpeg
  if (!ff) return { ok: false, done: [], failed: [], error: 'This needs ffmpeg, which is not installed.' }
  const done: string[] = []
  const failed: { path: string; error: string }[] = []
  for (const f of files) {
    const out = await freeName(path.dirname(f), path.basename(f, path.extname(f)), '.mp4')
    const r = await run(ff, ['-v', 'error', '-i', f, '-c', 'copy', '-movflags', '+faststart', '-y', out])
    if (r.code === 0 && fs.existsSync(out)) done.push(out)
    else {
      await fsp.rm(out, { force: true }).catch(() => {})
      failed.push({
        path: f,
        error: (r.err.split('\n').find(Boolean) || 'ffmpeg failed')
          + ' — the codecs may not fit in MP4, which needs a real conversion',
      })
    }
  }
  return { ok: !!done.length, done, failed }
}

// ------------------------------------------------------------- documents

/** Every picture into one PDF, in the order given. */
export async function imagesToPdf(files: string[]): Promise<ToolboxResult> {
  const conv = resolveTools().convert
  if (!conv.length) return { ok: false, done: [], failed: [], error: 'This needs ImageMagick, which is not installed.' }
  if (!files.length) return { ok: false, done: [], failed: [], error: 'No pictures selected.' }
  const dir = path.dirname(files[0])
  const out = await freeName(dir, path.basename(dir) || 'images', '.pdf')
  const r = await run(conv[0], [...conv.slice(1), ...files, out], 15 * 60_000)
  if (r.code !== 0 || !fs.existsSync(out)) {
    await fsp.rm(out, { force: true }).catch(() => {})
    return { ok: false, done: [], failed: files.map(f => ({ path: f, error: r.err.split('\n')[0] || 'convert failed' })) }
  }
  return { ok: true, done: [out], failed: [] }
}

/** Every page of a PDF as a PNG, into a folder beside it. */
export async function pdfToImages(files: string[]): Promise<ToolboxResult> {
  const pdftoppm = resolveTools().pdftoppm
  if (!pdftoppm) return { ok: false, done: [], failed: [], error: 'This needs poppler-utils, which is not installed.' }
  const done: string[] = []
  const failed: { path: string; error: string }[] = []
  for (const f of files) {
    const base = path.basename(f, path.extname(f))
    let dir = path.join(path.dirname(f), `${base} pages`)
    for (let i = 2; fs.existsSync(dir); i++) dir = path.join(path.dirname(f), `${base} pages (${i})`)
    await fsp.mkdir(dir, { recursive: true })
    const r = await run(pdftoppm, ['-png', '-r', '150', '--', f, path.join(dir, 'page')], 15 * 60_000)
    const made = (await fsp.readdir(dir).catch(() => [])).length
    if (r.code === 0 && made) done.push(dir)
    else {
      await fsp.rm(dir, { recursive: true, force: true }).catch(() => {})
      failed.push({ path: f, error: r.err.split('\n').find(Boolean) || 'pdftoppm produced nothing' })
    }
  }
  return { ok: !!done.length, done, failed }
}

// -------------------------------------------------------------- archives

/** `7z t` — does this archive still read back? */
export async function testArchives(files: string[]): Promise<ToolboxResult> {
  const z = resolveTools().sevenZip
  if (!z) return { ok: false, done: [], failed: [], error: 'This needs 7-Zip, which is not installed.' }
  const done: string[] = []
  const failed: { path: string; error: string }[] = []
  for (const f of files) {
    const r = await run(z, ['t', '--', f], 30 * 60_000)
    if (r.code === 0) done.push(f)
    else failed.push({ path: f, error: r.err.split('\n').find(Boolean) || 'failed the integrity test' })
  }
  return { ok: !failed.length, done, failed }
}

// ------------------------------------------------------------------ exif

/**
 * Set each file's modified time from the date the photo was taken.
 *
 * Cameras and phones write the real date into EXIF, while copying, syncing and
 * unzipping all rewrite the filesystem timestamp — which is why a folder of
 * holiday photos so often sorts by "the day I copied them". exiftool knows the
 * tag and can write the file time from it in one pass.
 */
export async function datesFromExif(files: string[]): Promise<ToolboxResult> {
  const et = resolveTools().exiftool
  if (!et) {
    return { ok: false, done: [], failed: [], error: 'This needs exiftool, which is not installed (see Options ▸ System).' }
  }
  // WHICH files actually carry a date, asked first.
  //
  // This used to write and then report `done: files` — every input, whatever
  // happened. A picture with no DateTimeOriginal is left completely untouched
  // by exiftool, so running this over a folder of screenshots reported
  // "Dated 500 files" while changing nothing at all. A no-op reported as a
  // success is worse than an error, because nobody goes back to check.
  const ask = await runOut(et, ['-m', '-q', '-q', '-p', '$FilePath', '-if', '$DateTimeOriginal', '--', ...files], 5 * 60_000)
  const dated = ask.out.split('\n').map(l => l.trim()).filter(l => l.startsWith('/'))
  const undated = files.filter(f => !dated.includes(f))

  if (!dated.length) {
    return {
      ok: false, done: [],
      failed: undated.map(path => ({ path, error: 'no date recorded in it' })),
      error: 'None of these carry an EXIF date to copy.',
    }
  }

  // -overwrite_original: exiftool would otherwise leave a _original copy of
  // every picture beside it, which on a photo library is a silent doubling
  const r = await run(et, ['-overwrite_original', '-P', '-FileModifyDate<DateTimeOriginal', '--', ...dated], 15 * 60_000)
  if (r.code !== 0) {
    return { ok: false, done: [], failed: [{ path: dated[0] ?? '', error: r.err.split('\n').find(Boolean) || 'exiftool failed' }] }
  }
  return {
    ok: true,
    done: dated,
    failed: undated.map(path => ({ path, error: 'no date recorded in it' })),
  }
}

ipcMain.handle(CH('findCleanup'), (_e, root: string) => findCleanup(root))
ipcMain.handle(CH('extractAudio'), (_e, files: string[]) => extractAudio(files ?? []))
ipcMain.handle(CH('remuxToMp4'), (_e, files: string[]) => remuxToMp4(files ?? []))
ipcMain.handle(CH('imagesToPdf'), (_e, files: string[]) => imagesToPdf(files ?? []))
ipcMain.handle(CH('pdfToImages'), (_e, files: string[]) => pdfToImages(files ?? []))
ipcMain.handle(CH('testArchives'), (_e, files: string[]) => testArchives(files ?? []))
ipcMain.handle(CH('datesFromExif'), (_e, files: string[]) => datesFromExif(files ?? []))
