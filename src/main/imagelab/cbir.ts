// Turning a LOCAL picture into a reverse-image search.
//
// This is the rung phases 1 and 2 cannot reach. A local file cannot be handed to
// `rpt=imageview&url=…` because this machine is not publicly reachable, so the bytes have to be
// uploaded — and Yandex's old upload endpoint (`/images-apphost/image-download`) now answers
// `400 Incorrect avatar size`. Rather than chase parameters out of a webpack chunk, the working
// route is to drive Yandex's OWN uploader in a hidden window: put the file on the page's
// `input[type=file]` through CDP, let their JavaScript do whatever it currently does, and read the
// `cbir_id` URL it navigates to. When they change the handshake, their own page changes with it.
//
// After that it is plain HTTP again. A SERP ships its whole result set as JSON in one attribute,
// so harvesting is `fetch` + `parseSerp`, not a browser full of DOM.
//
// THREE THINGS THAT LOOK LIKE "NO RESULTS" AND ARE NOT:
//   * The uploader lands on `tabInt=1`, the "about this image" tab, which has NO serpList.
//     normalizeReverseUrl forces `cbir_page=similar`; without it the answer is 0 items, no error.
//   * A captcha renders as an ordinary layout with no images. Undetected, it is indistinguishable
//     from a search that ran and found nothing — so it stops the run rather than paging deeper.
//   * Pacing is what keeps a run alive at all. Yandex counts per IP and cannot see windows or
//     tabs, so every request in this process goes through ONE queue.
import { BrowserWindow, session } from 'electron'
import * as path from 'node:path'
import { fetchText } from './fetch'
import { isCaptcha, normalizeReverseUrl, parseSerp, type SerpResult } from './vendor/yandex'

/** gap between SERP requests, jittered — measured as what keeps a harvest alive */
const PACE_MS = 900
const PACE_JITTER_MS = 400
/** the hidden window gets this long to complete the upload handshake */
const UPLOAD_TIMEOUT_MS = 45_000
/**
 * How long to keep looking for the upload control before giving up on it.
 *
 * Measured, and the reason this is a poll rather than a query: `loadURL` resolves when the document
 * has loaded, but the input is created by Yandex's own JavaScript afterwards. A cold run took 3.6 s
 * and found it; the very next run, with the page cached, reached the query in 281 ms and reported
 * "Yandex may have changed it" — the same code, the same site, a different answer purely because it
 * arrived early. A one-shot query makes this feature fail intermittently and blame the far end.
 */
const INPUT_WAIT_MS = 15_000
const INPUT_POLL_MS = 250
/** partition kept separate from the app's own browsing state, but persistent so cookies stick */
const PARTITION = 'persist:imagelab'

let lastRequestAt = 0

/**
 * One queue for the whole process.
 *
 * Not per window, not per search: the far end counts requests per IP address, so two searches
 * running at once would double the rate while looking perfectly reasonable from inside the app.
 */
async function paced<T>(fn: () => Promise<T>): Promise<T> {
  const gap = PACE_MS + Math.floor(Math.random() * PACE_JITTER_MS)
  const wait = Math.max(0, lastRequestAt + gap - Date.now())
  if (wait) await new Promise(r => setTimeout(r, wait))
  lastRequestAt = Date.now()
  return fn()
}

export interface CbirResult {
  ok: boolean
  /** the normalised reverse-search URL, once the handshake has produced one */
  url?: string
  error?: string
  captcha?: boolean
}

/**
 * Upload `file` through Yandex's own uploader and return the reverse-search URL.
 *
 * The window is never shown. It is torn down in a `finally` — a leaked hidden BrowserWindow holds
 * a renderer process and a session for the life of the app, and nothing on screen would say so.
 */
export async function reverseUrlForFile(file: string, domain = 'yandex.com'): Promise<CbirResult> {
  if (!file.startsWith('/')) return { ok: false, error: 'Not a file on this computer.' }

  const win = new BrowserWindow({
    show: false,
    webPreferences: {
      partition: PARTITION,
      // this window renders a third-party page: it gets no preload, no node, and no access to
      // anything this app owns
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      javascript: true,
    },
  })

  try {
    const wc = win.webContents
    await wc.loadURL(`https://${domain}/images/`)

    // CDP is how a file reaches an <input type=file> without a real click: there is no other way
    // to set one programmatically, by design.
    let debuggerAttached = false
    try {
      wc.debugger.attach('1.3')
      debuggerAttached = true
    } catch (e) {
      return { ok: false, error: `could not drive the uploader: ${String((e as Error)?.message ?? e)}` }
    }

    try {
      const html = await wc.executeJavaScript('document.documentElement.outerHTML').catch(() => '')
      if (typeof html === 'string' && isCaptcha(html, wc.getURL())) {
        return { ok: false, captcha: true, error: 'Yandex is asking for a captcha.' }
      }

      // The document is re-fetched every poll on purpose: nodeIds are invalidated whenever the DOM
      // is rebuilt, and this page rebuilds itself while it settles.
      let inputNodeId = 0
      const until = Date.now() + INPUT_WAIT_MS
      for (;;) {
        try {
          const { root } = await wc.debugger.sendCommand('DOM.getDocument', { depth: -1 }) as { root: { nodeId: number } }
          const found = await wc.debugger.sendCommand('DOM.querySelector', {
            nodeId: root.nodeId, selector: 'input[type=file]',
          }) as { nodeId: number }
          if (found?.nodeId) { inputNodeId = found.nodeId; break }
        } catch { /* the DOM moved under us; the next poll re-reads it */ }
        if (Date.now() >= until) break
        await new Promise(r => setTimeout(r, INPUT_POLL_MS))
      }
      if (!inputNodeId) {
        return { ok: false, error: 'The upload control never appeared — Yandex may have changed the page.' }
      }

      // the navigation this triggers IS the answer; watch for it before setting the file
      const landed = new Promise<string>((resolve) => {
        const timer = setTimeout(() => resolve(''), UPLOAD_TIMEOUT_MS)
        const onNav = (_e: unknown, url: string): void => {
          if (!/cbir_id=/.test(url)) return
          clearTimeout(timer)
          wc.off('did-navigate', onNav)
          wc.off('did-navigate-in-page', onNav)
          resolve(url)
        }
        wc.on('did-navigate', onNav)
        wc.on('did-navigate-in-page', onNav)
      })

      await wc.debugger.sendCommand('DOM.setFileInputFiles', { nodeId: inputNodeId, files: [file] })
      const url = await landed
      if (!url) return { ok: false, error: 'The upload did not produce a search — it may have been rejected.' }

      // tabInt=1 has no serpList; this is the line that makes the difference between 40 results
      // and a silent zero
      return { ok: true, url: normalizeReverseUrl(url) }
    } finally {
      if (debuggerAttached) { try { wc.debugger.detach() } catch { /* already gone */ } }
    }
  } catch (e) {
    return { ok: false, error: String((e as Error)?.message ?? e) }
  } finally {
    try { win.destroy() } catch { /* already gone */ }
  }
}

/**
 * Fetch and parse one reverse-search page.
 *
 * Plain HTTP on purpose: the whole result set is in the page's `data-state` attribute, so one GET
 * is about thirty results with no layout engine involved.
 */
export async function harvest(url: string): Promise<SerpResult & { ok: boolean; error?: string }> {
  const empty = {
    ok: false, captcha: false, items: [], otherSizes: [], related: [],
    hasNext: false, nextPage: null, region: '', empty: true,
  }
  const got = await paced(() => fetchText(normalizeReverseUrl(url)))
  if (!got.ok || !got.text) return { ...empty, error: got.error ?? 'no answer from Yandex' }
  if (isCaptcha(got.text, url)) return { ...empty, captcha: true, error: 'Yandex is asking for a captcha.' }
  try {
    const parsed = parseSerp(got.text, url)
    return { ...parsed, ok: true }
  } catch (e) {
    return { ...empty, error: String((e as Error)?.message ?? e) }
  }
}

/** cookies for this feature live in their own partition; this is how a caller clears them */
export function clearImagelabSession(): Promise<void> {
  return session.fromPartition(PARTITION).clearStorageData()
}

/** for logs and error messages */
export function fileLabel(file: string): string {
  return path.basename(file)
}
