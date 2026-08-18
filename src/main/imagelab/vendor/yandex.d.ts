// Types for vendor/yandex.js, which is kept BYTE-IDENTICAL to
// projects/web/YandexLab/lib/yandex.js on purpose.
//
// It is vendored rather than ported because it is 519 lines of parsing whose value is that it
// already works against real SERPs, and because hand-transcription is exactly what went wrong once
// in this port: imagelab/names.ts started life eating hyphens out of every filename, from a
// character class whose two control bytes a terminal renders as nothing. A file copied by `cp` and
// checked with `cmp` cannot acquire that class of bug, and `scripts/test-imagelab.mjs` runs the
// original fixture tests against this exact copy.
//
// Refreshing it: copy the file across again, run the tests, and if Yandex has changed their markup
// the fixture tests are what will say so. The fixtures live in scripts/fixtures/.

/** one copy of a picture, at the size Yandex CLAIMS for it — claims, not measurements */
export interface SerpSize {
  url: string
  w: number
  h: number
  bytes: number
}

/** one result, flattened out of the SERP's entity graph */
export interface SerpItem {
  id: string
  /** Yandex-hosted preview — never hotlink-blocked, so it always loads */
  thumb: string
  /** ordered candidate URLs for the full-size view, biggest claim first */
  sources: string[]
  /**
   * The same candidates WITH their claimed dimensions — this is what quality selection works from,
   * and what supplies `claimW`/`claimH` to imagelab/quality.ts. The biggest entry is regularly a
   * dead link, so the ladder is walked DOWN until something decodes.
   */
  sizes: SerpSize[]
  width: number
  height: number
  bytes: number
  title: string
  text: string
  /** the page the image was found on */
  pageUrl: string
  domain: string
  /** Yandex's own viewer link for this result, relative */
  detailUrl: string
}

export interface SerpResult {
  captcha: boolean
  items: SerpItem[]
  /**
   * Yandex's own "other sizes" picker for the image that was searched FOR — the single most
   * valuable thing on a reverse-image page for this feature, because every entry is by definition
   * the same picture at another resolution.
   */
  otherSizes: SerpSize[]
  /** related-query chips; populated on reverse-image SERPs, empty on plain text ones */
  related: unknown[]
  hasNext: boolean
  nextPage: number | null
  region: string
  empty: boolean
}

export declare const YANDEX_DOMAINS: string[]

export declare function isYandexHost(host: string): boolean
export declare function safeDomain(domain: string): string
export declare function yandexRegistrableDomain(host: string): string

export declare function buildSearchUrl(opts?: {
  domain?: string; text?: string; page?: number; unfiltered?: boolean; filters?: unknown
}): string

/** a reverse-image search for a PUBLICLY REACHABLE image URL */
export declare function buildReverseUrl(opts?: {
  domain?: string; imageUrl?: string; unfiltered?: boolean
}): string

/**
 * Force a harvested reverse URL onto the page that actually carries results.
 *
 * Measured on one image, everything else equal: `tabInt=1` (the "about this image" tab, which is
 * what the uploader hands back) returns 0 items, no parameter returns 0 items, and
 * `cbir_page=similar` returns 40 items and 5 tags. Skipping this makes the whole feature look
 * implemented and return nothing.
 */
export declare function normalizeReverseUrl(url: string): string

export declare function buildTuneUrl(domain: string): string
export declare function yandexResultUrl(domain: string, detailUrl: string): string

/** a local path or private address cannot be handed to `rpt=imageview&url=` — it must be uploaded */
export declare function isUnreachableByRemote(url: string): boolean

/** a captcha renders as an ordinary layout with no images, so it looks exactly like "no results" */
export declare function isCaptcha(html: string, finalUrl?: string): boolean

export declare function extractState(html: string): unknown
export declare function parseSerp(html: string, finalUrl: string): SerpResult
export declare function looksFiltered(html: string): boolean
