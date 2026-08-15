// Home page — Win11's default landing view.
//
// Three collapsible sections: Quick access (pinned folders, the same set the
// nav pane mirrors), Favorites (pinned FILES) and Recent (recently used files
// from the GTK store, shared with Nemo). It lives beside the file view inside
// #main and swaps with it whenever the active tab sits at home:// — the view
// host keeps owning every real folder listing.
import { app, liq, HOME_URI, Tab } from '../core/app'
import type { FavoriteEntry, FileEntry, Place, RecentEntry } from '../../shared/types'
import { PUSH } from '../../shared/ipc'
import { formatDate } from '../../shared/sort'
import { showMenu } from '../menus/menu'
import type { MenuItem } from '../menus/menu-types'
import { escapeHtml, iconURL, thumbURL, wantsThumb } from './items'
import { attachPeek } from './peek'
import { openInMediaViewer } from '../media/overlay'

const RECENT_LIMIT = 25
const TILE_ICON = 32
const ROW_ICON = 20

type SectionId = 'quick' | 'favorites' | 'recent'

const CHEVRON_SVG =
  '<svg viewBox="0 0 12 12" width="12" height="12" fill="none" aria-hidden="true">' +
  '<path d="M4.5 2.5 8 6l-3.5 3.5" stroke="currentColor" stroke-width="1.3" ' +
  'stroke-linecap="round" stroke-linejoin="round"/></svg>'

const PIN_SVG =
  '<svg viewBox="0 0 16 16" width="12" height="12" fill="currentColor" aria-hidden="true">' +
  '<path d="M9.6 1.7a1 1 0 0 1 1.42 0l3.28 3.28a1 1 0 0 1 0 1.42l-.9.9a1 1 0 0 1-.93.27l-.66-.15' +
  '-2.28 2.28.3 2.35a1 1 0 0 1-.28.83l-.33.33a1 1 0 0 1-1.41 0L5.6 11l-3.42 3.42a.6.6 0 0 1-.85-.85' +
  'L4.75 10.2 2.54 7.99a1 1 0 0 1 0-1.41l.33-.33a1 1 0 0 1 .83-.29l2.35.31L8.33 3.99l-.15-.66' +
  'a1 1 0 0 1 .27-.93l1.15-.7z"/></svg>'

// ---------------------------------------------------------------- helpers

const ARCHIVE_MIME = /(zip|compressed|tar|rar|7z|gzip|bzip)/i

/** freedesktop icon names for a mime type (renderer-side twin of fs/mime.ts). */
function iconsForMime(mime: string): string[] {
  const major = mime.split('/')[0]
  const cat =
    major === 'text' ? 'text-x-generic'
      : major === 'image' ? 'image-x-generic'
        : major === 'video' ? 'video-x-generic'
          : major === 'audio' ? 'audio-x-generic'
            : major === 'font' ? 'font-x-generic'
              : ARCHIVE_MIME.test(mime) ? 'package-x-generic'
                : ''
  return [...new Set([mime.replace('/', '-'), cat, 'text-x-generic'].filter(Boolean))]
}

function dirOf(p: string): string {
  const i = p.lastIndexOf('/')
  return i <= 0 ? '/' : p.slice(0, i)
}

/** No mime database in the renderer: extension -> a good-enough icon family. */
function mimeGuess(name: string): string {
  const ext = (name.split('.').pop() ?? '').toLowerCase()
  if (/^(png|jpg|jpeg|gif|webp|bmp|svg|ico|tiff?|avif)$/.test(ext)) return 'image/' + ext
  if (/^(mp4|mkv|avi|mov|webm|wmv|m4v|mpg|mpeg)$/.test(ext)) return 'video/' + ext
  if (/^(mp3|flac|ogg|wav|m4a|opus|aac)$/.test(ext)) return 'audio/' + ext
  if (/^(zip|7z|rar|tar|gz|bz2|xz|tgz)$/.test(ext)) return 'application/zip'
  if (ext === 'pdf') return 'application/pdf'
  if (/^(txt|md|log|json|xml|csv|ts|js|css|html|sh|py|c|h|cpp|rs|go|ini|conf|yml|yaml)$/.test(ext)) return 'text/plain'
  return 'application/octet-stream'
}

/** Win11 Home shows ages, not timestamps, until entries get old. */
function relTime(ms: number): string {
  if (!ms) return ''
  const diff = Date.now() - ms
  if (diff < 0) return formatDate(ms)              // clock skew / future mtime
  const min = Math.floor(diff / 60_000)
  if (min < 1) return 'Just now'
  if (min < 60) return `${min} minute${min === 1 ? '' : 's'} ago`
  const hours = Math.floor(min / 60)
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`
  const days = Math.floor(hours / 24)
  if (days === 1) return 'Yesterday'
  if (days < 7) return `${days} days ago`
  return formatDate(ms)
}

/**
 * Order a Home section by the tab's sort.
 *
 * Only the keys a Home entry can actually answer are honoured — it has a name
 * and, for Recent, a time. Asking for "size" on a list of pinned folders has no
 * answer, so it falls back to the name rather than shuffling them arbitrarily,
 * which would look like a bug.
 */
function sortEntries<T extends { name: string; visitedAt?: number }>(
  items: T[], key: string, desc: boolean,
): T[] {
  const out = items.slice()
  out.sort((a, b) => {
    let d = 0
    if (key === 'mtime' || key === 'ctime' || key === 'atime') d = (a.visitedAt ?? 0) - (b.visitedAt ?? 0)
    if (!d) d = a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' })
    return desc ? -d : d
  })
  return out
}

function navigate(path: string): void {
  void app.activeTab?.navigate(path)
}

function copyAsPath(path: string): void {
  void liq.copyTextToClipboard(`"${path}"`)
}

/** Navigate to the containing folder and select the file once the listing settles. */
async function openFileLocation(p: string): Promise<void> {
  const tab = app.activeTab
  if (!tab) return
  await tab.navigate(dirOf(p))
  let timer = 0
  const onListing = (e: Event): void => {
    const t = (e as CustomEvent).detail as Tab
    if (t !== tab || t.loading) return
    stop()
    if (t.rows.some(r => r.path === p)) t.setSelection([p], p)
  }
  const stop = (): void => {
    window.clearTimeout(timer)
    app.events.removeEventListener('tab-listing', onListing)
  }
  app.events.addEventListener('tab-listing', onListing)
  timer = window.setTimeout(stop, 8000)             // gone / unreadable folder
}

// ---------------------------------------------------------------- mount

/** One Home page is mounted per pane; the global favorite verbs belong to the
 *  first of them only (see the bottom of mountHome). */
let favoriteVerbsClaimed = false

export interface HomeHostOpts {
  /** Which Tab decides whether this Home page is showing. Defaults to the
   *  focused pane; views/panes.ts pins one instance per pane. */
  getTab?: () => Tab | null
  /** The pane's file view, hidden while Home shows (they are twins). */
  sibling?: HTMLElement | null
  /** Called on any interaction, so the owning pane takes focus first — the
   *  tile handlers below then navigate through app.activeTab as usual. */
  onActivate?: () => void
}

export function mountHome(root: HTMLElement, opts: HomeHostOpts = {}): void {
  const viewhost = opts.sibling ?? document.getElementById('viewhost')
  const myTab = (): Tab | null => (opts.getTab ? opts.getTab() : app.activeTab) ?? null
  root.innerHTML = ''
  if (opts.onActivate) root.addEventListener('mousedown', () => opts.onActivate!(), true)

  const scroller = document.createElement('div')
  scroller.className = 'home-scroll'
  root.appendChild(scroller)

  // empty-space menu (items and headers stopPropagation): Home has no folder to
  // paste into or create in, so it is just the page's own options
  scroller.addEventListener('contextmenu', (e) => {
    e.preventDefault()
    showMenu([
      { label: 'Refresh', onClick: () => { void refresh() } },
      { separator: true },
      {
        label: 'Show recent files', checked: app.settings.showRecent,
        onClick: () => { void app.setSettings({ showRecent: !app.settings.showRecent }) },
      },
    ], { x: e.clientX, y: e.clientY })
  })

  /**
   * Hover peek works here too.
   *
   * Peek was attached only to the file view, so resting the pointer on a Home
   * tile did nothing — the same feature, the same delay, silently absent on the
   * page you land on. It needs a scroller, the tab, and a hit test from element
   * to entry; Home can answer all three, and every tile already carries its path
   * in `title` plus the flag saying whether it is a folder.
   */
  attachPeek({
    scroller,
    tab: () => myTab(),
    entryFromEvent: (target) => {
      const el = (target as HTMLElement | null)?.closest?.('[data-peek-path]') as HTMLElement | null
      const path = el?.dataset.peekPath ?? ''
      if (!path.startsWith('/')) return null
      const name = path.slice(path.lastIndexOf('/') + 1) || path
      return synthEntry(path, name, undefined, el!.dataset.peekDir === '1')
    },
    onActivate: opts.onActivate,
  })

  const sectionState = loadSectionState()
  let places: Place[] = app.places ?? []
  let favorites: FavoriteEntry[] = []
  let recents: RecentEntry[] = []
  /** the tab's sort, applied to each section — Home used to ignore it */
  let sortKey: string = 'mtime'
  let sortDesc = true
  let dataGen = 0
  let lastRefreshAt = 0

  function loadSectionState(): Record<string, boolean> {
    try {
      const raw = localStorage.getItem('home-sections')
      if (raw) return JSON.parse(raw) as Record<string, boolean>
    } catch { /* corrupted — defaults below */ }
    return {}
  }

  function saveSectionState(): void {
    try { localStorage.setItem('home-sections', JSON.stringify(sectionState)) } catch { /* full */ }
  }

  // ---------- section chrome ----------

  function makeSection(id: SectionId, title: string, menu?: (x: number, y: number) => void): HTMLElement {
    const sec = document.createElement('section')
    sec.className = 'home-section'
    sec.dataset.section = id
    const header = document.createElement('button')
    header.className = 'home-sec-header'
    header.innerHTML =
      `<span class="home-sec-chev">${CHEVRON_SVG}</span>` +
      `<span class="home-sec-title">${escapeHtml(title)}</span>` +
      '<span class="home-sec-count"></span>'
    const body = document.createElement('div')
    body.className = 'home-sec-body'
    const expanded = sectionState[id] !== false                // default open
    sec.classList.toggle('collapsed', !expanded)
    body.hidden = !expanded
    header.addEventListener('click', () => {
      const open = sec.classList.contains('collapsed')
      sec.classList.toggle('collapsed', !open)
      body.hidden = !open
      sectionState[id] = open
      saveSectionState()
    })
    if (menu) {
      header.addEventListener('contextmenu', (e) => {
        e.preventDefault()
        e.stopPropagation()
        menu(e.clientX, e.clientY)
      })
    }
    sec.append(header, body)
    scroller.appendChild(sec)
    return sec
  }

  function setCount(sec: HTMLElement, n: number): void {
    const el = sec.querySelector('.home-sec-count') as HTMLElement
    el.textContent = n ? String(n) : ''
  }

  function bodyOf(sec: HTMLElement): HTMLElement {
    return sec.querySelector('.home-sec-body') as HTMLElement
  }

  function emptyNote(text: string): HTMLElement {
    const el = document.createElement('div')
    el.className = 'home-empty'
    el.textContent = text
    return el
  }

  // ---------- item wiring ----------

  interface ItemOpts {
    path: string
    name: string
    isDir: boolean
    menu: (x: number, y: number) => void
    /** the other files in the same section, so ←/→ can walk them in the viewer */
    siblings?: { path: string; name: string; mime?: string }[]
    /** a real mime when the source knows one (Recent does); beats the guesser */
    mime?: string
  }

  /**
   * A FileEntry good enough to decide how to open something.
   *
   * Home tiles are built from Quick access / Favorites / Recent, none of which
   * carry a stat — only a path and a name. The media viewer needs six fields
   * (path, name, ext, mime, size, isDir) and uses size for display, not for the
   * decision, so a synthesised entry answers the question correctly without a
   * stat per tile on a page that may be showing a dead network mount.
   */
  function synthEntry(p: string, name: string, known?: string, isDir = false): FileEntry {
    const mime = isDir ? 'inode/directory' : (known && known !== 'application/octet-stream' ? known : mimeGuess(name))
    return {
      name, path: p, isDir, isSymlink: false,
      size: -1, mtime: 0, ctime: 0, mime,
      icons: isDir ? ['folder'] : iconsForMime(mime),
      hidden: name.startsWith('.'),
      ext: isDir ? '' : (name.split('.').pop() ?? '').toLowerCase(),
    }
  }

  /**
   * Open a file from a Home tile the way the file list would.
   *
   * This used to be a bare `liq.openPath`, which had two faults. The visible one
   * was that openPath went through `gio open`, and with LiqExplorer registered
   * for x-scheme-handler/file GIO resolved every file:// URI back to this app —
   * so double-clicking anything here opened another Explorer window instead of
   * the file (fixed in main/platform/apps.ts, which no longer routes files
   * through the scheme handler). The second is that it skipped the in-app
   * viewer entirely, so a photo in Recent opened in an external program while
   * the same photo in a folder opened in the pane — the setting said one thing
   * and two paths in the app did different things.
   */
  function openFile(o: ItemOpts): void {
    const rows = (o.siblings ?? [{ path: o.path, name: o.name, mime: o.mime }])
      .map(s => synthEntry(s.path, s.name, s.mime))
    if (openInMediaViewer(synthEntry(o.path, o.name, o.mime), rows)) return
    void liq.openPath(o.path)
  }

  function wireItem(el: HTMLElement, o: ItemOpts): void {
    el.tabIndex = 0
    // what hover peek reads. Set here rather than inferred from `title` or the
    // tile classes, because Recent rows carry neither and a hit test that works
    // for two sections out of three is worse than none.
    el.dataset.peekPath = o.path
    if (o.isDir) el.dataset.peekDir = '1'
    if (o.isDir) {
      // folders only: [data-liq-path] declares a right-drag DESTINATION
      el.dataset.liqPath = o.path
      el.dataset.liqLabel = o.name
    }
    // folders navigate on a single click (Win11 Home tiles); files need the
    // double-click, unless the user asked for single-click opening
    el.addEventListener('click', () => {
      if (o.isDir) navigate(o.path)
      else if (app.settings.singleClickOpen) openFile(o)
    })
    el.addEventListener('dblclick', () => {
      if (!o.isDir && !app.settings.singleClickOpen) openFile(o)
    })
    el.addEventListener('mousedown', (e) => { if (e.button === 1) e.preventDefault() })
    el.addEventListener('auxclick', (e) => {
      if (e.button === 1 && o.isDir) { e.preventDefault(); void app.newTab(o.path, true) }
    })
    el.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' && e.key !== ' ') return
      e.preventDefault()
      if (o.isDir) navigate(o.path); else openFile(o)
    })
    el.addEventListener('contextmenu', (e) => {
      e.preventDefault()
      e.stopPropagation()
      el.focus()
      o.menu(e.clientX, e.clientY)
    })
  }

  /**
   * A tile's picture: the file's own thumbnail where there is one, otherwise
   * the mime icon.
   *
   * Home only ever drew mime icons, so a folder of photos pinned to Favorites
   * showed five identical green "image" glyphs — in Large icons, which is the
   * mode you pick precisely to see the pictures. The file view has answered
   * this since it was written (items.ts wantsThumb/thumbURL over liqthumb://);
   * this is the same call, so Home shares the thumbnail cache rather than
   * building a second one.
   */
  function paintTileImage(img: HTMLImageElement, name: string, icons: string[], size: number, file?: { path: string; mime?: string }): void {
    const fallback = iconURL(icons, size)
    const mode = myTab()?.viewState?.mode ?? 'tiles'
    const entry = file ? synthEntry(file.path, name, file.mime) : null
    const thumb = entry && wantsThumb(entry, mode) ? thumbURL(entry, mode) : ''
    img.classList.toggle('is-thumb', !!thumb)
    img.src = thumb || fallback
    img.addEventListener('error', () => {
      // no thumbnail (not an image after all, or the thumbnailer declined):
      // fall back to the icon rather than leaving a hole
      if (thumb && img.src !== fallback) {
        img.classList.remove('is-thumb')
        img.src = fallback
      } else img.style.visibility = 'hidden'
    })
  }

  function makeTile(name: string, icons: string[], pinned: boolean, file?: { path: string; mime?: string }): HTMLElement {
    const el = document.createElement('div')
    el.className = 'home-tile'
    const img = document.createElement('img')
    img.className = 'home-tile-icon'
    img.draggable = false
    img.alt = ''
    paintTileImage(img, name, icons, TILE_ICON, file)
    const label = document.createElement('span')
    label.className = 'home-tile-name'
    label.textContent = name
    label.title = name
    el.append(img, label)
    if (pinned) {
      const pin = document.createElement('span')
      pin.className = 'home-tile-pin'
      pin.innerHTML = PIN_SVG
      pin.title = 'Pinned'
      el.appendChild(pin)
    }
    return el
  }

  // ---------- Quick access ----------

  const quickSec = makeSection('quick', 'Quick access')

  /** how (and whether) a Quick access tile can be removed again:
   *  'place' = a GTK bookmark unpinPlace really can delete, 'favorite' = one of
   *  ours. The six XDG user dirs are synthesised unconditionally by places.ts,
   *  so unpinning one can never remove its tile no matter what the bookmarks
   *  file says — for an unbookmarked dir it rewrote that file for nothing, and
   *  for a bookmarked one it silently destroyed Nemo's sidebar entry while the
   *  tile stayed put. Only `kind: 'pinned'` survives being unpinned. */
  type Unpin = 'place' | 'favorite' | null
  interface QuickItem { path: string; name: string; icons: string[]; unpin: Unpin }

  function quickItems(): QuickItem[] {
    const out: QuickItem[] = []
    const seen = new Set<string>()
    for (const p of places) {
      if (p.kind !== 'user-dir' && p.kind !== 'pinned') continue
      if (seen.has(p.path)) continue
      seen.add(p.path)
      out.push({
        path: p.path, name: p.label,
        icons: p.icons?.length ? p.icons : ['folder'],
        unpin: p.kind === 'pinned' ? 'place' : null,
      })
    }
    for (const f of favorites) {
      if (!f.isDir || seen.has(f.path)) continue
      seen.add(f.path)
      out.push({ path: f.path, name: f.name, icons: ['folder'], unpin: 'favorite' })
    }
    return out
  }

  function folderMenu(path: string, unpin: Unpin): (x: number, y: number) => void {
    return (x, y) => {
      const items: MenuItem[] = [
        { label: 'Open', onClick: () => navigate(path) },
        { label: 'Open in new tab', onClick: () => { void app.newTab(path, true) } },
      ]
      if (unpin) {
        items.push(
          { separator: true },
          {
            label: 'Unpin from Quick access',
            onClick: () => {
              if (unpin === 'place') void liq.unpinPlace(path)
              else void liq.invoke('removeFavorite', [path]).then(refresh)
            },
          },
        )
      }
      items.push(
        { separator: true },
        { label: 'Copy as path', shortcut: 'Ctrl+Shift+C', onClick: () => copyAsPath(path) },
        { label: 'Properties', shortcut: 'Alt+Enter', onClick: () => app.emit('show-properties', [path]) },
      )
      showMenu(items, { x, y })
    }
  }

  function renderQuick(): void {
    const body = bodyOf(quickSec)
    body.textContent = ''
    const items = sortEntries(quickItems(), sortKey, sortDesc)
    setCount(quickSec, items.length)
    if (!items.length) {
      body.appendChild(emptyNote('Pin a folder to see it here.'))
      return
    }
    const grid = document.createElement('div')
    grid.className = 'home-tiles'
    for (const it of items) {
      // the pin badge now means what it says: only tiles that can be unpinned
      const tile = makeTile(it.name, it.icons, it.unpin !== null)
      tile.title = it.path
      wireItem(tile, { path: it.path, name: it.name, isDir: true, menu: folderMenu(it.path, it.unpin) })
      grid.appendChild(tile)
    }
    body.appendChild(grid)
  }

  // ---------- Favorites ----------

  const favSec = makeSection('favorites', 'Favorites')

  function fileMenu(path: string, source: 'favorite' | 'recent'): (x: number, y: number) => void {
    return (x, y) => {
      const items: MenuItem[] = [
        { label: 'Open', onClick: () => openFile({ path, name: path.split('/').pop() ?? path, isDir: false, menu: () => {} }) },
        { label: 'Open file location', onClick: () => { void openFileLocation(path) } },
        { separator: true },
        source === 'favorite'
          ? {
              label: 'Remove from Favorites',
              onClick: () => { void liq.invoke('removeFavorite', [path]).then(refresh) },
            }
          : {
              label: 'Add to Favorites',
              // Recent only ever lists files; say so rather than letting main
              // guess isDir from the extension (see favorites.ts isDirSafe)
              onClick: () => { void liq.invoke('addFavorite', [{ path, isDir: false }]).then(refresh) },
            },
      ]
      if (source === 'recent') {
        items.push({
          label: 'Remove from Recent',
          onClick: () => { void liq.invoke('removeRecent', path).then(refresh) },
        })
      }
      items.push(
        { separator: true },
        { label: 'Copy as path', shortcut: 'Ctrl+Shift+C', onClick: () => copyAsPath(path) },
        { label: 'Properties', shortcut: 'Alt+Enter', onClick: () => app.emit('show-properties', [path]) },
      )
      showMenu(items, { x, y })
    }
  }

  function renderFavorites(): void {
    const body = bodyOf(favSec)
    body.textContent = ''
    // Folders belong here too. The store has always kept isDir and the "Add to
    // Favorites" verb has always accepted a folder — this section simply threw
    // them away on the way to the screen, so pinning a folder looked like it had
    // silently failed. Folders first, the way a file listing orders them.
    const items = sortEntries(favorites, sortKey, sortDesc)
      .sort((a, b) => Number(!!b.isDir) - Number(!!a.isDir))
    setCount(favSec, items.length)
    if (!items.length) {
      body.appendChild(emptyNote('Files and folders you add to Favorites show up here.'))
      return
    }
    // only the files make a viewer playlist; a folder is not something ←/→ walks
    const playable = items.filter(f => !f.isDir)
    const grid = document.createElement('div')
    grid.className = 'home-tiles'
    for (const f of items) {
      const tile = makeTile(
        f.name,
        f.isDir ? ['folder'] : iconsForMime(mimeGuess(f.name)),
        false,
        f.isDir ? undefined : { path: f.path },
      )
      tile.classList.add(f.isDir ? 'home-tile-dir' : 'home-tile-file')
      tile.title = f.path
      wireItem(tile, {
        path: f.path, name: f.name, isDir: !!f.isDir, menu: fileMenu(f.path, 'favorite'),
        // the rest of Favorites becomes the viewer's playlist, so ←/→ walks the
        // section the way it walks a folder
        siblings: playable.map(x => ({ path: x.path, name: x.name })),
      })
      grid.appendChild(tile)
    }
    body.appendChild(grid)
  }

  // ---------- Recent ----------

  const recentSec = makeSection('recent', 'Recent', (x, y) => {
    showMenu([
      {
        label: 'Clear recent files list',
        disabled: !recents.length,
        // this wipes ~/.local/share/recently-used.xbel, which every GTK app
        // (Nemo included) shares and nothing can restore — so confirm first
        onClick: () => app.emit('show-confirm', {
          title: 'Clear recent files',
          message: 'This clears the recent files list for all apps that share it, '
            + 'including your file manager and document apps. It cannot be undone.',
          okLabel: 'Clear',
          danger: true,
          onOk: () => { void liq.invoke('clearRecent').then(refresh) },
        }),
      },
      {
        label: 'Show recent files',
        checked: app.settings.showRecent,
        onClick: () => { void app.setSettings({ showRecent: !app.settings.showRecent }) },
      },
    ], { x, y })
  })

  function renderRecent(): void {
    const body = bodyOf(recentSec)
    body.textContent = ''
    recentSec.hidden = !app.settings.showRecent
    setCount(recentSec, recents.length)
    const ordered = sortEntries(recents, sortKey, sortDesc)
    if (!recents.length) {
      body.appendChild(emptyNote('Files you open show up here.'))
      return
    }
    const list = document.createElement('div')
    list.className = 'home-list'
    for (const r of ordered) {
      const row = document.createElement('div')
      row.className = 'home-row'
      const img = document.createElement('img')
      img.className = 'home-row-icon'
      img.draggable = false
      img.alt = ''
      const mime = r.mime && r.mime !== 'application/octet-stream' ? r.mime : mimeGuess(r.name)
      paintTileImage(img, r.name, iconsForMime(mime), ROW_ICON, { path: r.path, mime })
      const name = document.createElement('span')
      name.className = 'home-row-name'
      name.textContent = r.name
      name.title = r.path
      const dir = document.createElement('span')
      dir.className = 'home-row-dir'
      dir.textContent = r.dir
      dir.title = r.dir
      const when = document.createElement('span')
      when.className = 'home-row-time'
      when.textContent = relTime(r.visitedAt)
      when.title = r.visitedAt ? formatDate(r.visitedAt) : ''
      row.append(img, name, dir, when)
      wireItem(row, {
        path: r.path, name: r.name, isDir: false, mime: r.mime, menu: fileMenu(r.path, 'recent'),
        siblings: ordered.map(x => ({ path: x.path, name: x.name, mime: x.mime })),
      })
      list.appendChild(row)
    }
    body.appendChild(list)
  }

  // ---------- data ----------

  async function refresh(): Promise<void> {
    const gen = ++dataGen
    lastRefreshAt = Date.now()
    places = app.places ?? []
    const [favs, recent] = await Promise.all([
      liq.invoke('listFavorites').catch(() => [] as FavoriteEntry[]),
      app.settings.showRecent
        ? liq.invoke('listRecent', RECENT_LIMIT).catch(() => [] as RecentEntry[])
        : Promise.resolve([] as RecentEntry[]),
    ])
    if (gen !== dataGen) return                      // a newer refresh already landed
    favorites = Array.isArray(favs) ? favs : []
    recents = Array.isArray(recent) ? recent : []
    renderQuick()
    renderFavorites()
    renderRecent()
    publishCounts()
  }

  /** the status bar has no rows to count on this page, so Home tells it */
  function publishCounts(): void {
    if (!visible) return
    app.emit('home-counts', {
      quick: quickItems().length,
      favorites: favorites.filter(f => !f.isDir).length,
      recent: app.settings.showRecent ? recents.length : 0,
    })
  }

  // ---------- visibility ----------

  let visible = false

  function sync(): void {
    const t = myTab()
    const isHome = !!t && t.path === HOME_URI
    root.hidden = !isHome
    if (viewhost) viewhost.hidden = isHome
    if (isHome && !visible) void refresh()           // always land on fresh data
    visible = isHome
    // the mode belongs to the tab, so arriving on Home from a folder in Details
    // must bring Details with it rather than showing whatever was here last
    if (isHome) { applyViewState(); publishCounts() }
  }

  /**
   * Home honours the view mode and the sort order.
   *
   * It did not, and nothing said so: the View and Sort buttons stayed enabled
   * on this page and simply did nothing, because the mode lives on the Tab and
   * only the file view was reading it. Home draws its own tiles and rows, so it
   * has to apply the mode itself — which it can, since "how big are the icons"
   * and "what order are these in" are questions this page can answer as well as
   * any folder.
   *
   * The mode becomes a data attribute and CSS does the rest, so switching modes
   * costs no re-render — the sections keep their scroll position and the
   * Recent list does not flicker.
   */
  /** the mode the sections were last BUILT for; the thumbnail size and whether
   *  there is a thumbnail at all both depend on it */
  let builtForMode = ''

  function applyViewState(): void {
    const t = myTab()
    const mode = t?.viewState?.mode ?? 'tiles'
    root.dataset.mode = mode
    const key = t?.viewState?.sortKey ?? 'mtime'
    const desc = (t?.viewState?.sortDir ?? 'desc') === 'desc'
    const modeChanged = mode !== builtForMode
    if (modeChanged) builtForMode = mode
    if (key !== sortKey || desc !== sortDesc || modeChanged) {
      sortKey = key
      sortDesc = desc
      // a mode change is a rebuild, not just a restyle: List has no thumbnails
      // and Large wants the big ones, so the <img> sources themselves change
      if (visible) { renderQuick(); renderFavorites(); renderRecent() }
    }
  }
  app.on('tab-viewstate', (t: Tab) => { if (t === myTab()) applyViewState() })

  app.on('tab-navigated', (t: Tab) => { if (t === myTab()) sync() })
  app.on('tabs-changed', () => sync())
  app.on('panes-changed', () => sync())              // split opened/closed
  // F5 / Refresh on Home: the tab has nothing to list, so re-pull our own data
  // (skipped right after a navigation, which already refreshed)
  app.on('tab-listing', (t: Tab) => {
    if (t !== myTab() || t.path !== HOME_URI) return
    if (Date.now() - lastRefreshAt < 300) return
    void refresh()
  })
  app.on('places-changed', () => { places = app.places ?? []; if (visible) renderQuick() })
  app.on('settings-changed', () => { if (visible) void refresh() })
  liq.on(PUSH.favoritesChanged, (list: FavoriteEntry[]) => {
    favorites = Array.isArray(list) ? list : []
    if (visible) { renderQuick(); renderFavorites() }
  })
  // context-menu "Add to Favorites" (wired wherever the app emits it). Items are
  // { path, isDir } where the emitter knows the entry; bare paths still work.
  //
  // These two are GLOBAL commands, not per-page rendering: with a Home page
  // mounted in each pane, only the first instance may run the IPC or every
  // add/remove would fire twice. Both instances still redraw, because the main
  // process broadcasts favoritesChanged after any write.
  if (!favoriteVerbsClaimed) {
    favoriteVerbsClaimed = true
    app.on('add-to-favorites', (items: (string | { path: string; isDir: boolean })[]) => {
      void liq.invoke('addFavorite', items).then(() => { if (visible) void refresh() })
    })
    app.on('remove-from-favorites', (items: (string | { path: string })[]) => {
      void liq.invoke('removeFavorite', items).then(() => { if (visible) void refresh() })
    })
  }

  sync()
}
