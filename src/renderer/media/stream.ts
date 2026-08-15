// A transcoded video, presented as if it were an ordinary seekable one.
//
// The stream arriving over liqplay:// has no index and no length: ffmpeg starts
// wherever it was told to and produces fragments until something stops it. So
// the <video> element's own currentTime always counts from zero at whatever
// point the stream began, and its duration is meaningless.
//
// This wraps that into one continuous timeline:
//
//   real position = offset + element.currentTime
//   real duration = the probed duration, which the element never knows
//   seek(t)       = throw the stream away and start a new one at t
//
// A restart is not free — it is a fresh ffmpeg and a fresh keyframe hunt,
// measured at 161-245 ms on this machine — so scrubbing is debounced: dragging
// the scrub bar moves the displayed position immediately and only restarts the
// stream once the user lets go. Without that, one drag across a two-hour film
// would spawn and kill a hundred encoders.
import type { PlayMode, StreamInfo } from '../../shared/playplan'
import { previewURL } from '../../shared/preview'

/** wait this long after the last seek request before restarting ffmpeg */
const SEEK_DEBOUNCE_MS = 260

export interface StreamSource {
  mode: PlayMode
  /** the real length in seconds, from the probe */
  duration: number
  /** the real position: where the stream started, plus how far it has played */
  currentTime(): number
  /** restart the stream at `sec` */
  seek(sec: number): void
  /** true between a seek request and the restart actually landing */
  seeking(): boolean
  /**
   * Swap to a finished conversion on disk, keeping the position.
   *
   * From this point the file is an ordinary seekable MP4 served over liqfile://,
   * so restart-seeking is switched off and the element's own timeline becomes
   * the real one — which is why `offset` goes to zero and `direct` is latched.
   */
  upgrade(cachedFile: string): void
  /** true once upgrade() has taken effect */
  isUpgraded(): boolean
  /** seconds of the file that the element's own time 0 corresponds to. Subtitle
   *  cues are written against the FILE's timeline, so they have to be shifted
   *  by -this to stay in step after a restart-seek. */
  offsetNow(): number
  /** carry a different audio track; restarts the stream at the current position */
  setAudioTrack(n: number): void
  audioTrack(): number
  /** called after every restart/upgrade, so the caller can re-shift subtitles */
  onTimelineChange(fn: () => void): () => void
  dispose(): void
}

export function playURL(path: string, startSec: number, maxHeight: number, audioTrack = -1): string {
  const q = new URLSearchParams()
  q.set('path', path)
  if (startSec > 0) q.set('t', String(Math.floor(startSec)))
  q.set('h', String(maxHeight))
  if (audioTrack >= 0) q.set('a', String(audioTrack))
  return `liqplay://play/?${q.toString()}`
}

export function attachStream(
  media: HTMLMediaElement,
  path: string,
  info: StreamInfo,
  mode: PlayMode,
  maxHeight: number,
  onRestart?: () => void,
  /** where to begin — non-zero when taking over from playback already under way */
  startAt = 0,
): StreamSource {
  let offset = Math.max(0, Math.floor(startAt))
  /** where the user has asked to be, while the restart is still in flight */
  let pending = -1
  let timer = 0
  let disposed = false
  /** latched by upgrade(): the element is now playing a real seekable file */
  let direct = false
  let audio = -1
  const timelineListeners = new Set<() => void>()
  const timelineChanged = (): void => { for (const fn of [...timelineListeners]) fn() }

  media.src = playURL(path, offset, maxHeight, audio)

  function restart(): void {
    if (disposed || pending < 0) return
    // FLOOR HERE, once, because playURL floors what it sends to ffmpeg. Keeping
    // the fraction in `offset` while the stream really began on the whole
    // second put every subtitle cue out by that fraction — measured as a
    // constant -446 ms drift before this line existed.
    const at = Math.floor(pending)
    pending = -1
    offset = at
    const wasPlaying = !media.paused
    media.src = playURL(path, at, maxHeight, audio)
    media.load()
    if (wasPlaying) {
      // autoplay after a programmatic load is allowed here because the element
      // was already playing; a rejection just leaves it paused
      media.addEventListener('loadeddata', () => { void media.play().catch(() => {}) }, { once: true })
    }
    onRestart?.()
    timelineChanged()
  }

  return {
    mode,
    duration: info.duration,
    currentTime(): number {
      // while a seek is pending, report where the user asked to be — otherwise
      // the scrub knob snaps back to the old position for a quarter second
      if (pending >= 0 && !direct) return pending
      return offset + (Number.isFinite(media.currentTime) ? media.currentTime : 0)
    },
    seek(sec: number): void {
      if (disposed) return
      const at = Math.max(0, Math.min(sec, info.duration || sec))
      if (direct) { media.currentTime = at; return }
      pending = at
      window.clearTimeout(timer)
      timer = window.setTimeout(restart, SEEK_DEBOUNCE_MS)
    },
    seeking: () => pending >= 0,
    upgrade(cachedFile: string): void {
      if (disposed || direct || !cachedFile) return
      const at = pending >= 0 ? pending : offset + (Number.isFinite(media.currentTime) ? media.currentTime : 0)
      const wasPlaying = !media.paused
      window.clearTimeout(timer)
      pending = -1
      direct = true
      offset = 0
      media.src = previewURL(cachedFile, { type: 'video/mp4' })
      media.load()
      media.addEventListener('loadedmetadata', () => {
        // land exactly where the stream had got to, so the swap is invisible
        if (at > 0 && Number.isFinite(media.duration)) {
          media.currentTime = Math.min(at, Math.max(0, media.duration - 0.25))
        }
        if (wasPlaying) void media.play().catch(() => {})
      }, { once: true })
      onRestart?.()
      timelineChanged()
    },
    isUpgraded: () => direct,
    offsetNow: () => (direct ? 0 : offset),
    audioTrack: () => audio,
    setAudioTrack(n: number): void {
      if (disposed || n === audio) return
      audio = n
      // an upgraded file carries only the default track, so choosing another
      // one means going back to the live stream — which is the only place a
      // different -map can be applied
      const at = offset + (Number.isFinite(media.currentTime) ? media.currentTime : 0)
      direct = false
      pending = at
      window.clearTimeout(timer)
      restart()
    },
    onTimelineChange(fn: () => void): () => void {
      timelineListeners.add(fn)
      return () => timelineListeners.delete(fn)
    },
    dispose(): void {
      disposed = true
      window.clearTimeout(timer)
    },
  }
}
