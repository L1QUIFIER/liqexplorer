// Per-type file preview rendering, lifted out of views/preview.ts so the peek
// popover (views/peek.ts) and the preview pane show a file the same way instead
// of owning two answers to "how do I display a PDF / video / archive".
//
// BOTH SURFACES NOW RENDER THROUGH HERE. The pane kept its own copies for a
// while — it was being rewritten in parallel when this module landed — and two
// copies of "how do I display a video" is exactly the drift this module exists
// to prevent, since a codec-gate fix has to be remembered twice. views/preview.ts
// now supplies a PreviewHost and keeps only what is genuinely its own: the
// caption, the empty/multi/folder cases, and what "still current" means. That
// removed 289 lines and left one place where each file type is decided.
//
// What each kind renders as (unchanged from the pane's original behaviour):
//   image   inline <img> through liqfile:// (animated GIF/WebP animate),
//           natural dimensions in the caption; non-decodable image formats
//           (tiff/psd/raw/heic) fall through to their liqthumb thumbnail
//   video   <video controls preload="metadata">, gated on canPlayType() so
//           mkv/avi/wmv show the thumbnail + "no built-in codec" instead of a
//           black box; a runtime error falls back the same way
//   audio   <audio controls> + title/artist/album and embedded cover art from
//           the main-side tag reader (ID3v2/ID3v1/FLAC/Ogg/MP4)
//   text    first PREVIEW.textMaxBytes, monospace, textContent (never innerHTML)
//   pdf     Chromium's built-in viewer via <embed type="application/pdf">
//           (verified working over liqfile:// under this CSP)
//   archive top-level listing with sizes, folders clickable to drill in
//   other   thumbnail if the freedesktop thumbnailers can make one, else the
//           big file icon and "No preview available."
//
// The HOST owns everything that differs between the two surfaces: where the
// caption goes, what "still current" means, and how a re-render is requested.
// Folders are the host's business too — the pane shows an icon, the popover
// shows a grid — so nothing here handles isDir.
//
// Cost control on slow mounts (the project's own share is a hard-mounted CIFS):
// every async result is dropped unless host.alive() still says the render is
// current (so arrowing down a list never renders a stale row), reads are
// size-capped and deadline-bounded main-side, and anything big on a network
// mount waits for an explicit click.
import type { FileEntry } from '../../shared/types'
import { formatDate, formatSize, typeLabelFor } from '../../shared/sort'
import { app, liq } from '../core/app'
import { iconURL } from './items'
import {
  PREVIEW, classifyPreview, likelyPlayable, previewURL,
  type PreviewTags, type PreviewTextResult,
} from '../../shared/preview'
import { PEEK } from '../../shared/peek'
import { renderMedia, type MediaItem } from '../media/render'
import { openInMediaViewer } from '../media/overlay'
import type { Identified } from '../../shared/identify'

/** FileEntry carries everything MediaItem needs; this is the narrowing. */
function toItem(e: FileEntry): MediaItem {
  return { path: e.path, name: e.name, ext: e.ext, mime: e.mime, size: e.size, isDir: e.isDir }
}

export interface PreviewHost {
  /** container the preview is appended to; the host empties it before calling */
  body: HTMLElement
  /** name + metadata line ('' parts are dropped) */
  setCaption(name: string, parts: (string | undefined | false)[]): void
  /** false once this render has been superseded — every continuation checks it */
  alive(): boolean
  /** render this entry again from scratch (size-gate release, archive drill-up) */
  rerender(): void
  /** paths the user clicked past the size/remote gate; owned by the host so the
   *  decision survives a re-render */
  forced: Set<string>
  /** peek popover: a glance in a small box — fewer rows, fewer lines */
  compact?: boolean
}

// ------------------------------------------------------------------ dom

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K, cls?: string, text?: string,
): HTMLElementTagNameMap[K] {
  const n = document.createElement(tag)
  if (cls) n.className = cls
  if (text !== undefined) n.textContent = text
  return n
}

export function stage(body: HTMLElement): HTMLElement {
  const s = el('div', 'pv-stage')
  body.appendChild(s)
  return s
}

export function note(body: HTMLElement, text: string, cls = ''): HTMLElement {
  const n = el('div', 'pv-note' + (cls ? ' ' + cls : ''), text)
  body.appendChild(n)
  return n
}

function button(body: HTMLElement, label: string, onClick: () => void): HTMLButtonElement {
  const b = el('button', 'pv-btn', label)
  b.addEventListener('click', onClick)
  body.appendChild(b)
  return b
}

export function bigIcon(e: FileEntry, into: HTMLElement): HTMLImageElement {
  const img = el('img', 'pv-icon')
  img.draggable = false
  img.src = iconURL(e, 96)
  img.addEventListener('error', () => { img.style.visibility = 'hidden' })
  into.appendChild(img)
  return img
}

/** thumbnail from the freedesktop cache, falling back to the big file icon */
export function thumb(e: FileEntry, into: HTMLElement, onMiss?: () => void): HTMLImageElement {
  const img = el('img', 'pv-thumb')
  img.draggable = false
  img.addEventListener('error', () => {
    img.remove()
    bigIcon(e, into)
    onMiss?.()
  })
  img.src = `liqthumb://?path=${encodeURIComponent(e.path)}&size=x-large`
  into.appendChild(img)
  return img
}

/** stop and detach any media before the body is thrown away */
export function clearPreviewBody(body: HTMLElement): void {
  for (const m of Array.from(body.querySelectorAll('video, audio'))) {
    const media = m as HTMLMediaElement
    try { media.pause() } catch { /* already gone */ }
    media.removeAttribute('src')
    try { media.load() } catch { /* detached */ }
  }
  body.textContent = ''
  body.scrollTop = 0
}

export function duration(sec: number): string {
  const s = Math.round(sec)
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const r = s % 60
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}`
    : `${m}:${String(r).padStart(2, '0')}`
}

// -------------------------------------------------------------- guards

/** Reading this now would be rude: huge, or big and across the network. */
function gateReason(host: PreviewHost, e: FileEntry): string | null {
  if (host.forced.has(e.path)) return null
  if (e.size > PREVIEW.localAutoMaxBytes) return `${formatSize(e.size)} file`
  if (e.remote && e.size > PREVIEW.remoteAutoMaxBytes) {
    return `${formatSize(e.size)} on a network location`
  }
  return null
}

function showGate(host: PreviewHost, e: FileEntry, reason: string): void {
  const s = stage(host.body)
  thumb(e, s)
  note(host.body, `${reason} — not previewed automatically.`)
  button(host.body, 'Preview anyway', () => { host.forced.add(e.path); host.rerender() })
}

// ------------------------------------------------------------ renderers

function renderImage(host: PreviewHost, e: FileEntry): void {
  const gated = gateReason(host, e)
  if (gated) { showGate(host, e, gated); return }
  const s = stage(host.body)
  const img = el('img', 'pv-img')
  img.draggable = false
  img.alt = ''
  img.addEventListener('load', () => {
    if (!host.alive()) return
    if (img.naturalWidth && img.naturalHeight) {
      host.setCaption(e.name, [typeLabelFor(e), formatSize(e.size),
        `${img.naturalWidth} × ${img.naturalHeight}`, formatDate(e.mtime)])
    }
  })
  img.addEventListener('error', () => {
    if (!host.alive()) return
    img.remove()
    thumb(e, s, () => note(host.body, 'No preview available.'))
  })
  img.src = previewURL(e.path, { type: e.mime })
  s.appendChild(img)
}

/**
 * Video and audio both go through media/render.ts — the same renderer the
 * viewer uses.
 *
 * They used to have their own element here, gated on likelyPlayable() with a
 * "no built-in codec" dead end. That was correct when nothing could play those
 * files; it stopped being correct when the transcode pipeline landed, and the
 * pane went on refusing MPEG-2 rips, AVI, WMV and FLV that the viewer plays
 * perfectly — the same complaint, one surface over. Sharing the renderer means
 * the fallback, the silent-audio probe and the honest dead end are all the ones
 * that already exist, and a fix to any of them lands in both places at once.
 *
 * backgroundConvert is OFF here: this is a glance, not a decision to watch.
 */
function renderPlayable(host: PreviewHost, e: FileEntry, kind: 'video' | 'audio'): void {
  if (kind === 'video') {
    const gated = gateReason(host, e)
    if (gated) { showGate(host, e, gated); return }
  }
  const into = el('div', kind === 'video' ? 'pv-stage' : 'pv-audiohost')
  host.body.appendChild(into)
  renderMedia(into, toItem(e), {
    controls: true,
    backgroundConvert: false,
    // the pane is a few hundred pixels wide; encoding more is thrown away
    maxHeight: host.compact ? 360 : 540,
    onReady: (h) => {
      if (!host.alive()) return
      const m = h.media
      // h.stream.duration when the file is being transcoded: the ELEMENT's
      // duration is the fragmented stream's, which reads as a couple of seconds
      // for a twenty-minute film. Same reason the viewer's transport goes
      // through mediaDuration() rather than touching m.duration.
      const secs = h.stream ? h.stream.duration
        : m && Number.isFinite(m.duration) ? m.duration : 0
      host.setCaption(e.name, [typeLabelFor(e), formatSize(e.size),
        h.width ? `${h.width} × ${h.height}` : undefined,
        secs > 0 ? duration(secs) : undefined])
    },
  })
}

function renderVideo(host: PreviewHost, e: FileEntry): void {
  renderPlayable(host, e, 'video')
}

function renderAudio(host: PreviewHost, e: FileEntry): void {
  const s = stage(host.body)
  const art = el('div', 'pv-art')
  s.appendChild(art)
  bigIcon(e, art)
  // the element itself comes from the shared renderer, so an AC3 or DTS track
  // is transcoded here exactly as it is in the viewer
  renderPlayable(host, e, 'audio')
  const lines = el('div', 'pv-tags')
  host.body.appendChild(lines)

  liq.invoke('previewTags', e.path).then((tags: PreviewTags | null) => {
    if (!host.alive() || !tags) return
    if (tags.cover) {
      art.textContent = ''
      const img = el('img', 'pv-cover')
      img.draggable = false
      img.addEventListener('error', () => { art.textContent = ''; bigIcon(e, art) })
      img.src = `data:${tags.cover.mime};base64,${tags.cover.data}`
      art.appendChild(img)
    }
    if (tags.title) lines.appendChild(el('div', 'pv-tag-title', tags.title))
    if (tags.artist) lines.appendChild(el('div', 'pv-tag-sub', tags.artist))
    const rest = [tags.album, tags.year, tags.track && `Track ${tags.track}`]
      .filter(Boolean).join('  ·  ')
    if (rest) lines.appendChild(el('div', 'pv-tag-sub', rest))
  }, () => { /* tag reader unavailable — the player is the preview */ })
}

function renderPdf(host: PreviewHost, e: FileEntry): void {
  const gated = gateReason(host, e)
  if (gated) { showGate(host, e, gated); return }
  const s = stage(host.body)
  s.classList.add('pv-stage-fill')
  const emb = el('embed', 'pv-pdf')
  emb.type = 'application/pdf'
  // Chromium's PDF viewer loads fine over liqfile:// under this CSP (verified
  // on Electron 38 in <embed>, <object> and <iframe>); the fragment just trims
  // its chrome down to a preview and is ignored if unsupported. The peek
  // popover asks for page 1 explicitly — it is a glance at the first page.
  emb.src = previewURL(e.path, {
    type: 'application/pdf',
    fragment: host.compact ? 'page=1&toolbar=0&navpanes=0&view=FitH' : 'toolbar=0&navpanes=0&view=FitH',
  })
  s.appendChild(emb)
}

function renderText(host: PreviewHost, e: FileEntry, maxBytes: number, maxLines: number): void {
  const loading = note(host.body, 'Reading…', 'pv-dim')
  liq.invoke('previewText', e.path, maxBytes).then((res: PreviewTextResult) => {
    if (!host.alive()) return
    loading.remove()
    if (!res || !res.ok) {
      if (res?.timedOut) {
        note(host.body, 'Preview timed out — this location is slow or not responding.')
        button(host.body, 'Try again', () => host.rerender())
      } else {
        note(host.body, res?.error ? `Could not read this file: ${res.error}` : 'No preview available.')
      }
      return
    }
    if (res.binary) { renderOther(host, e, 'No text preview available (binary file).'); return }
    if (!res.text) { note(host.body, 'This file is empty.', 'pv-dim'); return }
    let text = res.text
    let cut = false
    if (maxLines > 0) {
      const lines = text.split('\n')
      if (lines.length > maxLines) { text = lines.slice(0, maxLines).join('\n'); cut = true }
    }
    const pre = el('pre', 'pv-text')
    pre.textContent = text                           // never innerHTML
    host.body.appendChild(pre)
    if (cut) {
      const n = note(host.body, `First ${maxLines} lines of ${e.name}.`, 'pv-dim')
      host.body.insertBefore(n, pre)
    } else if (res.truncated) {
      const n = note(host.body,
        `Showing the first ${formatSize(res.bytes)} of ${formatSize(res.size)}.`, 'pv-dim')
      host.body.insertBefore(n, pre)
    }
  }, () => {
    if (!host.alive()) return
    loading.remove()
    note(host.body, 'No preview available.')
  })
}

function renderArchive(host: PreviewHost, e: FileEntry, maxRows: number): void {
  const list = el('div', 'pv-arch')
  host.body.appendChild(list)
  let inner = ''

  const load = (): void => {
    list.textContent = ''
    const info = el('div', 'pv-dim pv-arch-status', inner ? `${inner}/` : 'Reading archive…')
    list.appendChild(info)
    const target = inner ? `archive://${e.path}!/${inner}` : e.path
    let settled = false
    const late = window.setTimeout(() => {
      if (!settled && host.alive()) info.textContent = 'Still reading this archive…'
    }, PREVIEW.archiveTimeoutMs)

    Promise.resolve(liq.archiveList(target)).then((entries: FileEntry[]) => {
      settled = true
      clearTimeout(late)
      if (!host.alive()) return
      list.textContent = ''
      if (inner) {
        const up = el('div', 'pv-arch-row pv-arch-up')
        up.append(rowIcon(['folder']), el('span', 'pv-arch-name', '..'))
        up.addEventListener('click', () => {
          inner = inner.includes('/') ? inner.slice(0, inner.lastIndexOf('/')) : ''
          load()
        })
        list.appendChild(up)
      }
      const rows = [...entries].sort((a, b) =>
        (a.isDir === b.isDir ? 0 : a.isDir ? -1 : 1) ||
        a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }))
      const shown = rows.slice(0, maxRows)
      for (const r of shown) {
        const row = el('div', 'pv-arch-row' + (r.isDir ? ' is-dir' : ''))
        row.append(
          rowIcon(r.icons?.length ? r.icons : [r.isDir ? 'folder' : 'text-x-generic']),
          el('span', 'pv-arch-name', r.name),
          el('span', 'pv-arch-size', r.isDir ? '' : formatSize(r.size)),
        )
        if (r.isDir) {
          row.addEventListener('click', () => {
            inner = inner ? `${inner}/${r.name}` : r.name
            load()
          })
        }
        list.appendChild(row)
      }
      if (rows.length > shown.length) {
        list.appendChild(el('div', 'pv-dim pv-arch-status',
          `…and ${rows.length - shown.length} more`))
      }
      const dirs = rows.filter(r => r.isDir).length
      host.setCaption(e.name, [
        typeLabelFor(e), formatSize(e.size),
        `${rows.length} item${rows.length === 1 ? '' : 's'}${inner ? ' in ' + inner : ''}`,
        dirs ? `${dirs} folder${dirs === 1 ? '' : 's'}` : undefined,
      ])
      if (!rows.length) list.appendChild(el('div', 'pv-note', 'This archive is empty.'))
    }, (err: unknown) => {
      settled = true
      clearTimeout(late)
      if (!host.alive()) return
      list.textContent = ''
      const msg = String((err as Error)?.message ?? err).replace(/^Error:\s*/, '')
      list.appendChild(el('div', 'pv-note', msg || 'Could not read this archive.'))
    })
  }
  load()
}

export function rowIcon(icons: string[]): HTMLImageElement {
  const img = el('img', 'pv-arch-icon')
  img.draggable = false
  img.src = iconURL(icons, 16)
  img.addEventListener('error', () => { img.style.visibility = 'hidden' })
  return img
}

function renderOther(host: PreviewHost, e: FileEntry, missText = 'No preview available.'): void {
  const s = stage(host.body)
  thumb(e, s, () => { if (host.alive()) note(host.body, missText) })
  // "No preview available" is where a user gets stuck: a row they cannot act on
  // and no idea why. Ask what the BYTES say and offer the few things worth
  // trying. Only for files the system could not name — everything else already
  // says what it is.
  if (e.mime === 'application/octet-stream' && e.path.startsWith('/') && e.size > 0) {
    void liq.invoke('identifyFile', e.path).then((id: Identified | null) => {
      if (!host.alive() || !id) return
      const box = el('div', 'pvr-identify')
      box.appendChild(el('div', 'pvr-idwhy', id.why))
      for (const sug of id.suggestions) {
        const b = el('button', 'mvr-btn', sug.label)
        b.addEventListener('click', () => runSuggestion(sug.id, e))
        box.appendChild(b)
      }
      host.body.appendChild(box)
    }).catch(() => { /* unreadable: the note above is all there is to say */ })
  }
}

/** the actions offered for an unidentified file */
function runSuggestion(id: Identified['suggestions'][number]['id'], e: FileEntry): void {
  switch (id) {
    case 'view': case 'text':
      // force it into the viewer, which reads the bytes rather than the name.
      // If even that cannot show it, hand it to the desktop's own application
      // rather than leaving the button doing nothing.
      if (!openInMediaViewer(e, [e], { force: true })) void liq.openPath(e.path)
      break
    case 'openwith':
      // there is no chooser dialog to call here, and inventing a button that
      // silently does nothing is worse than sending it to the default handler
      void liq.openPath(e.path)
      break
    case 'rename': app.emit('start-rename', e.path); break
    case 'properties': app.emit('show-properties', [e.path]); break
  }
}

/**
 * Render one FILE into host.body. Callers handle folders and multi-selection
 * themselves; entries with no filesystem path (trash://, archive:// members)
 * fall through to the thumbnail/icon path.
 */
export function renderPreview(host: PreviewHost, e: FileEntry): void {
  if (!e.path.startsWith('/')) { renderOther(host, e); return }
  const textBytes = host.compact ? Math.min(PREVIEW.textMaxBytes, PEEK.textMaxBytes) : PREVIEW.textMaxBytes
  const textLines = host.compact ? PEEK.textMaxLines : 0
  const archRows = host.compact ? PEEK.archiveMaxRows : PREVIEW.archiveMaxRows
  switch (classifyPreview(e)) {
    case 'image': renderImage(host, e); break
    case 'video': renderVideo(host, e); break
    case 'audio': renderAudio(host, e); break
    case 'text': renderText(host, e, textBytes, textLines); break
    case 'pdf': renderPdf(host, e); break
    case 'archive': renderArchive(host, e, archRows); break
    default: renderOther(host, e); break
  }
}
