// Ported from projects/web/YandexLab/lib/imghash.js — see imagelab/README.md.
//
// Perceptual image fingerprints, for recognising placeholders.
//
// The problem: a download can succeed perfectly — HTTP 200, valid PNG, correct size — and still be
// "Picture Removed" from the host rather than the picture. Measured on one real job: 44 of 914
// files were the same PiXhost removal notice. Byte hashing does not catch these reliably, because
// hosts re-encode and the same notice appears at several sizes; and a size/dimension rule would ban
// every genuinely small image along with it.
//
// So: dHash, the difference hash. Reduce to 9×8 grey, compare each pixel to its right-hand
// neighbour, and keep the 64 comparison bits. It survives rescaling, recompression and mild colour
// shifts — exactly the transformations a CDN applies — while staying completely different for two
// unrelated photographs. Two images are "the same" when their hashes differ in few enough bits
// (Hamming distance).
//
// Pure and dependency-free so the offline suite can exercise it on synthetic pixels: the caller
// does the decoding and the resize, and hands over raw bytes.
//
// KNOWN LIMIT, measured during the port: dHash compares horizontal neighbours, so a smooth linear
// gradient produces a near-uniform bit pattern and ALL such images collide. That is inherent to the
// algorithm, not a defect — but it means flat or synthetic images are its weak spot, and a matcher
// built on it should not be pointed at, say, a folder of solid-colour swatches.

/** Rec. 601 luma. Cheap, and matched to how these notices are drawn (dark text on white). */
function luma(r: number, g: number, b: number): number {
  return (r * 299 + g * 587 + b * 114) / 1000
}

export interface RawImage {
  data: Uint8Array | Buffer
  width: number
  height: number
  /** Electron's nativeImage.getBitmap() is BGRA; a PNG decoded elsewhere is RGBA */
  order?: 'rgba' | 'bgra'
  channels?: number
}

/**
 * Convert an interleaved pixel buffer to a grayscale array.
 *
 * `order` matters: Electron's `nativeImage.getBitmap()` returns BGRA on every platform we run on,
 * while a PNG decoded elsewhere is RGBA. Getting it backwards does not throw — it silently
 * produces a hash that is stable but wrong, which is the worst kind of bug in a matcher.
 */
export function toGray({ data, width, height, order = 'rgba', channels = 4 }: RawImage): Float64Array {
  const out = new Float64Array(width * height)
  const bgr = order === 'bgra'
  for (let i = 0, p = 0; i < width * height; i++, p += channels) {
    const a = data[p]
    const b = data[p + 1]
    const c = data[p + 2]
    out[i] = bgr ? luma(c, b, a) : luma(a, b, c)
  }
  return out
}

/** Nearest-neighbour box resize. Adequate: dHash throws away all but 64 bits of detail anyway. */
export function resizeGray(
  gray: Float64Array, w: number, h: number, tw: number, th: number,
): Float64Array {
  const out = new Float64Array(tw * th)
  for (let y = 0; y < th; y++) {
    const sy = Math.min(h - 1, Math.floor((y * h) / th))
    for (let x = 0; x < tw; x++) {
      const sx = Math.min(w - 1, Math.floor((x * w) / tw))
      out[y * tw + x] = gray[sy * w + sx]
    }
  }
  return out
}

/**
 * 64-bit difference hash, as 16 hex characters.
 *
 * Returns '' for an image too small to sample — better an explicit "no fingerprint" than a hash
 * built from three pixels that will collide with everything.
 */
export function dHash(img: RawImage | null | undefined): string {
  if (!img || !img.data || !img.width || !img.height) return ''
  if (img.width < 2 || img.height < 2) return ''
  const gray = toGray(img)
  const W = 9
  const H = 8
  const small = resizeGray(gray, img.width, img.height, W, H)
  let bits = ''
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W - 1; x++) {
      bits += small[y * W + x] > small[y * W + x + 1] ? '1' : '0'
    }
  }
  let hex = ''
  for (let i = 0; i < 64; i += 4) hex += parseInt(bits.slice(i, i + 4), 2).toString(16)
  return hex
}

/** Bits that differ between two hex fingerprints. 64 (max) when they are not comparable. */
export function hamming(a: unknown, b: unknown): number {
  const x = String(a || '')
  const y = String(b || '')
  if (!x || !y || x.length !== y.length) return 64
  let d = 0
  for (let i = 0; i < x.length; i++) {
    let v = parseInt(x[i], 16) ^ parseInt(y[i], 16)
    while (v) {
      d += v & 1
      v >>= 1
    }
  }
  return d
}

/**
 * How much variation the image has, 0–1.
 *
 * A second, independent placeholder signal: "no image" pages are frequently a flat colour or a flat
 * colour with a line of text. Anything under ~0.02 is effectively blank. Deliberately NOT used to
 * reject on its own — a legitimate photograph can be a white studio background — only to flag.
 */
export function flatness(img: RawImage | null | undefined): number {
  if (!img || !img.data || !img.width || !img.height) return 1
  const gray = toGray(img)
  let sum = 0
  for (let i = 0; i < gray.length; i++) sum += gray[i]
  const mean = sum / gray.length
  let variance = 0
  for (let i = 0; i < gray.length; i++) variance += (gray[i] - mean) ** 2
  return Math.sqrt(variance / gray.length) / 128
}

export interface BannedEntry {
  id: string
  hash: string
  label: string
  dims?: string
  builtin?: boolean
  /** per-entry override of the default tolerance */
  tolerance?: number
}

export interface BannedMatch extends BannedEntry {
  distance: number
}

/**
 * Does this fingerprint match anything on the ban list?
 *
 * Default tolerance 6 of 64 bits (~90% agreement). Higher starts catching unrelated images that
 * happen to share a layout — two screenshots, two book covers — and a false positive here silently
 * discards a real download, so the threshold errs tight.
 */
export function matchBanned(
  hash: string, banned: BannedEntry[] | null | undefined, tolerance = 6,
): BannedMatch | null {
  if (!hash) return null
  for (const b of banned || []) {
    const d = hamming(hash, b.hash)
    if (d <= (b.tolerance != null ? b.tolerance : tolerance)) return { ...b, distance: d }
  }
  return null
}
