// Subtitles on a <track>, including the awkward case: a transcoded stream.
//
// For an ordinary file this is dull — fetch WebVTT, make a blob, attach it. The
// interesting part is that a transcoded stream RESTARTS ITS CLOCK on every seek
// (see media/stream.ts): ffmpeg is told `-ss 900`, so the element's time zero is
// the file's 15:00. Subtitle cues are written against the file's own timeline,
// so attaching them unshifted puts every line fifteen minutes out — and, worse,
// it looks like the subtitles are simply broken rather than misaligned.
//
// So the VTT is fetched ONCE and re-shifted from the same source text whenever
// the timeline moves. Re-shifting from the original each time (rather than
// shifting the previous result) is what keeps repeated seeks from accumulating
// rounding drift.
import { shiftVtt } from '../../shared/tracks'
import type { StreamSource } from './stream'

export interface SubtitleAttachment {
  /** switch to a different subtitle track, or -1 for none */
  select(n: number): Promise<void>
  current(): number
  dispose(): void
}

export function attachSubtitles(
  media: HTMLMediaElement,
  path: string,
  getStream: () => StreamSource | undefined,
  onError?: (msg: string) => void,
): SubtitleAttachment {
  let current = -1
  let source = ''
  let url = ''
  let node: HTMLTrackElement | null = null
  let offTimeline: (() => void) | null = null
  let disposed = false
  /** guards against a slow fetch landing after the user picked another track */
  let token = 0

  function revoke(): void {
    if (url) { URL.revokeObjectURL(url); url = '' }
  }

  function paint(): void {
    if (disposed || !source) return
    const offset = getStream()?.offsetNow() ?? 0
    const text = shiftVtt(source, -offset)
    revoke()
    url = URL.createObjectURL(new Blob([text], { type: 'text/vtt' }))
    if (!node) {
      node = document.createElement('track')
      node.kind = 'subtitles'
      node.default = true
      media.appendChild(node)
    }
    node.src = url
    // the mode has to be set AFTER the browser has adopted the track element,
    // and re-set on every swap: replacing .src resets it to 'disabled'
    const apply = (): void => {
      const t = node?.track
      if (t) t.mode = 'showing'
    }
    apply()
    // ...and again once it has loaded, because a track whose cues are not
    // parsed yet reports a mode that does not stick
    node.addEventListener('load', apply, { once: true })
  }

  function detach(): void {
    offTimeline?.()
    offTimeline = null
    revoke()
    node?.remove()
    node = null
    source = ''
  }

  return {
    current: () => current,
    async select(n: number): Promise<void> {
      const mine = ++token
      if (n < 0) { current = -1; detach(); return }
      current = n
      const vtt = await window.liq?.invoke?.('subtitleVtt', path, n).catch(() => '') as string
      if (disposed || mine !== token) return
      if (!vtt) {
        current = -1
        detach()
        onError?.('That subtitle track could not be read.')
        return
      }
      source = vtt
      paint()
      // re-shift whenever a seek restarts the stream underneath us
      offTimeline?.()
      offTimeline = getStream()?.onTimelineChange(() => paint()) ?? null
    },
    dispose(): void {
      disposed = true
      detach()
    },
  }
}
