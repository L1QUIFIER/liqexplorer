// "Put this file on screen inside that element" — the one piece of per-type
// rendering shared by everything that shows a file's CONTENT rather than a
// listing row: the floating media viewer (media/viewer.ts), its popped-out
// window (media/popout.ts), and any future peek/quick-look popover.
//
// Deliberately tiny and self-contained: it imports nothing from core/app, so a
// page that never boots the file manager (the pop-out window) can use it, and
// it owns no chrome — no captions, no toolbar, no keyboard. Callers get an
// element plus the underlying <img>/<video>/<audio> and drive it themselves.
//
// Everything streams through liqfile:// (see shared/preview.ts): media is never
// read into memory here, which matters because the user's library lives on a
// CIFS share. Text is the one exception and it is capped main-side at 256 KB.
import { PREVIEW, classifyPreview, likelyPlayable, previewURL, type PreviewTextResult } from '../../shared/preview'
import { takePreloaded } from './preload'
import { attachStream, type StreamSource } from './stream'
// the literal rather than an import of shared/ipc: this module is also loaded by
// the pop-out page, and its bundle should not pull the whole IPC vocabulary in
const PUSH_MEDIA_CACHE_READY = 'liqpush:media-cache-ready'
import { decidePlay, type StreamInfo } from '../../shared/playplan'

/** The subset of FileEntry this module needs — FileEntry satisfies it. */
export interface MediaItem {
  path: string
  name: string
  /** lowercase, no dot */
  ext: string
  mime: string
  size: number
  isDir?: boolean
}

/** What the viewer can actually display. 'other' = we can only offer a thumbnail. */
export type ViewKind = 'image' | 'video' | 'audio' | 'pdf' | 'text' | 'other'

const VIEW_KINDS = new Set<ViewKind>(['image', 'video', 'audio', 'pdf', 'text'])

/** What we ASK Chromium to decode, which is not always the file's real mime:
 *  .mov is usually h264/aac in a QuickTime container Chromium demuxes happily,
 *  but canPlayType('video/quicktime') is ''. Kept here (not in shared/preview)
 *  because it is a rendering detail, not part of the preview vocabulary. */
const PROBE_MIME: Record<string, string> = {
  mp4: 'video/mp4', m4v: 'video/mp4', mov: 'video/mp4', webm: 'video/webm',
  ogv: 'video/ogg', mkv: 'video/x-matroska', avi: 'video/x-msvideo',
  mp3: 'audio/mpeg', m4a: 'audio/mp4', m4b: 'audio/mp4', aac: 'audio/aac',
  flac: 'audio/flac', ogg: 'audio/ogg', oga: 'audio/ogg', opus: 'audio/ogg',
  wav: 'audio/wav', wave: 'audio/wav', mka: 'audio/webm',
}

export function probeMimeFor(item: MediaItem): string {
  return PROBE_MIME[item.ext] ?? item.mime
}

/** Classification collapsed to what this module renders (archives are listings,
 *  not content, so they are 'other' here even though the preview pane lists them). */
export function viewKindFor(item: MediaItem): ViewKind {
  const k = classifyPreview({ isDir: !!item.isDir, ext: item.ext, mime: item.mime, name: item.name })
  switch (k) {
    case 'image': case 'video': case 'audio': case 'pdf': case 'text': return k
    default: return 'other'
  }
}

export function isViewable(item: MediaItem): boolean {
  return !item.isDir && item.path.startsWith('/') && VIEW_KINDS.has(viewKindFor(item))
}

/**
 * Will Chromium play this?
 *
 * canPlayType() is a MIME ALLOWLIST, not a capability check, and for Matroska
 * it lies. Measured on this build: `canPlayType('video/x-matroska')` returns ''
 * for a VP9+Opus MKV and an H.264+Opus MKV that both then play perfectly —
 * 3840px and 1920px, readyState 4, currentTime advancing 2.96s in 2s of wall
 * time. Electron's libffmpeg does contain ff_matroska_demuxer; only the
 * allowlist is missing the type.
 *
 * So for containers Chromium demuxes but does not advertise, we say yes and let
 * the element's own `error` event be the verdict. Being wrong there costs a
 * fallback that is already built and already needed; being wrong the other way
 * refused files that work, which is what "lots of vids aren't playing" mostly
 * turned out to be.
 *
 * AVI, WMV/ASF and FLV are NOT in this list on purpose — libffmpeg has no
 * demuxer for any of them, and confirmed: an H.264+AAC FLV fails under every
 * MIME label. Those genuinely need ffmpeg.
 */
/**
 * Containers with no Chromium demuxer at all. Trying these directly is not
 * optimism, it is a guaranteed failure and a wasted round trip — confirmed for
 * FLV, which fails under every MIME label it can be given.
 */
const NO_DEMUXER = new Set(['avi', 'wmv', 'asf', 'flv', 'mpg', 'mpeg', 'vob',
  'ts', 'm2ts', 'mts', 'rm', 'rmvb', 'divx', 'wma', 'ogm'])

export function mustTranscode(item: MediaItem): boolean {
  return NO_DEMUXER.has(item.ext)
}

export function canDecode(item: MediaItem, kind: ViewKind): boolean {
  if (kind !== 'video' && kind !== 'audio') return true
  return likelyPlayable(item.ext, probeMimeFor(item), kind)
}

export interface RenderOptions {
  /** native <video>/<audio> controls; the viewer draws its own, so default off */
  controls?: boolean
  muted?: boolean
  /** called once the content is measurable (image decoded / metadata parsed) */
  onReady?: (h: MediaHandle) => void
  /** unrecoverable: no codec, unreadable file, decode failure */
  onError?: (message: string) => void
  /** we fell back to transcoding; the message explains what is being done */
  onTranscoding?: (why: string) => void
  /** a restart-seek landed, so any cached position/duration is stale */
  onRestart?: () => void
  /** tallest picture worth producing for this surface; the preview pane and
   *  hover previews are small, and encoding 4K to fill a 320px box is waste */
  maxHeight?: number
  /**
   * Convert the whole file in the background once it starts streaming.
   *
   * Right for the viewer, where the user has committed to watching something.
   * Wrong for a glance: arrowing down a folder of DVD rips would queue an hour
   * of encoding and tens of gigabytes for files nobody chose to watch. Hosts
   * that merely SHOW a file pass false.
   */
  backgroundConvert?: boolean
}

export interface MediaHandle {
  kind: ViewKind
  item: MediaItem
  /** the element added to the host (media element, <img>, <embed>, <pre>, ...) */
  element: HTMLElement
  /** set for kind video/audio */
  media: HTMLMediaElement | null
  /** set for kind image */
  image: HTMLImageElement | null
  /** set when the media is being transcoded: its element's own currentTime and
   *  duration are meaningless, and callers must go through this instead */
  stream?: StreamSource
  /** natural size once known (image/video), else 0 */
  width: number
  height: number
  dispose(): void
}

/** The honest dead end: what it is, and the way out. Used both when we know up
 *  front we cannot decode something and when the decoder tells us mid-load. */
function showCannotPlay(host: HTMLElement, item: MediaItem, kind: ViewKind): void {
  host.textContent = ''
  const label = item.ext ? item.ext.toUpperCase() : kind
  host.appendChild(thumbFallback(item))
  host.appendChild(el('div', 'mvr-note', `Nothing here can play this ${label}.`))
  const open = el('button', 'mvr-btn', 'Open in the default player')
  open.addEventListener('click', () => { void window.liq?.openPath?.(item.path) })
  host.appendChild(open)
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K, cls?: string, text?: string,
): HTMLElementTagNameMap[K] {
  const n = document.createElement(tag)
  if (cls) n.className = cls
  if (text !== undefined) n.textContent = text
  return n
}

/** Stop and DETACH a media element. Without removeAttribute('src') + load(),
 *  Chromium keeps the liqfile:// request alive and the read stream open. */
function detachMedia(m: HTMLMediaElement): void {
  try { m.pause() } catch { /* already gone */ }
  m.removeAttribute('src')
  try { m.load() } catch { /* detached */ }
}

/**
 * Ask the main process to convert this file properly in the background, and
 * swap the element over when it is done.
 *
 * Entirely optional — the stream already plays, and seeking through it costs
 * about 130 ms — so every failure here is silent by design: no conversion, no
 * swap, and the user keeps the playback they already had. Files above the
 * main-side size ceiling come back 'too-big' and are simply left streaming.
 */
function startBackgroundConvert(
  path: string, height: number, src: StreamSource, clears: Array<() => void>,
): void {
  const liq = window.liq
  if (!liq?.invoke || !liq.on) return
  let off: (() => void) | null = null
  const stop = (): void => { off?.(); off = null }
  clears.push(stop)

  off = liq.on(PUSH_MEDIA_CACHE_READY, (payload: unknown) => {
    const p = payload as { path?: string; file?: string }
    // the broadcast reaches every window and every open file
    if (p?.path !== path || !p.file) return
    stop()
    src.upgrade(p.file)
    void liq.invoke?.('mediaCachePin', p.file, true)
  })

  void liq.invoke('mediaCacheStatus', path, height).then((st: unknown) => {
    const s = st as { state?: string; file?: string }
    if (s?.state === 'ready' && s.file) {
      // converted on an earlier viewing: skip the stream entirely
      stop()
      src.upgrade(s.file)
      void liq.invoke?.('mediaCachePin', s.file, true)
      return
    }
    if (s?.state === 'none') void liq.invoke?.('mediaCacheStart', path, height)
  }).catch(() => { stop() })
}

/**
 * The cached thumbnail, shown while the full-resolution image is still coming
 * off the share, so pressing Next paints something immediately instead of
 * leaving an empty stage. It is the same picture at the same aspect ratio, just
 * soft — which reads as "loading" without needing a spinner.
 *
 * Held back by DELAY_MS: a photo already in the browser cache decodes in a
 * frame or two, and flashing a blurry version of it first would be worse than
 * showing nothing. Only images slow enough to actually wait for get one.
 */
function placeholder(host: HTMLElement, item: MediaItem): { clear: () => void } {
  const DELAY_MS = 110
  let node: HTMLImageElement | null = null
  const timer = window.setTimeout(() => {
    node = el('img', 'mvr-ph')
    node.alt = ''
    node.draggable = false
    // a missing thumbnail must not paint a broken-image glyph over the stage
    node.addEventListener('error', () => { node?.remove(); node = null }, { once: true })
    node.src = `liqthumb://?path=${encodeURIComponent(item.path)}&size=x-large`
    host.insertBefore(node, host.firstChild)
  }, DELAY_MS)
  return {
    clear(): void {
      window.clearTimeout(timer)
      node?.remove()
      node = null
    },
  }
}

/**
 * Render `item` into `host` (which is emptied first). Synchronous: the handle
 * comes back immediately and fills in width/height when the content loads.
 */
export function renderMedia(host: HTMLElement, item: MediaItem, opts: RenderOptions = {}): MediaHandle {
  host.textContent = ''
  const kind = viewKindFor(item)
  let disposed = false

  /** teardown owned by individual branches (placeholder timers, so far) */
  const clears: Array<() => void> = []

  const handle: MediaHandle = {
    kind, item, element: host, media: null, image: null, width: 0, height: 0,
    dispose(): void {
      if (disposed) return
      disposed = true
      for (const c of clears) c()
      handle.stream?.dispose()
      for (const m of Array.from(host.querySelectorAll('video, audio'))) detachMedia(m as HTMLMediaElement)
      host.textContent = ''
    },
  }
  const ready = (): void => { if (!disposed) opts.onReady?.(handle) }
  const fail = (msg: string): void => { if (!disposed) opts.onError?.(msg) }

  switch (kind) {
    case 'image': {
      // an element the preloader already fetched AND decoded, if it warmed this
      // one — adopting it skips both, which measured 1 ms against 84 ms for
      // building a fresh <img> on the same URL (see media/preload.ts)
      const pre = takePreloaded(item.path)
      const img = pre ?? el('img', 'mvr-img')
      img.className = 'mvr-img'
      img.draggable = false
      img.alt = ''
      // a decoded arrival must not flash a placeholder it will never need
      const ph = img.complete && img.naturalWidth > 0
        ? { clear(): void {} }
        : placeholder(host, item)
      const settle = (): void => {
        ph.clear()
        handle.width = img.naturalWidth
        handle.height = img.naturalHeight
        ready()
      }
      img.addEventListener('load', settle)
      img.addEventListener('error', () => { ph.clear(); fail('This image could not be decoded.') }, { once: true })
      if (!pre) img.src = previewURL(item.path, { type: item.mime })
      handle.element = img
      handle.image = img
      host.appendChild(img)
      clears.push(ph.clear)
      // an adopted element already fired its load: report size on the next tick
      // so the caller has its handle back before onReady runs
      if (img.complete && img.naturalWidth > 0) queueMicrotask(() => { if (!disposed) settle() })
      break
    }

    case 'video':
    case 'audio': {
      const m = kind === 'video' ? el('video', 'mvr-video') : el('audio', 'mvr-audio')
      m.controls = !!opts.controls
      // metadata only: a preload="auto" on a 4 GB file across the share would
      // pull the whole thing before the first frame ever showed
      m.preload = 'metadata'
      m.muted = !!opts.muted
      if (m instanceof HTMLVideoElement) m.playsInline = true
      m.addEventListener('loadedmetadata', () => {
        if (m instanceof HTMLVideoElement) { handle.width = m.videoWidth; handle.height = m.videoHeight }
        ready()
      })
      // The grid thumbnailer and this element read the same share, and eight
      // thumbnailer processes drown out one player trying to fill its buffer.
      // Hold them off while it does. Renewed on 'waiting' (a stall means the
      // share is the bottleneck, which is exactly when this matters) and let
      // go once playback is steady. The main-side hold is a self-expiring
      // lease, so a missed release costs a few seconds, not the session.
      const hold = (): void => { void window.liq?.invoke?.('holdThumbnails').catch(() => {}) }
      const letGo = (): void => { void window.liq?.invoke?.('releaseThumbnails').catch(() => {}) }
      m.addEventListener('loadstart', hold)
      m.addEventListener('waiting', hold)
      m.addEventListener('canplaythrough', letGo)
      m.addEventListener('pause', letGo)
      clears.push(letGo)
      // Since canDecode is deliberately optimistic about Matroska (it plays far
      // more often than canPlayType admits), the element's error IS the real
      // verdict for those — and it has to offer the same way out as a refusal
      // up front, or an MPEG-2 MKV would sit here as a dead panel instead of
      // opening in the player that can play it.
      // FALL THROUGH, DO NOT GIVE UP. Chromium's failure is the start of the
      // second attempt, not the end: ffmpeg can transcode almost anything into
      // something this element will take (see main/platform/transcode.ts). Only
      // when that fails too is the honest dead end shown.
      let triedTranscode = false
      const onDecodeFailure = (): void => {
        if (disposed || triedTranscode) return
        triedTranscode = true
        void beginTranscode()
      }
      /**
       * Take over from direct playback, keeping the position and play state.
       * Used both when the element reports an error and — more importantly —
       * when it does NOT: see checkSilentPlayback below.
       */
      const beginTranscode = async (): Promise<void> => {
        const info = await window.liq?.invoke?.('streamInfo', item.path).catch(() => null) as StreamInfo | null
        if (disposed) return
        if (!info) { showCannotPlay(host, item, kind); fail('no codec'); return }
        const plan = decidePlay(info)
        if (plan.mode === 'none' || plan.mode === 'direct') {
          // 'direct' here means the planner disagrees with the element about
          // what just failed — re-running the same request would only fail
          // again, so stop rather than loop
          showCannotPlay(host, item, kind)
          fail('no codec')
          return
        }
        m.addEventListener('error', () => {
          if (disposed) return
          showCannotPlay(host, item, kind)
          fail('no codec')
        }, { once: true })
        const height = opts.maxHeight ?? 720
        // carry over whatever direct playback had already reached, so a
        // mid-playback takeover does not throw the viewer back to the start
        const takeoverAt = Number.isFinite(m.currentTime) ? m.currentTime : 0
        const wasPlaying = !m.paused
        const src = attachStream(m, item.path, info, plan.mode, height, () => opts.onRestart?.(), takeoverAt)
        if (wasPlaying) m.addEventListener('loadeddata', () => { void m.play().catch(() => {}) }, { once: true })
        handle.stream = src
        opts.onTranscoding?.(plan.why)
        if (opts.backgroundConvert !== false) startBackgroundConvert(item.path, height, src, clears)
      }

      /**
       * THE FAILURE THAT DOES NOT FAIL.
       *
       * An MKV of H.264 video with an E-AC3 soundtrack plays. The picture is
       * perfect, no error fires, readyState reaches 4 — and there is no sound,
       * because Chromium decoded the video and silently dropped the audio it
       * cannot handle. Measured on a real file: 35.6 MB of video decoded, 0
       * bytes of audio, error null.
       *
       * Waiting for an error therefore cannot work. The probe is authoritative
       * and cheap (cached, and the track list needs it anyway), so it runs
       * alongside playback and takes over the moment it disagrees. Starting
       * direct first is still right: the common case — 349 plain H.264 MP4s —
       * gets its first frame without waiting for ffprobe.
       */
      const checkSilentPlayback = async (): Promise<void> => {
        const info = await window.liq?.invoke?.('streamInfo', item.path).catch(() => null) as StreamInfo | null
        if (disposed || triedTranscode || !info) return
        const plan = decidePlay(info)
        if (plan.mode === 'direct' || plan.mode === 'none') return
        triedTranscode = true
        await beginTranscode()
      }

      m.addEventListener('error', onDecodeFailure, { once: true })
      if (mustTranscode(item)) {
        // no demuxer exists for these, so the direct attempt is a guaranteed
        // round trip to a guaranteed failure — skip straight to ffmpeg
        triedTranscode = true
        void beginTranscode()
      } else {
        m.src = previewURL(item.path, { type: probeMimeFor(item) })
        void checkSilentPlayback()
      }
      handle.element = m
      handle.media = m
      if (kind === 'audio') host.appendChild(coverArt(item))
      host.appendChild(m)
      break
    }

    case 'pdf': {
      // Chromium's own PDF viewer, loaded over liqfile:// — index.html's CSP
      // grants object-src/frame-src for exactly this. The fragment is the
      // standard Adobe open-parameter set and is ignored where unsupported.
      const emb = el('embed', 'mvr-pdf')
      emb.type = 'application/pdf'
      emb.src = previewURL(item.path, { type: 'application/pdf', fragment: 'view=FitH' })
      handle.element = emb
      host.appendChild(emb)
      ready()
      break
    }

    case 'text': {
      const pre = el('pre', 'mvr-text')
      pre.textContent = 'Reading…'
      handle.element = pre
      host.appendChild(pre)
      window.liq.invoke('previewText', item.path, PREVIEW.textMaxBytes).then((res: PreviewTextResult) => {
        if (disposed) return
        if (!res || !res.ok) { pre.textContent = ''; fail(res?.timedOut ? 'This location is not responding.' : 'This file could not be read.'); return }
        if (res.binary) { pre.remove(); host.appendChild(thumbFallback(item)); fail('Binary file — no text preview.'); return }
        pre.textContent = res.text || ''
        if (res.truncated) {
          const n = el('div', 'mvr-note', `Showing the first ${Math.round(res.bytes / 1024)} KB of ${Math.round(res.size / 1024)} KB.`)
          host.insertBefore(n, pre)
        }
        ready()
      }, () => { if (!disposed) { pre.textContent = ''; fail('This file could not be read.') } })
      break
    }

    default: {
      host.appendChild(thumbFallback(item))
      host.appendChild(el('div', 'mvr-note', 'No preview available for this file type.'))
      fail('unsupported')
      break
    }
  }

  return handle
}

/** freedesktop thumbnail if one exists, otherwise the file-type icon */
function thumbFallback(item: MediaItem): HTMLElement {
  const wrap = el('div', 'mvr-fallback')
  const img = el('img', 'mvr-thumb')
  img.draggable = false
  img.addEventListener('error', () => {
    img.remove()
    const icon = el('img', 'mvr-icon')
    icon.draggable = false
    icon.src = `liqicon://application-x-generic?size=96`
    wrap.appendChild(icon)
  }, { once: true })
  img.src = `liqthumb://?path=${encodeURIComponent(item.path)}&size=x-large`
  wrap.appendChild(img)
  return wrap
}

/** album art for audio, filled in asynchronously from the main-side tag reader */
function coverArt(item: MediaItem): HTMLElement {
  const art = el('div', 'mvr-art')
  const icon = el('img', 'mvr-icon')
  icon.draggable = false
  icon.src = 'liqicon://audio-x-generic?size=96'
  art.appendChild(icon)
  const lines = el('div', 'mvr-tags')
  art.appendChild(lines)
  window.liq.invoke('previewTags', item.path).then((tags: { title?: string; artist?: string; album?: string; cover?: { mime: string; data: string } } | null) => {
    if (!tags || !art.isConnected) return
    if (tags.cover) {
      const img = el('img', 'mvr-cover')
      img.draggable = false
      img.src = `data:${tags.cover.mime};base64,${tags.cover.data}`
      icon.replaceWith(img)
    }
    if (tags.title) lines.appendChild(el('div', 'mvr-tag-title', tags.title))
    const sub = [tags.artist, tags.album].filter(Boolean).join('  ·  ')
    if (sub) lines.appendChild(el('div', 'mvr-tag-sub', sub))
  }, () => { /* no tag reader: the icon is the art */ })
  return art
}

/** 0:07 / 1:23:45 — the format both the viewer and its window title use */
export function clock(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) return '0:00'
  const s = Math.floor(sec)
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const r = s % 60
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}`
    : `${m}:${String(r).padStart(2, '0')}`
}
