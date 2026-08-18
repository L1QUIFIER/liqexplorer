// Landing a better copy on disk — and the IPC the app talks to imagelab through.
//
// NOTHING HERE DELETES ANYTHING. The better copy is written BESIDE the original as
// "name (better).jpg", verified after it lands, and that is where this stops. Swapping the files is
// left to the app's ordinary trash and rename, which are already queued through the ops engine and
// already on the undo stack — so "replace" costs one Ctrl+Z to take back, and this module never
// has to grow a destructive path of its own.
//
// The verification after the write is not ceremony. The bytes were judged in memory; what matters
// is what reached the disk, and this app's files live on a CIFS share where a write can fail long
// after it appeared to succeed.
import { ipcMain, nativeImage } from 'electron'
import type { IpcMainInvokeEvent } from 'electron'
import * as fsp from 'node:fs/promises'
import * as path from 'node:path'
import { CH } from '../../shared/ipc'
import { clearImagelabSession } from './cbir'
import { fetchImage } from './fetch'
import { findBetter, replacementName, type BetterResult, type Candidate } from './better'
import { inspectImage, measure, worthUpgrading } from './inspect'

export interface SaveResult {
  ok: boolean
  /** where the better copy landed */
  file?: string
  width?: number
  height?: number
  bytes?: number
  error?: string
}

/** a name that does not collide, keeping the original stem: "cat (better).jpg", then " (better 2)" */
async function freeName(dir: string, base: string): Promise<string> {
  const ext = path.extname(base)
  const stem = path.basename(base, ext)
  for (let i = 0; i < 500; i++) {
    const name = i === 0 ? `${stem} (better)${ext}` : `${stem} (better ${i + 1})${ext}`
    const full = path.join(dir, name)
    try {
      await fsp.access(full)
    } catch {
      return full
    }
  }
  return path.join(dir, `${stem} (better ${Date.now()})${ext}`)
}

/**
 * Download `candidate` and write it beside `original`.
 *
 * Re-fetched rather than carried over from the judging pass: holding every candidate's bytes in
 * memory to save one request is how a batch over a folder of photographs turns into a gigabyte of
 * heap.
 */
export async function saveBetter(original: string, candidate: Candidate, referer?: string): Promise<SaveResult> {
  if (!original.startsWith('/')) return { ok: false, error: 'Not a file on this computer.' }
  const got = await fetchImage(candidate.url, referer)
  if (!got.ok || !got.body) {
    return { ok: false, error: got.error ?? 'That copy could not be downloaded a second time.' }
  }
  const dir = path.dirname(original)
  const target = await freeName(dir, replacementName(original, got.contentType, candidate.url))
  try {
    await fsp.writeFile(target, got.body)
  } catch (e) {
    return { ok: false, error: String((e as Error)?.message ?? e) }
  }
  // what actually landed, not what was promised
  const dims = await measure(target)
  if (!dims.width || !dims.height) {
    await fsp.rm(target, { force: true }).catch(() => {})
    return { ok: false, error: 'What landed could not be measured, so it was removed again.' }
  }
  const st = await fsp.stat(target).catch(() => null)
  return { ok: true, file: target, width: dims.width, height: dims.height, bytes: st?.size ?? got.body.length }
}

/**
 * The origin URL a downloaded file remembers, when anything bothered to record one.
 *
 * `user.xdg.origin.url` is the freedesktop convention, and the share here does support user
 * extended attributes — but measured on this machine, NOTHING sets it: neither Firefox nor Chrome
 * on Linux writes it, so no existing download carries one. It is read anyway because it costs one
 * syscall and is the only way a local file can name its own source without being asked, and
 * because anything this app saves in future can set it.
 */
export async function originUrl(file: string): Promise<{ url: string; page: string }> {
  const read = async (attr: string): Promise<string> => {
    try {
      // node has no xattr API; getfattr is in attr(1), present on every desktop
      const { execFile } = await import('node:child_process')
      return await new Promise<string>(resolve => {
        execFile('getfattr', ['--only-values', '-n', attr, '--', file], { timeout: 4000 }, (err, out) => {
          resolve(err ? '' : String(out).trim())
        })
      })
    } catch { return '' }
  }
  const [url, page] = await Promise.all([
    read('user.xdg.origin.url'),
    read('user.xdg.referrer.url'),
  ])
  return { url: /^https?:/i.test(url) ? url : '', page: /^https?:/i.test(page) ? page : '' }
}

ipcMain.handle(CH('imageInspect'), async (_e: IpcMainInvokeEvent, file: string) => {
  const facts = await inspectImage(file)
  const origin = await originUrl(file)
  return { ...facts, worth: worthUpgrading(facts), origin }
})

ipcMain.handle(CH('imageFindBetter'), async (
  _e, file: string, sourceUrl?: string, pageUrl?: string, useSearch?: boolean,
): Promise<BetterResult> => {
  // fall back to whatever the file remembers about itself
  if (!sourceUrl && !pageUrl) {
    const o = await originUrl(file)
    return findBetter(file, o.url || undefined, o.page || undefined, !!useSearch)
  }
  return findBetter(file, sourceUrl, pageUrl, !!useSearch)
})

/**
 * A candidate rendered small enough to hand the renderer as a `data:` URL.
 *
 * The renderer's CSP allows `img-src ... data:` and nothing remote, deliberately — so a candidate
 * cannot simply be dropped into an <img src>. That restriction is worth keeping: it is what stops a
 * search result's URL from becoming a request this app makes on the user's behalf just by rendering.
 *
 * Downscaled to PREVIEW_MAX so a 6000px candidate does not cross the IPC boundary as a 20 MB
 * base64 string. WebP falls back to the original bytes, because `nativeImage` cannot decode it —
 * but Blink in the renderer can, so the picture still appears.
 */
const PREVIEW_MAX = 480
const PREVIEW_RAW_CAP = 4 * 1024 * 1024

ipcMain.handle(CH('imagePreview'), async (_e, url: string, referer?: string): Promise<{
  ok: boolean; dataUrl?: string; width?: number; height?: number; error?: string
}> => {
  const got = await fetchImage(url, referer)
  if (!got.ok || !got.body) return { ok: false, error: got.error ?? 'that copy could not be downloaded' }
  const img = nativeImage.createFromBuffer(got.body)
  if (img.isEmpty()) {
    // WebP (and anything else nativeImage will not touch) — pass the bytes through untouched
    if (got.body.length > PREVIEW_RAW_CAP) return { ok: false, error: 'too large to preview' }
    const type = got.contentType.split(';')[0] || 'image/webp'
    return { ok: true, dataUrl: `data:${type};base64,${got.body.toString('base64')}` }
  }
  const { width, height } = img.getSize()
  const scaled = Math.max(width, height) > PREVIEW_MAX
    ? img.resize(width >= height ? { width: PREVIEW_MAX } : { height: PREVIEW_MAX })
    : img
  return { ok: true, dataUrl: scaled.toDataURL(), width, height }
})

/**
 * Throw away the cookies this feature has collected.
 *
 * The search runs in its own `persist:imagelab` partition, so this touches nothing the user browses
 * with. It is offered on the captcha path because a stuck session cookie is the one cause of a
 * persistent block that is fixable from this side — the far end mostly counts by address, which no
 * button here can change.
 */
ipcMain.handle(CH('imagelabForget'), async (): Promise<{ ok: boolean }> => {
  await clearImagelabSession().catch(() => {})
  return { ok: true }
})

ipcMain.handle(CH('imageSaveBetter'), (_e, file: string, candidate: Candidate, referer?: string) =>
  saveBetter(file, candidate, referer))
