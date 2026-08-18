// Status bar: item count, selection count + size; right end: Details / Large
// thumbnails quick view toggles (Win10-heritage buttons Win11 kept).
import { app, liq, Tab } from '../core/app'
import { formatSize } from '../../shared/sort'
import type { OpProgress } from '../../shared/types'

const SVG_DETAILS = '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"><path d="M5.5 3.5h9M5.5 8h9M5.5 12.5h9"/><path d="M2 3.5h.6M2 8h.6M2 12.5h.6"/></svg>'
const SVG_THUMBS = '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"><rect x="1.8" y="1.8" width="5.4" height="5.4" rx="0.8"/><rect x="8.8" y="1.8" width="5.4" height="5.4" rx="0.8"/><rect x="1.8" y="8.8" width="5.4" height="5.4" rx="0.8"/><rect x="8.8" y="8.8" width="5.4" height="5.4" rx="0.8"/></svg>'

export function mountStatusBar(root: HTMLElement): void {
  root.innerHTML = `
    <span class="sb-count"></span>
    <span class="sb-sel"></span>
    <div class="sb-spacer"></div>
    <button class="sb-activity" hidden aria-live="polite"></button>
    <button class="sb-toggle sb-details" title="Display information about each item in the window" aria-label="Details view">${SVG_DETAILS}</button>
    <button class="sb-toggle sb-thumbs" title="Display items by using large thumbnails" aria-label="Large icons view">${SVG_THUMBS}</button>`

  const count = root.querySelector('.sb-count') as HTMLElement
  const sel = root.querySelector('.sb-sel') as HTMLElement
  const activity = root.querySelector('.sb-activity') as HTMLButtonElement
  const detailsBtn = root.querySelector('.sb-details') as HTMLButtonElement
  const thumbsBtn = root.querySelector('.sb-thumbs') as HTMLButtonElement

  // ---- activity light ----
  //
  // The quietest useful answer to "is it doing something, or is it stuck".
  // Hidden when nothing is happening, so it costs no space and no attention;
  // when a transfer or a scan is running it says what and how far, and clicking
  // it opens the operations list.
  //
  // It also reports the one thing the app cannot fix and the user cannot see:
  // a network mount that has just reconnected. A stall during a reconnect looks
  // exactly like the app hanging, and saying "the share dropped" turns an
  // apparently broken file manager into an explained one.
  interface Health {
    busy: string[]
    loop: { worstLagMs: number }
    mount: { reconnectsSinceLaunch: number } | null
  }
  let lastReconnects = 0
  let mountWarnUntil = 0

  const pollActivity = async (): Promise<void> => {
    const ops = (await liq.getOps().catch(() => [])) as OpProgress[]
    const live = ops.filter(o => o.status === 'running' || o.status === 'queued' || o.status === 'enumerating')
    const h = (await liq.invoke('health').catch(() => null)) as Health | null

    if (h?.mount && h.mount.reconnectsSinceLaunch > lastReconnects) {
      lastReconnects = h.mount.reconnectsSinceLaunch
      mountWarnUntil = Date.now() + 20_000      // say it, then stop nagging
    }

    if (Date.now() < mountWarnUntil) {
      activity.hidden = false
      activity.className = 'sb-activity is-warn'
      activity.textContent = 'Network drive reconnected'
      activity.title = 'The share dropped and came back. Anything that paused just now was the network, not this app.'
      return
    }
    if (live.length) {
      const a = live[0]
      const pct = a.bytesTotal > 0 ? Math.round((a.bytesDone / a.bytesTotal) * 100) : 0
      const more = live.length > 1 ? ` +${live.length - 1}` : ''
      activity.hidden = false
      activity.className = 'sb-activity is-busy'
      activity.textContent = `${a.kind} ${pct}%${more}`
      activity.title = `${a.itemsDone} of ${a.itemsTotal} — ${a.currentFile || ''}\nClick to highlight the transfer panel.`
      return
    }
    if (h?.busy?.length) {
      activity.hidden = false
      activity.className = 'sb-activity is-busy'
      activity.textContent = 'Scanning…'
      activity.title = h.busy.join('\n')
      return
    }
    activity.hidden = true
  }
  activity.addEventListener('click', () => app.emit('ops-attention'))
  // 1s: fast enough to feel live, slow enough that the poll itself is free
  window.setInterval(() => { void pollActivity() }, 1000)
  void pollActivity()

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
