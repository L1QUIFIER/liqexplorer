// Item element renderers shared by every view mode, plus small formatting
// helpers (display name, cell text, icon/thumbnail URLs). No app state here —
// everything comes in through RenderCtx so elements can be recycled freely.
// NOTE: inline on* attributes are blocked by the CSP; error handlers are
// assigned as properties after innerHTML is set.
import type { FileEntry, ViewMode } from '../../shared/types'
import { formatDate, formatSize, typeLabelFor } from '../../shared/sort'
import type { Group } from '../../shared/sort'
import { archiveUri, isArchiveUri, parseArchiveUri } from '../../shared/archive'
import { liq } from '../core/app'
// self-mounting: importing livemedia installs the live-preview driver (its own
// listeners + stylesheet), so nothing else in the app needs a line for it
import { markLive } from './livemedia'
import { markDuration } from './mediabadge'
// self-mounting, same as livemedia above: importing starsHtml installs the
// whole ratings feature (stylesheet, number keys, change fan-out)
import { ratingBadgeHtml, starsHtml } from './ratings'

export interface DetailCol {
  key: string           // SortKey, or a synthetic key like 'folderPath'
  width: number
  label: string
  right?: boolean
  /**
   * Injected by the view host for a particular location — 'Folder path' in
   * search results, 'Original location' / 'Date deleted' in the Recycle Bin —
   * rather than chosen by the user. It is not in viewState.columns, so it must
   * not be draggable, resizable or sortable: all three would try to write it
   * back into a column list it does not belong to.
   */
  synthetic?: boolean
}

export interface RenderCtx {
  mode: ViewMode
  icon: number
  showExt: boolean
  checkboxes: boolean
  searchMode: boolean
  /** details only: columns in render order (name first) */
  cols?: DetailCol[]
}

export const COLUMN_LABELS: Record<string, string> = {
  name: 'Name',
  mtime: 'Date modified',
  ctime: 'Date created',
  atime: 'Date accessed',
  type: 'Type',
  size: 'Size',
  ext: 'File extension',
  rating: 'Rating',
  folderPath: 'Folder path',
  origPath: 'Original location',
  deletedAt: 'Date deleted',
  dateTaken: 'Date taken',
  dimensions: 'Dimensions',
  duration: 'Length',
}

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string))
}

export function dirname(p: string): string {
  const i = p.lastIndexOf('/')
  return i <= 0 ? '/' : p.slice(0, i)
}

/** name with the extension hidden when the setting says so (never for dirs) */
export function displayName(e: FileEntry, showExt: boolean): string {
  if (showExt || e.isDir || !e.ext) return e.name
  const cut = e.name.length - e.ext.length - 1
  return cut > 0 && e.name[cut] === '.' ? e.name.slice(0, cut) : e.name
}

export function iconURL(e: FileEntry | string[], size: number): string {
  const names = Array.isArray(e) ? e : e.icons
  const list = (names && names.length ? names : ['text-x-generic']).map(encodeURIComponent).join(',')
  return `liqicon://${list}?size=${size}`
}

const THUMB_MODES = new Set<ViewMode>(['extra-large', 'large', 'medium', 'tiles', 'content'])

export function wantsThumb(e: FileEntry, mode: ViewMode): boolean {
  if (!THUMB_MODES.has(mode) || e.isDir) return false
  return e.mime.startsWith('image/') || e.mime.startsWith('video/') || e.mime === 'application/pdf'
}

export function thumbURL(e: FileEntry, mode: ViewMode): string {
  const size = mode === 'extra-large' || mode === 'large' ? 'large' : 'normal'
  return `liqthumb://?path=${encodeURIComponent(e.path)}&size=${size}`
}

// ---- thumbnails for files INSIDE an archive -------------------------------
//
// A member has no path on disk, so it must be extracted before it can be
// thumbnailed. Doing that per tile would spawn one 7z per image; instead every
// request inside one animation-frame-ish window is collected and extracted in a
// single run, which is what makes a gallery of a hundred images inside a zip
// practical. Results are remembered for the session (the member cache in main
// is keyed by archive mtime, so it self-invalidates).

const memberPaths = new Map<string, string>()          // archive-uri -> local path
const pendingByArchive = new Map<string, {
  members: Set<string>
  waiters: ((map: Record<string, string>) => void)[]
  timer: number
}>()

/** local file for an archive member, extracting it (batched) if needed */
export function archiveMemberPath(uri: string): Promise<string | null> {
  const known = memberPaths.get(uri)
  if (known) return Promise.resolve(known)
  const p = parseArchiveUri(uri)
  if (!p || !p.inner) return Promise.resolve(null)

  let batch = pendingByArchive.get(p.archive)
  if (!batch) {
    batch = { members: new Set(), waiters: [], timer: 0 }
    pendingByArchive.set(p.archive, batch)
  }
  batch.members.add(p.inner)

  const done = new Promise<Record<string, string>>(resolve => { batch!.waiters.push(resolve) })
  if (!batch.timer) {
    batch.timer = window.setTimeout(() => {
      const b = pendingByArchive.get(p.archive)!
      pendingByArchive.delete(p.archive)
      void liq.invoke('archiveMembers', { archive: p.archive, members: [...b.members] })
        .then((map: Record<string, string>) => {
          for (const [member, local] of Object.entries(map ?? {})) {
            memberPaths.set(archiveUri(p.archive, member), local)
          }
          for (const w of b.waiters) w(map ?? {})
        })
        .catch(() => { for (const w of b.waiters) w({}) })
    }, 60)
  }
  return done.then(map => map[p.inner] ?? null)
}

/** formatted cell value for a details column (also used for fit-to-content) */
export function cellText(e: FileEntry, key: string, showExt: boolean): string {
  switch (key) {
    case 'name': return displayName(e, showExt)
    case 'mtime': return formatDate(e.mtime)
    case 'ctime': return formatDate(e.btime ?? e.ctime)
    case 'atime': return formatDate(e.mtime)
    case 'type': return typeLabelFor(e)
    case 'size': return e.isDir ? '' : formatSize(e.size)
    case 'ext': return e.ext ? e.ext.toUpperCase() : ''
    case 'folderPath': return dirname(e.path)
    case 'origPath': return e.trashOrigPath ? dirname(e.trashOrigPath) : ''
    case 'deletedAt': return e.trashDeletedAt ? formatDate(e.trashDeletedAt) : ''
    // the cell renders stars, not text; this is what fit-to-content measures,
    // so it has to be as wide as five stars ever get
    case 'rating': return '★★★★★'
    default: return ''
  }
}

const CHECK = '<span class="vh-check"></span>'

export function renderEntry(el: HTMLElement, e: FileEntry, ctx: RenderCtx): void {
  const name = escapeHtml(displayName(e, ctx.showExt))
  const mode = ctx.mode
  let html = ''
  if (mode === 'details') {
    el.className = 'vh-item vh-row vh-details'
    const cols = ctx.cols ?? []
    for (let i = 0; i < cols.length; i++) {
      const c = cols[i]
      if (i === 0) {
        html += `<div class="vh-cell vh-namecell" style="width:${c.width}px">${CHECK}` +
          `<img class="vh-icon" width="16" height="16" alt="">` +
          `<span class="vh-label" title="${escapeHtml(e.name)}">${name}</span></div>`
      } else if (c.key === 'rating') {
        // the one column whose value is markup rather than text, so it cannot
        // go through the escapeHtml path below
        html += `<div class="vh-cell vh-seccell vh-ratecell" style="width:${c.width}px">` +
          `${e.isDir ? '' : starsHtml(e.rating ?? 0)}</div>`
      } else {
        // the text goes in a span, not straight into the cell: .vh-cell is a
        // flex container for vertical centring, and text-overflow never
        // ellipsizes a flex container's own text — a long Type value like
        // "Tar archive (gzip-compressed)" was sliced with nothing to show for it
        const txt = escapeHtml(cellText(e, c.key, ctx.showExt))
        html += `<div class="vh-cell vh-seccell${c.right ? ' vh-right' : ''}" style="width:${c.width}px">` +
          `<span class="vh-celltext" title="${txt}">${txt}</span></div>`
      }
    }
  } else if (mode === 'list' || mode === 'small') {
    el.className = 'vh-item vh-row vh-listrow'
    html = `${CHECK}<img class="vh-icon" width="16" height="16" alt="">` +
      `<span class="vh-label" title="${escapeHtml(e.name)}">${name}</span>`
  } else if (mode === 'content') {
    el.className = 'vh-item vh-row vh-content'
    const sub = ctx.searchMode ? dirname(e.path) : typeLabelFor(e)
    html = `${CHECK}<span class="vh-thumbwrap" style="width:32px;height:32px"><img class="vh-icon" alt=""></span>` +
      `<span class="vh-content-main"><span class="vh-label" title="${escapeHtml(e.name)}">${name}</span>` +
      `<span class="vh-sub">${escapeHtml(sub)}</span></span>` +
      `<span class="vh-content-right"><span>${escapeHtml(formatDate(e.mtime))}</span>` +
      `<span>${e.isDir ? '' : escapeHtml(formatSize(e.size))}</span></span>`
  } else if (mode === 'tiles') {
    el.className = 'vh-item vh-tile'
    html = `${CHECK}<span class="vh-thumbwrap" style="width:48px;height:48px"><img class="vh-icon" alt="">` +
      `${e.isDir ? '' : ratingBadgeHtml(e.rating ?? 0)}</span>` +
      `<span class="vh-tile-lines"><span class="vh-label" title="${escapeHtml(e.name)}">${name}</span>` +
      `<span class="vh-sub">${escapeHtml(typeLabelFor(e))}</span>` +
      `<span class="vh-sub">${e.isDir ? '' : escapeHtml(formatSize(e.size))}</span></span>`
  } else {
    el.className = `vh-item vh-grid vh-${mode}`
    // The badge lives INSIDE .vh-thumbwrap, so it is positioned against the
    // picture rather than the tile. That is what makes it impossible for it to
    // cover the filename — including when selecting a tile expands the label to
    // eight lines, which is where the old overlay was at its worst.
    html = `${CHECK}<span class="vh-thumbwrap" style="width:${ctx.icon}px;height:${ctx.icon}px">` +
      `<img class="vh-icon" alt="">${e.isDir ? '' : ratingBadgeHtml(e.rating ?? 0)}</span>` +
      `<span class="vh-label" title="${escapeHtml(e.name)}">${name}</span>`
  }
  el.innerHTML = html

  const img = el.querySelector('img.vh-icon') as HTMLImageElement | null
  if (img) {
    img.draggable = false
    const fallback = iconURL(e, ctx.icon)
    if (wantsThumb(e, mode)) {
      img.onerror = () => {
        img.onerror = () => { img.style.visibility = 'hidden' }
        img.src = fallback
      }
      img.classList.add('vh-thumbimg')
      // Every thumbnail carries its path so anything that mutates this <img>
      // later can tell whether the element was recycled onto a different file
      // first — the archive swap below, and the live previews in livemedia.ts.
      img.dataset.for = e.path
      markLive(img, e)
      // the badge hangs on the WRAPPER, not the <img>: it is positioned against
      // the picture, which is what keeps it off the filename (same reason as
      // the rating badge)
      const wrap = img.parentElement
      if (wrap?.classList.contains('vh-thumbwrap')) markDuration(wrap, e, ctx.icon)
      if (isArchiveUri(e.path)) {
        // show the type icon immediately, swap in the real thumbnail when the
        // member has been extracted (and only if this element wasn't recycled)
        img.src = fallback
        const forPath = e.path
        void archiveMemberPath(forPath).then(local => {
          if (!local || !img.isConnected || img.dataset.for !== forPath) return
          img.src = `liqthumb://?path=${encodeURIComponent(local)}&size=${
            mode === 'extra-large' || mode === 'large' ? 'large' : 'normal'}`
        })
      } else {
        img.src = thumbURL(e, mode)
      }
    } else {
      img.onerror = () => { img.style.visibility = 'hidden' }
      img.src = fallback
    }
    if (mode !== 'details' && mode !== 'list' && mode !== 'small') {
      img.style.maxWidth = ctx.icon + 'px'
      img.style.maxHeight = ctx.icon + 'px'
    }
  }
}

const CHEV_DOWN = '<svg viewBox="0 0 12 12" width="12" height="12"><path d="M2 4l4 4 4-4" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>'
const CHEV_UP = '<svg viewBox="0 0 12 12" width="12" height="12"><path d="M2 8l4-4 4 4" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>'

export function renderGroupHeader(el: HTMLElement, g: Group, collapsed: boolean): void {
  el.className = 'vh-group' + (collapsed ? ' collapsed' : '')
  el.innerHTML =
    `<span class="vh-group-label">${escapeHtml(g.label)}</span>` +
    `<span class="vh-group-count">(${g.count})</span>` +
    `<span class="vh-group-line"></span>` +
    `<span class="vh-group-chev" title="${collapsed ? 'Expand group' : 'Collapse group'}">${collapsed ? CHEV_DOWN : CHEV_UP}</span>`
}
