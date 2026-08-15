// Can Chromium play this file, and if not, what is the cheapest thing that can
// be done about it?
//
// Every entry in the two capability sets below was MEASURED against this
// Electron build with canPlayType, not taken from documentation:
//
//   video  avc1.640028 probably | vp09 probably | av01 probably | vp8 probably
//          hev1 (HEVC) no | mp4v.20.8 (MPEG-4 ASP) no | video/mpeg no
//   audio  mp4a.40.2 probably | mpeg probably | opus probably | vorbis probably
//          flac probably | wav probably | ac-3 no | ec-3 no | dtsc no
//
// Note that vp8/vp9/av1 are decodable even though Electron's bundled libffmpeg
// exports no such decoders — those come from Chromium's own libvpx/libdav1d,
// which is exactly why reasoning from the ffmpeg build alone gives the wrong
// answer here.
//
// Containers are a separate axis from codecs and get their own set: an H.264 +
// AAC stream that Chromium would decode happily is still unplayable inside an
// AVI, because there is no AVI demuxer. That case needs a remux — a stream copy
// into a new container, no re-encoding — which is close to free.

/** video codecs Chromium decodes natively */
export const PLAYABLE_VIDEO = new Set(['h264', 'vp8', 'vp9', 'av1'])

/** audio codecs Chromium decodes natively */
export const PLAYABLE_AUDIO = new Set(['aac', 'mp3', 'opus', 'vorbis', 'flac',
  'pcm_s16le', 'pcm_s24le', 'pcm_u8', 'pcm_f32le'])

/**
 * Containers Chromium can demux. Keyed by ffprobe's format_name tokens, which
 * arrive comma-joined ("mov,mp4,m4a,3gp,3g2,mj2") — hence matching by token
 * rather than by whole string.
 */
export const PLAYABLE_CONTAINER = new Set(['mov', 'mp4', 'm4a', '3gp', '3g2',
  'matroska', 'webm', 'ogg', 'mp3', 'wav', 'flac', 'aac'])

/** Only h264 goes into the fragmented MP4 we generate, so anything else that
 *  needs a container change has to be re-encoded even if it was decodable. */
const MP4_VIDEO = new Set(['h264'])
/** and likewise for its audio */
const MP4_AUDIO = new Set(['aac', 'mp3'])

export type PlayMode =
  /** hand the file to Chromium untouched */
  | 'direct'
  /** stream-copy both tracks into fragmented MP4; no re-encoding */
  | 'remux'
  /** copy the video, re-encode only the audio (the AC3 case) */
  | 'audio'
  /** re-encode the video, and the audio if it needs it (the MPEG-2 / HEVC case) */
  | 'full'
  /** there is no video or audio track we can do anything with */
  | 'none'

export interface StreamInfo {
  /** ffprobe codec_name of the first video stream, '' if there is none */
  vcodec: string
  /** ffprobe codec_name of the first audio stream, '' if there is none */
  acodec: string
  /** ffprobe format_name, comma-joined as it comes */
  format: string
  /** seconds, 0 when unknown. A transcoded stream has no duration of its own —
   *  the player's whole timeline is drawn from this number. */
  duration: number
  /** source pixel size, 0 when unknown; used to avoid upscaling */
  width: number
  height: number
}

export interface PlayPlan {
  mode: PlayMode
  /** one sentence, shown to the user when it matters */
  why: string
}

function containerOK(format: string): boolean {
  return format.split(',').some(f => PLAYABLE_CONTAINER.has(f.trim()))
}

/**
 * Pick the cheapest route to playing `info`.
 *
 * The order of the checks is the point: video re-encoding is by far the most
 * expensive thing here, so it is only reached once copying has been ruled out.
 * A 20-file library of MPEG-2 DVD rips lands on 'full'; the H.264-in-AVI case
 * that looks equally broken to the user lands on 'remux' and costs almost
 * nothing.
 */
export function decidePlay(info: StreamInfo): PlayPlan {
  const v = info.vcodec.toLowerCase()
  const a = info.acodec.toLowerCase()
  const hasV = !!v
  const hasA = !!a
  if (!hasV && !hasA) return { mode: 'none', why: 'This file has no video or audio track.' }

  const vOK = !hasV || PLAYABLE_VIDEO.has(v)
  const aOK = !hasA || PLAYABLE_AUDIO.has(a)
  const cOK = containerOK(info.format)

  if (vOK && aOK && cOK) return { mode: 'direct', why: 'Plays as-is.' }

  // The video has to be re-encoded — the expensive branch, and the only one
  // that needs the GPU.
  if (!vOK) {
    return {
      mode: 'full',
      why: `${v.toUpperCase()} video needs converting${aOK ? '' : ` (and ${a.toUpperCase()} audio)`}.`,
    }
  }

  // Video is fine but cannot be carried in fragmented MP4 as-is (VP9/AV1), and
  // the container has to change anyway. Re-encoding is the honest answer rather
  // than producing a file that fails at the muxer.
  if (!cOK && hasV && !MP4_VIDEO.has(v)) {
    return { mode: 'full', why: `${v.toUpperCase()} in this container needs converting.` }
  }

  if (!aOK) return { mode: 'audio', why: `${a.toUpperCase()} audio needs converting; the picture is copied.` }

  // Everything decodes; only the wrapper is wrong.
  if (hasA && !MP4_AUDIO.has(a)) {
    return { mode: 'audio', why: `Repackaging, and converting the ${a.toUpperCase()} audio.` }
  }
  return { mode: 'remux', why: 'Repackaging only — no quality is lost.' }
}

/** Does this plan need ffmpeg at all? */
export function needsTranscode(plan: PlayPlan): boolean {
  return plan.mode === 'remux' || plan.mode === 'audio' || plan.mode === 'full'
}
