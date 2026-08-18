'use strict'
/**
 * The pure half of the Yandex image rig: build the URLs, parse the results. No Electron, no Node
 * APIs, no I/O — so `scripts/test-yandex.mjs` can exercise every branch against saved fixtures.
 *
 * The regexes for consent / captcha / family filter are transcribed from LiqBrowser's
 * `src/shared/yandex.ts`, Cyrillic alternatives included. Those alternatives are not decoration:
 * yandex.com geo-redirects, so a search started from an English URL routinely lands on a
 * Russian-language page, and an English-only regex silently matched nothing — which looks exactly
 * like "the banner never appeared". Do not translate or dedupe them.
 *
 * ── How the results are actually obtained ───────────────────────────────────────────────────────
 *
 * A Yandex image SERP ships its entire result set as JSON inside ONE attribute:
 *
 *     <div class="Root" id="ImagesApp-…" data-state="{&quot;initialState&quot;:{…}}">
 *
 * and `initialState.serpList.items` is `{keys:[id…], entities:{id→item}}`. Each item carries a
 * Yandex-hosted `thumb` (small, fast, never hotlink-blocked), the third-party `img_href` (the
 * original), a `dups` list of alternate sizes, and the source page snippet. That is everything the
 * grid and the stage need, which is why this rig reads the SERP over plain HTTP instead of
 * rendering it: 30 results cost one ~400 KB document and no layout engine, so thousands of
 * thumbnails are a few seconds of paging rather than a browser full of DOM.
 *
 * Verified against live SERPs 2026-08-12 (yandex.com through the nl-ams exit).
 */

/* ── Domains ──────────────────────────────────────────────────────────────────────────────────── */

const YANDEX_DOMAINS = ['yandex.com', 'yandex.ru', 'yandex.com.tr', 'yandex.by', 'yandex.kz', 'yandex.uz', 'yandex.eu', 'ya.ru']

const YANDEX_HOST_RE = /(?:^|\.)(?:yandex\.com\.tr|yandex\.(?:ru|com|by|kz|uz|eu)|ya\.ru)$/i

function cleanHost(host) {
  return String(host == null ? '' : host).trim().toLowerCase().replace(/^\[|\]$/g, '').replace(/:\d+$/, '').replace(/\.$/, '')
}

function isYandexHost(host) {
  return YANDEX_HOST_RE.test(cleanHost(host))
}

/**
 * A domain safe to put in a URL we are about to fetch. Anything unrecognised collapses to
 * `yandex.com` rather than being interpolated — these builders take values derived from
 * page-observable state, and `https://${whatever}/images/search` would otherwise be an open
 * redirect dressed up as a helper.
 */
function safeDomain(domain) {
  return yandexRegistrableDomain(domain) || 'yandex.com'
}

/**
 * The registrable domain a Yandex host belongs to — `images.yandex.com.tr` → `yandex.com.tr`, and
 * `''` for anything that is not Yandex.
 *
 * This is the COOKIE SCOPE, and therefore the key the family-filter setting has to be tracked
 * under: a "no filter" preference saved on yandex.ru says nothing whatsoever about yandex.com, so
 * compare mode has to set it twice. `com.tr` is a public suffix, so the naive "last two labels"
 * split would produce the useless `com.tr` — hence the explicit table rather than counting dots.
 */
function yandexRegistrableDomain(host) {
  const m = /(?:^|\.)(yandex\.com\.tr|yandex\.(?:ru|com|by|kz|uz|eu)|ya\.ru)$/.exec(cleanHost(host))
  return (m && m[1]) || ''
}

/* ── URL building ─────────────────────────────────────────────────────────────────────────────── */

/**
 * Params that switch the family filter off and stop Yandex quietly answering a different question
 * than the one asked.
 *
 * - `fyandex=0`  — family filter off for THIS query. The persistent setting lives at /tune/search
 *   and is per-registrable-domain (a preference set on yandex.ru says nothing about yandex.com.tr),
 *   so the per-query param is the one that works on a cold session and on every front door at once.
 * - `nomisspell=1` — do not "correct" the spelling. Yandex silently searching a word you did not
 *   type is indistinguishable, in a grid of thumbnails, from the search being bad.
 * - `noreask=1` — do not substitute a reformulated query for the same reason.
 */
const UNFILTERED_PARAMS = { fyandex: '0', nomisspell: '1', noreask: '1' }

/**
 * Every narrowing filter Yandex's advanced panel can put on a URL — read off
 * `initialState.advancedSearch.filters.order` on a live SERP.
 *
 * "Unfiltered mode" strips these as well as switching the family filter off, because a filter the
 * user did not set is the other half of "why am I only seeing forty pictures".
 */
const NARROWING_PARAMS = ['isize', 'iorient', 'type', 'icolor', 'itype', 'recent', 'site', 'iw', 'ih']

/**
 * Build an image-search URL.
 *
 * `page` is Yandex's `p`, zero-based, ~30 results each. `unfiltered` applies UNFILTERED_PARAMS and
 * drops NARROWING_PARAMS; without it, whatever the caller passed in `filters` is preserved so the
 * filtered/unfiltered comparison is a real one.
 */
function buildSearchUrl({ domain = 'yandex.com', text = '', page = 0, unfiltered = false, filters = null } = {}) {
  const u = new URL(`https://${safeDomain(domain)}/images/search`)
  if (text) u.searchParams.set('text', text)
  if (page > 0) u.searchParams.set('p', String(page))
  if (filters) {
    for (const [k, v] of Object.entries(filters)) {
      if (v == null || v === '') continue
      if (unfiltered && NARROWING_PARAMS.includes(k)) continue
      u.searchParams.set(k, String(v))
    }
  }
  if (unfiltered) for (const [k, v] of Object.entries(UNFILTERED_PARAMS)) u.searchParams.set(k, v)
  return u.toString()
}

/**
 * Reverse image search for a URL Yandex can fetch itself. `rpt=imageview` is what makes Yandex treat
 * `url` as an image to look up rather than a text query.
 *
 * The caller is responsible for the image being publicly reachable — a `file://` path, a
 * a private-LAN host or `localhost` is not, and handing one over produces an empty result page that
 * looks like a broken feature. See `isUnreachableByRemote`.
 */
function buildReverseUrl({ domain = 'yandex.com', imageUrl = '', unfiltered = false } = {}) {
  const u = new URL(`https://${safeDomain(domain)}/images/search`)
  u.searchParams.set('rpt', 'imageview')
  u.searchParams.set('url', imageUrl)
  u.searchParams.set('cbir_page', 'similar')
  if (unfiltered) for (const [k, v] of Object.entries(UNFILTERED_PARAMS)) u.searchParams.set(k, v)
  return u.toString()
}

/**
 * Force a reverse-image URL onto the tab that actually contains a grid of images.
 *
 * A `cbir` search has several tabs, and the SERP only carries `serpList` for ONE of them. Yandex's
 * own uploader hands back `…&cbir_id=…&tabInt=1`, which is the "about this image" tab: sites that
 * host it, other sizes, no result grid. Parsed, that page yields **zero items** and is
 * indistinguishable from a search that found nothing — which is exactly how it presented, as
 * drag-and-drop appearing to do nothing at all despite the upload having succeeded.
 *
 * Measured on one uploaded image, same `cbir_id`, everything else equal:
 *   `tabInt=1` → 0 items · no parameter → 0 items · `cbir_page=similar` → **40 items + 5 tags**
 *
 * So every reverse URL this app harvests goes through here first. `tabInt` is dropped rather than
 * left alongside, because the two disagree about which tab is wanted.
 */
function normalizeReverseUrl(url) {
  let u
  try {
    u = new URL(String(url))
  } catch {
    return String(url)
  }
  if (!/\/images\/(?:touch\/)?search/.test(u.pathname)) return u.toString()
  const isReverse = u.searchParams.get('rpt') === 'imageview' || u.searchParams.has('cbir_id')
  if (!isReverse) return u.toString()
  u.searchParams.delete('tabInt')
  u.searchParams.set('cbir_page', 'similar')
  return u.toString()
}

/** Yandex's search-preferences page, where the persistent family filter lives. */
/**
 * Absolute link to a result on Yandex itself.
 *
 * `detail_url` arrives relative and hostless (`/images/search?pos=0&img_url=…&rpt=simage`), so it
 * has to be joined to the front door the result actually came from — pasting a bare path is useless,
 * and joining it to the wrong domain silently opens a different index.
 */
function yandexResultUrl(domain, detailUrl) {
  const d = String(detailUrl || '')
  if (!d) return ''
  if (/^https?:\/\//i.test(d)) return d
  return `https://${safeDomain(domain)}${d.startsWith('/') ? '' : '/'}${d}`
}

function buildTuneUrl(domain) {
  return `https://${safeDomain(domain)}/tune/search`
}

/**
 * Can a remote server fetch this URL? Anything private, loopback or non-http is a definite no, and
 * a reverse search on one is guaranteed to come back empty — better to say so than to run it.
 */
function isUnreachableByRemote(url) {
  let u
  try {
    u = new URL(url)
  } catch {
    return true
  }
  if (!/^https?:$/.test(u.protocol)) return true
  const h = cleanHost(u.hostname)
  if (h === 'localhost' || h.endsWith('.local') || h.endsWith('.localhost')) return true
  if (/^127\./.test(h) || h === '::1') return true
  if (/^10\./.test(h)) return true
  if (/^192\.168\./.test(h)) return true
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(h)) return true
  if (/^169\.254\./.test(h)) return true
  return false
}

/* ── The family filter at /tune/search ───────────────────────────────────────────────────────── */

/**
 * The "no filter" option. VERBATIM from the Home Screen extension's `ensureNoFilter`.
 *
 * `отключить` = "turn off"; `без ограничений` = "no restrictions" and is what the page actually
 * ships today. The Cyrillic alternatives are not decoration — yandex.com geo-redirects, so a session
 * on a CIS exit gets the Russian page and an English-only regex silently matches nothing, which
 * looks exactly like "the setting would not save".
 */
const NO_FILTER_RE = /без ограничений|no filter|no restrictions|отключить/i

/** The two restricted modes, used to READ the current setting rather than to set it. */
const MODERATE_RE = /умеренный поиск|умеренн|moderate search|moderate filter/i
const FAMILY_RE = /семейный режим|семейн|family mode|family (?:search|filter)/i

/** The Save button. Yandex ships it as `Сохранить` / `Save`. */
const TUNE_SAVE_RE = /сохранить|save/i

/** Consent controls, which sit over the settings page and swallow the click that follows. */
const CONSENT_CLICKABLE_SELECTOR =
  'button,[role="button"],.button,dialog a,[role="dialog"] a,[role="alertdialog"] a,[aria-modal="true"] a'
const CONSENT_ACCEPT_RE = /разрешить все|allow all|принять все|accept all/i

/** The one page whose radios this app may click. Anchored: /tune/geo and /tune/adv also have radios. */
const TUNE_PATH_RE = /^\/tune\/search(?:\/|$)/i

/** Filter states, in the order the page lists them. `unknown` means "not measured", never "off". */
const FILTER_STATES = ['none', 'moderate', 'family']

/** Classify one radio's label text into a filter state. Null when it is not a filter radio at all. */
function filterStateOfLabel(text) {
  const s = String(text || '')
  // Order matters: "no filter" must be tested before the restricted modes, because a page that
  // lists all three in one blob would otherwise match whichever regex came first.
  if (NO_FILTER_RE.test(s)) return 'none'
  if (FAMILY_RE.test(s)) return 'family'
  if (MODERATE_RE.test(s)) return 'moderate'
  return null
}

/* ── Captcha / rate limiting ──────────────────────────────────────────────────────────────────── */

const CAPTCHA_PATH_RE = /\/showcaptcha/i
const CAPTCHA_DOM_RE = /class="[^"]*(?:CheckboxCaptcha|SmartCaptcha|AdvancedCaptcha)|id="checkbox-captcha-form"|captcha__image/i
const CAPTCHA_TEXT_RE =
  /подтвердите, что запросы отправляли вы|вы не робот|you.?re not a robot|confirm.{0,20}not a robot|nos ha llegado un/i

/**
 * Is this response the rate limit rather than a result page?
 *
 * A captcha page renders as an ordinary Yandex layout with no images in it, so without this the
 * user sees "no results" for a search that was never run — the single most misleading failure this
 * rig can have, and the reason the harvester stops dead on it instead of paging on.
 *
 * The URL test is decisive on its own (a redirect to /showcaptcha IS the rate limit, whatever the
 * body looks like). The body test deliberately requires captcha-SHAPED MARKUP as well as the text:
 * results pages are full of third-party titles and snippets, and a result ABOUT captchas is still a
 * result.
 */
function isCaptcha(html, finalUrl) {
  if (finalUrl && CAPTCHA_PATH_RE.test(String(finalUrl))) return true
  const s = String(html || '')
  return CAPTCHA_DOM_RE.test(s) && CAPTCHA_TEXT_RE.test(s)
}

/* ── SERP parsing ─────────────────────────────────────────────────────────────────────────────── */

/** Undo the HTML entity escaping Yandex applies to the JSON it puts in an attribute. */
function unescapeAttr(s) {
  return String(s)
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
}

/**
 * Pull the ImagesApp state blob out of a SERP.
 *
 * A page carries several `data-state` attributes (the header and the footer have their own); the
 * one that matters is whichever contains `img_href`. Selecting by "largest" instead picks the app
 * shell on some layouts and returns zero results with no error — this is content-addressed for
 * that reason.
 */
function extractState(html) {
  const s = String(html || '')
  const re = /data-state="([^"]*)"/g
  let m
  while ((m = re.exec(s))) {
    if (m[1].indexOf('img_href') === -1) continue
    try {
      return JSON.parse(unescapeAttr(m[1]))
    } catch {
      /* a truncated or re-shaped blob is not fatal — keep looking */
    }
  }
  return null
}

/** Yandex omits the scheme on its own avatar URLs (`//avatars.mds…`). */
function absolutize(u) {
  const s = String(u || '')
  if (!s) return ''
  if (s.startsWith('//')) return 'https:' + s
  return s
}

function biggest(list) {
  let best = null
  for (const d of list || []) {
    if (!d || !d.url) continue
    const area = (Number(d.w) || 0) * (Number(d.h) || 0)
    if (!best || area > best.area) best = { area, url: absolutize(d.url), w: Number(d.w) || 0, h: Number(d.h) || 0, bytes: Number(d.fileSizeInBytes) || 0 }
  }
  return best
}

/**
 * Every copy of one image Yandex knows about, largest first.
 *
 * This is what "download the best quality" needs. Yandex's own viewer shows a list of sizes for a
 * result, and the biggest entry is regularly a dead link — the original host has moved or 404'd,
 * while a smaller mirror still serves. So this returns the whole ladder rather than a single best
 * pick, and the downloader walks DOWN it until something actually decodes.
 *
 * `w`/`h` are Yandex's claims, not measurements: an entry advertising 4000px can serve a placeholder.
 * Callers must verify the bytes they get (see `pickBestImage` in main.js).
 */
function sizeLadder(vd, ent, thumb) {
  const out = []
  const seen = new Set()
  const add = (url, w, h, bytes) => {
    const u = absolutize(url)
    if (!u || seen.has(u)) return
    seen.add(u)
    out.push({ url: u, w: Number(w) || 0, h: Number(h) || 0, bytes: Number(bytes) || 0 })
  }

  // The original as the SERP states it — dimensions come from the entity, not the dup list.
  add(vd.img_href || ent.origUrl || ent.url, ent.origWidth || ent.width, ent.origHeight || ent.height, 0)
  for (const d of vd.dups || []) add(d.url, d.w, d.h, d.fileSizeInBytes)
  for (const p of vd.preview || []) add(p.url, p.w, p.h, p.fileSizeInBytes)
  add(thumb, (vd.thumb && vd.thumb.w) || 0, (vd.thumb && vd.thumb.h) || 0, 0)

  // Largest claimed area first; an unknown size sorts last rather than first, because "no dimensions"
  // is far more often a thumbnail than a master.
  out.sort((a, b) => b.w * b.h - a.w * a.h)
  return out
}

/**
 * One result, flattened to what the UI needs.
 *
 * `sources` is the ordered fallback chain for the big stage and for saving, and it is the reason
 * the stage rarely goes blank: `img_href` is a third-party original that may be 403, dead, or
 * hotlink-blocked, whereas the Yandex `thumb` always loads. Trying the original first and degrading
 * to something that works beats showing a broken-image icon over a result that plainly exists.
 */
function flattenItem(id, ent) {
  const vd = (ent && ent.viewerData) || {}
  const snip = vd.snippet || ent.snippet || {}
  const thumb = absolutize((vd.thumb && vd.thumb.url) || (ent.image && ent.image.url) || '')
  const dup = biggest(vd.dups)
  const sizes = sizeLadder(vd, ent, thumb)

  return {
    id: String(id),
    thumb,
    /** Ordered candidates for the full-size view; the UI walks these on error. */
    sources: sizes.map((s) => s.url),
    /** The same candidates WITH their claimed dimensions — what quality selection works from. */
    sizes,
    width: Number(ent.origWidth || ent.width || (dup && dup.w) || 0),
    height: Number(ent.origHeight || ent.height || (dup && dup.h) || 0),
    bytes: (dup && dup.bytes) || 0,
    title: String(snip.title || ent.alt || '').trim(),
    text: String(snip.text || '').replace(/<[^>]*>/g, '').trim(),
    /** The page the image was found on — what "open source page" and attribution need. */
    pageUrl: String(snip.url || ''),
    domain: String(snip.domain || ''),
    /**
     * Yandex's own viewer link for THIS result, relative (`/images/search?pos=…&img_url=…`).
     * Absolutised by `yandexResultUrl` — it is the deep link back to the picture on the site,
     * as opposed to a fresh reverse search for it.
     */
    detailUrl: String(vd.detail_url || ''),
  }
}

/**
 * Parse one SERP into results plus everything needed to keep going.
 *
 * Returns `{items, related, hasNext, nextPage, captcha, region, empty}`. `related` is the
 * subcategory material — Yandex's own "people also search for" chips, which is the cheapest way to
 * go sideways into an adjacent gallery without inventing queries.
 */
function parseSerp(html, finalUrl) {
  if (isCaptcha(html, finalUrl)) {
    return { captcha: true, items: [], related: [], hasNext: false, nextPage: null, region: '', empty: false }
  }
  const state = extractState(html)
  const init = (state && state.initialState) || null
  if (!init || !init.serpList) {
    return { captcha: false, items: [], related: [], hasNext: false, nextPage: null, region: '', empty: true, unparsed: !state }
  }
  const sl = init.serpList
  const keys = (sl.items && sl.items.keys) || []
  const ents = (sl.items && sl.items.entities) || {}
  const items = []
  for (const k of keys) {
    const e = ents[k]
    if (!e) continue
    const f = flattenItem(k, e)
    if (f.thumb || f.sources.length) items.push(f)
  }

  const related = []
  const seen = new Set()
  const addRelated = (textVal, url) => {
    const t = String(textVal || '').trim()
    if (!t || seen.has(t.toLowerCase())) return
    seen.add(t.toLowerCase())
    related.push({ text: t, url: String(url || '') })
  }
  for (const r of (init.related && (init.related.data || init.related.redesignData)) || []) {
    addRelated(r && (r.text || r.title || r.query), r && (r.url || r.link))
  }
  for (const r of (init.popularRequestList && init.popularRequestList.requests) || []) {
    addRelated(r && (r.text || r.title || r.query), r && (r.url || r.link))
  }
  for (const r of (init.advancedSearch && init.advancedSearch.tags && init.advancedSearch.tags.items) || []) {
    addRelated(r && (r.text || r.title), r && r.url)
  }
  // Reverse-image searches put their "looks like this" chips somewhere else entirely.
  for (const r of (init.cbirTags && (init.cbirTags.tags || init.cbirTags.items)) || []) {
    addRelated(r && (r.text || r.title || r.query), r && r.url)
  }

  /**
   * The "other sizes" ladder for the image a REVERSE search was run on.
   *
   * This is the list behind Yandex's own size picker. It belongs to the query image rather than to
   * any result, so it is returned separately — a deep crawl uses it to upgrade the seed it already
   * has, which is often the single biggest quality win available.
   */
  const otherSizes = []
  const os = init.cbirOtherSizes || {}
  // Yandex ships this key as an object on ordinary SERPs and as a list only on reverse-image ones,
  // so the shape has to be tested rather than trusted — `for…of` on the object threw outright.
  const osList = [os.sizes, os.items, os.data].find(Array.isArray) || []
  for (const s of osList) {
    const url = absolutize(s && (s.url || s.origUrl || s.imageUrl))
    if (!url) continue
    otherSizes.push({ url, w: Number(s.w || s.width) || 0, h: Number(s.h || s.height) || 0, bytes: Number(s.fileSizeInBytes) || 0 })
  }
  otherSizes.sort((a, b) => b.w * b.h - a.w * a.h)

  const navi = sl.navi || {}
  const nextPath = navi.next || ''
  let nextPage = null
  if (nextPath) {
    const m = /[?&]p=(\d+)/.exec(nextPath)
    nextPage = m ? Number(m[1]) : null
  }

  return {
    captcha: false,
    items,
    otherSizes,
    related,
    hasNext: Boolean(nextPath) && items.length > 0,
    nextPage,
    region: String((init.user && init.user.region && init.user.region.real && init.user.region.real.name) || ''),
    empty: items.length === 0,
  }
}

/**
 * Is the family filter on, as far as this response can tell?
 *
 * Advisory only. Yandex does not state the setting on a results page, so this reads the disclaimer
 * it shows when a query was censored. False means "no evidence of filtering", never "proved off".
 */
function looksFiltered(html) {
  const state = extractState(html)
  const pd = state && state.initialState && state.initialState.pornoDisclaimer
  return Boolean(pd && pd.visible)
}

module.exports = {
  YANDEX_DOMAINS,
  UNFILTERED_PARAMS,
  NARROWING_PARAMS,
  isYandexHost,
  safeDomain,
  buildSearchUrl,
  buildReverseUrl,
  normalizeReverseUrl,
  buildTuneUrl,
  yandexResultUrl,
  NO_FILTER_RE,
  MODERATE_RE,
  FAMILY_RE,
  TUNE_SAVE_RE,
  TUNE_PATH_RE,
  CONSENT_CLICKABLE_SELECTOR,
  CONSENT_ACCEPT_RE,
  FILTER_STATES,
  filterStateOfLabel,
  yandexRegistrableDomain,
  isUnreachableByRemote,
  isCaptcha,
  extractState,
  parseSerp,
  looksFiltered,
}
