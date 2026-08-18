// Ported from projects/web/YandexLab/lib/upgrade.js — see imagelab/README.md.
//
// Turning a thumbnail into the original.
//
// Some results arrive with nothing but a hosted preview: the original link is missing or dead and
// the alternate-size list is empty, so the size ladder has one rung and the app can only show and
// save a small reference copy. That is the "I can't pick a higher quality version" case, and there
// are three independent ways out of it, cheapest first:
//
// 1. Rewrite the URL. Most image CDNs encode the size in the path, and the original is a
//    deterministic edit away — `i.pinimg.com/236x/…` → `/originals/…`. Costs one HEAD/GET per guess
//    and needs no search. THIS MODULE IS THAT STEP.
// 2. Read the source page. The page the image was found on usually links the full-size file in
//    `og:image` or a `srcset`. One fetch.
// 3. Ask a reverse image search. It returns the same picture at other resolutions, plus the
//    engine's own "other sizes" list. Costs a paced search, so it is last.
//
// Everything here is a GUESS. A rewritten URL frequently 404s, and a CDN will happily serve a
// placeholder at 200. Nothing in this file may be trusted without fetching and decoding the result.

/** Replace the last path segment matching `re`, keeping the rest of the URL intact. */
function swapPath(u: string, re: RegExp, replacement: string): string | null {
  try {
    const url = new URL(u)
    const next = url.pathname.replace(re, replacement)
    if (next === url.pathname) return null
    url.pathname = next
    return url.toString()
  } catch {
    return null
  }
}

function dropQuery(u: string, keys: string[]): string | null {
  try {
    const url = new URL(u)
    let changed = false
    for (const k of keys) {
      if (url.searchParams.has(k)) {
        url.searchParams.delete(k)
        changed = true
      }
    }
    return changed ? url.toString() : null
  } catch {
    return null
  }
}

function setQuery(u: string, k: string, v: string | number): string | null {
  try {
    const url = new URL(u)
    if (url.searchParams.get(k) === String(v)) return null
    url.searchParams.set(k, String(v))
    return url.toString()
  } catch {
    return null
  }
}

interface Rule {
  test: (host: string) => boolean
  build: (u: string) => (string | null)[]
}

/**
 * Every rule is `{test, build}` where `build` returns candidate URLs biggest-first.
 *
 * Transcribed from the URL shapes these CDNs actually serve. They are ordered so the first
 * candidate is the true original where one exists, because the caller stops at the first that
 * verifies larger.
 */
const RULES: Rule[] = [
  {
    // Pinterest: /236x/ /474x/ /564x/ /736x/ /1200x/ are derived sizes; /originals/ is the master.
    test: (h) => /(^|\.)pinimg\.com$/.test(h),
    build: (u) => [swapPath(u, /\/(?:\d+x\d*|orig)\//, '/originals/')],
  },
  {
    // Wikimedia: .../commons/thumb/a/ab/Name.jpg/800px-Name.jpg → .../commons/a/ab/Name.jpg
    test: (h) => /(^|\.)wikimedia\.org$|(^|\.)wikipedia\.org$/.test(h),
    build: (u) => [swapPath(u, /\/thumb\/(.+?)\/[^/]+$/, '/$1')],
  },
  {
    // WordPress.com's photon resizer takes the dimensions entirely from the query.
    test: (h) => /(^|\.)wp\.com$|(^|\.)files\.wordpress\.com$/.test(h),
    build: (u) => [dropQuery(u, ['w', 'h', 'resize', 'fit', 'crop', 'quality', 'strip', 'ssl'])],
  },
  {
    // Blogger/Blogspot: /s320/ /w400-h300/ are derived; /s0/ is the untouched upload.
    test: (h) => /(^|\.)bp\.blogspot\.com$|(^|\.)blogger\.googleusercontent\.com$|(^|\.)googleusercontent\.com$/.test(h),
    build: (u) => [swapPath(u, /\/(?:[swh]\d+(?:-[a-z0-9-]+)?)\//, '/s0/'), u.replace(/=[swh]\d+(?:-[a-z0-9-]*)?$/, '=s0')],
  },
  {
    test: (h) => /(^|\.)squarespace\.com$|(^|\.)squarespace-cdn\.com$/.test(h),
    build: (u) => [setQuery(u, 'format', '2500w')],
  },
  {
    // Shopify encodes the size as a filename suffix: name_400x.jpg → name.jpg
    test: (h) => /(^|\.)shopify\.com$|(^|\.)shopifycdn\.com$/.test(h),
    build: (u) => [swapPath(u, /_(\d+x\d*|\d*x\d+)(\.[a-z]+)$/i, '$2'), dropQuery(u, ['width', 'height'])],
  },
  {
    test: (h) => /(^|\.)ytimg\.com$/.test(h),
    build: (u) => [
      swapPath(u, /\/(?:hq|mq|sd|default|hqdefault|mqdefault|sddefault)([^/]*)$/, '/maxresdefault.jpg'),
    ],
  },
  {
    // Tumblr sizes live in the filename suffix; 1280 is the largest commonly served.
    test: (h) => /(^|\.)tumblr\.com$/.test(h),
    build: (u) => [swapPath(u, /_(\d+)(\.[a-z]+)$/i, '_1280$2')],
  },
  {
    // Imgur appends a single letter for thumbnails: abcde1b.jpg → abcde1.jpg
    test: (h) => /(^|\.)imgur\.com$/.test(h),
    build: (u) => [swapPath(u, /([A-Za-z0-9]{5,})[bsmtlh](\.[a-z]+)$/, '$1$2')],
  },
  {
    test: (h) => /(^|\.)staticflickr\.com$|(^|\.)flickr\.com$/.test(h),
    build: (u) => [swapPath(u, /_[a-z](\.[a-z]+)$/i, '_b$1'), swapPath(u, /_\d+x\d+(\.[a-z]+)$/i, '$1')],
  },
  {
    // Redbubble/Teepublic style: .../w:400,h:400/... or ?width=
    test: (h) => /(^|\.)redbubble\.net$|(^|\.)teepublic\.com$/.test(h),
    build: (u) => [dropQuery(u, ['width', 'height', 'w', 'h'])],
  },
  {
    // A very common generic shape: a `/thumb/` or `/thumbs/` segment mirroring a full-size path.
    test: () => true,
    build: (u) => [
      swapPath(u, /\/thumbs?\//, '/'),
      swapPath(u, /\/(?:small|medium|preview|resized)\//, '/large/'),
      dropQuery(u, ['w', 'h', 'width', 'height', 'size', 'resize', 'quality', 'q']),
    ],
  },
]

/**
 * Candidate "bigger" URLs for one image, best guess first.
 *
 * Returns only URLs that differ from the input. The caller must fetch and VERIFY each — a rewritten
 * URL is a hypothesis, not a result.
 */
export function upgradeCandidates(url: unknown): string[] {
  const s = String(url || '')
  if (!/^https?:\/\//i.test(s)) return []
  let host = ''
  try {
    host = new URL(s).hostname.toLowerCase()
  } catch {
    return []
  }
  const out: string[] = []
  for (const rule of RULES) {
    if (!rule.test(host)) continue
    for (const cand of rule.build(s) || []) {
      if (cand && cand !== s && !out.includes(cand)) out.push(cand)
    }
  }
  return out
}

/** Is this URL a Yandex-hosted preview? Those cannot be rewritten and mean we have only a copy. */
export function isYandexPreview(url: unknown): boolean {
  return /(^|\/\/)avatars\.mds\.yandex\.net\//.test(String(url || ''))
}

/**
 * Does this item only have a reference copy?
 *
 * True when every rung of its ladder is a hosted preview — the case where the UI can show a picture
 * but has nothing better to offer, and the one worth spending a search on.
 */
export function isThumbnailOnly(item: { sources?: string[] } | null | undefined): boolean {
  const urls = item?.sources || []
  if (!urls.length) return true
  return urls.every(isYandexPreview)
}
