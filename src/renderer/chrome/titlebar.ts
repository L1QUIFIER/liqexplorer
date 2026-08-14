// Win11 tab bar + caption buttons. Tabs live in the title-bar strip: folder icon,
// title, close-on-hover ×; + new-tab button; drag-to-reorder; middle-click close;
// tab context menu (Duplicate / Close / Close others / Close to the right).
// Whole strip is a drag region (base.css); interactive children opt out.
import { app, liq, Tab } from '../core/app'
import { PUSH } from '../../shared/ipc'

const SVG_MIN = '<svg width="10" height="10" viewBox="0 0 10 10"><path d="M0 5h10" stroke="currentColor" stroke-width="1" fill="none"/></svg>'
const SVG_MAX = '<svg width="10" height="10" viewBox="0 0 10 10"><rect x="0.5" y="0.5" width="9" height="9" rx="1.5" stroke="currentColor" stroke-width="1" fill="none"/></svg>'
const SVG_RESTORE = '<svg width="10" height="10" viewBox="0 0 10 10"><rect x="0.5" y="2.5" width="7" height="7" rx="1.5" stroke="currentColor" stroke-width="1" fill="none"/><path d="M2.5 2.5V2a1.5 1.5 0 0 1 1.5-1.5H8A1.5 1.5 0 0 1 9.5 2v4A1.5 1.5 0 0 1 8 7.5h-.5" stroke="currentColor" stroke-width="1" fill="none"/></svg>'
const SVG_CLOSE = '<svg width="10" height="10" viewBox="0 0 10 10"><path d="M0.5 0.5l9 9M9.5 0.5l-9 9" stroke="currentColor" stroke-width="1" fill="none"/></svg>'
const SVG_TAB_CLOSE = '<svg width="10" height="10" viewBox="0 0 10 10"><path d="M1 1l8 8M9 1l-8 8" stroke="currentColor" stroke-width="1.1" fill="none"/></svg>'
const SVG_PLUS = '<svg width="12" height="12" viewBox="0 0 12 12"><path d="M6 1v10M1 6h10" stroke="currentColor" stroke-width="1.2" fill="none" stroke-linecap="round"/></svg>'

function tabIconName(t: Tab): string {
  if (t.path === 'trash://') return 'user-trash,folder'
  if (t.path === app.homePath) return 'user-home,folder-home,folder'
  return 'folder'
}

export function mountTitlebar(root: HTMLElement): void {
  root.innerHTML = `
    <div class="tb-strip">
      <div class="tb-tablist" role="tablist"></div>
      <button class="tb-newtab" title="New tab (Ctrl+T)" aria-label="New tab">${SVG_PLUS}</button>
      <div class="tb-drag"></div>
      <div class="tb-caption">
        <button class="tb-min" title="Minimize" aria-label="Minimize">${SVG_MIN}</button>
        <button class="tb-max" title="Maximize" aria-label="Maximize">${SVG_MAX}</button>
        <button class="tb-close" title="Close" aria-label="Close">${SVG_CLOSE}</button>
      </div>
    </div>`

  const strip = root.querySelector('.tb-strip') as HTMLElement
  const list = root.querySelector('.tb-tablist') as HTMLElement
  const minBtn = root.querySelector('.tb-min') as HTMLButtonElement
  const maxBtn = root.querySelector('.tb-max') as HTMLButtonElement
  const closeBtn = root.querySelector('.tb-close') as HTMLButtonElement

  // ---- caption buttons ----
  let maximized = false
  const updateMaxGlyph = () => {
    maxBtn.innerHTML = maximized ? SVG_RESTORE : SVG_MAX
    maxBtn.title = maximized ? 'Restore' : 'Maximize'
    maxBtn.setAttribute('aria-label', maxBtn.title)
  }
  liq.isMaximized().then((m: boolean) => { maximized = m; updateMaxGlyph() })
  liq.on(PUSH.windowState, (s: { maximized: boolean }) => { maximized = s.maximized; updateMaxGlyph() })
  minBtn.addEventListener('click', () => liq.windowControl('minimize'))
  maxBtn.addEventListener('click', () => liq.windowControl(maximized ? 'restore' : 'maximize'))
  closeBtn.addEventListener('click', () => liq.windowControl('close'))

  // Double-click empty strip toggles maximize. The drag region may swallow mouse
  // events in some Electron versions (native caption handling then does the same
  // toggle); this covers the case where events do reach us.
  strip.addEventListener('dblclick', (e) => {
    const el = e.target as HTMLElement
    if (el.closest('.tb-tab') || el.closest('button')) return
    liq.windowControl(maximized ? 'restore' : 'maximize')
  })

  root.querySelector('.tb-newtab')!.addEventListener('click', () => { void app.newTab() })

  // ---- tab reorder helpers ----
  function moveTab(from: number, to: number): void {
    if (from === to || from < 0 || to < 0) return
    const active = app.activeTab
    const [t] = app.tabs.splice(from, 1)
    app.tabs.splice(to, 0, t)
    app.activeTabIndex = app.tabs.indexOf(active)
    app.emit('tabs-changed')
  }

  // ---- drag-to-reorder state ----
  interface DragState {
    index: number
    el: HTMLElement
    startX: number
    grabDX: number
    slotLeft: number
    moved: boolean
  }
  let drag: DragState | null = null
  let renderPending = false

  const measureSlot = (el: HTMLElement): number => {
    const prev = el.style.transform
    el.style.transform = ''
    const left = el.getBoundingClientRect().left
    el.style.transform = prev
    return left
  }

  const onPointerMove = (e: PointerEvent) => {
    if (!drag) return
    if (!drag.moved) {
      if (Math.abs(e.clientX - drag.startX) < 5) return
      drag.moved = true
      drag.el.classList.add('dragging')
      drag.slotLeft = measureSlot(drag.el)
    }
    // live reflow: find the insertion point among siblings by midpoint
    const siblings = [...list.children].filter(c => c !== drag!.el) as HTMLElement[]
    let ref: HTMLElement | null = null
    for (const sib of siblings) {
      const r = sib.getBoundingClientRect()
      if (e.clientX < r.left + r.width / 2) { ref = sib; break }
    }
    const currentNext = drag.el.nextElementSibling
    if (ref !== currentNext && ref !== drag.el) {
      drag.el.style.transform = ''
      list.insertBefore(drag.el, ref)
      drag.slotLeft = measureSlot(drag.el)
    }
    drag.el.style.transform = `translateX(${(e.clientX - drag.grabDX) - drag.slotLeft}px)`
  }

  const onPointerUp = () => {
    window.removeEventListener('pointermove', onPointerMove)
    window.removeEventListener('pointerup', onPointerUp)
    if (!drag) return
    const d = drag
    drag = null
    d.el.style.transform = ''
    d.el.classList.remove('dragging')
    if (d.moved) {
      const newIndex = [...list.children].indexOf(d.el)
      moveTab(d.index, newIndex)
    } else {
      app.activateTab(d.index)
    }
    if (renderPending) { renderPending = false; render() }
  }

  // ---- render ----
  const render = () => {
    if (drag) { renderPending = true; return }
    list.innerHTML = ''
    app.tabs.forEach((t, i) => {
      const el = document.createElement('div')
      el.className = 'tb-tab' + (i === app.activeTabIndex ? ' active' : '')
      el.setAttribute('role', 'tab')
      el.setAttribute('aria-selected', String(i === app.activeTabIndex))
      el.title = t.path

      const ic = document.createElement('img')
      ic.className = 'tb-tab-icon'
      ic.src = `liqicon://${tabIconName(t)}?size=16`
      ic.draggable = false
      el.appendChild(ic)

      const label = document.createElement('span')
      label.className = 'tb-tab-title'
      label.textContent = t.title || '…'
      el.appendChild(label)

      const close = document.createElement('button')
      close.className = 'tb-tab-close'
      close.title = 'Close tab (Ctrl+W)'
      close.setAttribute('aria-label', 'Close tab')
      close.innerHTML = SVG_TAB_CLOSE
      close.addEventListener('click', (e) => { e.stopPropagation(); app.closeTab(i) })
      el.appendChild(close)

      el.addEventListener('pointerdown', (e) => {
        if (e.button !== 0 || (e.target as HTMLElement).closest('.tb-tab-close')) return
        drag = { index: i, el, startX: e.clientX, grabDX: e.clientX - el.getBoundingClientRect().left, slotLeft: 0, moved: false }
        window.addEventListener('pointermove', onPointerMove)
        window.addEventListener('pointerup', onPointerUp)
      })
      el.addEventListener('auxclick', (e) => { if (e.button === 1) app.closeTab(i) })
      el.addEventListener('contextmenu', (e) => {
        e.preventDefault()
        app.emit('tab-context', { x: e.clientX, y: e.clientY, index: i })
      })
      list.appendChild(el)
    })
  }

  app.on('tabs-changed', render)
  app.on('tab-navigated', render)
  render()
}
