// "Is there a better copy of this picture, and is it really the same picture?"
//
// The escalation is the one imagelab/upgrade.ts sets out, cheapest first: rewrite the URL, then
// read the page the image came from. The third rung — asking a reverse image search — is phase 3
// and is deliberately absent here, so nothing in this file touches a search engine or opens a
// window.
//
// THE HARD PART IS NOT FINDING CANDIDATES, IT IS REFUSING THEM. A candidate has to clear three
// independent bars before it is allowed to replace anything, and each one exists because of a
// measured failure:
//
//   1. It must not be a PLACEHOLDER. A download can be HTTP 200, a valid PNG, the right size, and
//      still be the host's "Picture Removed" notice — 44 of 914 files on one real job.
//   2. It must be THE SAME PICTURE. Bigger is not better if it is a different photograph, and a
//      CDN will happily answer a rewritten URL with something unrelated. dHash settles it.
//   3. It must be MEANINGFULLY BIGGER. An upscale is bigger and worse, and swapping a file for a
//      1% gain is churn, so the bar is a real area gain rather than any gain at all.
import * as path from 'node:path'
import { dHash, hamming, matchBanned } from './imghash'
import { BUILTIN_BANNED } from './banned'
import { rungVerdict } from './quality'
import { upgradeCandidates } from './upgrade'
import { fetchImage, fetchText } from './fetch'
import type { Candidate } from '../../shared/imagelab'
import { inspectImage, measure, type ImageFacts } from './inspect'
import { harvest, reverseUrlForFile } from './cbir'
import { nativeImage } from 'electron'

/** how different two fingerprints may be and still be "the same picture" */
const SAME_PICTURE_BITS = 10
/** a replacement has to be at least this much bigger by area to be worth the churn */
const MIN_AREA_GAIN = 1.2
/** never try more than this many URLs for one picture */
const MAX_CANDIDATES = 12

// Defined in shared/ so the renderer can see the same shape without importing from main/.
export type { Candidate, CandidateVerdict } from '../../shared/imagelab'

export interface BetterResult {
  ok: boolean
  current: ImageFacts
  /** the reverse-search page that produced the candidates, when one was used */
  searchUrl?: string
  /** Yandex asked for a captcha; the run stopped rather than paging into the block */
  captcha?: boolean
  /** the winner, or null when nothing cleared the bars */
  best: Candidate | null
  tried: Candidate[]
  /** set when the run stopped because nothing was leaving this machine */
  transportDown?: boolean
  error?: string
}

/**
 * Image URLs a page advertises for itself.
 *
 * `og:image` is the one worth having — it is what a site tells a link previewer to use, which is
 * nearly always the full-size original. srcset is second because its largest entry is usually the
 * biggest derived size rather than the master.
 */
export function imagesFromPage(html: string, pageUrl: string): string[] {
  const out: string[] = []
  const add = (u: string | undefined): void => {
    if (!u) return
    try {
      const abs = new URL(u, pageUrl).toString()
      if (/^https?:/i.test(abs) && !out.includes(abs)) out.push(abs)
    } catch { /* not a usable reference */ }
  }
  for (const re of [
    /<meta[^>]+property=["']og:image(?::secure_url)?["'][^>]+content=["']([^"']+)["']/gi,
    /<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/gi,
    /<meta[^>]+name=["']twitter:image["'][^>]+content=["']([^"']+)["']/gi,
    /<link[^>]+rel=["']image_src["'][^>]+href=["']([^"']+)["']/gi,
  ]) {
    for (const m of html.matchAll(re)) add(m[1])
  }
  // srcset: take the entry with the largest width descriptor
  for (const m of html.matchAll(/srcset=["']([^"']+)["']/gi)) {
    let bestUrl = ''
    let bestW = 0
    for (const part of m[1].split(',')) {
      const bits = part.trim().split(/\s+/)
      const w = Number((bits[1] || '').replace(/[wx]$/i, '')) || 0
      if (bits[0] && w >= bestW) { bestW = w; bestUrl = bits[0] }
    }
    add(bestUrl)
  }
  return out
}

/** fingerprint a downloaded buffer through the SAME pipeline inspect.ts uses (see banned.ts) */
function fingerprintBuffer(buf: Buffer): string {
  const img = nativeImage.createFromBuffer(buf)
  if (img.isEmpty()) return ''
  const small = img.resize({ width: 32, height: 32, quality: 'good' })
  const size = small.getSize()
  if (!size.width || !size.height) return ''
  // see inspect.ts — Electron types getBitmap() as void, but it returns a Buffer
  const data = small.getBitmap() as unknown as Buffer
  return dHash({ data, width: size.width, height: size.height, order: 'bgra' })
}

async function judge(url: string, origin: Candidate['origin'], current: ImageFacts, referer?: string): Promise<Candidate> {
  const c: Candidate = {
    url, origin, width: 0, height: 0, bytes: 0, contentType: '',
    fingerprint: '', distance: 64, verdict: 'unreadable', why: '',
  }
  const got = await fetchImage(url, referer)
  if (!got.ok || !got.body) {
    c.why = got.error ?? 'no answer'
    c.errorCode = got.error ?? ''
    if (got.transport) {
      c.transport = true
      c.why = 'the request never left this machine — ' + c.why
    }
    return c
  }
  c.bytes = got.body.length
  c.contentType = got.contentType

  const dims = await measure(url, got.body)
  c.width = dims.width
  c.height = dims.height
  const area = dims.width * dims.height
  if (!area) {
    // Never silently accept what cannot be measured — that inversion is what let a 0x0 WebP
    // through as though it had proved itself.
    c.why = 'the bytes arrived but could not be measured'
    return c
  }

  c.fingerprint = fingerprintBuffer(got.body)
  const banned = matchBanned(c.fingerprint, BUILTIN_BANNED)
  if (banned) {
    c.verdict = 'placeholder'
    c.why = `a known placeholder (${banned.label})`
    return c
  }

  c.distance = current.fingerprint && c.fingerprint ? hamming(current.fingerprint, c.fingerprint) : 64
  if (c.distance > SAME_PICTURE_BITS) {
    c.verdict = 'different-picture'
    c.why = `a different picture (${c.distance} bits apart)`
    return c
  }

  // judged against what WE have, since at this rung nobody has advertised a size for it
  const rung = rungVerdict({ advertisedW: current.width, advertisedH: current.height, realW: dims.width, realH: dims.height })
  if (rung.verdict === 'undersized') {
    c.verdict = 'smaller'
    c.why = `smaller than what you have (${dims.width}x${dims.height})`
    return c
  }

  const gain = area / (current.area || 1)
  if (gain < MIN_AREA_GAIN) {
    c.verdict = 'same-size'
    c.why = `no real gain (${dims.width}x${dims.height})`
    return c
  }
  c.verdict = 'better'
  c.why = `${dims.width}x${dims.height} — ${gain.toFixed(1)}x the pixels`
  return c
}

/**
 * Look for a better copy of `file`.
 *
 * `sourceUrl` is where this picture came from, if that is known — a URL you pasted, or one a later
 * phase found. `pageUrl` is the page it appeared on, which is worth reading for an og:image.
 * Without either there is nothing to rewrite and nothing to read, which is exactly the gap phase 3
 * fills.
 */
/**
 * Rung 3: ask a reverse image search what else exists.
 *
 * `otherSizes` first — that is Yandex's own "other sizes" picker for the picture we uploaded, so
 * every entry is BY DEFINITION the same image at another resolution, which is exactly the question
 * being asked. The per-result ladders come after, and they carry Yandex's CLAIMED dimensions, so
 * they are ordered biggest-claim-first and still have to prove themselves on arrival — a rung
 * advertising 4000px will happily serve a placeholder.
 */
async function searchCandidates(file: string): Promise<{
  urls: { url: string; origin: Candidate['origin'] }[]; searchUrl?: string; captcha?: boolean; error?: string
}> {
  const rev = await reverseUrlForFile(file)
  if (!rev.ok || !rev.url) return { urls: [], captcha: rev.captcha, error: rev.error }
  const serp = await harvest(rev.url)
  if (serp.captcha) return { urls: [], searchUrl: rev.url, captcha: true, error: serp.error }
  if (!serp.ok) return { urls: [], searchUrl: rev.url, error: serp.error }

  const urls: { url: string; origin: Candidate['origin'] }[] = []
  const push = (u: string): void => {
    if (u && !urls.some(x => x.url === u)) urls.push({ url: u, origin: 'search' })
  }
  for (const s of serp.otherSizes) push(s.url)
  for (const item of serp.items) for (const rung of item.sizes) push(rung.url)
  return { urls, searchUrl: rev.url }
}

export async function findBetter(
  file: string, sourceUrl?: string, pageUrl?: string, useSearch = false,
): Promise<BetterResult> {
  const current = await inspectImage(file)
  if (current.error) return { ok: false, current, best: null, tried: [], error: current.error }
  if (!current.area) {
    return { ok: false, current, best: null, tried: [], error: 'This picture could not be measured, so nothing can be compared against it.' }
  }

  const urls: { url: string; origin: Candidate['origin'] }[] = []
  const push = (url: string, origin: Candidate['origin']): void => {
    if (!url || urls.some(u => u.url === url) || urls.length >= MAX_CANDIDATES) return
    urls.push({ url, origin })
  }

  if (sourceUrl) {
    // the rewrites first: they are one request each and need no page
    for (const u of upgradeCandidates(sourceUrl)) push(u, 'rewrite')
    push(sourceUrl, 'given')
  }
  if (pageUrl) {
    const page = await fetchText(pageUrl)
    if (page.ok && page.text) {
      for (const u of imagesFromPage(page.text, pageUrl)) {
        for (const up of upgradeCandidates(u)) push(up, 'rewrite')
        push(u, 'page')
      }
    }
  }

  let searchUrl: string | undefined
  let captcha: boolean | undefined
  // The search rung is LAST and only on request: it costs a hidden window, an upload and a paced
  // page fetch, where the two above cost one GET each.
  if (useSearch && !urls.length) {
    const found = await searchCandidates(file)
    searchUrl = found.searchUrl
    captcha = found.captcha
    for (const u of found.urls) push(u.url, u.origin)
    if (!urls.length) {
      return { ok: false, current, best: null, tried: [], searchUrl, captcha, error: found.error ?? 'The search returned nothing.' }
    }
  }

  if (!urls.length) {
    return {
      ok: false, current, best: null, tried: [],
      error: 'Nothing to look at yet — this needs a source address for the picture, the page it came from, or a reverse image search.',
    }
  }

  const tried: Candidate[] = []
  let best: Candidate | null = null
  for (const { url, origin } of urls) {
    const c = await judge(url, origin, current, pageUrl)
    tried.push(c)
    // A transport failure means nothing is leaving the machine; walking the rest of the list would
    // mark every remaining candidate bad for a reason that has nothing to do with them.
    if (c.transport) {
      return { ok: false, current, best: null, tried, transportDown: true, error: c.why }
    }
    if (c.verdict !== 'better') continue
    if (!best || c.width * c.height > best.width * best.height) best = c
    // the rewrites are ordered biggest-first, so the first winner is usually the best there is
    if (origin === 'rewrite') break
  }
  return { ok: true, current, best, tried, searchUrl, captcha }
}

/** the name a replacement should take, keeping the original stem */
export function replacementName(original: string, contentType: string, url: string): string {
  const stem = path.basename(original, path.extname(original))
  const ct = contentType.toLowerCase()
  const ext = ct.includes('png') ? '.png'
    : ct.includes('webp') ? '.webp'
      : ct.includes('gif') ? '.gif'
        : ct.includes('avif') ? '.avif'
          : ct.includes('jpeg') || ct.includes('jpg') ? '.jpg'
            : path.extname(new URL(url).pathname) || '.jpg'
  return stem + ext
}
