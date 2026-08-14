// Home page — Win11's default landing view (docs/research/research-layout-chrome.md §7).
//
// Three collapsible sections: Quick access (pinned folders, the same set the
// nav pane mirrors), Favorites (pinned FILES) and Recent (recently used files
// from the GTK store, shared with Nemo). It lives beside the file view inside
// #main and swaps with it whenever the active tab sits at home:// — the view
// host keeps owning every real folder listing.
import { app, liq, HOME_URI, Tab } from '../core/app'
import type { FavoriteEntry, Place, RecentEntry } from '../../shared/types'
import { PUSH } from '../../shared/ipc'
import { formatDate } from '../../shared/sort'
import { showMenu } from '../menus/menu'
import type { MenuItem } from '../menus/menu-types'
import { escapeHtml, iconURL } from './items'

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

export function mountHome(root: HTMLElement): void {
  const viewhost = document.getElementById('viewhost')
  root.innerHTML = ''

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

  const sectionState = loadSectionState()
  let places: Place[] = app.places ?? []
  let favorites: FavoriteEntry[] = []
  let recents: RecentEntry[] = []
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
  }

  function wireItem(el: HTMLElement, o: ItemOpts): void {
    el.tabIndex = 0
    if (o.isDir) {
      // folders only: [data-liq-path] declares a right-drag DESTINATION
      el.dataset.liqPath = o.path
      el.dataset.liqLabel = o.name
    }
    // folders navigate on a single click (Win11 Home tiles); files need the
    // double-click, unless the user asked for single-click opening
    el.addEventListener('click', () => {
      if (o.isDir) navigate(o.path)
      else if (app.settings.singleClickOpen) void liq.openPath(o.path)
    })
    el.addEventListener('dblclick', () => {
      if (!o.isDir && !app.settings.singleClickOpen) void liq.openPath(o.path)
    })
    el.addEventListener('mousedown', (e) => { if (e.button === 1) e.preventDefault() })
    el.addEventListener('auxclick', (e) => {
      if (e.button === 1 && o.isDir) { e.preventDefault(); void app.newTab(o.path, true) }
    })
    el.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' && e.key !== ' ') return
      e.preventDefault()
      if (o.isDir) navigate(o.path); else void liq.openPath(o.path)
    })
    el.addEventListener('contextmenu', (e) => {
      e.preventDefault()
      e.stopPropagation()
      el.focus()
      o.menu(e.clientX, e.clientY)
    })
  }

  function makeTile(name: string, icons: string[], pinned: boolean): HTMLElement {
    const el = document.createElement('div')
    el.className = 'home-tile'
    const img = document.createElement('img')
    img.className = 'home-tile-icon'
    img.draggable = false
    img.alt = ''
    img.src = iconURL(icons, TILE_ICON)
    img.addEventListener('error', () => { img.style.visibility = 'hidden' })
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

  /** pinned folders: GTK bookmarks + XDG user dirs, plus favorited folders */
  function quickItems(): { path: string; name: string; icons: string[]; place: boolean }[] {
    const out: { path: string; name: string; icons: string[]; place: boolean }[] = []
    const seen = new Set<string>()
    for (const p of places) {
      if (p.kind !== 'user-dir' && p.kind !== 'pinned') continue
      if (seen.has(p.path)) continue
      seen.add(p.path)
      out.push({ path: p.path, name: p.label, icons: p.icons?.length ? p.icons : ['folder'], place: true })
    }
    for (const f of favorites) {
      if (!f.isDir || seen.has(f.path)) continue
      seen.add(f.path)
      out.push({ path: f.path, name: f.name, icons: ['folder'], place: false })
    }
    return out
  }

  function folderMenu(path: string, isPlace: boolean): (x: number, y: number) => void {
    return (x, y) => {
      const items: MenuItem[] = [
        { label: 'Open', onClick: () => navigate(path) },
        { label: 'Open in new tab', onClick: () => { void app.newTab(path, true) } },
        { separator: true },
        {
          label: 'Unpin from Quick access',
          onClick: () => {
            if (isPlace) void liq.unpinPlace(path)
            else void liq.invoke('removeFavorite', [path]).then(refresh)
          },
        },
        { separator: true },
        { label: 'Copy as path', shortcut: 'Ctrl+Shift+C', onClick: () => copyAsPath(path) },
        { label: 'Properties', shortcut: 'Alt+Enter', onClick: () => app.emit('show-properties', [path]) },
      ]
      showMenu(items, { x, y })
    }
  }

  function renderQuick(): void {
    const body = bodyOf(quickSec)
    body.textContent = ''
    const items = quickItems()
    setCount(quickSec, items.length)
    if (!items.length) {
      body.appendChild(emptyNote('Pin a folder to see it here.'))
      return
    }
    const grid = document.createElement('div')
    grid.className = 'home-tiles'
    for (const it of items) {
      const tile = makeTile(it.name, it.icons, true)
      tile.title = it.path
      wireItem(tile, { path: it.path, name: it.name, isDir: true, menu: folderMenu(it.path, it.place) })
      grid.appendChild(tile)
    }
    body.appendChild(grid)
  }

  // ---------- Favorites ----------

  const favSec = makeSection('favorites', 'Favorites')

  function fileMenu(path: string, source: 'favorite' | 'recent'): (x: number, y: number) => void {
    return (x, y) => {
      const items: MenuItem[] = [
        { label: 'Open', onClick: () => { void liq.openPath(path) } },
        { label: 'Open file location', onClick: () => { void openFileLocation(path) } },
        { separator: true },
        source === 'favorite'
          ? {
              label: 'Remove from Favorites',
              onClick: () => { void liq.invoke('removeFavorite', [path]).then(refresh) },
            }
          : {
              label: 'Add to Favorites',
              onClick: () => { void liq.invoke('addFavorite', [path]).then(refresh) },
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
    const files = favorites.filter(f => !f.isDir)
    setCount(favSec, files.length)
    if (!files.length) {
      body.appendChild(emptyNote('Files you add to Favorites show up here.'))
      return
    }
    const grid = document.createElement('div')
    grid.className = 'home-tiles'
    for (const f of files) {
      const tile = makeTile(f.name, iconsForMime(mimeGuess(f.name)), false)
      tile.classList.add('home-tile-file')
      tile.title = f.path
      wireItem(tile, { path: f.path, name: f.name, isDir: false, menu: fileMenu(f.path, 'favorite') })
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
    if (!recents.length) {
      body.appendChild(emptyNote('Files you open show up here.'))
      return
    }
    const list = document.createElement('div')
    list.className = 'home-list'
    for (const r of recents) {
      const row = document.createElement('div')
      row.className = 'home-row'
      const img = document.createElement('img')
      img.className = 'home-row-icon'
      img.draggable = false
      img.alt = ''
      const mime = r.mime && r.mime !== 'application/octet-stream' ? r.mime : mimeGuess(r.name)
      img.src = iconURL(iconsForMime(mime), ROW_ICON)
      img.addEventListener('error', () => { img.style.visibility = 'hidden' })
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
      wireItem(row, { path: r.path, name: r.name, isDir: false, menu: fileMenu(r.path, 'recent') })
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
  }

  // ---------- visibility ----------

  let visible = false

  function sync(): void {
    const isHome = app.activeTab?.path === HOME_URI
    root.hidden = !isHome
    if (viewhost) viewhost.hidden = isHome
    if (isHome && !visible) void refresh()           // always land on fresh data
    visible = isHome
  }

  app.on('tab-navigated', (t: Tab) => { if (t === app.activeTab) sync() })
  app.on('tabs-changed', () => sync())
  // F5 / Refresh on Home: the tab has nothing to list, so re-pull our own data
  // (skipped right after a navigation, which already refreshed)
  app.on('tab-listing', (t: Tab) => {
    if (t !== app.activeTab || t.path !== HOME_URI) return
    if (Date.now() - lastRefreshAt < 300) return
    void refresh()
  })
  app.on('places-changed', () => { places = app.places ?? []; if (visible) renderQuick() })
  app.on('settings-changed', () => { if (visible) void refresh() })
  liq.on(PUSH.favoritesChanged, (list: FavoriteEntry[]) => {
    favorites = Array.isArray(list) ? list : []
    if (visible) { renderQuick(); renderFavorites() }
  })
  // context-menu "Add to Favorites" (wired wherever the app emits it)
  app.on('add-to-favorites', (paths: string[]) => {
    void liq.invoke('addFavorite', paths).then(() => { if (visible) void refresh() })
  })
  app.on('remove-from-favorites', (paths: string[]) => {
    void liq.invoke('removeFavorite', paths).then(() => { if (visible) void refresh() })
  })

  sync()
}
