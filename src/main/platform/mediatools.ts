// Per-item media actions from the viewer's menu: grab a frame, convert a gif.
//
// These exist because the viewer is the only place in the app that knows WHICH
// frame you are looking at. A tool that re-opens the file and guesses a
// timestamp is a different, worse feature; "save this frame" only means
// anything while the frame is on screen, so the action belongs to the menu that
// is open over it.
//
// Everything here is LOCAL. No part of this module reaches the network, which
// is what lets it work with no configuration and no privacy question at all —
// the outbound half of the media menu (reverse search) is deliberately a
// separate path with its own consent.
//
// Self-registered IPC, so main/ipc.ts and preload.ts stay untouched — the same
// pattern platform/mediawindow.ts uses. It must be imported from main/index.ts
// or the handlers never run; bin/check-ipc.mjs catches that.
import { BrowserWindow, clipboard, ipcMain, nativeImage, shell } from 'electron'
import { spawn } from 'node:child_process'
import * as fsp from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { CH, PUSH } from '../../shared/ipc'
import { resolveTools } from './tools'
import { listBrowsers, openUrlWith } from './apps'
import type { AppCandidate } from '../../shared/types'

/** ffmpeg gets a deadline: a damaged file can make it sit forever on one frame */
const FRAME_TIMEOUT = 30_000
const CONVERT_TIMEOUT = 10 * 60_000

interface Ran { ok: boolean; err: string }

function run(bin: string, args: string[], timeout: number): Promise<Ran> {
  return new Promise(resolve => {
    let done = false
    const finish = (ok: boolean, err: string): void => { if (!done) { done = true; resolve({ ok, err }) } }
    try {
      const c = spawn(bin, args, { stdio: ['ignore', 'ignore', 'pipe'] })
      let errText = ''
      // keep only the tail: ffmpeg's banner is thousands of lines and the
      // useful message is always the last one
      c.stderr.on('data', d => { errText = (errText + String(d)).slice(-2000) })
      const t = setTimeout(() => { try { c.kill('SIGKILL') } catch { /* gone */ } finish(false, 'It took too long and was stopped.') }, timeout)
      c.on('error', e => { clearTimeout(t); finish(false, String((e as Error)?.message ?? e)) })
      c.on('close', code => {
        clearTimeout(t)
        if (code === 0) { finish(true, ''); return }
        const last = errText.trim().split('\n').pop() ?? ''
        finish(false, last || `ffmpeg exited with ${code}.`)
      })
    } catch (e) { finish(false, String((e as Error)?.message ?? e)) }
  })
}

/**
 * A name that does not overwrite anything.
 *
 * Saving a frame or converting a gif must never land on top of an existing
 * file. Both actions are things people repeat — three frames from the same
 * clip, the same gif converted twice — so a fixed name would silently destroy
 * the previous result.
 */
async function freeName(dir: string, stem: string, ext: string): Promise<string> {
  for (let i = 0; i < 1000; i++) {
    const name = i === 0 ? `${stem}.${ext}` : `${stem} (${i}).${ext}`
    const full = path.join(dir, name)
    try { await fsp.stat(full) } catch { return full }
  }
  return path.join(dir, `${stem} (${Date.now()}).${ext}`)
}

export interface FrameResult { ok: boolean; path?: string; error?: string }

/** Write the frame at `seconds` out as a PNG beside the source. */
export async function saveFrame(file: string, seconds: number): Promise<FrameResult> {
  if (!file?.startsWith('/')) return { ok: false, error: 'That is not a file on this computer.' }
  const ff = resolveTools().ffmpeg
  if (!ff) return { ok: false, error: 'This needs ffmpeg, which is not installed.' }
  const dir = path.dirname(file)
  const stem = path.basename(file, path.extname(file))
  const at = Number.isFinite(seconds) && seconds > 0 ? seconds : 0
  const out = await freeName(dir, `${stem} frame ${at.toFixed(1)}s`, 'png')
  // -ss BEFORE -i seeks by keyframe and is fast; the extra -ss after it makes
  // the seek exact, which matters because the whole promise is "this frame"
  const r = await run(ff, [
    '-v', 'error', '-nostdin',
    '-ss', String(Math.max(0, at - 2)), '-i', file, '-ss', String(Math.min(2, at)),
    '-frames:v', '1', '-y', out,
  ], FRAME_TIMEOUT)
  if (!r.ok) return { ok: false, error: r.err }
  try { await fsp.stat(out) } catch { return { ok: false, error: 'ffmpeg reported success but wrote nothing.' } }
  return { ok: true, path: out }
}

export interface ConvertResult { ok: boolean; path?: string; saved?: number; error?: string }

/**
 * Re-encode a gif as H.264 or VP9.
 *
 * `-vf` pads to even dimensions because H.264 cannot encode an odd width or
 * height, and gifs are frequently odd — without it this fails on a large
 * fraction of real files with a message nobody can act on.
 *
 * `-loop 0` on WebM keeps the looping behaviour a gif has; MP4 has no loop flag
 * and the player decides, which the viewer already does for short clips.
 */
export async function gifToVideo(file: string, format: 'mp4' | 'webm'): Promise<ConvertResult> {
  if (!file?.startsWith('/')) return { ok: false, error: 'That is not a file on this computer.' }
  if (path.extname(file).toLowerCase() !== '.gif') return { ok: false, error: 'That is not a gif.' }
  const ff = resolveTools().ffmpeg
  if (!ff) return { ok: false, error: 'This needs ffmpeg, which is not installed.' }
  let before = 0
  try { before = (await fsp.stat(file)).size } catch { return { ok: false, error: 'That file could not be read.' } }

  const dir = path.dirname(file)
  const stem = path.basename(file, path.extname(file))
  const out = await freeName(dir, stem, format)
  const args = format === 'mp4'
    ? ['-v', 'error', '-nostdin', '-i', file,
       '-movflags', 'faststart', '-pix_fmt', 'yuv420p',
       '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2',
       '-c:v', 'libx264', '-crf', '20', '-preset', 'slow', '-y', out]
    : ['-v', 'error', '-nostdin', '-i', file,
       '-c:v', 'libvpx-vp9', '-crf', '32', '-b:v', '0', '-row-mt', '1', '-loop', '0', '-y', out]
  const r = await run(ff, args, CONVERT_TIMEOUT)
  if (!r.ok) return { ok: false, error: r.err }
  let after = 0
  try { after = (await fsp.stat(out)).size } catch { return { ok: false, error: 'ffmpeg reported success but wrote nothing.' } }
  // report the saving only when there is one: VP9 on a tiny gif can be bigger,
  // and claiming a saving that did not happen is worse than saying nothing
  const saved = before > 0 && after < before ? Math.round((1 - after / before) * 100) : 0
  return { ok: true, path: out, saved }
}

/**
 * Show a file in the app itself, selected.
 *
 * `shell.openPath(folder)` was what the viewer used, and it is the wrong verb:
 * it hands the FOLDER to whatever file manager the desktop prefers, which then
 * opens it scrolled to the top with nothing highlighted — so having asked
 * "where is this file", the user arrives somewhere they still have to search.
 * This lands the app's own window on the folder with the item selected.
 */
ipcMain.handle(CH('revealPath'), (_e, file: string) => {
  if (!file?.startsWith('/')) return false
  const dir = path.dirname(file)
  const win = BrowserWindow.getAllWindows().find(w => !w.isDestroyed() && w.webContents.getURL().includes('renderer/index.html'))
  if (!win) return false
  win.webContents.send(PUSH.openPathRequest, { path: dir, select: file })
  if (win.isMinimized()) win.restore()
  win.focus()
  return true
})

ipcMain.handle(CH('mediaSaveFrame'), (_e, file: string, seconds: number) => saveFrame(file, Number(seconds) || 0))
ipcMain.handle(CH('mediaGifToVideo'), (_e, file: string, format: string) =>
  gifToVideo(file, format === 'webm' ? 'webm' : 'mp4'))

// ---------------------------------------------------------- looking it up

/**
 * Handing a search to the DEFAULT BROWSER, which is the whole privacy design.
 *
 * Nothing here opens a socket. The app extracts a frame, puts it on the
 * clipboard, and asks the desktop to open a search page; the request that
 * actually reaches the internet is made by the browser, under whatever setup
 * the user already trusts. That is why this path needs no proxy, no VPN
 * configuration and no exception to the app's own network rules — there is no
 * app traffic to route.
 *
 * `shell.openExternal` with a renderer-supplied string is a real hole: it hands
 * an arbitrary URI to the desktop, and on Linux that reaches every registered
 * scheme handler, not just browsers. So the renderer never supplies a URL. It
 * names an engine from this table, and the query is encoded here.
 */
interface Engine {
  label: string
  /**
   * Reverse-image entry point. ABSENT means this site has no reverse image
   * search — DuckDuckGo does not have one, and offering it was offering
   * something that does not exist.
   */
  image?: (o: SearchOpts) => string
  /** plain web search for text */
  text?: (q: string, o: SearchOpts) => string
}

export interface SearchOpts {
  /** switch the site's own content filter off */
  unfiltered: boolean
  /** which Yandex front door: they are separate indexes, not translations */
  yandexDomain: string
}

/**
 * Yandex has several front doors and they return DIFFERENT results for the same
 * picture — they are separate indexes, not localisations of one. Which one to
 * ask is therefore a real choice, not a cosmetic one.
 *
 * Kept as an allowlist because the domain reaches a URL builder: an arbitrary
 * string here would let a caller point the "search" at any host it liked.
 */
export const YANDEX_DOMAINS = ['yandex.com', 'yandex.ru', 'yandex.com.tr', 'yandex.by', 'yandex.kz', 'yandex.uz', 'yandex.eu', 'ya.ru']

function yandexHost(d: string): string {
  return YANDEX_DOMAINS.includes(d) ? d : 'yandex.com'
}

/**
 * Turning each site's content filter OFF.
 *
 * These are ordinary search preferences, and every one of them is a documented
 * parameter the site's own settings page sets. They matter here for a dull
 * reason rather than an interesting one: a filter hides results, and this
 * feature exists to find a bigger copy of a picture the user already has. A
 * hidden result is a copy not found.
 *
 *   Google     safe=off
 *   Bing       adlt=off
 *   DuckDuckGo kp=-2
 *   Yandex     fyandex=0, plus nomisspell/noreask so it answers the question
 *              that was asked rather than one it preferred
 *   TinEye     has no filter; sort=size is what actually helps, because the
 *              whole point is the biggest copy
 */
const ENGINES = new Map<string, Engine>(Object.entries({
  lens: {
    label: 'Google Lens',
    // the bare host shows the upload/paste target; /search does not
    image: () => 'https://lens.google.com/',
    text: (q, o) => `https://www.google.com/search?q=${encodeURIComponent(q)}${o.unfiltered ? '&safe=off' : ''}`,
  },
  yandex: {
    label: 'Yandex',
    // rpt=imageview is the reverse-image mode; without it this is a text page
    image: (o) => `https://${yandexHost(o.yandexDomain)}/images/search?rpt=imageview`
      + (o.unfiltered ? '&fyandex=0&nomisspell=1&noreask=1' : ''),
    text: (q, o) => `https://${yandexHost(o.yandexDomain)}/search/?text=${encodeURIComponent(q)}`
      + (o.unfiltered ? '&fyandex=0&nomisspell=1&noreask=1' : ''),
  },
  tineye: {
    label: 'TinEye',
    // its home page IS the upload target; sorting by size is the useful default
    image: () => 'https://tineye.com/?sort=size&order=desc',
  },
  bing: {
    label: 'Bing',
    image: (o) => `https://www.bing.com/visualsearch${o.unfiltered ? '?adlt=off' : ''}`,
    text: (q, o) => `https://www.bing.com/search?q=${encodeURIComponent(q)}${o.unfiltered ? '&adlt=off' : ''}`,
  },
  ddg: {
    label: 'DuckDuckGo',
    // no image entry: DuckDuckGo has no reverse image search
    text: (q, o) => `https://duckduckgo.com/?q=${encodeURIComponent(q)}${o.unfiltered ? '&kp=-2' : ''}`,
  },
} as Record<string, Engine>))

export function searchEngines(): { id: string; label: string; image: boolean; text: boolean }[] {
  return [...ENGINES].map(([id, e]) => ({ id, label: e.label, image: !!e.image, text: !!e.text }))
}

export interface OpenResult { ok: boolean; engine?: string; url?: string; error?: string }

/**
 * Build the URL and DO NOT open it.
 *
 * Split out because the alternative is testing the launcher, and testing the
 * launcher means launching: a check of "what URL does Yandex get" opened nine
 * tabs in the developer's real browser, because an unknown app id correctly
 * falls back to the desktop default and the desktop default is a browser that
 * was already running. Anything that only needs to know the address asks this.
 */
export function searchUrlFor(engine: string, mode: 'image' | 'text', query: string, o: SearchOpts): OpenResult {
  const e = ENGINES.get(engine)
  if (!e) return { ok: false, error: 'That is not a search site this app knows.' }
  if (mode === 'image') {
    if (!e.image) return { ok: false, error: `${e.label} has no reverse image search.` }
    return { ok: true, engine: e.label, url: e.image(o) }
  }
  if (!e.text) return { ok: false, error: `${e.label} cannot search for text.` }
  const q = String(query ?? '').slice(0, 300).trim()
  if (!q) return { ok: false, error: 'There is nothing to search for.' }
  return { ok: true, engine: e.label, url: e.text(q, o) }
}

/** Open an engine's reverse-image page. The picture travels via the clipboard. */
export async function openImageSearch(engine: string, o: SearchOpts, appId?: string): Promise<OpenResult> {
  const e = ENGINES.get(engine)
  if (!e) return { ok: false, error: 'That is not a search site this app knows.' }
  if (!e.image) return { ok: false, error: `${e.label} has no reverse image search.` }
  const url = e.image(o)
  try { await openUrlWith(url, appId) } catch (err) {
    return { ok: false, error: String((err as Error)?.message ?? err) }
  }
  return { ok: true, engine: e.label, url }
}

/** Open a plain web search for some text — a filename, usually. Nothing uploaded. */
export async function openTextSearch(engine: string, query: string, o: SearchOpts, appId?: string): Promise<OpenResult> {
  const e = ENGINES.get(engine)
  if (!e) return { ok: false, error: 'That is not a search site this app knows.' }
  if (!e.text) return { ok: false, error: `${e.label} cannot search for text.` }
  const q = String(query ?? '').slice(0, 300).trim()
  if (!q) return { ok: false, error: 'There is nothing to search for.' }
  const url = e.text(q, o)
  try { await openUrlWith(url, appId) } catch (err) {
    return { ok: false, error: String((err as Error)?.message ?? err) }
  }
  return { ok: true, engine: e.label, url }
}

/**
 * Put a picture on the clipboard so it can be pasted into a search page.
 *
 * For a video or a gif this is a frame, extracted first. nativeImage decodes
 * PNG and JPEG only — not WebP, not AVIF, not gif — so anything else is
 * converted through ffmpeg on the way rather than failing silently with an
 * empty image, which is what a straight createFromPath would do.
 */
export async function copyPictureToClipboard(file: string, seconds?: number): Promise<FrameResult> {
  if (!file?.startsWith('/')) return { ok: false, error: 'That is not a file on this computer.' }
  const ext = path.extname(file).toLowerCase()
  let src = file
  let temp = ''
  if (ext !== '.png' && ext !== '.jpg' && ext !== '.jpeg') {
    const ff = resolveTools().ffmpeg
    if (!ff) return { ok: false, error: 'This needs ffmpeg, which is not installed.' }
    temp = path.join(os.tmpdir(), `liqexplorer-frame-${process.pid}-${Date.now()}.png`)
    const at = Number.isFinite(seconds) && (seconds as number) > 0 ? (seconds as number) : 0
    const args = at > 0
      ? ['-v', 'error', '-nostdin', '-ss', String(at), '-i', file, '-frames:v', '1', '-y', temp]
      : ['-v', 'error', '-nostdin', '-i', file, '-frames:v', '1', '-y', temp]
    const r = await run(ff, args, FRAME_TIMEOUT)
    if (!r.ok) return { ok: false, error: r.err }
    src = temp
  }
  try {
    const img = nativeImage.createFromPath(src)
    if (img.isEmpty()) return { ok: false, error: 'That picture could not be read.' }
    clipboard.writeImage(img)
  } catch (e) {
    return { ok: false, error: String((e as Error)?.message ?? e) }
  } finally {
    if (temp) { try { await fsp.unlink(temp) } catch { /* tmp, it can stay */ } }
  }
  // the source, never `src`: a temp frame has already been deleted by here, and
  // handing back the name of a file that no longer exists invites a caller to use it
  return { ok: true, path: file }
}

/**
 * The browsers on this machine, for the "send it to…" picker.
 *
 * Deduplicated by NAME: Chrome ships two desktop entries that both claim https
 * (`com.google.Chrome.desktop` and `google-chrome.desktop`), so the raw list
 * offers "Google Chrome" twice and the user cannot tell which is which. The
 * default-marked entry wins, otherwise the first.
 */
export async function listSearchBrowsers(): Promise<AppCandidate[]> {
  const all = await listBrowsers()
  const byName = new Map<string, AppCandidate>()
  for (const a of all) {
    const seen = byName.get(a.name)
    if (!seen || (a.isDefault && !seen.isDefault)) byName.set(a.name, a)
  }
  return [...byName.values()]
}

ipcMain.handle(CH('mediaSearchEngines'), () => searchEngines())
ipcMain.handle(CH('mediaSearchPreview'), (_e, engine: string, mode: string, q: string, o: SearchOpts) =>
  searchUrlFor(String(engine), mode === 'text' ? 'text' : 'image', String(q ?? ''), opts(o)))
ipcMain.handle(CH('mediaSearchBrowsers'), () => listSearchBrowsers())
ipcMain.handle(CH('mediaOpenImageSearch'), (_e, engine: string, o: SearchOpts, appId?: string) =>
  openImageSearch(String(engine), opts(o), appId ? String(appId) : undefined))
ipcMain.handle(CH('mediaOpenTextSearch'), (_e, engine: string, q: string, o: SearchOpts, appId?: string) =>
  openTextSearch(String(engine), String(q), opts(o), appId ? String(appId) : undefined))
ipcMain.handle(CH('mediaCopyPicture'), (_e, file: string, seconds?: number) =>
  copyPictureToClipboard(file, Number(seconds) || 0))

/** never trust the shape that arrives over IPC */
function opts(o: unknown): SearchOpts {
  const r = (o ?? {}) as Partial<SearchOpts>
  return { unfiltered: r.unfiltered !== false, yandexDomain: yandexHost(String(r.yandexDomain ?? '')) }
}
