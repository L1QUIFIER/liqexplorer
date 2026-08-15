// STAR RATINGS — the renderer half.
//
// SELF-MOUNTING: importing this module installs the whole feature — its
// stylesheet, the number-key handler, and the listener that keeps entries in
// sync when main says a rating changed. The hook that imports it is
// starsHtml(), called from items.ts while it renders a tile, exactly as
// livemedia.ts is imported by the thumbnail path. Nothing in index.ts needs a
// line for it.
//
// Recycling: view-host.ts pools item <div>s and rebuilds their children with
// innerHTML on every bind, so the stars are emitted as part of that HTML and
// carry no per-element listeners and no state that has to be unwound. Clicks
// are delegated on the scroller (see view-host.ts), which is the only
// arrangement that survives recycling.
import { app, liq } from '../core/app'
import type { Tab } from '../core/app'
import type { FileEntry } from '../../shared/types'
import type { MenuItem } from '../menus/menu-types'
import { RATING_MAX, RATINGS_CHANGED, ratingLabel, type RatingsChanged } from '../../shared/ratings'

const STAR = 'M8 1.7l1.86 3.77 4.16.6-3.01 2.94.71 4.14L8 11.2l-3.72 1.95.71-4.14L1.98 6.07l4.16-.6z'

/** Star row markup. Pure — no state, no listeners; view-host delegates the click. */
export function starsHtml(rating: number): string {
  let s = `<span class="vh-stars${rating ? ' rated' : ''}">`
  for (let i = 1; i <= RATING_MAX; i++) {
    s += `<span class="vh-star${i <= rating ? ' on' : ''}" data-star="${i}" title="${ratingLabel(i)}">` +
      `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="${STAR}"/></svg></span>`
  }
  return s + '</span>'
}

/**
 * Corner badge for a tile. Returns '' for an unrated file — no element at all,
 * which is both the common case and the cheapest thing for a 5000-tile folder.
 *
 * This replaced a five-star strip that was absolutely positioned over the tile.
 * That strip was 80px wide and a medium tile is exactly 80px, so it covered the
 * filename it was annotating; worse, selecting a tile expands its label to eight
 * lines while the strip stayed pinned to the original tile bottom, stamping
 * across the name. A badge inside the thumbnail can never touch the text in any
 * state, because it is positioned against the picture rather than the tile.
 *
 * One star and a digit, not five stars: at a 48-96px thumbnail five 12px stars
 * are a grey smear, and the number is what is actually being communicated.
 */
export function ratingBadgeHtml(rating: number): string {
  if (!rating) return ''
  return `<span class="vh-ratebadge" title="${ratingLabel(rating)}" aria-hidden="true">` +
    `<svg viewBox="0 0 16 16"><path d="${STAR}"/></svg>${rating}</span>`
}

// ------------------------------------------------------------------ applying

/** Rate paths. Main owns the write; the repaint comes back over RATINGS_CHANGED
 *  so every pane and both windows agree without any of them guessing. */
export function applyRating(paths: string[], rating: number): void {
  const real = paths.filter(p => p.startsWith('/'))
  if (!real.length) return
  void liq.invoke('setRating', real, rating)
}

/** Rate whatever is selected in the focused pane. Folders are skipped rather
 *  than rated: the filter deliberately never hides a folder, so a rating on one
 *  could never be acted on, and a star that does nothing is worse than none. */
export function rateSelection(rating: number): void {
  const t = app.activeTab
  if (!t?.selection.size) return
  const files = (t.selectedEntries() as FileEntry[]).filter(e => !e.isDir)
  applyRating(files.map(e => e.path), rating)
}

// ------------------------------------------------------------- change fan-out

function applyChanges(changes: Record<string, number>): void {
  const touched = new Set<Tab>()
  for (const t of app.allTabs()) {
    for (const e of t.entries as FileEntry[]) {
      const next = changes[e.path]
      if (next === undefined) continue
      if (next) e.rating = next; else delete e.rating
      touched.add(t)
    }
  }
  for (const t of touched) {
    // recompute, not just repaint: with sort-by-rating or a rating filter live,
    // the change can move or remove the row
    t.recompute()
    app.emit('tab-listing', t)
  }
  // "Starred" is a listing OF the ratings, so any change invalidates it
  for (const t of app.allTabs()) {
    if (t.path === STARRED_URI && !touched.has(t)) void t.refresh()
  }
}

// ------------------------------------------------------------------- backfill

export const STARRED_URI = 'starred://'

/** paths already offered to main, so scrolling a folder does not re-ask */
const asked = new Set<string>()
let backfillTimer: number | null = null

/**
 * Ask main to look for ratings this app has never recorded: an xattr that came
 * along with a file some other tool moved, or an xmp:Rating baked into a photo
 * by digiKam / Lightroom / Windows. Debounced and bounded because every miss on
 * the share is an SMB round-trip.
 */
function scheduleBackfill(): void {
  if (backfillTimer !== null) return
  backfillTimer = window.setTimeout(() => {
    backfillTimer = null
    const t = app.activeTab
    if (!t) return
    const want: string[] = []
    for (const e of t.entries as FileEntry[]) {
      if (e.rating || !e.path.startsWith('/') || asked.has(e.path)) continue
      want.push(e.path)
      if (want.length >= 240) break
    }
    if (!want.length) return
    for (const p of want) asked.add(p)
    if (asked.size > 20_000) asked.clear()
    void liq.invoke('backfillRatings', want)
  }, 700)
}

// --------------------------------------------------------------- filter menus

const FILTER_STEPS = [1, 2, 3, 4, 5]

/** Shared by the command bar's Sort menu and the background context menu. */
export function ratingFilterSubmenu(t: Tab): MenuItem[] {
  const cur = t.viewState.minRating ?? 0
  return [
    {
      label: 'All items', radio: true, checked: !cur,
      onClick: () => t.setViewState({ minRating: 0 }),
    },
    { separator: true },
    ...FILTER_STEPS.map<MenuItem>(n => ({
      label: n === RATING_MAX ? `${RATING_MAX} stars` : `${n} ${n === 1 ? 'star' : 'stars'} and up`,
      radio: true, checked: cur === n,
      onClick: () => t.setViewState({ minRating: n }),
    })),
  ]
}

/** Rate submenu for the item context menu. */
export function rateSubmenu(entries: FileEntry[]): MenuItem[] {
  const files = entries.filter(e => !e.isDir)
  const paths = files.map(e => e.path)
  // a mixed selection shows no radio filled, which is the honest answer
  const all = files.length ? files[0].rating ?? 0 : 0
  const uniform = files.every(e => (e.rating ?? 0) === all)
  return [
    ...[5, 4, 3, 2, 1].map<MenuItem>(n => ({
      label: ratingLabel(n), radio: true, checked: uniform && all === n,
      shortcut: String(n),
      onClick: () => applyRating(paths, n),
    })),
    { separator: true },
    {
      label: 'Clear rating', radio: true, checked: uniform && !all, shortcut: '0',
      onClick: () => applyRating(paths, 0),
    },
  ]
}

// ------------------------------------------------------------- the filter bar

/**
 * A strip above the items that appears only while a rating filter is on. The
 * menus are where the filter is set; this exists so it can never be on without
 * being visible — a filtered folder that looks like an empty one is the whole
 * failure mode worth designing against.
 */
export function mountRatingBar(root: HTMLElement, getTab: () => Tab | null): void {
  const bar = document.createElement('div')
  bar.className = 'vh-ratebar'
  bar.hidden = true
  root.appendChild(bar)

  const paint = (): void => {
    const t = getTab()
    const min = t?.viewState.minRating ?? 0
    bar.hidden = !min
    root.classList.toggle('vh-has-ratebar', !!min)
    if (!min || !t) return
    bar.innerHTML = `<span class="vh-ratebar-txt">Showing ${starsHtml(min)} ${
      min === RATING_MAX ? 'only' : 'and up'}</span>` +
      '<button class="vh-ratebar-clear" type="button">Clear filter</button>'
    bar.querySelector('.vh-ratebar-clear')!
      .addEventListener('click', () => t.setViewState({ minRating: 0 }))
  }

  app.on('tab-viewstate', paint)
  app.on('tab-navigated', paint)
  app.on('tab-listing', paint)
  app.on('pane-focus', paint)
  paint()
}

// ------------------------------------------------------------------ self-mount

function injectStyles(): void {
  if (document.querySelector('link[data-rating-style]')) return
  const link = document.createElement('link')
  link.rel = 'stylesheet'
  link.href = 'styles/ratings.css'
  link.setAttribute('data-rating-style', '1')
  document.head.appendChild(link)
}

function mount(): void {
  injectStyles()

  // Capture phase, deliberately: the views layer owns plain letter/digit keys
  // for type-ahead (view-host.ts binds keydown on the scroller), so a bubble
  // listener would jump the selection to a file starting with "3" before this
  // ever saw the key. stopPropagation is what keeps type-ahead out of it.
  window.addEventListener('keydown', (e) => {
    if (e.ctrlKey || e.altKey || e.metaKey || e.shiftKey) return
    const target = e.target as HTMLElement | null
    const tag = target?.tagName
    if (tag === 'INPUT' || tag === 'TEXTAREA' || target?.isContentEditable) return
    if (!e.code.startsWith('Digit')) return
    const n = Number(e.code.slice(5))
    if (!Number.isFinite(n) || n < 0 || n > RATING_MAX) return
    const t = app.activeTab
    if (!t?.selection.size) return
    rateSelection(n)
    e.preventDefault()
    e.stopPropagation()
  }, true)

  liq.on(RATINGS_CHANGED, (p: RatingsChanged) => applyChanges(p?.changes ?? {}))
  app.on('tab-listing', scheduleBackfill)

  // starred:// is this module's location, so it names itself rather than
  // costing core/app.ts a branch. Tab.navigate's fallback is the last path
  // segment, which would render the tab as "starred:". This listener is
  // registered at import time — before boot() calls mountTitlebar — so the
  // title is already correct by the time the tab strip reads it.
}

mount()
