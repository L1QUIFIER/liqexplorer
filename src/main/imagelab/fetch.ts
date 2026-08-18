// Fetching a candidate image, with the two headers that decide whether it arrives at all.
//
// **Referer.** `session.fetch(url, { headers: { Referer } })` is CANCELLED by Chromium's network
// delegate before it leaves — ERR_BLOCKED_BY_CLIENT, with one "Cancelling request … with invalid
// referrer" line on stderr. fetch's standard `referrer` field is accepted but sends NO HEADER AT
// ALL. Only `net.request({ referrerPolicy })` plus `setHeader('Referer', …)` actually puts one on
// the wire (verified against a live echo host). Any main-process fetch aimed at a hotlink-protected
// CDN is otherwise dead on arrival, and it fails looking exactly like an ad blocker.
//
// **Accept.** A browsing session advertises `image/webp` and `image/avif`, so hosts
// content-negotiate WebP even for a `.jpg` URL — Wikipedia does. That is precisely the format this
// feature is trying to get AWAY from, and the one `nativeImage` cannot decode. Asking for JPEG and
// PNG first is free and avoids the whole problem at the source.
import { net } from 'electron'
import { isTransportDown } from './transport'

/** never pull more than this for one candidate; a "picture" bigger than this is not one */
const MAX_BYTES = 40 * 1024 * 1024
const TIMEOUT_MS = 30_000

/** JPEG and PNG first, on purpose — see the Accept note above. */
const ACCEPT = 'image/jpeg,image/png,image/*;q=0.8,*/*;q=0.5'

export interface FetchedImage {
  ok: boolean
  url: string
  /** the URL that actually answered, after redirects */
  finalUrl: string
  status: number
  contentType: string
  body: Buffer | null
  /** true when the failure was our own route out rather than the remote host */
  transport: boolean
  error?: string
}

/**
 * GET an image.
 *
 * `referer` is the page the image was found on. Hotlink-protected hosts refuse without it and
 * serve a placeholder — or a 403 — with it absent, so it is worth carrying even though it is a
 * nuisance to set.
 */
export function fetchImage(url: string, referer?: string): Promise<FetchedImage> {
  const base: FetchedImage = {
    ok: false, url, finalUrl: url, status: 0, contentType: '', body: null, transport: false,
  }
  if (!/^https?:\/\//i.test(url)) {
    return Promise.resolve({ ...base, error: 'Not an http(s) address.' })
  }

  return new Promise(resolve => {
    let done = false
    const finish = (v: FetchedImage): void => { if (!done) { done = true; resolve(v) } }

    let req: Electron.ClientRequest
    try {
      req = net.request({
        method: 'GET',
        url,
        // the ONLY combination that puts a cross-origin Referer on the wire
        referrerPolicy: 'no-referrer-when-downgrade',
        redirect: 'follow',
      })
    } catch (e) {
      finish({ ...base, error: String((e as Error)?.message ?? e) })
      return
    }

    req.setHeader('Accept', ACCEPT)
    req.setHeader('User-Agent',
      'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36')
    if (referer) {
      try { req.setHeader('Referer', referer) } catch { /* malformed; go without */ }
    }

    const timer = setTimeout(() => {
      try { req.abort() } catch { /* already gone */ }
      // Our own deadline counts as transport evidence, in the weaker class. A blackholed proxy
      // produces no error of its own — it accepts the connection and then relays nothing, ever —
      // so silence is the only symptom there is. One slow host times out too, which is why this
      // needs a streak across several hosts before it means anything.
      finish({ ...base, error: 'net::ERR_TIMED_OUT (the server did not answer in time)', transport: true })
    }, TIMEOUT_MS)

    req.on('response', (res) => {
      const status = res.statusCode ?? 0
      const type = String(res.headers['content-type'] ?? '')
      const chunks: Buffer[] = []
      let total = 0
      res.on('data', (c: Buffer) => {
        total += c.length
        if (total > MAX_BYTES) {
          try { req.abort() } catch { /* gone */ }
          clearTimeout(timer)
          finish({ ...base, status, contentType: type, error: 'that image is larger than this will accept' })
          return
        }
        chunks.push(c)
      })
      res.on('end', () => {
        clearTimeout(timer)
        const body = Buffer.concat(chunks)
        finish({
          ok: status >= 200 && status < 300 && body.length > 0,
          url,
          finalUrl: (res as unknown as { url?: string }).url || url,
          status,
          contentType: type,
          body: body.length ? body : null,
          transport: false,
          error: status >= 200 && status < 300 ? undefined : `the server answered ${status}`,
        })
      })
      res.on('error', (e: Error) => {
        clearTimeout(timer)
        finish({ ...base, status, error: String(e?.message ?? e), transport: isTransportDown(e) })
      })
    })

    req.on('error', (e: Error) => {
      clearTimeout(timer)
      // A transport failure means the request never left this machine. The caller must stop
      // consuming its queue rather than march on marking items failed — one dead tunnel once
      // marked 5,132 images bad and reported the job done.
      finish({ ...base, error: String(e?.message ?? e), transport: isTransportDown(e) })
    })

    try { req.end() } catch (e) {
      clearTimeout(timer)
      finish({ ...base, error: String((e as Error)?.message ?? e) })
    }
  })
}

/** GET a page as text — for reading og:image out of the page an image was found on. */
export function fetchText(url: string, referer?: string): Promise<{ ok: boolean; text: string; error?: string }> {
  return fetchImage(url, referer).then(r => ({
    ok: r.ok,
    text: r.body ? r.body.toString('utf8') : '',
    error: r.error,
  }))
}
