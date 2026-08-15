// Status bar: item count, selection count + size; right end: Details / Large
// thumbnails quick view toggles (Win10-heritage buttons Win11 kept).
import { app, Tab } from '../core/app'
import { formatSize } from '../../shared/sort'

const SVG_DETAILS = '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"><path d="M5.5 3.5h9M5.5 8h9M5.5 12.5h9"/><path d="M2 3.5h.6M2 8h.6M2 12.5h.6"/></svg>'
const SVG_THUMBS = '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"><rect x="1.8" y="1.8" width="5.4" height="5.4" rx="0.8"/><rect x="8.8" y="1.8" width="5.4" height="5.4" rx="0.8"/><rect x="1.8" y="8.8" width="5.4" height="5.4" rx="0.8"/><rect x="8.8" y="8.8" width="5.4" height="5.4" rx="0.8"/></svg>'

export function mountStatusBar(root: HTMLElement): void {
  root.innerHTML = `
    <span class="sb-count"></span>
    <span class="sb-sel"></span>
    <div class="sb-spacer"></div>
    <button class="sb-toggle sb-details" title="Display information about each item in the window" aria-label="Details view">${SVG_DETAILS}</button>
    <button class="sb-toggle sb-thumbs" title="Display items by using large thumbnails" aria-label="Large icons view">${SVG_THUMBS}</button>`

  const count = root.querySelector('.sb-count') as HTMLElement
  const sel = root.querySelector('.sb-sel') as HTMLElement
  const detailsBtn = root.querySelector('.sb-details') as HTMLButtonElement
  const thumbsBtn = root.querySelector('.sb-thumbs') as HTMLButtonElement

  detailsBtn.addEventListener('click', () => app.activeTab.setViewState({ mode: 'details' }))
  thumbsBtn.addEventListener('click', () => app.activeTab.setViewState({ mode: 'large' }))

  const render = () => {
    const t = app.activeTab
    if (!t) return
    const n = t.rows.length
    // Home has no rows of its own, so "0 items" would look broken and a blank
    // bar (what was here) looks like the bar is broken instead. It does have
    // counts — they just live on the page rather than on the tab.
    if (t.path === 'home://') {
      const parts: string[] = []
      if (homeCounts.quick) parts.push(`${homeCounts.quick} pinned`)
      if (homeCounts.favorites) parts.push(`${homeCounts.favorites} favourite${homeCounts.favorites === 1 ? '' : 's'}`)
      if (homeCounts.recent) parts.push(`${homeCounts.recent} recent`)
      count.textContent = parts.join('  ·  ')
    } else {
      count.textContent = `${n} item${n === 1 ? '' : 's'}`
    }
    const s = t.selectedEntries()
    if (s.length) {
      const bytes = s.reduce((a, e) => a + (e.size > 0 ? e.size : 0), 0)
      sel.textContent = `| ${s.length} item${s.length === 1 ? '' : 's'} selected ${bytes > 0 ? ' ' + formatSize(bytes) : ''}`
    } else {
      sel.textContent = ''
    }
    detailsBtn.classList.toggle('active', t.viewState.mode === 'details')
    thumbsBtn.classList.toggle('active', t.viewState.mode === 'large')
  }

  let homeCounts = { quick: 0, favorites: 0, recent: 0 }
  app.on('home-counts', (c: { quick: number; favorites: number; recent: number }) => {
    homeCounts = c
    if (app.activeTab?.path === 'home://') render()
  })

  const renderVisibility = () => { root.toggleAttribute('hidden', !app.settings.showStatusBar) }

  app.on('tab-listing', (t: Tab) => { if (t === app.activeTab) render() })
  app.on('tab-selection', (t: Tab) => { if (t === app.activeTab) render() })
  app.on('tab-viewstate', (t: Tab) => { if (t === app.activeTab) render() })
  app.on('tabs-changed', render)
  app.on('settings-changed', renderVisibility)
  renderVisibility()
  render()
}
