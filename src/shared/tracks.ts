// Audio and subtitle tracks inside a media file.
//
// WHAT IS ACTUALLY IN THE LIBRARY, counted rather than guessed — it decides the
// whole shape of this feature:
//
//   202  subrip            text  -> converts to WebVTT cleanly
//    54  ass               text  -> converts, losing styling and positioning
//   299  hdmv_pgs_subtitle BITMAP -> a picture per cue; no text exists to show
//    15  dvd_subtitle      BITMAP -> same
//
// So the majority of subtitle tracks on this machine CANNOT be displayed by a
// <track> element at any price: they are images, and turning them into text
// would mean OCR. ffmpeg says so plainly — "Subtitle encoding currently only
// possible from text to text or bitmap to bitmap" — and the honest thing is to
// list those tracks and say why they are unavailable, rather than hide them
// (looks like we missed them) or offer them and fail (looks broken).

/** subtitle codecs that are text, and so can become WebVTT */
export const TEXT_SUB_CODECS = new Set(['subrip', 'srt', 'ass', 'ssa', 'webvtt', 'mov_text', 'text', 'stl'])

/** subtitle codecs that are pictures; listed, but never selectable */
export const BITMAP_SUB_CODECS = new Set(['hdmv_pgs_subtitle', 'dvd_subtitle', 'dvb_subtitle', 'xsub'])

export interface AudioTrack {
  /** index among AUDIO streams — what ffmpeg's `-map 0:a:N` takes. Not the
   *  absolute stream index, which for a typical MKV starts at 1, not 0. */
  n: number
  codec: string
  channels: number
  lang: string
  title: string
  /** the one the muxer marks as default */
  isDefault: boolean
}

export interface SubTrack {
  /** index among SUBTITLE streams, for `-map 0:s:N` */
  n: number
  codec: string
  lang: string
  title: string
  isDefault: boolean
  /** false for the bitmap formats; the picker shows these greyed with a reason */
  textBased: boolean
}

export interface MediaTracks {
  audio: AudioTrack[]
  subs: SubTrack[]
}

/** A human label for a track picker: "English — Atmos 5.1" and so on. */
export function trackLabel(t: AudioTrack | SubTrack, fallback: string): string {
  const lang = t.lang ? languageName(t.lang) : ''
  const parts: string[] = []
  if (lang) parts.push(lang)
  if (t.title && t.title.toLowerCase() !== lang.toLowerCase()) parts.push(t.title)
  if (!parts.length) parts.push(fallback)
  return parts.join(' — ')
}

/** The handful of ISO 639-2 codes that actually turn up here, plus a graceful
 *  fall-through: an unknown code shown as-is beats showing nothing. */
const LANGS: Record<string, string> = {
  eng: 'English', fre: 'French', fra: 'French', ger: 'German', deu: 'German',
  spa: 'Spanish', ita: 'Italian', jpn: 'Japanese', por: 'Portuguese', rus: 'Russian',
  chi: 'Chinese', zho: 'Chinese', kor: 'Korean', dut: 'Dutch', nld: 'Dutch',
  pol: 'Polish', swe: 'Swedish', dan: 'Danish', nor: 'Norwegian', fin: 'Finnish',
  ara: 'Arabic', hin: 'Hindi', tur: 'Turkish', cze: 'Czech', ces: 'Czech',
  hun: 'Hungarian', gre: 'Greek', ell: 'Greek', heb: 'Hebrew', tha: 'Thai',
  und: '',
}

export function languageName(code: string): string {
  const c = code.toLowerCase().slice(0, 3)
  if (c in LANGS) return LANGS[c]
  return code.toUpperCase()
}

// ---------------------------------------------------------------- VTT shifting

/**
 * WebVTT timestamps come in two shapes — `HH:MM:SS.mmm` and `MM:SS.mmm` — and
 * ffmpeg emits the short one whenever the hour is zero, which is most cues in
 * most files. A shifter that only understood the long form would silently skip
 * exactly the cues it was most likely to be given.
 */
const CUE_RE = /(\d{2,}:)?(\d{2}):(\d{2})\.(\d{3})\s*-->\s*(\d{2,}:)?(\d{2}):(\d{2})\.(\d{3})/g

function toSeconds(h: string | undefined, m: string, s: string, ms: string): number {
  return (h ? parseInt(h, 10) * 3600 : 0) + parseInt(m, 10) * 60 + parseInt(s, 10) + parseInt(ms, 10) / 1000
}

function fromSeconds(t: number): string {
  // Round to whole milliseconds FIRST. Doing it per-field instead lets a time
  // like 34.9996 produce ms=1000 and the malformed stamp "00:00:34.1000",
  // which a parser reads as 34.1 s — a cue silently landing most of a second
  // early rather than failing loudly.
  const totalMs = Math.max(0, Math.round(t * 1000))
  const h = Math.floor(totalMs / 3_600_000)
  const m = Math.floor((totalMs % 3_600_000) / 60_000)
  const s = Math.floor((totalMs % 60_000) / 1000)
  const ms = totalMs % 1000
  const pad = (n: number, w = 2): string => String(n).padStart(w, '0')
  return `${pad(h)}:${pad(m)}:${pad(s)}.${pad(ms, 3)}`
}

/**
 * Move every cue by `delta` seconds, dropping the ones that end up entirely in
 * the past.
 *
 * This exists because a transcoded stream restarts its clock at zero on every
 * seek: ffmpeg is told `-ss 900`, so the element's currentTime 0 IS the file's
 * 15:00, and subtitle cues written against the file's own timeline would be
 * fifteen minutes out. Shifting by -offset puts them back in step.
 */
export function shiftVtt(vtt: string, delta: number): string {
  if (!delta) return vtt
  return vtt.replace(CUE_RE, (_all, h1, m1, s1, ms1, h2, m2, s2, ms2) => {
    const start = toSeconds(h1, m1, s1, ms1) + delta
    const end = toSeconds(h2, m2, s2, ms2) + delta
    // a cue that finished before the stream began has nothing to show; give it
    // a zero-length slot at 0 rather than dropping the block, because dropping
    // it would mean re-serialising the whole file structure
    if (end <= 0) return `${fromSeconds(0)} --> ${fromSeconds(0)}`
    return `${fromSeconds(start)} --> ${fromSeconds(end)}`
  })
}
