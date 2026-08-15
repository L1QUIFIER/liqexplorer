// Preview pane — Win11 Explorer's right-hand column (View > Show > Preview
// pane, Alt+P, or the command bar's rightmost button). Visibility follows the
// existing `showPreviewPane` setting, width is remembered in localStorage.
//
// What each selection previews as:
//   image   inline <img> through liqfile:// (animated GIF/WebP animate),
//           natural dimensions in the caption; non-decodable image formats
//           (tiff/psd/raw/heic) fall through to their liqthumb thumbnail
//   video   <video controls preload="metadata">, gated on canPlayType() so
//           mkv/avi/wmv show the thumbnail + "no built-in codec" instead of a
//           black box; a runtime error falls back the same way
//   audio   <audio controls> + title/artist/album and embedded cover art from
//           the main-side tag reader (ID3v2/ID3v1/FLAC/Ogg/MP4)
//   text    first 256 KB, monospace, textContent (never innerHTML), with
//           "Showing the first 256 KB of N" when truncated
//   pdf     Chromium's built-in viewer via <embed type="application/pdf">
//           (verified working over liqfile:// under this CSP)
//   archive top-level listing with sizes, folders clickable to drill in
//   folder  icon + name (+ item count when the folder is the open one)
//   other   thumbnail if the freedesktop thumbnailers can make one, else the
//           big file icon and "No preview available."
//   0 / N   folder summary / "N items selected" with the combined size
//
// Cost control on slow mounts (the project's own share is a hard-mounted CIFS):
// selection changes are debounced by PREVIEW.debounceMs, every async result is
// dropped unless its generation is still current (so arrowing down a list never
// renders a stale row), reads are size-capped and deadline-bounded main-side,
// and anything big on a network mount waits for an explicit click.
import {
  bigIcon, clearPreviewBody, el, note, renderPreview, stage, thumb,
  type PreviewHost,
} from './previewrender'
import type { AppSettings, FileEntry } from '../../shared/types'
import { formatDate, formatSize, typeLabelFor } from '../../shared/sort'
import { app, liq } from '../core/app'
import type { Tab } from '../core/app'
import { iconURL } from './items'
import {
  PREVIEW, PROBE_MIME, classifyPreview, likelyPlayable, previewURL,
  type PreviewTags, type PreviewTextResult,
} from '../../shared/preview'
import { mountInspector } from './inspector/shell'
import { createDetailsPage } from './inspector/details'
import { createEditPage } from './inspector/edit'
import { createRenamePage } from './inspector/rename'
import { createDocPage } from './inspector/doc'

const MIN_W = 180
const MAX_W = 900
const DEFAULT_W = 320

export function mountPreviewPane(root: HTMLElement): void {
  const splitter = document.getElementById('sidepane-splitter')

  root.classList.add('pv')
  const body = el('div', 'pv-body')
  const caption = el('div', 'pv-caption')
  const nameEl = el('div', 'pv-name')
  const metaEl = el('div', 'pv-meta')
  caption.append(nameEl, metaEl)

  // The pane is a tabbed inspector; Preview is one tab of it. Its body and
  // caption keep their exact flex roles, just one level deeper — #sidepane is
  // already a flex column, so the strip drops in as a sibling and no layout
  // maths changes.
  const previewPage = el('div', 'ins-page')
  previewPage.dataset.tab = 'preview'
  previewPage.append(body, caption)
  const inspector = mountInspector(root, previewPage)
  inspector.register('details', createDetailsPage())
  inspector.register('rename', createRenamePage())
  inspector.register('edit', createEditPage())
  inspector.register('doc', createDocPage())

  /** bumped on every render; async continuations that no longer match are dropped */
  let gen = 0
  let timer = 0
  let lastKey = ''
  /** last applied visibility (null = never applied) */
  let visible: boolean | null = null
  /** paths the user explicitly asked to load despite the size/remote guard */
  const forced = new Set<string>()

  // ------------------------------------------------------------------ dom


  function setCaption(name: string, parts: (string | undefined | false)[]): void {
    nameEl.textContent = name
    nameEl.title = name
    metaEl.textContent = parts.filter(Boolean).join('  ·  ')
  }


  // ------------------------------------------------------------ renderers

  function renderEmpty(t: Tab | undefined): void {
    if (!t) { note(body, 'No preview available.'); setCaption('', []); return }
    const files = t.rows.filter(r => !r.isDir)
    const dirs = t.rows.length - files.length
    const bytes = files.reduce((n, f) => n + Math.max(0, f.size), 0)
    const s = stage(body)
    const folder: FileEntry = {
      name: t.title || t.path, path: t.path, isDir: true, isSymlink: false,
      size: 0, mtime: 0, ctime: 0, mime: 'inode/directory', icons: ['folder'],
      hidden: false, ext: '',
    }
    bigIcon(folder, s)
    setCaption(t.title || t.path, [
      t.loading ? 'Loading…' : `${t.rows.length} item${t.rows.length === 1 ? '' : 's'}`,
      dirs ? `${dirs} folder${dirs === 1 ? '' : 's'}` : undefined,
      files.length ? formatSize(bytes) : undefined,
    ])
    note(body, 'Select a file to preview it.')
  }

  function renderMulti(sel: FileEntry[]): void {
    const dirs = sel.filter(e => e.isDir).length
    const bytes = sel.reduce((n, e) => n + (e.isDir ? 0 : Math.max(0, e.size)), 0)
    const s = stage(body)
    const icon = el('div', 'pv-multi', String(sel.length))
    s.appendChild(icon)
    setCaption(`${sel.length} items selected`, [
      dirs ? `${dirs} folder${dirs === 1 ? '' : 's'}` : undefined,
      bytes || dirs < sel.length ? formatSize(bytes) : undefined,
    ])
    note(body, 'Select a single file to preview it.')
  }

  function renderFolder(e: FileEntry, t: Tab | undefined): void {
    const s = stage(body)
    bigIcon(e, s)
    // an item count is only free when the folder happens to be the open one
    const known = t && t.path === e.path && !t.loading ? t.rows.length : null
    setCaption(e.name, [
      'File folder',
      known !== null ? `${known} item${known === 1 ? '' : 's'}` : undefined,
      e.mtime ? formatDate(e.mtime) : undefined,
    ])
    note(body, 'No preview available.')
  }










  // ---------------------------------------------------------------- render

  function selectionKey(t: Tab | undefined): string {
    if (!t) return 'none'
    const sel = t.selectedEntries()
    if (sel.length === 0) return `0|${t.path}|${t.rows.length}|${t.loading ? 1 : 0}`
    if (sel.length > 1) {
      return `n|${sel.length}|${sel.reduce((n, e) => n + Math.max(0, e.size), 0)}`
    }
    const e = sel[0]
    return `1|${e.path}|${e.size}|${e.mtime}|${forced.has(e.path) ? 1 : 0}`
  }

  function render(): void {
    if (root.hidden) return
    // the pane is open but showing another tab: rendering here would decode a
    // file nobody is looking at, and on a share that is not free
    if (inspector.current() !== 'preview') return
    const t = app.activeTab
    const key = selectionKey(t)
    // a background refresh (CIFS mtime polling) must not restart a playing video
    if (key === lastKey && body.childElementCount) return
    lastKey = key
    const myGen = ++gen
    clearPreviewBody(body)

    const sel = t ? t.selectedEntries() : []
    if (!t || sel.length === 0) { renderEmpty(t); return }
    if (sel.length > 1) { renderMulti(sel); return }

    const e = sel[0]
    setCaption(e.name, [
      typeLabelFor(e),
      e.isDir ? undefined : formatSize(e.size),
      e.mtime ? formatDate(e.mtime) : undefined,
    ])

    if (e.isDir) { renderFolder(e, t); return }
    // trash:// / archive:// entries have no readable filesystem path
    // trash:// and archive:// entries have no readable filesystem path, so
    // there is nothing for the shared renderer to open — a thumbnail is all
    // that can be offered
    if (!e.path.startsWith('/')) {
      thumb(e, stage(body), () => { if (myGen === gen) note(body, 'No preview available.') })
      return
    }

    // Everything past this point is views/previewrender.ts — the same code the
    // peek popover runs. The pane keeps only what is genuinely its own: the
    // caption, the empty/multi/folder cases, and what "still current" means.
    renderPreview(host(myGen), e)
  }

  /** the pane's side of the PreviewHost contract (see previewrender.ts) */
  function host(myGen: number): PreviewHost {
    return {
      body,
      setCaption,
      // a render is superseded the moment the selection changes; every async
      // continuation in previewrender checks this before touching the DOM
      alive: () => myGen === gen,
      rerender: () => { lastKey = ''; render() },
      forced,
    }
  }

  function schedule(delay: number = PREVIEW.debounceMs): void {
    if (root.hidden) return
    if (timer) clearTimeout(timer)
    timer = window.setTimeout(() => { timer = 0; render() }, delay)
  }

  // -------------------------------------------------------- visibility

  const previewBtn = document.querySelector('#commandbar .cb-preview') as HTMLButtonElement | null

  function setVisible(v: boolean): void {
    void app.setSettings({ showPreviewPane: v })     // persists + emits settings-changed
  }

  function applyVisibility(s: AppSettings): void {
    const show = !!s.showPreviewPane
    // 'settings-changed' fires for every setting; only react to a real flip, or
    // an unrelated toggle would restart a playing preview
    if (show === visible) return
    visible = show
    root.hidden = !show
    if (splitter) splitter.hidden = !show
    if (previewBtn) {
      previewBtn.classList.toggle('active', show)
      previewBtn.setAttribute('aria-pressed', show ? 'true' : 'false')
    }
    if (show) { lastKey = ''; schedule(0) }
    else {
      if (timer) { clearTimeout(timer); timer = 0 }
      gen++                     // orphan any in-flight read
      clearPreviewBody(body)
      lastKey = ''
    }
  }

  // ---------------------------------------------------------- splitter

  function setWidth(w: number): void {
    const clamped = Math.min(MAX_W, Math.max(MIN_W, Math.round(w)))
    document.documentElement.style.setProperty('--sidepane-w', clamped + 'px')
  }

  function mountSplitter(): void {
    const saved = Number(localStorage.getItem('sidepane-w'))
    setWidth(Number.isFinite(saved) && saved >= MIN_W && saved <= MAX_W ? saved : DEFAULT_W)
    if (!splitter) return
    splitter.addEventListener('mousedown', (e) => {
      e.preventDefault()
      const startX = (e as MouseEvent).clientX
      const startW = root.getBoundingClientRect().width
      splitter.classList.add('dragging')
      document.body.style.cursor = 'col-resize'
      const move = (ev: MouseEvent) => setWidth(startW - (ev.clientX - startX))
      const up = () => {
        window.removeEventListener('mousemove', move)
        window.removeEventListener('mouseup', up)
        splitter.classList.remove('dragging')
        document.body.style.cursor = ''
        try {
          localStorage.setItem('sidepane-w', String(Math.round(root.getBoundingClientRect().width)))
        } catch { /* storage full */ }
      }
      window.addEventListener('mousemove', move)
      window.addEventListener('mouseup', up)
    })
  }

  // ------------------------------------------------------------- mount

  mountSplitter()
  if (previewBtn) {
    previewBtn.disabled = false
    previewBtn.title = 'Preview pane (Alt+P)'
    previewBtn.addEventListener('click', () => setVisible(!app.settings.showPreviewPane))
  }
  applyVisibility(app.settings)

  app.on('tab-selection', (t: Tab) => { if (t === app.activeTab) schedule() })
  app.on('tab-navigated', (t: Tab) => { if (t === app.activeTab) schedule() })
  app.on('tab-listing', (t: Tab) => { if (t === app.activeTab) schedule() })
  app.on('tabs-changed', () => schedule())
  app.on('settings-changed', (s: AppSettings) => applyVisibility(s))
  app.on('toggle-preview-pane', () => setVisible(!app.settings.showPreviewPane))
  app.on('set-preview-pane', (v: boolean) => setVisible(!!v))
}
