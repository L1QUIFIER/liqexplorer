// Rating metadata that lives WITH the file rather than in our own index:
// extended attributes, and read-only import of XMP xmp:Rating from images.
//
// MEASURED ON THIS MACHINE before the storage design was chosen (n=300 files):
//
//                      ext4 (local)      CIFS //server/share
//   setxattr           0.001 ms/file     6.05 ms/file
//   getxattr (hit)     0.000 ms/file     1.40 ms/file
//   getxattr (miss)    0.001 ms/file     1.33 ms/file
//   lstat              0.001 ms/file     0.004 ms/file
//
// So xattrs DO work on the share — they are real SMB2 EAs, confirmed by the
// QueryInfos counter in /proc/fs/cifs/Stats incrementing on every getfattr, and
// they survive a rename server-side. But a getxattr there costs 363x an lstat,
// because it is a full round-trip while the lstat is served from the directory
// enumeration the listing already did. Reading one per file while listing would
// add ~1.3 s to a 1000-file folder and ~6.6 s to a 5000-file media folder.
//
// Hence: the xattr is written eagerly (so the rating travels with the file when
// ANY tool moves it) but read only lazily and in bounded batches — never from
// the listing path. state/ratings.ts holds the index that listing actually uses.
//
// Node has no xattr binding, so this shells out to attr(1). getfattr accepts
// many paths per invocation, which matters: one spawn per file measured
// 0.33 ms, while 200 paths in a single spawn measured 0.61 ms total.
import { execFile } from 'node:child_process'
import * as fsp from 'node:fs/promises'
import { clampRating, RATING_MAX } from '../../shared/ratings'

/** freedesktop-ish; what we write. Value is a bare 0..5 integer. */
const XATTR_NAME = 'user.xdg.rating'
/** KDE/Baloo writes 0..10 here. Read-only: we never write this one. */
const XATTR_BALOO = 'user.baloo.rating'

/** paths per getfattr invocation — ARG_MAX is 2 MB here, this is about
 *  keeping one slow batch from blocking the next for too long */
const BATCH = 200
/** a batch that has not answered by now is on a mount that is not answering */
const EXEC_TIMEOUT_MS = 10_000
/** XMP packets live in the file header; this bounds a read on a huge RAW file */
const XMP_SCAN_BYTES = 256 * 1024

let xattrToolMissing = false

function run(cmd: string, args: string[]): Promise<{ code: number; stdout: string }> {
  return new Promise(resolve => {
    execFile(cmd, args, { timeout: EXEC_TIMEOUT_MS, maxBuffer: 8 << 20 }, (err, stdout) => {
      const e = err as (NodeJS.ErrnoException & { code?: number | string }) | null
      if (e && e.code === 'ENOENT') { xattrToolMissing = true; resolve({ code: -1, stdout: '' }); return }
      // getfattr exits 1 when ANY path lacks the attribute, which is the normal
      // case — the stdout blocks are still valid and are what we parse.
      resolve({ code: typeof e?.code === 'number' ? e.code : e ? 1 : 0, stdout: stdout || '' })
    })
  })
}

/** getfattr escapes non-printables in its `# file:` header as \ooo octal. */
function unescapePath(s: string): string {
  return s.replace(/\\([0-7]{3})/g, (_, o: string) => String.fromCharCode(parseInt(o, 8)))
}

/**
 * Ratings held as xattrs, for the paths that have one. Missing paths are simply
 * absent from the map — never an error, since most files are unrated.
 */
export async function readXattrRatings(paths: string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>()
  if (xattrToolMissing || !paths.length) return out
  for (let i = 0; i < paths.length; i += BATCH) {
    const slice = paths.slice(i, i + BATCH)
    for (const name of [XATTR_NAME, XATTR_BALOO]) {
      const { code, stdout } = await run('getfattr',
        ['-n', name, '--absolute-names', '-e', 'text', '--', ...slice])
      if (code === -1) return out                       // attr(1) not installed
      let cur = ''
      for (const line of stdout.split('\n')) {
        if (line.startsWith('# file: ')) { cur = unescapePath(line.slice(8)); continue }
        const eq = line.indexOf('=')
        if (!cur || eq < 0 || !line.startsWith(name)) continue
        const raw = Number(line.slice(eq + 1).replace(/"/g, ''))
        if (!Number.isFinite(raw)) continue
        // Baloo's 0..10 and our 0..5 are both plausible in user.xdg.rating if
        // some other tool wrote it, so anything above 5 is read as the 10-scale.
        const r = clampRating(raw > RATING_MAX ? raw / 2 : raw)
        // xdg wins over baloo: it is the one we write, so it is the fresher of
        // the two whenever both exist
        if (r && (name === XATTR_NAME || !out.has(cur))) out.set(cur, r)
      }
    }
  }
  return out
}

/** Best-effort: a read-only file, a filesystem without user_xattr, or a missing
 *  attr(1) must not fail the rating — the index is the source of truth. */
export async function writeXattrRating(p: string, rating: number): Promise<boolean> {
  if (xattrToolMissing) return false
  const { code } = rating > 0
    ? await run('setfattr', ['-n', XATTR_NAME, '-v', String(rating), '--', p])
    : await run('setfattr', ['-x', XATTR_NAME, '--', p])
  return code === 0
}

// ---------------------------------------------------------------- XMP import

// Windows Explorer writes MicrosoftPhoto:Rating alongside xmp:Rating on a
// different scale; these are its six discrete values.
const MS_SCALE: Record<number, number> = { 0: 0, 1: 1, 25: 2, 50: 3, 75: 4, 99: 5 }

const XMP_EXT = new Set(['jpg', 'jpeg', 'png', 'tif', 'tiff', 'webp', 'heic', 'avif', 'dng', 'cr2', 'nef', 'arw'])

export function canHoldXmp(ext: string): boolean { return XMP_EXT.has(ext) }

/**
 * xmp:Rating out of an image header, or null.
 *
 * Deliberately a bounded byte scan rather than a real XMP parser: the packet is
 * XML in a JPEG APP1 / PNG iTXt segment near the front of the file, there is no
 * XMP library in this project (and no native modules allowed), and a regex over
 * the first 256 KB answers the only question being asked. Verified against
 * fixtures written both ways — xmp:Rating="4" as an attribute and
 * <xmp:Rating>3</xmp:Rating> as an element — in JPEG and PNG.
 *
 * Read-only on purpose: writing XMP back means rewriting the user's image
 * files, which is not a risk this feature needs to take.
 */
export async function readXmpRating(p: string): Promise<number | null> {
  let buf: Buffer
  try {
    const fh = await fsp.open(p, 'r')
    try {
      const b = Buffer.allocUnsafe(XMP_SCAN_BYTES)
      const { bytesRead } = await fh.read(b, 0, XMP_SCAN_BYTES, 0)
      buf = b.subarray(0, bytesRead)
    } finally { await fh.close() }
  } catch { return null }

  // latin1 keeps byte offsets 1:1 so binary image data can never merge two
  // adjacent bytes into one character and fake a match
  const txt = buf.toString('latin1')
  const attr = /xmp:Rating\s*=\s*["'](-?\d+)["']/.exec(txt)
  if (attr) return clampRating(attr[1])
  const elem = /<xmp:Rating[^>]*>\s*(-?\d+)/.exec(txt)
  if (elem) return clampRating(elem[1])
  const ms = /MicrosoftPhoto:Rating\s*=\s*["'](\d+)["']/.exec(txt)
    ?? /<MicrosoftPhoto:Rating[^>]*>\s*(\d+)/.exec(txt)
  if (ms) {
    const v = Number(ms[1])
    return MS_SCALE[v] ?? clampRating(Math.round(v / 20))
  }
  return null
}
