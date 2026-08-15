// Display-ready metadata rows for the inspector's Details tab.
//
// Self-registers its IPC (the ops/convert.ts + platform/preview.ts pattern), so
// main/ipc.ts stays untouched:
//     fileFacts(path)         -> FileFacts
//     fileFactsMany(paths)    -> FileFacts[]   (capped; rename tokens need it)
//
// ALL FORMATTING HAPPENS HERE — shared/facts.ts says why: the renderer paints
// label/value pairs and never learns ffprobe's or pdfinfo's field names, so
// swapping a tool is a change to this file only.
//
// The tools, as they actually behave on this machine:
//   image  ImageMagick 6.9.12 `identify` (there is no `magick` driver). Asking
//          for one named EXIF property that is absent prints a warning per miss
//          on stderr, so `%[EXIF:*]` — which dumps only what exists — is the
//          only usable form. `file[0]` pins the first frame, or a multi-frame
//          GIF/ICO prints one line per frame and the parse is nonsense.
//   av     ffprobe 6.1.1, header-only: measured 30–110 ms for a 700 MB MKV on
//          the CIFS share, so this is affordable on selection change.
//   pdf    poppler 24.02 `pdfinfo -isodates` (raw dates print as
//          "Fri Aug 7 18:50:21 2026 EDT", which no Date parser reads back).
//          qpdf and exiftool are NOT installed — nothing here may want them.
//
// Every bound below exists because /mnt/share is a hard-mounted CIFS share where
// one syscall can block for minutes:
//   * stat races a deadline, the trick statDeadline() in protocols.ts exists for;
//   * a probe resolves within FACTS_TIMEOUT_MS whatever the child does, and the
//     child gets SIGKILL slightly sooner, so an abandoned probe can never leave a
//     wedged ffprobe behind;
//   * at most MAX_PROBES children run at once — the slot/queue idiom from
//     protocols.ts, LIFO for the same reason (the newest request is the file the
//     user is looking at now), with concurrent asks for one key coalesced;
//   * results cache on path+mtime+size, the same identity archiveKey() uses in
//     ops/archive/members.ts: mtime and size in the key ARE the invalidation.
//
// And never trust an exit code: ops/convert.ts documents ImageMagick 6 exiting 0
// while producing something else entirely. Every parser here has to find the
// fields it came for before the result counts as anything but a failure.
import { ipcMain } from 'electron'
import { spawn, type ChildProcess } from 'node:child_process'
import type { Stats } from 'node:fs'
import * as fsp from 'node:fs/promises'
import * as path from 'node:path'
import { CH } from '../../shared/ipc'
import type { FactRow, FactsKind, FileFacts } from '../../shared/facts'
import type { StreamInfo } from '../../shared/playplan'
import { formatDate, formatSize } from '../../shared/sort'
import { mimeForName } from '../fs/mime'
import * as archive from '../ops/archive/backend'

/** Whatever the filesystem or the child does, a probe answers by now. Sits above
 *  FACTS_UI_TIMEOUT_MS (2.5 s): the renderer has already shown "—" by then, but
 *  finishing still fills the cache for the next time this file is selected. */
const FACTS_TIMEOUT_MS = 5000
/** The stat race and every child deadline sit deliberately INSIDE the guarantee
 *  above, so a slow file times out through the normal return path and the answer
 *  still carries its kind, mtime and size. The outer race is then only ever the
 *  backstop for something that ignored its own deadline. */
const CHILD_TIMEOUT_MS = FACTS_TIMEOUT_MS - 500
/** Probes are short and I/O bound; four is enough to keep a multi-select moving
 *  without handing a folder of video the whole machine. */
const MAX_PROBES = 4
/** fileFactsMany is a bulk helper, not a scan — the caller must page. */
const MANY_CAP = 500
/** A batch of 500 on a slow mount would otherwise take 500/MAX_PROBES × the
 *  per-file deadline; unfinished entries come back marked instead. */
const MANY_TIMEOUT_MS = 30_000
/** Stream rows rendered before the list is summarised (MKVs carry font
 *  attachments, and a Details tab is not a stream inspector). */
const MAX_STREAMS = 12

// ------------------------------------------------------------------ scheduling

let running = 0
const queue: (() => void)[] = []

function acquireSlot(): Promise<void> {
  if (running < MAX_PROBES) { running++; return Promise.resolve() }
  return new Promise(res => queue.push(() => { running++; res() }))
}

function releaseSlot(): void {
  running--
  // LIFO: while arrowing down a folder, the newest request is the row actually
  // selected. Oldest-first spends the budget on files already scrolled past.
  queue.pop()?.()
}

/** Resolve with `fallback()` after `ms` no matter what the work does. The work
 *  is abandoned, not cancelled — its own child timer does the killing. */
function withDeadline<T>(work: Promise<T>, ms: number, fallback: () => T): Promise<T> {
  return new Promise(resolve => {
    let settled = false
    const timer = setTimeout(() => { if (!settled) { settled = true; resolve(fallback()) } }, ms)
    const finish = (v: T): void => { if (!settled) { settled = true; clearTimeout(timer); resolve(v) } }
    work.then(finish, () => finish(fallback()))
  })
}

// ------------------------------------------------------------------ child procs

interface Proc { code: number | null; out: string; err: string; timedOut: boolean }

/**
 * Spawn with stdin IGNORED (archive/backend.ts's rule 1: a tool that prompts
 * blocks forever otherwise), capture stdout/stderr, and SIGKILL at `ms`.
 * Never rejects — a missing binary comes back as code -1.
 */
function run(bin: string, args: string[], ms: number, capOut = 1 << 20): Promise<Proc> {
  return new Promise(resolve => {
    let child: ChildProcess
    try {
      child = spawn(bin, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        // ImageMagick's OpenMP takes every core PER PROCESS without this; see
        // the measurement in the header of ops/convert.ts.
        env: { ...process.env, MAGICK_THREAD_LIMIT: '1', OMP_NUM_THREADS: '1' },
      })
    } catch (e) {
      resolve({ code: -1, out: '', err: String((e as Error)?.message ?? e), timedOut: false })
      return
    }
    let out = ''
    let err = ''
    let timedOut = false
    child.stdout?.setEncoding('utf8')
    child.stderr?.setEncoding('utf8')
    child.stdout?.on('data', (d: string) => { if (out.length < capOut) out += d })
    child.stderr?.on('data', (d: string) => { if (err.length < 8192) err += d })
    // a SIGKILL mid-read surfaces as a stream error; unhandled it takes the main
    // process down (the same trap runPiped() guards in ops/convert.ts)
    child.stdout?.on('error', () => {})
    child.stderr?.on('error', () => {})
    const timer = setTimeout(() => { timedOut = true; try { child.kill('SIGKILL') } catch { /* gone */ } }, ms)
    let settled = false
    const finish = (code: number | null, e?: string): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ code, out, err: e ?? err, timedOut })
    }
    child.on('error', e => finish(-1, String((e as Error)?.message ?? e)))
    child.on('close', c => finish(c))
  })
}

// ------------------------------------------------------------------ formatting

const num = (n: number, digits = 1): string => {
  const s = n.toFixed(digits)
  return s.replace(/\.?0+$/, '') || '0'
}

const count = (n: number): string => n.toLocaleString('en-US')

/** "1:23:45" / "3:07" — the same shape as the media transport's clock(). */
function duration(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) return '0:00'
  const s = Math.round(sec)
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const r = s % 60
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}`
    : `${m}:${String(r).padStart(2, '0')}`
}

function bitrate(bps: number): string {
  if (!Number.isFinite(bps) || bps <= 0) return ''
  if (bps >= 1_000_000) return `${num(bps / 1_000_000)} Mbps`
  if (bps >= 1000) return `${Math.round(bps / 1000)} kbps`
  return `${Math.round(bps)} bps`
}

/** no thousands separators: "1,920 × 1,080" reads as two numbers rather than
 *  as the one shape everyone recognises */
const dimensions = (w: number, h: number): string => `${w} × ${h}`

function megapixels(w: number, h: number): string {
  const mp = (w * h) / 1_000_000
  return `${mp >= 1 ? mp.toFixed(1) : mp.toFixed(2)} MP`
}

/** Title-case a single word ("stereo" -> "Stereo"); layouts like "5.1(side)"
 *  and "quad" both come out readable and neither needs a lookup table. */
const cap = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1)

const rowsPush = (rows: FactRow[], group: string | undefined, label: string, value: string | null | undefined, mono = false): void => {
  if (value === null || value === undefined) return
  const v = value.trim()
  if (!v) return
  rows.push(mono ? { label, value: v, group, mono } : { label, value: v, group })
}

// ------------------------------------------------------------------ stat

/** Explorer's wording rather than an errno, mirroring errText() in preview.ts. */
function errText(e: unknown): string {
  switch ((e as NodeJS.ErrnoException)?.code) {
    case 'ENOENT': return 'The item is no longer in this location.'
    case 'EACCES':
    case 'EPERM': return 'You do not have permission to read this file.'
    case 'EIO': return 'The location could not be read.'
  }
  return String((e as Error)?.message ?? e)
}

interface StatResult { st?: Stats; error?: string }

/** stat() on a dead CIFS mount never returns; this always does. */
function statDeadline(p: string, ms: number): Promise<StatResult> {
  return new Promise(resolve => {
    let done = false
    const timer = setTimeout(() => { if (!done) { done = true; resolve({ error: TIMED_OUT }) } }, ms)
    fsp.stat(p).then(
      st => { if (!done) { done = true; clearTimeout(timer); resolve({ st }) } },
      e => { if (!done) { done = true; clearTimeout(timer); resolve({ error: errText(e) }) } },
    )
  })
}

const TIMED_OUT = 'Timed out reading this file.'

// ------------------------------------------------------------------ image

type Exif = Map<string, string>

/** `%[EXIF:*]` prints "exif:Key=Value" lines. Values containing newlines (a
 *  UserComment) leave stray lines behind — they simply do not match. */
function parseExif(text: string): Exif {
  const out: Exif = new Map()
  for (const line of text.split('\n')) {
    if (!line.startsWith('exif:')) continue
    const eq = line.indexOf('=')
    if (eq < 0) continue
    const key = line.slice(5, eq)
    // exif:thumbnail:* is the embedded preview's own IFD — same tag names,
    // different (and wrong) subject
    if (key.startsWith('thumbnail:')) continue
    const v = line.slice(eq + 1).trim()
    if (v) out.set(key, v)
  }
  return out
}

/** EXIF numbers are rationals ("26/10"); a few writers emit plain decimals. */
function rational(v: string | undefined): number | null {
  if (!v) return null
  const m = /^\s*(-?\d+)\s*\/\s*(-?\d+)\s*$/.exec(v)
  if (m) { const d = Number(m[2]); return d === 0 ? null : Number(m[1]) / d }
  const n = Number(v.trim())
  return Number.isFinite(n) ? n : null
}

/** EXIF carries no timezone: the stamp is the photographer's wall clock, so it
 *  is read as local time rather than shifted into one. */
function exifDate(v: string | undefined): number | null {
  const m = /^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec((v ?? '').trim())
  if (!m) return null
  const t = new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]).getTime()
  return Number.isFinite(t) ? t : null
}

const ORIENTATION: Record<string, string> = {
  '1': 'Normal', '2': 'Mirrored horizontally', '3': 'Rotated 180°',
  '4': 'Mirrored vertically', '5': 'Mirrored and rotated 90° CCW',
  '6': 'Rotated 90° CW', '7': 'Mirrored and rotated 90° CW', '8': 'Rotated 90° CCW',
}

/** "41/1, 24/1, 1234/100" + "N" -> signed decimal degrees. */
function gpsCoord(val: string | undefined, ref: string | undefined): number | null {
  if (!val) return null
  const p = val.split(',').map(s => rational(s))
  if (p[0] === null || p[0] === undefined) return null
  const deg = p[0] + (p[1] ?? 0) / 60 + (p[2] ?? 0) / 3600
  if (!Number.isFinite(deg)) return null
  const r = (ref ?? '').trim().toUpperCase().charAt(0)
  return (r === 'S' || r === 'W') ? -deg : deg
}

function cameraRows(x: Exif, rows: FactRow[]): void {
  const G = 'Camera'
  const taken = exifDate(x.get('DateTimeOriginal') ?? x.get('DateTimeDigitized') ?? x.get('DateTime'))
  if (taken !== null) rowsPush(rows, G, 'Date taken', formatDate(taken))
  rowsPush(rows, G, 'Camera maker', x.get('Make'))
  rowsPush(rows, G, 'Camera model', x.get('Model'))
  rowsPush(rows, G, 'Lens', x.get('LensModel'))

  const f = rational(x.get('FNumber'))
  if (f !== null && f > 0) rowsPush(rows, G, 'F-stop', `f/${num(f)}`)

  const exp = rational(x.get('ExposureTime'))
  if (exp !== null && exp > 0) {
    rowsPush(rows, G, 'Exposure time', exp >= 1 ? `${num(exp)} s` : `1/${Math.round(1 / exp)} s`)
  }

  // EXIF 2.3 renamed ISOSpeedRatings to PhotographicSensitivity; cameras in the
  // wild write either, and multi-value entries lead with the one that applied.
  const iso = (x.get('ISOSpeedRatings') ?? x.get('PhotographicSensitivity') ?? x.get('ISOSpeed') ?? '')
    .split(',')[0]?.trim()
  if (iso && Number.isFinite(Number(iso))) rowsPush(rows, G, 'ISO speed', `ISO ${Number(iso)}`)

  const fl = rational(x.get('FocalLength'))
  if (fl !== null && fl > 0) rowsPush(rows, G, 'Focal length', `${num(fl)} mm`)
  const fl35 = rational(x.get('FocalLengthIn35mmFilm'))
  if (fl35 !== null && fl35 > 0) rowsPush(rows, G, '35 mm equivalent', `${num(fl35, 0)} mm`)

  rowsPush(rows, G, 'Orientation', ORIENTATION[(x.get('Orientation') ?? '').trim()])

  const lat = gpsCoord(x.get('GPSLatitude'), x.get('GPSLatitudeRef'))
  const lon = gpsCoord(x.get('GPSLongitude'), x.get('GPSLongitudeRef'))
  if (lat !== null && lon !== null) {
    rowsPush(rows, G, 'Coordinates',
      `${Math.abs(lat).toFixed(4)}° ${lat < 0 ? 'S' : 'N'}, ${Math.abs(lon).toFixed(4)}° ${lon < 0 ? 'W' : 'E'}`)
  }
  // no "above/below sea level": GPSAltitudeRef is a BYTE, and IM6 renders every
  // non-printable byte as '.', so its sign is not recoverable from identify's
  // output at all (verified — 0 and 1 both come back as '.')
  const alt = rational(x.get('GPSAltitude'))
  if (alt !== null) rowsPush(rows, G, 'Altitude', `${num(Math.abs(alt), 0)} m`)
}

const IDENTIFY_SEP = '@@liqfacts@@'

async function probeImage(p: string, ms: number): Promise<{ rows: FactRow[]; error?: string }> {
  // one identify run for both the raster facts and the EXIF dump; the wildcard
  // is what keeps the stderr clean (see header)
  const fmt = `%m\n%w\n%h\n%[colorspace]\n%z\n${IDENTIFY_SEP}\n%[EXIF:*]`
  const r = await run('identify', ['-quiet', '-format', fmt, `${p}[0]`], ms)
  if (r.timedOut) return { rows: [], error: TIMED_OUT }
  const sep = r.out.indexOf(IDENTIFY_SEP)
  const head = (sep < 0 ? r.out : r.out.slice(0, sep)).split('\n')
  const format = (head[0] ?? '').trim()
  const w = Number(head[1])
  const h = Number(head[2])
  // exit code alone is not evidence (see header): the parse has to have worked
  if (!format || !Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) {
    return { rows: [], error: imageError(r) }
  }

  const rows: FactRow[] = []
  rowsPush(rows, 'Image', 'Format', format)
  rowsPush(rows, 'Image', 'Dimensions', dimensions(w, h))
  rowsPush(rows, 'Image', 'Megapixels', megapixels(w, h))
  rowsPush(rows, 'Image', 'Colour space', (head[3] ?? '').trim())
  const depth = Number(head[4])
  if (Number.isFinite(depth) && depth > 0) rowsPush(rows, 'Image', 'Bit depth', `${depth}-bit`)

  if (sep >= 0) cameraRows(parseExif(r.out.slice(sep + IDENTIFY_SEP.length)), rows)
  return { rows }
}

function imageError(r: Proc): string {
  const line = r.err.split('\n').map(s => s.trim()).filter(Boolean).pop()
  // identify wraps every message in "identify-im6.q16: … `/the/path' @ error/…"
  // — the pane already shows which file this is, and nobody needs the binary's
  // name or its source location
  const msg = line
    ?.replace(/^[\w.-]*identify[^:]*:\s*/i, '')
    .replace(/\s*@\s*error\/.*$/, '')
    .replace(/\s*`[^`]*'\s*$/, '')
  return msg ? cap(msg) : 'This image could not be read.'
}

// ------------------------------------------------------------------ audio/video

interface FfStream {
  index?: number
  codec_name?: string
  codec_long_name?: string
  profile?: string
  codec_type?: string
  width?: number
  height?: number
  pix_fmt?: string
  sample_rate?: string
  channels?: number
  channel_layout?: string
  bit_rate?: string
  r_frame_rate?: string
  avg_frame_rate?: string
  tags?: Record<string, string>
  disposition?: Record<string, number>
  duration?: string
}

interface FfFormat {
  format_name?: string
  format_long_name?: string
  duration?: string
  bit_rate?: string
  tags?: Record<string, string>
}

/** ISO 639 codes common enough in real media that showing the raw code would be
 *  a needless puzzle; anything else falls through as its own code. */
const LANGUAGES: Record<string, string> = {
  eng: 'English', en: 'English', spa: 'Spanish', es: 'Spanish', fra: 'French', fre: 'French',
  fr: 'French', deu: 'German', ger: 'German', de: 'German', ita: 'Italian', it: 'Italian',
  por: 'Portuguese', pt: 'Portuguese', rus: 'Russian', ru: 'Russian', jpn: 'Japanese',
  ja: 'Japanese', kor: 'Korean', ko: 'Korean', zho: 'Chinese', chi: 'Chinese', zh: 'Chinese',
  ara: 'Arabic', nld: 'Dutch', dut: 'Dutch', swe: 'Swedish', nor: 'Norwegian', dan: 'Danish',
  fin: 'Finnish', pol: 'Polish', tur: 'Turkish', ces: 'Czech', cze: 'Czech', hun: 'Hungarian',
  ell: 'Greek', gre: 'Greek', heb: 'Hebrew', hin: 'Hindi', tha: 'Thai', vie: 'Vietnamese',
  ukr: 'Ukrainian', ron: 'Romanian', rum: 'Romanian', und: 'Undetermined',
}

function fps(s: FfStream): string | null {
  for (const v of [s.avg_frame_rate, s.r_frame_rate]) {
    const m = /^(\d+)\/(\d+)$/.exec(v ?? '')
    if (!m) continue
    const d = Number(m[2])
    if (!d) continue
    const f = Number(m[1]) / d
    if (!Number.isFinite(f) || f <= 0) continue
    return `${Math.abs(f - Math.round(f)) < 0.001 ? Math.round(f) : f.toFixed(2)} fps`
  }
  return null
}

/** tag keys vary in case between containers (MKV shouts, MP4 does not) */
function lowerTags(t: Record<string, string> | undefined): Map<string, string> {
  const m = new Map<string, string>()
  for (const [k, v] of Object.entries(t ?? {})) if (typeof v === 'string') m.set(k.toLowerCase(), v)
  return m
}

function streamRows(streams: FfStream[], rows: FactRow[], formatBitrate: number): void {
  // fonts and cover art ride along as attachment/data streams; a Details tab is
  // not a stream inspector, so only the playable ones get a section
  const shown = streams.filter(s => ['video', 'audio', 'subtitle'].includes(s.codec_type ?? ''))
  const total = new Map<string, number>()
  for (const s of shown) total.set(s.codec_type!, (total.get(s.codec_type!) ?? 0) + 1)
  const seen = new Map<string, number>()

  for (const s of shown.slice(0, MAX_STREAMS)) {
    const type = s.codec_type!
    const n = (seen.get(type) ?? 0) + 1
    seen.set(type, n)
    // only number the headings when there is more than one of a kind, or every
    // single-track file reads "Video 1"
    const G = cap(type) + (total.get(type)! > 1 ? ` ${n}` : '')

    // profile on its own row, not appended: half of ffprobe's long names already
    // end in parentheses, and "AAC (Advanced Audio Coding) (HE-AAC)" is a mess
    rowsPush(rows, G, 'Codec', s.codec_long_name || s.codec_name)
    rowsPush(rows, G, 'Profile', s.profile)
    if (s.width && s.height) rowsPush(rows, G, 'Frame size', dimensions(s.width, s.height))
    if (type === 'video') rowsPush(rows, G, 'Frame rate', fps(s))
    rowsPush(rows, G, 'Pixel format', s.pix_fmt)
    const sr = Number(s.sample_rate)
    if (Number.isFinite(sr) && sr > 0) rowsPush(rows, G, 'Sample rate', `${num(sr / 1000)} kHz`)
    if (s.channels) {
      rowsPush(rows, G, 'Channels',
        s.channel_layout ? `${cap(s.channel_layout)} (${s.channels})` : `${s.channels}`)
    }
    // in a single-stream file the stream bit rate IS the file bit rate, already
    // shown above; repeating it makes an MP3 look like it has two of them
    const br = Number(s.bit_rate)
    if (Number.isFinite(br) && br > 0 && !(streams.length === 1 && formatBitrate > 0)) {
      rowsPush(rows, G, 'Bit rate', bitrate(br))
    }
    const tags = lowerTags(s.tags)
    const lang = (tags.get('language') ?? '').trim().toLowerCase()
    // 'und' is what every MP4 muxer writes when nobody set a language; saying
    // "Undetermined" on each track of every phone video is pure noise
    if (lang && lang !== 'und') rowsPush(rows, G, 'Language', LANGUAGES[lang] ?? lang)
    rowsPush(rows, G, 'Title', tags.get('title'))
  }

  const hidden = streams.length - Math.min(shown.length, MAX_STREAMS)
  if (hidden > 0) rowsPush(rows, undefined, 'Other streams', count(hidden))
}

async function probeAv(p: string, ms: number): Promise<{ rows: FactRow[]; error?: string }> {
  const r = await run('ffprobe',
    ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', '--', p], ms)
  if (r.timedOut) return { rows: [], error: TIMED_OUT }
  let data: { format?: FfFormat; streams?: FfStream[] }
  try { data = JSON.parse(r.out) } catch { return { rows: [], error: avError(r) } }
  const f = data.format ?? {}
  const streams = Array.isArray(data.streams) ? data.streams : []
  // parsed JSON is not proof of a media file: ffprobe emits {} for a text file
  if (!streams.length && !f.format_name) return { rows: [], error: avError(r) }

  const rows: FactRow[] = []
  const tags = lowerTags(f.tags)
  rowsPush(rows, undefined, 'Title', tags.get('title'))
  rowsPush(rows, undefined, 'Artist', tags.get('artist') ?? tags.get('album_artist'))
  rowsPush(rows, undefined, 'Album', tags.get('album'))
  rowsPush(rows, undefined, 'Year', tags.get('date') ?? tags.get('year'))

  const dur = Number(f.duration)
  if (Number.isFinite(dur) && dur > 0) rowsPush(rows, undefined, 'Length', duration(dur))
  const br = Number(f.bit_rate)
  if (Number.isFinite(br) && br > 0) rowsPush(rows, undefined, 'Bit rate', bitrate(br))
  rowsPush(rows, undefined, 'Container', f.format_long_name || f.format_name)

  streamRows(streams, rows, Number.isFinite(br) ? br : 0)
  if (!rows.length) return { rows: [], error: avError(r) }
  return { rows }
}

function avError(r: Proc): string {
  const line = r.err.split('\n').map(s => s.trim()).filter(Boolean).pop()
  return line ? cap(line.replace(/^.*?:\s*/, '')) : 'This file could not be read as media.'
}

// ------------------------------------------------------------------ pdf

/** "Key:   value" lines; a value may itself contain colons, so only the first
 *  one separates. */
function parsePdfInfo(text: string): Map<string, string> {
  const out = new Map<string, string>()
  for (const line of text.split('\n')) {
    const c = line.indexOf(':')
    if (c <= 0) continue
    const k = line.slice(0, c).trim()
    const v = line.slice(c + 1).trim()
    if (k && v && !out.has(k)) out.set(k, v)
  }
  return out
}

function isoDate(v: string | undefined): number | null {
  if (!v) return null
  const t = Date.parse(v)
  return Number.isFinite(t) ? t : null
}

async function probePdf(p: string, ms: number): Promise<{ rows: FactRow[]; error?: string }> {
  const r = await run('pdfinfo', ['-isodates', '-enc', 'UTF-8', '--', p], ms)
  if (r.timedOut) return { rows: [], error: TIMED_OUT }
  const info = parsePdfInfo(r.out)
  const pages = Number(info.get('Pages'))
  // every readable PDF reports a page count; without it the run produced nothing
  // usable however it exited
  if (!Number.isFinite(pages) || pages <= 0) return { rows: [], error: pdfError(r) }

  const G = 'Document'
  const rows: FactRow[] = []
  rowsPush(rows, G, 'Title', info.get('Title'))
  rowsPush(rows, G, 'Author', info.get('Author'))
  rowsPush(rows, G, 'Subject', info.get('Subject'))
  rowsPush(rows, G, 'Pages', count(pages))
  rowsPush(rows, G, 'Page size', info.get('Page size')?.replace(/\bx\b/, '×'))
  const created = isoDate(info.get('CreationDate'))
  if (created !== null) rowsPush(rows, G, 'Content created', formatDate(created))
  const modified = isoDate(info.get('ModDate'))
  if (modified !== null) rowsPush(rows, G, 'Date last saved', formatDate(modified))
  rowsPush(rows, G, 'Application', info.get('Creator'))
  rowsPush(rows, G, 'PDF producer', info.get('Producer'))
  rowsPush(rows, G, 'PDF version', info.get('PDF version'))
  // an unencrypted PDF is the overwhelming default; a "Protected: No" row on
  // every document is noise, so only the exception is shown
  const enc = info.get('Encrypted')
  if (enc && !/^no\b/i.test(enc)) rowsPush(rows, G, 'Protected', 'Yes')
  return { rows }
}

function pdfError(r: Proc): string {
  const line = r.err.split('\n').map(s => s.trim()).filter(Boolean)
    .find(l => /error|password|damaged/i.test(l))
  if (line && /password/i.test(line)) return 'This PDF needs a password.'
  return line ? cap(line.replace(/^Command Line Error:\s*/i, '')) : 'This PDF could not be read.'
}

// ------------------------------------------------------------------ archive

async function probeArchive(p: string, ms: number): Promise<{ rows: FactRow[]; error?: string }> {
  // backend.list() has no timeout of its own — it is normally driven by the op
  // engine, which owns cancellation. onChild is that hook, so the deadline
  // reaches the child here too. It has to keep killing after it fires, not just
  // once: list() runs 7z and then falls back to lsar, and killing only the tool
  // that happened to be running lets the NEXT one start with no budget left.
  let child: ChildProcess | null = null
  let expired = false
  const kill = (c: ChildProcess | null): void => { try { c?.kill('SIGKILL') } catch { /* gone */ } }
  const timer = setTimeout(() => { expired = true; kill(child) }, ms)
  let listing: archive.ArchiveListing
  try {
    listing = await archive.list(p, { onChild: c => { child = c; if (expired) kill(c) } })
  } catch {
    return { rows: [] }
  } finally {
    clearTimeout(timer)
  }
  // A listing that failed, needs a password, or was killed by the deadline is
  // not an error worth a banner — it is an archive whose contents we simply do
  // not know yet, and the archive view is where the user resolves that.
  if (!listing.ok) return { rows: [] }

  const dirs = new Set<string>()
  let files = 0
  for (const e of listing.entries) {
    const clean = e.path.replace(/\/+$/, '')
    if (e.isDir) { if (clean) dirs.add(clean); continue }
    files++
    // plenty of zips store no directory entries at all; derive the folders from
    // the member paths or the count contradicts the archive browser
    let d = clean.slice(0, Math.max(0, clean.lastIndexOf('/')))
    while (d) {
      dirs.add(d)
      d = d.slice(0, Math.max(0, d.lastIndexOf('/')))
    }
  }

  const G = 'Archive'
  const rows: FactRow[] = []
  rowsPush(rows, G, 'Format', listing.type ? cap(listing.type) : '')
  rowsPush(rows, G, 'Files', count(files))
  rowsPush(rows, G, 'Folders', count(dirs.size))
  if (listing.totalSize > 0) rowsPush(rows, G, 'Uncompressed size', formatSize(listing.totalSize))
  if (listing.encrypted) rowsPush(rows, G, 'Protected', 'Yes')
  return { rows }
}

// ------------------------------------------------------------------ dispatch

function kindFor(p: string): FactsKind {
  const name = path.basename(p)
  const mime = mimeForName(name, false)
  if (mime === 'application/pdf') return 'pdf'
  if (mime.startsWith('image/')) return 'image'
  if (mime.startsWith('video/') || mime.startsWith('audio/')) return 'av'
  if (archive.isArchiveName(name)) return 'archive'
  return 'none'
}

function blank(p: string, over: Partial<FileFacts> = {}): FileFacts {
  return { path: p, mtime: 0, size: 0, kind: 'none', rows: [], ...over }
}

const cacheKey = (p: string, st: Stats): string => `${p}\0${st.mtimeMs}\0${st.size}`

/** path+mtime+size, so an edit invalidates itself. Bounded and cleared whole on
 *  overflow, like negCache in protocols.ts — an LRU would cost more bookkeeping
 *  than a re-probe. */
const cache = new Map<string, FileFacts>()
const MAX_CACHE = 2000
/** concurrent asks for the same file share one probe */
const inflight = new Map<string, Promise<FileFacts>>()

async function probe(p: string, st: Stats): Promise<FileFacts> {
  const base = blank(p, { mtime: st.mtimeMs, size: st.size })
  // directories, sockets, devices: nothing to probe, and no error either
  if (!st.isFile()) return base
  const kind = kindFor(p)
  if (kind === 'none') return base

  await acquireSlot()
  let res: { rows: FactRow[]; error?: string }
  try {
    res = kind === 'image' ? await probeImage(p, CHILD_TIMEOUT_MS)
      : kind === 'av' ? await probeAv(p, CHILD_TIMEOUT_MS)
        : kind === 'pdf' ? await probePdf(p, CHILD_TIMEOUT_MS)
          : await probeArchive(p, CHILD_TIMEOUT_MS)
  } finally {
    releaseSlot()
  }
  return { ...base, kind, rows: res.rows, ...(res.error ? { error: res.error } : {}) }
}

export async function fileFacts(p: string): Promise<FileFacts> {
  // archive:// , trash:// and computer:// rows are not files; probing one would
  // spawn a tool against a string that no filesystem has ever heard of
  if (!p || !p.startsWith('/')) return blank(p)

  const work = (async (): Promise<FileFacts> => {
    const { st, error } = await statDeadline(p, CHILD_TIMEOUT_MS)
    if (!st) return blank(p, { error: error ?? TIMED_OUT })
    const key = cacheKey(p, st)
    const hit = cache.get(key)
    if (hit) return hit
    const running = inflight.get(key)
    if (running) return running

    const job = probe(p, st)
    inflight.set(key, job)
    try {
      const facts = await job
      // a timeout is a fact about the mount, not about the file — caching it
      // would make one slow moment permanent until the file changes
      if (!facts.error) {
        if (cache.size >= MAX_CACHE) cache.clear()
        cache.set(key, facts)
      }
      return facts
    } finally {
      inflight.delete(key)
    }
  })()

  return withDeadline(work, FACTS_TIMEOUT_MS, () => blank(p, { error: TIMED_OUT }))
}

export async function fileFactsMany(paths: string[]): Promise<FileFacts[]> {
  const list = (Array.isArray(paths) ? paths : []).slice(0, MANY_CAP)
  const out: FileFacts[] = list.map(p => blank(p, { error: TIMED_OUT }))
  const work = Promise.all(list.map(async (p, i) => { out[i] = await fileFacts(p) }))
  // the per-file deadline already bounds each entry; this bounds the QUEUE, so a
  // full batch on a wedged mount cannot hold the caller for 500/MAX_PROBES × 5 s
  await withDeadline(work.then(() => undefined), MANY_TIMEOUT_MS, () => undefined)
  return out
}

/**
 * Just the running time, for the badge on a video thumbnail.
 *
 * It rides the same cache and the same probe pool as fileFacts rather than
 * keeping its own: a folder where the tiles have asked for durations is exactly
 * a folder where the Details tab is about to be asked for the rest, and the
 * second question should then be free. Missing entries come back absent rather
 * than as an error — the badge is an ornament, and a folder of 500 videos must
 * not become 500 error objects crossing IPC.
 */
export async function mediaDurations(paths: string[]): Promise<Record<string, string>> {
  const out: Record<string, string> = {}
  const facts = await fileFactsMany(paths)
  for (const f of facts) {
    if (f.kind !== 'av' || f.error) continue
    const row = f.rows.find(r => r.label === 'Length')
    if (row) out[f.path] = row.value
  }
  return out
}

/**
 * The codec/container facts the play planner needs, and nothing else.
 *
 * Deliberately NOT derived from fileFacts: those rows are formatted for humans
 * ("H.264 High @ L4.0"), and parsing a display string back into a codec name is
 * exactly the kind of round-trip that breaks the first time a label is reworded.
 * This asks ffprobe for the raw identifiers instead, and keeps its own tiny
 * cache on the same path+mtime+size identity.
 */
const planCache = new Map<string, StreamInfo | null>()
/** the raw ffprobe answer, shared so that opening one video costs ONE probe */
const rawCache = new Map<string, ProbeJson | null>()

export interface ProbeJson { format?: FfFormat; streams?: FfStream[] }

/**
 * One `ffprobe -show_format -show_streams` per file, cached on path+mtime+size
 * and shared by everything that needs it.
 *
 * It exists because opening a single video was spawning two identical probes —
 * one to decide how to play it, one to list its tracks — and on a share that is
 * two round trips for an answer that cannot have changed in between.
 */
export async function probeStreams(p: string): Promise<ProbeJson | null> {
  if (!p.startsWith('/')) return null
  let st: Stats
  try { st = await fsp.stat(p) } catch { return null }
  if (!st.isFile()) return null
  const key = cacheKey(p, st)
  if (rawCache.has(key)) return rawCache.get(key) ?? null

  await acquireSlot()
  let r: Proc
  try {
    r = await run('ffprobe',
      ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', '--', p], CHILD_TIMEOUT_MS)
  } finally { releaseSlot() }
  let data: ProbeJson | null = null
  try {
    const parsed = JSON.parse(r.out) as ProbeJson
    // parsed JSON is not proof of a media file: ffprobe emits {} for a text file
    if (parsed.format?.format_name || parsed.streams?.length) data = parsed
  } catch { /* not a media file */ }

  if (rawCache.size >= MAX_CACHE) rawCache.clear()
  rawCache.set(key, data)
  return data
}

export async function streamInfo(p: string): Promise<StreamInfo | null> {
  if (!p.startsWith('/')) return null
  let st: Stats
  try { st = await fsp.stat(p) } catch { return null }
  if (!st.isFile()) return null
  const key = cacheKey(p, st)
  if (planCache.has(key)) return planCache.get(key) ?? null

  const data = await probeStreams(p)
  let info: StreamInfo | null = null
  try {
    if (!data) throw new Error('no probe')
    const streams = Array.isArray(data.streams) ? data.streams : []
    // the FIRST of each type, which is what a <video> element would pick too
    const v = streams.find(s => s.codec_type === 'video' && !isCoverArt(s))
    const a = streams.find(s => s.codec_type === 'audio')
    const format = String(data.format?.format_name ?? '')
    if (format || v || a) {
      // duration lives on the format for most containers and on the stream for
      // a few; take whichever is present rather than trusting one of them
      const dur = Number(data.format?.duration ?? v?.duration ?? a?.duration ?? 0)
      info = {
        vcodec: String(v?.codec_name ?? ''),
        acodec: String(a?.codec_name ?? ''),
        format,
        duration: Number.isFinite(dur) && dur > 0 ? dur : 0,
        width: Number(v?.width) || 0,
        height: Number(v?.height) || 0,
      }
    }
  } catch { /* not a media file, or ffprobe is missing: info stays null */ }

  if (planCache.size >= MAX_CACHE) planCache.clear()
  planCache.set(key, info)
  return info
}

/**
 * An embedded cover picture is a video stream as far as ffprobe is concerned,
 * and treating an MP3's artwork as "the video track" would send every tagged
 * MP3 down the transcode path.
 *
 * The disposition flag is the authority. Matching on codec name alone is not
 * good enough and was wrong in a way real files hit: a Canon camera's AVI is
 * genuine MJPEG VIDEO at 30 fps, and calling it artwork left the file playing
 * with no picture at all (measured: 0x0). A still frame has no frame rate, so
 * the rate is what separates the two when the flag is absent.
 */
function isCoverArt(s: FfStream): boolean {
  if (s.disposition?.attached_pic === 1) return true
  if (!ATTACHED_PIC_CODECS.has(String(s.codec_name))) return false
  const rate = String(s.avg_frame_rate ?? '')
  return rate === '' || rate === '0/0'
}
const ATTACHED_PIC_CODECS = new Set(['mjpeg', 'png', 'bmp', 'gif'])

// ------------------------------------------------------- self-registered IPC

ipcMain.handle(CH('fileFacts'), (_e, p: string) => fileFacts(p))
ipcMain.handle(CH('fileFactsMany'), (_e, paths: string[]) => fileFactsMany(paths))
ipcMain.handle(CH('mediaDurations'), (_e, paths: string[]) => mediaDurations(paths))
ipcMain.handle(CH('streamInfo'), (_e, p: string) => streamInfo(p))
