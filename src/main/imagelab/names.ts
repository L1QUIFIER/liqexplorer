// Ported from projects/web/YandexLab/lib/names.js — see imagelab/README.md.
//
// Filename construction. Pure, so the offline suite can actually exercise it.
//
// This lives in its own module because of the bug that produced it. `safeName` originally read
// `[ -<>:"/\\|?*]`, where the unescaped `-` sitting between space (0x20) and `<` (0x3C) forms a
// character RANGE — one that covers every digit. So every saved filename quietly lost its numbers:
// "Photo 2024 test" became "Photo test", "Sunset [1080x1523]" became "Sunset [ x ]", and a title
// that was only digits collapsed to the fallback. It survived six rounds of work and was only
// caught when resolutions were added to filenames and came out empty.
//
// It was invisible partly because it lived in `main.js`, which the offline suite cannot import.
// Anything that transforms user-visible data belongs somewhere it can be tested.

/**
 * Characters Windows reserves, plus control codes. Digits, hyphens, spaces and unicode are all
 * legal.
 *
 * The control-code range is written with ESCAPES here. In the original it is two raw bytes (0x00
 * and 0x1F) sitting literally in the source, which makes the file non-UTF-8 — `file` reports it as
 * `data`, grep refuses to search it, and a terminal renders the class as `[<>:"/\|?* -]`, i.e. as
 * though it contained a space and a hyphen. Transcribing what the screen showed reproduced the
 * module's own founding bug in a new form: the port ate hyphens out of every filename, and only
 * the ported test "hyphens survive" caught it.
 *
 * Two lessons, both already implied by the comment above: a character class is worth reading as
 * bytes, and anything that transforms user-visible data belongs where a test can reach it.
 */
export const ILLEGAL_RE = /[<>:"/\\|?*\x00-\x1f]+/g

/** Names Windows refuses outright, whatever the extension. */
const RESERVED_RE = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i

export function safeName(s: unknown, fallback = 'image'): string {
  let out = String(s == null ? '' : s)
    .replace(ILLEGAL_RE, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 110)
    // Windows rejects a trailing dot or space on a path component.
    .replace(/[. ]+$/, '')
    .trim()
  if (!out) return fallback
  if (RESERVED_RE.test(out)) out = `_${out}`
  return out
}

/**
 * The extension to save under.
 *
 * The Content-Type is trusted first because a URL's extension is frequently a lie — CDNs serve
 * WebP from a `.jpg` path constantly — and the bytes on disk should match the name.
 */
export function extFromUrl(u: unknown, contentType?: unknown): string {
  const ct = String(contentType || '').toLowerCase()
  if (ct.includes('jpeg') || ct.includes('jpg')) return '.jpg'
  if (ct.includes('png')) return '.png'
  if (ct.includes('webp')) return '.webp'
  if (ct.includes('gif')) return '.gif'
  if (ct.includes('avif')) return '.avif'
  if (ct.includes('bmp')) return '.bmp'
  try {
    const p = new URL(String(u))
    const m = /\.(jpe?g|png|webp|gif|avif|bmp)(?:$|[?#])/i.exec(p.pathname + (p.search || ''))
    if (m) return '.' + m[1].toLowerCase().replace('jpeg', 'jpg')
  } catch {
    /* fall through to the default */
  }
  return '.jpg'
}

/** `Title [1200x800]` — the verified resolution, so a folder sorts by real quality. */
export function nameWithDims(title: unknown, width: number, height: number, fallback = 'image'): string {
  const dims = width && height ? ` [${width}x${height}]` : ''
  return safeName(String(title || '') + dims, fallback)
}
