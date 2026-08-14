// Navigation row: back/forward/up/refresh, breadcrumb address bar (chevron
// child-folder dropdowns, « overflow, edit mode with autocomplete), search box.
import { app, liq, Tab } from '../core/app'
import type { FileEntry } from '../../shared/types'
import { showMenu } from '../menus/menu'
import type { MenuItem } from '../menus/menu-types'

const SVG_BACK = '<svg width="16" height="16" viewBox="0 0 16 16"><path d="M14 8H2.5M7 3.5 2.5 8 7 12.5" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>'
const SVG_FWD = '<svg width="16" height="16" viewBox="0 0 16 16"><path d="M2 8h11.5M9 3.5 13.5 8 9 12.5" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>'
const SVG_UP = '<svg width="16" height="16" viewBox="0 0 16 16"><path d="M8 14V2.5M3.5 7 8 2.5 12.5 7" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>'
const SVG_REFRESH = '<svg width="16" height="16" viewBox="0 0 16 16"><path d="M13.5 8A5.5 5.5 0 1 1 11.7 3.9M13.5 1.5v3.2h-3.2" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>'
const SVG_CHEV_RIGHT = '<svg width="12" height="12" viewBox="0 0 12 12"><path d="M4 2l4 4-4 4" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>'
const SVG_CHEVS_LEFT = '<svg width="12" height="12" viewBox="0 0 12 12"><path d="M6 2 2 6l4 4M10.5 2l-4 4 4 4" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/></svg>'
const SVG_SEARCH = '<svg width="14" height="14" viewBox="0 0 16 16"><circle cx="7" cy="7" r="4.6" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M10.6 10.6 14 14" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>'
const SVG_X = '<svg width="12" height="12" viewBox="0 0 12 12"><path d="M2 2l8 8M10 2l-8 8" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>'

interface Crumb { label: string; path: string; name: string }

function normPath(p: string): string { return p.replace(/\/+$/, '') || '/' }

function labelForPath(path: string): string {
  if (path === 'home://') return 'Home'
  if (path === 'trash://') return 'Recycle Bin'
  if (path === 'computer://') return 'This PC'
  const n = normPath(path)
  if (n === '/') return 'Computer'
  if (n === normPath(app.homePath)) return 'Home'
  return n.split('/').pop() ?? n
}

function crumbsFor(path: string): Crumb[] {
  if (path === 'home://') return [{ label: 'Home', path: 'home://', name: 'Home' }]
  if (path === 'trash://') return [{ label: 'Recycle Bin', path: 'trash://', name: 'Recycle Bin' }]
  if (path === 'computer://') return [{ label: 'This PC', path: 'computer://', name: 'This PC' }]
  if (path.includes('://')) return [{ label: path, path, name: path }]
  const norm = normPath(path)
  const home = normPath(app.homePath || '')
  const out: Crumb[] = []
  let rest: string
  if (home !== '/' && (norm === home || norm.startsWith(home + '/'))) {
    out.push({ label: 'Home', path: home, name: home.split('/').pop() ?? 'Home' })
    rest = norm.slice(home.length)
  } else {
    out.push({ label: 'Computer', path: '/', name: '/' })
    rest = norm
  }
  let acc = out[0].path === '/' ? '' : out[0].path
  for (const part of rest.split('/').filter(Boolean)) {
    acc += '/' + part
    out.push({ label: part, path: acc, name: part })
  }
  return out
}

function locIconFor(t: Tab): string {
  if (t.path === 'home://') return 'go-home,user-home,folder-home,folder'
  if (t.path === 'trash://') return 'user-trash,folder'
  if (t.path === 'computer://') return 'computer,drive-harddisk,folder'
  if (normPath(t.path) === normPath(app.homePath)) return 'user-home,folder-home,folder'
  if (normPath(t.path) === '/') return 'computer,drive-harddisk,folder'
  return 'folder'
}

export function mountNavRow(root: HTMLElement): void {
  root.innerHTML = `
    <button class="nr-btn nr-back" title="Back (Alt+Left)" aria-label="Back">${SVG_BACK}</button>
    <button class="nr-btn nr-fwd" title="Forward (Alt+Right)" aria-label="Forward">${SVG_FWD}</button>
    <button class="nr-btn nr-up" title="Up (Alt+Up)" aria-label="Up">${SVG_UP}</button>
    <button class="nr-btn nr-refresh" title="Refresh (F5)" aria-label="Refresh">${SVG_REFRESH}</button>
    <div class="nr-address">
      <button class="nr-loc" title="Edit address" aria-label="Edit address"><img class="nr-loc-icon" alt=""></button>
      <div class="nr-crumbs"></div>
      <input class="nr-edit" spellcheck="false" hidden>
    </div>
    <div class="nr-search-wrap">
      <span class="nr-search-glyph">${SVG_SEARCH}</span>
      <input class="nr-search" spellcheck="false">
      <button class="nr-search-clear" title="Close search" aria-label="Close search" hidden>${SVG_X}</button>
    </div>`

  const backBtn = root.querySelector('.nr-back') as HTMLButtonElement
  const fwdBtn = root.querySelector('.nr-fwd') as HTMLButtonElement
  const upBtn = root.querySelector('.nr-up') as HTMLButtonElement
  const refreshBtn = root.querySelector('.nr-refresh') as HTMLButtonElement
  const address = root.querySelector('.nr-address') as HTMLElement
  const locBtn = root.querySelector('.nr-loc') as HTMLButtonElement
  const locIcon = root.querySelector('.nr-loc-icon') as HTMLImageElement
  const crumbsEl = root.querySelector('.nr-crumbs') as HTMLElement
  const editInput = root.querySelector('.nr-edit') as HTMLInputElement
  const searchInput = root.querySelector('.nr-search') as HTMLInputElement
  const searchClear = root.querySelector('.nr-search-clear') as HTMLButtonElement

  // ---------- nav buttons ----------
  backBtn.addEventListener('click', () => { if (!suppressBackClick) app.activeTab.back(); suppressBackClick = false })
  fwdBtn.addEventListener('click', () => app.activeTab.forward())
  upBtn.addEventListener('click', () => app.activeTab.up())
  refreshBtn.addEventListener('click', () => app.activeTab.refresh())

  // back long-press / right-click -> per-tab history dropdown
  let suppressBackClick = false
  let pressTimer: number | undefined
  const showHistoryMenu = () => {
    const t = app.activeTab
    if (!t.history.length) return
    const items: MenuItem[] = []
    for (let i = t.history.length - 1; i >= 0; i--) {
      const idx = i
      items.push({
        label: labelForPath(t.history[i]),
        radio: true,
        checked: idx === t.historyIndex,
        onClick: () => { t.historyIndex = idx; void t.navigate(t.history[idx], false) },
      })
    }
    showMenu(items, { x: 0, y: 0, anchorEl: backBtn, minWidth: 200 })
  }
  backBtn.addEventListener('contextmenu', (e) => { e.preventDefault(); showHistoryMenu() })
  backBtn.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return
    pressTimer = window.setTimeout(() => { suppressBackClick = true; showHistoryMenu() }, 450)
  })
  const cancelPress = () => { if (pressTimer !== undefined) { window.clearTimeout(pressTimer); pressTimer = undefined } }
  backBtn.addEventListener('pointerup', cancelPress)
  backBtn.addEventListener('pointerleave', cancelPress)
  // release anywhere ends the long-press; clear the flag AFTER the click this
  // same release may generate on backBtn (click fires before the timeout task)
  window.addEventListener('pointerup', () => {
    cancelPress()
    if (suppressBackClick) window.setTimeout(() => { suppressBackClick = false }, 0)
  })

  // ---------- breadcrumbs ----------
  let editing = false

  const openChevronMenu = async (btn: HTMLElement, dirPath: string, nextName: string | null): Promise<void> => {
    let kids: FileEntry[] = []
    try { kids = await liq.listChildDirs(dirPath, app.settings.showHidden) } catch { /* dead mount etc. */ }
    const items: MenuItem[] = kids.length
      ? kids.map(k => ({
          label: k.name, icon: 'folder', checked: k.name === nextName,
          onClick: () => { void app.activeTab.navigate(k.path) },
        }))
      : [{ label: '(no subfolders)', disabled: true }]
    btn.classList.add('open')
    showMenu(items, { x: 0, y: 0, anchorEl: btn, minWidth: 180, onClose: () => btn.classList.remove('open') })
  }

  const renderCrumbs = () => {
    const t = app.activeTab
    if (!t) return
    locIcon.src = `liqicon://${locIconFor(t)}?size=16`
    if (editing) return
    crumbsEl.hidden = false
    editInput.hidden = true

    if (t.searchQuery !== null) {
      crumbsEl.innerHTML = ''
      const wrap = document.createElement('div')
      wrap.className = 'nr-search-crumb'
      const lbl = document.createElement('span')
      lbl.textContent = `Search Results in ${labelForPath(t.path)}`
      wrap.appendChild(lbl)
      const cancel = document.createElement('button')
      cancel.className = 'nr-search-cancel'
      cancel.title = 'Close search'
      cancel.innerHTML = SVG_X
      cancel.addEventListener('click', () => t.endSearch())
      wrap.appendChild(cancel)
      crumbsEl.appendChild(wrap)
      return
    }

    const crumbs = crumbsFor(t.path)
    const build = (start: number) => {
      crumbsEl.innerHTML = ''
      if (start > 0) {
        const over = document.createElement('button')
        over.className = 'crumb-chev crumb-overflow'
        over.title = 'Hidden locations'
        over.innerHTML = SVG_CHEVS_LEFT
        over.addEventListener('click', (e) => {
          e.stopPropagation()
          const hidden = crumbs.slice(0, start)
          showMenu(hidden.map(c => ({
            label: c.label, icon: 'folder',
            onClick: () => { void t.navigate(c.path) },
          })), { x: 0, y: 0, anchorEl: over, minWidth: 180 })
        })
        crumbsEl.appendChild(over)
      }
      crumbs.slice(start).forEach((c, j) => {
        const i = start + j
        const pair = document.createElement('div')
        pair.className = 'crumb'
        pair.dataset.liqPath = c.path          // right-drag drop target
        pair.dataset.liqLabel = c.label
        const btn = document.createElement('button')
        btn.className = 'crumb-btn'
        btn.textContent = c.label
        btn.title = c.path
        btn.addEventListener('click', (e) => { e.stopPropagation(); void t.navigate(c.path) })
        pair.appendChild(btn)
        if (!c.path.includes('://')) {
          const chev = document.createElement('button')
          chev.className = 'crumb-chev'
          chev.setAttribute('aria-label', `Subfolders of ${c.label}`)
          chev.innerHTML = SVG_CHEV_RIGHT
          chev.addEventListener('click', (e) => {
            e.stopPropagation()
            void openChevronMenu(chev, c.path, crumbs[i + 1]?.name ?? null)
          })
          pair.appendChild(chev)
        }
        crumbsEl.appendChild(pair)
      })
    }
    let start = 0
    build(start)
    while (start < crumbs.length - 1 && crumbsEl.scrollWidth > crumbsEl.clientWidth) {
      start++
      build(start)
    }
  }

  // ---------- address edit mode + autocomplete ----------
  let acFlyout: HTMLElement | null = null
  let acItems: FileEntry[] = []
  let acSel = -1
  let acTimer: number | undefined
  let acReq = 0

  const destroyFlyout = () => { acFlyout?.remove(); acFlyout = null; acItems = []; acSel = -1 }

  const renderFlyout = () => {
    destroyFlyout()
    if (!acItems.length) return
    const fly = document.createElement('div')
    fly.className = 'nr-autocomplete'
    const r = address.getBoundingClientRect()
    fly.style.left = `${r.left}px`
    fly.style.top = `${r.bottom + 2}px`
    fly.style.width = `${r.width}px`
    acItems.forEach((it, i) => {
      const row = document.createElement('div')
      row.className = 'nr-ac-item' + (i === acSel ? ' sel' : '')
      row.innerHTML = `<img class="icon" src="liqicon://folder?size=16" alt=""><span></span>`
      ;(row.querySelector('span') as HTMLElement).textContent = it.path
      row.addEventListener('pointerdown', (e) => e.preventDefault())  // keep input focus
      row.addEventListener('click', () => { void commitEdit(it.path) })
      fly.appendChild(row)
    })
    document.getElementById('menu-layer')!.appendChild(fly)
    acFlyout = fly
  }

  const setAcSel = (i: number) => {
    acSel = i
    acFlyout?.querySelectorAll('.nr-ac-item').forEach((el, j) => el.classList.toggle('sel', j === acSel))
    if (acSel >= 0 && acItems[acSel]) editInput.value = acItems[acSel].path
  }

  const updateAutocomplete = async () => {
    const req = ++acReq
    let v = editInput.value
    if (v.startsWith('~')) v = normPath(app.homePath) + v.slice(1)
    if (v.includes('://') || !v.startsWith('/')) { destroyFlyout(); return }
    const slash = v.lastIndexOf('/')
    const dir = slash <= 0 ? '/' : v.slice(0, slash)
    const prefix = v.slice(slash + 1).toLowerCase()
    let kids: FileEntry[] = []
    try { kids = await liq.listChildDirs(dir, app.settings.showHidden) } catch { /* ignore */ }
    if (req !== acReq || !editing) return
    acItems = kids.filter(k => k.name.toLowerCase().startsWith(prefix)).slice(0, 12)
    acSel = -1
    renderFlyout()
  }

  const openEdit = () => {
    const t = app.activeTab
    if (!t || editing) return
    editing = true
    crumbsEl.hidden = true
    editInput.hidden = false
    editInput.value = t.path
    address.classList.add('editing')
    editInput.focus()
    editInput.select()
  }

  const closeEdit = () => {
    if (!editing) return
    editing = false
    address.classList.remove('editing')
    if (acTimer !== undefined) window.clearTimeout(acTimer)
    destroyFlyout()
    clearErrorHint()
    editInput.hidden = true
    crumbsEl.hidden = false
    renderCrumbs()
  }

  const shake = () => {
    editInput.classList.remove('nr-shake')
    void editInput.offsetWidth  // restart animation
    editInput.classList.add('nr-shake')
  }

  // transient "can't find" hint under the address bar (inline-styled: no
  // stylesheet edits in this slice; tokens come from tokens.css vars)
  let errHint: HTMLElement | null = null
  let errHintTimer: number | undefined
  const clearErrorHint = () => {
    if (errHintTimer !== undefined) { window.clearTimeout(errHintTimer); errHintTimer = undefined }
    errHint?.remove()
    errHint = null
  }
  const showErrorHint = (msg: string) => {
    clearErrorHint()
    const el = document.createElement('div')
    el.className = 'nr-error-hint'
    el.textContent = msg
    const r = address.getBoundingClientRect()
    el.style.cssText =
      `position:fixed;left:${r.left}px;top:${r.bottom + 2}px;max-width:${Math.round(r.width)}px;` +
      'z-index:300;padding:4px 8px;font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;' +
      'background:var(--bg-flyout);color:var(--text-primary);border:1px solid var(--danger);' +
      'border-radius:var(--radius-lg);box-shadow:var(--shadow-flyout)'
    document.getElementById('menu-layer')!.appendChild(el)
    errHint = el
    errHintTimer = window.setTimeout(clearErrorHint, 4000)
  }

  async function commitEdit(raw: string): Promise<void> {
    const t = app.activeTab
    let v = raw.trim()
    if (!v) { closeEdit(); return }
    if (v.startsWith('~')) v = normPath(app.homePath) + v.slice(1)
    if (!v.includes('://')) {
      v = normPath(v)
      const ok = await liq.pathExists(v)
      if (!ok) {
        shake()
        showErrorHint(`LiqExplorer can’t find ${v}. Check the spelling and try again.`)
        return
      }
    }
    closeEdit()
    void t.navigate(v)
  }

  editInput.addEventListener('input', () => {
    clearErrorHint()
    if (acTimer !== undefined) window.clearTimeout(acTimer)
    acTimer = window.setTimeout(() => { void updateAutocomplete() }, 150)
  })
  editInput.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' && acItems.length) { setAcSel(Math.min(acItems.length - 1, acSel + 1)); e.preventDefault() }
    else if (e.key === 'ArrowUp' && acItems.length) { setAcSel(Math.max(0, acSel - 1)); e.preventDefault() }
    else if (e.key === 'Tab') {
      e.preventDefault()
      const pick = acItems[acSel >= 0 ? acSel : 0]
      if (pick) { editInput.value = pick.path; destroyFlyout(); void updateAutocomplete() }
    } else if (e.key === 'Enter') {
      e.preventDefault()
      void commitEdit(acSel >= 0 && acItems[acSel] ? acItems[acSel].path : editInput.value)
    } else if (e.key === 'Escape') {
      e.preventDefault(); e.stopPropagation()
      closeEdit()
    }
  })
  editInput.addEventListener('blur', () => { window.setTimeout(() => { if (editing && document.activeElement !== editInput) closeEdit() }, 80) })

  locBtn.addEventListener('click', openEdit)
  address.addEventListener('click', (e) => {
    if (editing) return
    const el = e.target as HTMLElement
    if (el.closest('button') || el.closest('.nr-search-crumb')) return
    openEdit()
  })
  app.on('edit-address', openEdit)

  // ---------- search box ----------
  const renderSearch = () => {
    const t = app.activeTab
    if (!t) return
    // the main-side search walker can't read virtual roots (trash://,
    // computer://) — it would report 0 results, so disable instead
    searchInput.disabled = t.isVirtual
    searchInput.placeholder = t.isVirtual ? 'Search unavailable here' : `Search ${labelForPath(t.path)}`
    searchInput.value = t.searchQuery ?? ''
    searchClear.hidden = t.searchQuery === null
  }
  searchInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && searchInput.value.trim()) {
      if (app.activeTab.isVirtual) return
      void app.activeTab.startSearch(searchInput.value.trim())
    } else if (e.key === 'Escape') {
      e.stopPropagation()
      searchInput.value = ''
      app.activeTab.endSearch()
      searchInput.blur()
    }
  })
  searchClear.addEventListener('click', () => { searchInput.value = ''; app.activeTab.endSearch() })
  app.on('focus-search', () => { searchInput.focus(); searchInput.select() })

  // ---------- state tracking ----------
  const renderButtons = () => {
    const t = app.activeTab
    if (!t) return
    backBtn.disabled = !t.canBack()
    fwdBtn.disabled = !t.canForward()
    upBtn.disabled = !t.canUp()
  }
  const renderAll = () => { renderButtons(); renderCrumbs(); renderSearch() }

  app.on('tab-navigated', (t: Tab) => { if (t === app.activeTab) { if (editing) closeEdit(); renderAll() } })
  app.on('tabs-changed', () => { if (editing) closeEdit(); renderAll() })
  window.addEventListener('resize', renderCrumbs)
  renderAll()
}
