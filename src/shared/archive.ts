// Archive filename recognition, shared by the renderer (menu gating) and the
// main-process backend. Multi-part sets matter: only the FIRST volume may be
// handed to the extractor, and the set should read as one item in the UI.
//
//   foo.part1.rar / foo.part01.rar   first volume; foo.part2.rar … are members
//   foo.rar + foo.r00, foo.r01 …     old-style RAR split (foo.rar is first)
//   foo.7z.001, foo.zip.001, foo.001 numbered split (…001 is first)
//   foo.z01 … + foo.zip              split zip (the .zip is the one to open)

const SINGLE_RE = /\.(zip|7z|rar|tar|gz|tgz|bz2|tbz2?|xz|txz|zst|lz4|lzma|cab|iso|arj|lzh|lha|wim|cpio|z)$/i
const PART_RAR_RE = /\.part(\d+)\.rar$/i
const OLD_RAR_RE = /\.r(\d+)$/i
const NUMBERED_RE = /\.(\d{3,})$/
const SPLIT_ZIP_RE = /\.z(\d+)$/i

// ---- archive:// URIs (Explorer's "browse a zip like a folder") ----
// Shape: archive:///abs/path/file.zip!/inner/path   (empty inner = archive root)

const ARCHIVE_URI_RE = /^archive:\/\/(.*?)(?:!\/(.*))?$/

export function archiveUri(archive: string, inner = ''): string {
  const i = inner.replace(/^\/+|\/+$/g, '')
  return `archive://${archive}!/${i}`
}

export function parseArchiveUri(uri: string): { archive: string; inner: string } | null {
  const m = ARCHIVE_URI_RE.exec(uri)
  if (!m || !m[1]) return null
  return { archive: m[1], inner: (m[2] ?? '').replace(/^\/+|\/+$/g, '') }
}

export function isArchiveUri(p: string): boolean {
  return p.startsWith('archive://')
}

export function isArchiveName(name: string): boolean {
  return SINGLE_RE.test(name) || PART_RAR_RE.test(name) || NUMBERED_RE.test(name)
}

/** true for volumes that are NOT the entry point of their set (hide/skip them) */
export function isSecondaryVolume(name: string): boolean {
  const part = PART_RAR_RE.exec(name)
  if (part) return Number(part[1]) !== 1
  if (OLD_RAR_RE.test(name)) return true          // .r00/.r01 follow the .rar
  if (SPLIT_ZIP_RE.test(name)) return true        // .z01 follows the .zip
  const num = NUMBERED_RE.exec(name)
  if (num) return Number(num[1]) !== 1
  return false
}

/** the volume an extractor should be pointed at, given any member of a set */
export function primaryVolume(path: string): string {
  const part = PART_RAR_RE.exec(path)
  if (part) return path.replace(PART_RAR_RE, `.part${'1'.padStart(part[1].length, '0')}.rar`)
  if (OLD_RAR_RE.test(path)) return path.replace(OLD_RAR_RE, '.rar')
  if (SPLIT_ZIP_RE.test(path)) return path.replace(SPLIT_ZIP_RE, '.zip')
  const num = NUMBERED_RE.exec(path)
  if (num) return path.replace(NUMBERED_RE, '.' + '1'.padStart(num[1].length, '0'))
  return path
}

/** name shown for the whole set, e.g. 'foo.part1.rar' -> 'foo.rar' */
export function archiveStem(name: string): string {
  return name
    .replace(PART_RAR_RE, '.rar')
    .replace(NUMBERED_RE, '')
    .replace(/\.(tar\.(gz|bz2|xz|zst)|tgz|tbz2?|txz)$/i, '')
    .replace(SINGLE_RE, '')
}
