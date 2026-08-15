// Dual pane (Krusader / Total Commander twin panels) INSIDE one tab.
//
// The DOM is fixed at boot: #panes holds two .pn-pane boxes with a splitter
// between them, and each pane owns a full view host + a Home page (the two are
// twins, exactly as they were when there was only one of each). The second pane
// is `hidden` until the tab is split.
//
// Nothing here knows about tabs beyond `app.activePrimary`: pane 0 always
// renders the active tab, pane 1 its `.secondary`. Switching tabs therefore
// shows/hides the split all by itself, which is what "the split is remembered
// per tab" means.
//
// Focus is the whole trick. A capture-phase mousedown (and focusin, for the
// keyboard) on a pane box calls app.focusPane() BEFORE any handler inside runs,
// so by the time a click, a menu or a command reads `app.activeTab` it already
// resolves to the pane that was clicked.
import {
  app, liq, DEFAULT_SPLIT_RATIO, SPLIT_MAX, SPLIT_MIN, type SplitDir, type Tab,
} from '../core/app'
import { mountViewHost } from './view-host'
import { mountHome } from './home'
import { transferWithConfirm } from '../core/confirmmove'

const RATIO_KEY = 'pane-split-ratio'
const DIR_KEY = 'pane-split-dir'

const clampRatio = (r: number): number =>
  Math.min(SPLIT_MAX, Math.max(SPLIT_MIN, Number.isFinite(r) ? r : DEFAULT_SPLIT_RATIO))

function dirOf(p: string): string {
  const i = p.lastIndexOf('/')
  return i <= 0 ? '/' : p.slice(0, i)
}

/**
 * True when F5 / F6 have real work to do: a split, a selection, and two real
 * directories. Keyboard uses it so that F5 keeps its Explorer meaning
 * (refresh) whenever the Krusader meaning (copy to the other panel) would be a
 * silent no-op — an unsplit tab, an empty selection, or a pane sitting on
 * home:// / trash:// / computer:// / archive://.
 */
export function canTransferToOtherPane(): boolean {
  const from = app.activeTab
  const to = app.otherPane()
  return !!from && !!to && !from.isVirtual && !to.isVirtual && from.selection.size > 0
}

function loadPrefs(): void {
  try {
    const r = Number(localStorage.getItem(RATIO_KEY))
    if (Number.isFinite(r) && r > 0) app.defaultSplitRatio = clampRatio(r)
    const d = localStorage.getItem(DIR_KEY)
    if (d === 'h' || d === 'v') app.defaultSplitDir = d
  } catch { /* storage disabled — defaults stand */ }
}

function savePrefs(): void {
  try {
    localStorage.setItem(RATIO_KEY, String(app.defaultSplitRatio))
    localStorage.setItem(DIR_KEY, app.defaultSplitDir)
  } catch { /* storage full */ }
}

export function mountPanes(): void {
  const wrap = document.getElementById('panes')
  if (!wrap) return
  const paneEls = Array.from(wrap.querySelectorAll('.pn-pane')) as HTMLElement[]
  const splitter = document.getElementById('pane-splitter') as HTMLElement | null
  if (paneEls.length < 2) return
  loadPrefs()

  /** which Tab a pane renders; null when the active tab is not split */
  const tabFor = (i: 0 | 1): Tab | null => {
    const p = app.activePrimary
    if (!p) return null
    return i === 0 ? p : p.secondary
  }

  // ---------------------------------------------------------------- layout

  /** write the flex proportions only — used live during a splitter drag, where
   *  emitting 'panes-changed' per mousemove would rebuild both views */
  function applyRatio(ratio: number, split: boolean): void {
    paneEls[0].style.flex = split ? `${ratio} 1 0%` : '1 1 0%'
    paneEls[1].style.flex = `${1 - ratio} 1 0%`
  }

  // an arrow, not a declaration: hoisting would lose the null narrowing on wrap
  const layout = (): void => {
    const p = app.activePrimary
    const split = !!p?.secondary
    wrap.classList.toggle('pn-split', split)
    wrap.classList.toggle('pn-vert', split && p!.splitDir === 'v')
    if (splitter) splitter.hidden = !split
    paneEls[1].hidden = !split
    applyRatio(p ? clampRatio(p.splitRatio) : DEFAULT_SPLIT_RATIO, split)
    const active = split ? p!.activePane : 0
    paneEls[0].classList.toggle('pn-active', active === 0)
    paneEls[1].classList.toggle('pn-active', active === 1)
  }

  // ---------------------------------------------------------------- panes

  function focusPaneDom(i: 0 | 1): void {
    const el = paneEls[i]
    if (el.hidden) return
    const view = el.querySelector('.pn-view') as HTMLElement | null
    if (view && !view.hidden) {
      ;(view.querySelector('.vh-scroll') as HTMLElement | null)?.focus()
      return
    }
    ;(el.querySelector('.pn-home') as HTMLElement | null)?.focus()
  }

  /** Keep the real DOM focus in the pane that owns logical focus, or arrow keys
   *  would keep driving the pane the accent rail says is asleep. Left alone
   *  when focus is already somewhere inside that pane (a click just put it on
   *  the exact element the user aimed at). */
  function followDomFocus(): void {
    const ae = document.activeElement as HTMLElement | null
    // never yank focus out of the address bar, the search box or a rename
    const tag = ae?.tagName
    if (tag === 'INPUT' || tag === 'TEXTAREA' || ae?.isContentEditable) return
    const i: 0 | 1 = app.activePrimary?.activePane === 1 ? 1 : 0
    if (ae && ae !== document.body && paneEls[i].contains(ae)) return
    focusPaneDom(i)
  }

  // registered before the hosts mount, so their own 'panes-changed' rebuilds
  // measure a box that has already taken its new size
  app.on('panes-changed', layout)
  app.on('pane-focus', () => { layout(); followDomFocus() })
  app.on('tabs-changed', () => { layout(); followDomFocus() })

  for (const i of [0, 1] as const) {
    const el = paneEls[i]
    const view = el.querySelector('.pn-view') as HTMLElement
    const homeEl = el.querySelector('.pn-home') as HTMLElement
    homeEl.tabIndex = -1                 // focus target when Home fills the pane
    const activate = (): void => app.focusPane(i)
    // capture: beats every handler inside the pane, so app.activeTab is already
    // correct when a click selects, opens a menu or starts a drag
    el.addEventListener('mousedown', activate, true)
    el.addEventListener('focusin', activate)
    mountViewHost(view, { getTab: () => tabFor(i), onActivate: activate })
    mountHome(homeEl, { getTab: () => tabFor(i), sibling: view, onActivate: activate })
  }

  // ---------------------------------------------------------------- splitter

  splitter?.addEventListener('mousedown', (e) => {
    const p = app.activePrimary
    if (!p?.secondary || e.button !== 0) return
    e.preventDefault()
    const vert = p.splitDir === 'v'
    let ratio = clampRatio(p.splitRatio)
    splitter.classList.add('dragging')
    document.body.style.cursor = vert ? 'row-resize' : 'col-resize'
    const move = (ev: MouseEvent): void => {
      const r = wrap.getBoundingClientRect()
      const size = vert ? r.height : r.width
      if (size <= 0) return
      ratio = clampRatio((vert ? ev.clientY - r.top : ev.clientX - r.left) / size)
      applyRatio(ratio, true)
    }
    const up = (): void => {
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
      splitter.classList.remove('dragging')
      document.body.style.cursor = ''
      app.setSplitRatio(ratio)           // commits + rebuilds both views once
      savePrefs()
    }
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
  })

  // double-clicking the splitter resets to an even split (every FM does this)
  splitter?.addEventListener('dblclick', () => {
    if (!app.activePrimary?.secondary) return
    app.setSplitRatio(DEFAULT_SPLIT_RATIO)
    savePrefs()
  })

  // ---------------------------------------------------------------- transfer

  /**
   * F5 / F6: copy or move the focused pane's selection into the other pane's
   * folder, through the same ops engine drag & drop and paste use.
   */
  function transfer(kind: 'copy' | 'move'): void {
    // both ends must be real directories: trash://, computer://, archive:// and
    // home:// rows are not files the engine can move, and are not destinations
    if (!canTransferToOtherPane()) return
    const from = app.activeTab
    const to = app.otherPane()!
    const dest = to.path
    const sources = from.selectedEntries()
      .map(e => e.path)
      .filter(s => dest !== s && !dest.startsWith(s + '/'))
    const filtered = kind === 'move' ? sources.filter(s => dirOf(s) !== dest) : sources
    if (!filtered.length) return
    const ask = kind === 'move'
      ? (app.settings.confirmMove || app.settings.confirmDrop)
      : app.settings.confirmDrop
    transferWithConfirm(kind, filtered, dest, ask)
  }

  // ---------------------------------------------------------------- commands

  app.on('toggle-dual-pane', () => { app.toggleSplit(); savePrefs() })
  app.on('set-dual-pane', (on: boolean) => { app.setSplit(!!on); savePrefs() })
  app.on('pane-focus-toggle', () => app.toggleFocusedPane())
  app.on('swap-panes', () => { void app.swapPanes() })
  app.on('set-pane-layout', (dir: SplitDir) => {
    app.setSplitDir(dir === 'v' ? 'v' : 'h')
    savePrefs()
  })
  app.on('pane-copy-to-other', () => transfer('copy'))
  app.on('pane-move-to-other', () => transfer('move'))
  // context menus emit this with the folder's path (or the entry itself)
  app.on('open-in-other-pane', (d: string | { path?: string } | null) => {
    const path = typeof d === 'string' ? d : d?.path
    if (path) void app.openInOtherPane(path)
  })

  layout()
}
