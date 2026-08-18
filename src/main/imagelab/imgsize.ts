// Ported from projects/web/YandexLab/lib/imgsize.js — see imagelab/README.md.
//
// Image dimensions read straight out of the container header, for formats Electron cannot decode.
//
// This exists because of a measurable failure, not for tidiness. A "pick the best image" walk goes
// through a result's size ladder largest-first and accepts a rung only when the pixels it actually
// decoded are within half the advertised area — that check is what stops a CDN's 160×120
// placeholder being saved as the 4000×3000 original it claimed to be. `nativeImage` cannot decode
// WebP, so a WebP rung decoded to 0×0, and `realArea === 0` short-circuited the guard to ACCEPT.
// The result was the exact inversion of the intent: every other format had to prove itself while
// WebP was waved through, and because the walk stops at the first acceptance, the mirrors below it
// — often carrying the real full-size photo — were never tried.
//
// Note for LiqExplorer: this is the single most important module in the port. The feature it
// serves is named after the format that broke it.

export interface ImageSize {
  width: number
  height: number
  kind: 'extended' | 'lossy' | 'lossless'
}

/**
 * @param buf the first bytes are enough; the whole file is fine too
 */
export function webpSize(buf: Buffer | null | undefined): ImageSize | null {
  if (!buf || buf.length < 30) return null
  if (buf.toString('latin1', 0, 4) !== 'RIFF' || buf.toString('latin1', 8, 12) !== 'WEBP') return null

  const chunk = buf.toString('latin1', 12, 16)

  // Extended format (animation, alpha, ICC…): a VP8X chunk carries the canvas size up front, and it
  // is authoritative — the frames inside may be smaller than the canvas.
  if (chunk === 'VP8X') {
    const width = buf.readUIntLE(24, 3) + 1
    const height = buf.readUIntLE(27, 3) + 1
    return valid(width, height, 'extended')
  }

  // Simple lossy: 3-byte frame tag, then the sync code that confirms a keyframe, then 14-bit sizes.
  if (chunk === 'VP8 ') {
    if (buf[23] !== 0x9d || buf[24] !== 0x01 || buf[25] !== 0x2a) return null
    const width = buf.readUInt16LE(26) & 0x3fff
    const height = buf.readUInt16LE(28) & 0x3fff
    return valid(width, height, 'lossy')
  }

  // Simple lossless: signature byte, then width-1 and height-1 packed as 14 bits each.
  if (chunk === 'VP8L') {
    if (buf[20] !== 0x2f) return null
    const bits = buf.readUInt32LE(21)
    const width = (bits & 0x3fff) + 1
    const height = ((bits >> 14) & 0x3fff) + 1
    return valid(width, height, 'lossless')
  }

  return null
}

function valid(width: number, height: number, kind: ImageSize['kind']): ImageSize | null {
  return width > 0 && height > 0 ? { width, height, kind } : null
}
