// Folder thumbnails: a folder that shows what is inside it.
//
// Explorer shows a plain folder icon whether it holds a tax return or four
// hundred photographs, and the only way to find out was to open it — or, here,
// to hover and wait for the peek popover. For a picture library that is the
// wrong way round: the contents are the identity of the folder, and the name
// often is not ("2019-07", "Camera Roll (2)").
//
// THE COST IS THE WHOLE DESIGN. A listing can hold hundreds of folders, this
// machine's own share is a hard-mounted CIFS where one read can block for
// minutes, and the naive version — scan every folder, thumbnail everything
// inside — would make opening a directory slower than the thing it is trying to
// illustrate. So:
//
//   * the dirent scan is bounded and deadline-guarded, and never recurses;
//   * ALREADY-CACHED thumbnails are preferred, so a folder you have browsed
//     costs almost nothing — the pictures were thumbnailed on the way past;
//   * the whole composite is ONE ImageMagick process, not one per picture;
//   * the result goes in the ordinary freedesktop thumbnail cache under the
//     FOLDER's own uri, validated by the folder's mtime — which changes exactly
//     when entries are added or removed, so invalidation is free and correct;
//   * a folder with no pictures in it gets a fail marker like any other
//     unthumbnailable file, so it is asked once rather than on every listing.
//
// It still has to LOOK like a folder. A tile that renders as a bare photograph
// loses the one distinction that matters in a file manager — double-clicking it
// does something entirely different from double-clicking a picture — so the
// contents are inlaid into a folder shape rather than replacing it.
//
// It deliberately does NOT import from platform/protocols.ts, which is what
// calls it: protocols.ts owns the thumbnail cache and resolves each picture to
// its cached copy before handing the list over. Reaching back for that here
// would make the two modules import each other, and a cycle that happens to
// work because of when the functions are called is a trap for whoever edits it
// next.
import * as fsp from 'node:fs/promises'
import * as path from 'node:path'
import { spawn } from 'node:child_process'
import { resolveTools } from './tools'
import { resolveIcon } from './icons'

/** dirents read before giving up on finding pictures — a bounded look, not a search */
const SCAN_CAP = 400
/** wall clock for the scan; a partial answer beats a hung listing */
const SCAN_MS = 1500
/** how many pictures go into the tile */
export const TILES = 4
/** the composite gets a deadline of its own */
const COMPOSE_MS = 20_000

const IMAGE_EXT = new Set(['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'avif', 'tif', 'tiff'])
/** videos count as contents, but only via a thumbnail that already exists —
 *  spawning ffmpeg per clip to illustrate a folder is not worth the wait */
const VIDEO_EXT = new Set(['mp4', 'm4v', 'mkv', 'mov', 'webm', 'avi', 'wmv', 'flv', 'mpg', 'mpeg'])

export interface FolderContents {
  /** pictures, in name order, capped at TILES */
  images: string[]
  /** videos, in name order — usable only if the caller already has a thumbnail */
  videos: string[]
}

/**
 * Pick what to show, cheapest first.
 *
 * Sorted by name so the tile is STABLE: a folder whose picture changed every
 * time it was drawn would be worse than no picture, because the thing a
 * thumbnail is for is recognising the folder again.
 */
export async function scanForMedia(dir: string): Promise<FolderContents> {
  const deadline = Date.now() + SCAN_MS
  let names: string[]
  try {
    const dh = await fsp.opendir(dir)
    names = []
    try {
      for await (const de of dh) {
        if (names.length >= SCAN_CAP || Date.now() > deadline) break
        if (de.isFile()) names.push(de.name)
      }
    } finally {
      // opendir's iterator closes itself when exhausted, but a `break` leaves it
      // open and the fd would leak once per folder drawn
      try { await dh.close() } catch { /* already closed by the iterator */ }
    }
  } catch { return { images: [], videos: [] } }

  names.sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }))
  const images: string[] = []
  const videos: string[] = []
  for (const n of names) {
    const ext = path.extname(n).slice(1).toLowerCase()
    if (IMAGE_EXT.has(ext)) images.push(path.join(dir, n))
    else if (VIDEO_EXT.has(ext)) videos.push(path.join(dir, n))
    if (images.length >= TILES) break
  }

  return { images: images.slice(0, TILES), videos: videos.slice(0, TILES) }
}

/**
 * Compose the tile.
 *
 * The base is THE USER'S OWN FOLDER ICON, resolved through the icon theme, with
 * the pictures inlaid into its face. Drawing a generic folder shape instead was
 * the first attempt and it looked wrong for an honest reason: every other folder
 * in the window is the theme's blue (or whatever the theme is), so a grey
 * rectangle among them reads as a different kind of object rather than as a
 * folder with pictures in it. Borrowing the real icon means this tracks whatever
 * theme is installed, including one the user changes later.
 *
 * The inlay sits inside the lower-middle of the icon, which is the body on every
 * common folder theme — the tab is at the top and is left clear, because the tab
 * is most of what makes the silhouette read as "folder" at a glance.
 *
 * `-resize WxH^ -gravity center -extent WxH` is the fill-and-crop pair: without
 * `^` a portrait photo is letterboxed into a wide cell and the tile turns into
 * mostly background.
 */
export async function composeFolderThumb(files: string[], px: number, out: string): Promise<boolean> {
  const conv = resolveTools().convert
  if (!conv.length || !files.length) return false

  const S = px
  // the folder face: inside the body on every common theme, tab left clear
  const inner = {
    x: Math.round(S * 0.15), y: Math.round(S * 0.40),
    w: Math.round(S * 0.70), h: Math.round(S * 0.46),
  }
  const gap = Math.max(1, Math.round(S * 0.012))
  const n = Math.min(files.length, TILES)
  const cols = n === 1 ? 1 : 2
  const rows = n <= 2 ? 1 : 2
  const cw = Math.floor((inner.w - gap * (cols - 1)) / cols)
  const ch = Math.floor((inner.h - gap * (rows - 1)) / rows)

  // the theme's own folder, at the size we are drawing; a theme with no folder
  // icon at all is not worth inventing one for, so the tile is simply refused
  // and the caller falls back to the ordinary icon
  const base = resolveIcon(['folder'], S)
  if (!base) return false
  const args: string[] = [
    ...conv.slice(1),
    '-background', 'none', '-density', '300', base, '-resize', `${S}x${S}`,
    '-gravity', 'NorthWest', '-background', 'none', '-extent', `${S}x${S}`,
  ]
  for (let i = 0; i < n; i++) {
    const cx = inner.x + (i % cols) * (cw + gap)
    const cy = inner.y + Math.floor(i / cols) * (ch + gap)
    args.push(
      '(', files[i] + '[0]', '-resize', `${cw}x${ch}^`, '-gravity', 'center', '-extent', `${cw}x${ch}`, ')',
      // -gravity set INSIDE the parentheses leaks back out in ImageMagick 6, and
      // then -geometry is measured from the centre instead of the top-left: the
      // tiles land low and right and fall off the canvas. Reset it per tile.
      '-gravity', 'NorthWest',
      '-geometry', `+${cx}+${cy}`, '-composite',
    )
  }
  args.push('-strip', `PNG32:${out}`)

  return new Promise(resolve => {
    let done = false
    const finish = (v: boolean): void => { if (!done) { done = true; resolve(v) } }
    try {
      const c = spawn(conv[0], args, { stdio: ['ignore', 'ignore', 'ignore'] })
      const t = setTimeout(() => { try { c.kill('SIGKILL') } catch { /* gone */ } finish(false) }, COMPOSE_MS)
      c.on('error', () => { clearTimeout(t); finish(false) })
      c.on('close', code => { clearTimeout(t); finish(code === 0) })
    } catch { finish(false) }
  })
}
