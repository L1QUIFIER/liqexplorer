// Win11 flyout menu framework — full implementation of the menu-types contract.
// Features: icon row (Win11 compact action row w/ tooltips), submenus (250ms
// hover intent, keyboard, click), viewport clamp + upward flip, internal
// scrolling for tall menus, full keyboard navigation (arrows, Home/End, Enter,
// Esc, Tab into the icon row, first-letter jump), one root menu at a time,
// capture-phase outside-mousedown / blur / Escape dismissal, focus restore.
// All visual styling lives in styles/menus.css.

import type { MenuAction, MenuItem, MenuOptions } from './menu-types'

const HOVER_DELAY = 250          // submenu open-intent delay (ms)
const EDGE = 8                   // min gap to the viewport edges
const SUB_OVERLAP = 4            // submenu horizontal overlap with parent

const CHECK_SVG =
  '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M3.5 8.5l3 3 6-7"/></svg>'
const RADIO_SVG =
  '<svg viewBox="0 0 16 16"><circle cx="8" cy="8" r="3" fill="currentColor"/></svg>'
const CHEVRON_SVG =
  '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M6 3.5 10.5 8 6 12.5"/></svg>'

interface Level {
  el: HTMLElement
  scrollEl: HTMLElement
  items: MenuItem[]
  /** parallel to items; null for separators */
  itemEls: (HTMLElement | null)[]
  activeIndex: number
  parent: Level | null
  /** index of the item in the parent that owns this submenu */
  parentIndex: number
  child: Level | null
  hoverTimer: number
}

let root: Level | null = null
let rootOnClose: (() => void) | null = null
let prevFocus: Element | null = null

function layerEl(): HTMLElement {
  return document.getElementById('menu-layer')!
}

export function closeMenus(): void {
  if (!root) return
  const onClose = rootOnClose
  removeGlobalListeners()
  destroyLevel(root)
  root = null
  rootOnClose = null
  if (prevFocus instanceof HTMLElement && prevFocus.isConnected) prevFocus.focus()
  prevFocus = null
  onClose?.()
}

export function showMenu(items: MenuItem[], opts: MenuOptions): void {
  closeMenus()
  prevFocus = document.activeElement
  const level = buildLevel(items, null, -1, opts.iconRow)
  root = level
  rootOnClose = opts.onClose ?? null
  level.el.classList.add('menu-root')
  if (opts.minWidth) level.el.style.minWidth = `${opts.minWidth}px`
  layerEl().appendChild(level.el)
  positionRoot(level.el, opts)
  addGlobalListeners()
  level.el.focus()
}

// ---------- construction ----------

function buildLevel(
  items: MenuItem[], parent: Level | null, parentIndex: number, iconRow?: MenuAction[],
): Level {
  const el = document.createElement('div')
  el.className = 'menu'
  el.setAttribute('role', 'menu')
  el.tabIndex = -1
  const level: Level = {
    el, scrollEl: null!, items, itemEls: [], activeIndex: -1,
    parent, parentIndex, child: null, hoverTimer: 0,
  }
  el.addEventListener('contextmenu', (e) => e.preventDefault())

  if (iconRow?.length) el.appendChild(buildIconRow(iconRow))

  const scroll = document.createElement('div')
  scroll.className = 'menu-scroll'
  level.scrollEl = scroll
  el.appendChild(scroll)

  items.forEach((it, idx) => {
    if (it.separator || it.label === undefined) {
      const sep = document.createElement('div')
      sep.className = 'menu-sep'
      sep.setAttribute('role', 'separator')
      scroll.appendChild(sep)
      level.itemEls.push(null)
      return
    }
    const item = document.createElement('div')
    item.className = 'menu-item'
    item.setAttribute('role', it.radio ? 'menuitemradio' : it.checked !== undefined ? 'menuitemcheckbox' : 'menuitem')
    if (it.disabled) { item.classList.add('is-disabled'); item.setAttribute('aria-disabled', 'true') }
    if (it.danger) item.classList.add('is-danger')
    if (it.submenu) { item.classList.add('has-sub'); item.setAttribute('aria-haspopup', 'menu') }
    if (it.checked !== undefined) item.setAttribute('aria-checked', String(!!it.checked))

    const lead = document.createElement('span')
    lead.className = 'menu-lead'
    if (it.checked) {
      lead.classList.add(it.radio ? 'menu-radio' : 'menu-check')
      lead.innerHTML = it.radio ? RADIO_SVG : CHECK_SVG
    } else if (it.icon) {
      lead.appendChild(iconEl(it.icon))
    }
    item.appendChild(lead)

    const label = document.createElement('span')
    label.className = 'menu-label'
    label.textContent = it.label
    item.appendChild(label)

    if (it.shortcut) {
      const sc = document.createElement('span')
      sc.className = 'menu-shortcut'
      sc.textContent = it.shortcut
      item.appendChild(sc)
    }
    if (it.submenu) {
      const arrow = document.createElement('span')
      arrow.className = 'menu-subarrow'
      arrow.innerHTML = CHEVRON_SVG
      item.appendChild(arrow)
    }

    item.addEventListener('mouseenter', () => {
      if (!it.disabled) setActive(level, idx)
      scheduleHover(level, idx)
    })
    item.addEventListener('click', (e) => {
      e.stopPropagation()
      if (it.disabled) return
      if (it.submenu) {
        clearTimeout(level.hoverTimer)
        openSubmenu(level, idx)
        return
      }
      activate(it)
    })
    scroll.appendChild(item)
    level.itemEls.push(item)
  })
  return level
}

function buildIconRow(rowActions: MenuAction[]): HTMLElement {
  const row = document.createElement('div')
  row.className = 'menu-iconrow'
  for (const a of rowActions) {
    const btn = document.createElement('button')
    btn.type = 'button'
    btn.className = 'menu-iconbtn'
    btn.disabled = !!a.disabled
    btn.setAttribute('aria-label', a.tooltip)
    btn.dataset.id = a.id
    if (a.icon) btn.appendChild(iconEl(a.icon))
    const tip = document.createElement('span')
    tip.className = 'menu-tip'
    tip.textContent = a.tooltip
    btn.appendChild(tip)
    btn.addEventListener('click', (e) => {
      e.stopPropagation()
      if (a.disabled) return
      closeMenus()
      a.onClick()
    })
    row.appendChild(btn)
  }
  return row
}

/** liqicon name (comma-separated fallbacks ok) or inline '<svg' string -> element */
function iconEl(spec: string): HTMLElement {
  const span = document.createElement('span')
  span.className = 'menu-icon'
  if (spec.startsWith('<svg')) {
    span.innerHTML = spec
    return span
  }
  const img = document.createElement('img')
  img.className = 'menu-icon-img'
  img.src = `liqicon://${spec}?size=16`
  img.draggable = false
  img.addEventListener('error', () => { img.style.visibility = 'hidden' })
  span.appendChild(img)
  return span
}

// ---------- positioning ----------

function positionRoot(el: HTMLElement, opts: MenuOptions): void {
  const w = el.offsetWidth
  const h = el.offsetHeight
  let x = opts.x
  let y = opts.y
  let up = false
  let anchorRect: DOMRect | null = null
  if (opts.anchorEl) {
    anchorRect = opts.anchorEl.getBoundingClientRect()
    x = anchorRect.left
    y = anchorRect.bottom + 4
  }
  if (x + w > innerWidth - EDGE) {
    x = anchorRect ? Math.max(EDGE, anchorRect.right - w) : Math.max(EDGE, innerWidth - EDGE - w)
  }
  if (x < EDGE) x = EDGE
  if (y + h > innerHeight - EDGE) {
    if (anchorRect) {
      const above = anchorRect.top - 4 - h
      if (above >= EDGE) { y = above; up = true }
      else y = Math.max(EDGE, innerHeight - EDGE - h)
    } else {
      // pointer menu: open upward, bottom edge at the cursor
      up = true
      y = Math.max(EDGE, opts.y - h)
    }
  }
  el.style.left = `${Math.round(x)}px`
  el.style.top = `${Math.round(y)}px`
  if (up) el.classList.add('menu--up')  // flips animation + moves icon row nearest the pointer
}

function positionSubmenu(el: HTMLElement, itemEl: HTMLElement): void {
  const r = itemEl.getBoundingClientRect()
  const w = el.offsetWidth
  const h = el.offsetHeight
  let x = r.right - SUB_OVERLAP
  if (x + w > innerWidth - EDGE) x = r.left - w + SUB_OVERLAP   // flip to the left side
  if (x < EDGE) x = EDGE
  let y = r.top - 5                                             // first item aligns with parent item
  if (y + h > innerHeight - EDGE) y = Math.max(EDGE, innerHeight - EDGE - h)
  el.style.left = `${Math.round(x)}px`
  el.style.top = `${Math.round(y)}px`
}

// ---------- submenu chain ----------

function scheduleHover(level: Level, idx: number): void {
  clearTimeout(level.hoverTimer)
  level.hoverTimer = window.setTimeout(() => {
    if (level.child && level.child.parentIndex !== idx) closeChild(level)
    const it = level.items[idx]
    if (it?.submenu && !it.disabled && !level.child) openSubmenu(level, idx)
  }, HOVER_DELAY)
}

function openSubmenu(level: Level, idx: number): Level | null {
  const it = level.items[idx]
  if (!it?.submenu) return null
  if (level.child && level.child.parentIndex === idx) return level.child
  closeChild(level)
  const itemEl = level.itemEls[idx]
  if (!itemEl) return null
  const sub = buildLevel(it.submenu, level, idx)
  sub.el.classList.add('menu-sub')
  layerEl().appendChild(sub.el)
  positionSubmenu(sub.el, itemEl)
  level.child = sub
  itemEl.classList.add('is-open')
  return sub
}

function closeChild(level: Level): void {
  if (!level.child) return
  level.itemEls[level.child.parentIndex]?.classList.remove('is-open')
  destroyLevel(level.child)
  level.child = null
}

function destroyLevel(l: Level): void {
  if (l.child) destroyLevel(l.child)
  l.child = null
  clearTimeout(l.hoverTimer)
  l.el.remove()
}

function deepest(): Level | null {
  let l = root
  while (l?.child) l = l.child
  return l
}

// ---------- activation / highlight ----------

function activate(it: MenuItem): void {
  const cb = it.onClick
  closeMenus()
  cb?.()
}

function setActive(level: Level, idx: number, scroll = false): void {
  if (level.activeIndex !== idx) {
    level.itemEls[level.activeIndex]?.classList.remove('is-active')
    level.activeIndex = idx
    level.itemEls[idx]?.classList.add('is-active')
  }
  if (scroll) level.itemEls[idx]?.scrollIntoView({ block: 'nearest' })
}

function enabledIndices(level: Level): number[] {
  const out: number[] = []
  level.items.forEach((it, i) => {
    if (!it.separator && it.label !== undefined && !it.disabled) out.push(i)
  })
  return out
}

function moveActive(level: Level, dir: 1 | -1): void {
  const idxs = enabledIndices(level)
  if (!idxs.length) return
  const pos = idxs.indexOf(level.activeIndex)
  const next = pos < 0
    ? (dir === 1 ? idxs[0] : idxs[idxs.length - 1])
    : idxs[(pos + dir + idxs.length) % idxs.length]
  setActive(level, next, true)
}

function moveTo(level: Level, where: 'first' | 'last'): void {
  const idxs = enabledIndices(level)
  if (!idxs.length) return
  setActive(level, where === 'first' ? idxs[0] : idxs[idxs.length - 1], true)
}

function letterJump(level: Level, ch: string): void {
  const matches = enabledIndices(level)
    .filter(i => (level.items[i].label ?? '').toLowerCase().startsWith(ch))
  if (!matches.length) return
  if (matches.length === 1) {
    const idx = matches[0]
    const it = level.items[idx]
    if (it.submenu) {
      setActive(level, idx, true)
      const sub = openSubmenu(level, idx)
      if (sub) moveTo(sub, 'first')
    } else {
      activate(it)
    }
    return
  }
  const after = matches.find(i => i > level.activeIndex)
  setActive(level, after ?? matches[0], true)
}

// ---------- icon row keyboard ----------

function iconRowButtons(): HTMLButtonElement[] {
  if (!root) return []
  return [...root.el.querySelectorAll<HTMLButtonElement>('.menu-iconbtn:not(:disabled)')]
}

function cycleIconRow(dir: 1 | -1): void {
  const btns = iconRowButtons()
  if (!btns.length) return
  const cur = btns.indexOf(document.activeElement as HTMLButtonElement)
  btns[(cur + dir + btns.length) % btns.length].focus()
}

function tabCycle(): void {
  const btns = iconRowButtons()
  if (!btns.length) return
  const cur = btns.indexOf(document.activeElement as HTMLButtonElement)
  if (cur >= 0 && cur < btns.length - 1) btns[cur + 1].focus()
  else if (cur === btns.length - 1) root?.el.focus()
  else btns[0].focus()
}

// ---------- global dismissal + keyboard ----------

function onDocMousedown(e: MouseEvent): void {
  const t = e.target as Node | null
  for (let l: Level | null = root; l; l = l.child) {
    if (t && l.el.contains(t)) return
  }
  closeMenus()
}

function onWinBlur(): void { closeMenus() }
function onWinResize(): void { closeMenus() }

function onDocKeydown(e: KeyboardEvent): void {
  if (!root) return
  const lvl = deepest()
  if (!lvl) return
  const focusEl = document.activeElement
  const inIconRow = focusEl instanceof HTMLElement && focusEl.classList.contains('menu-iconbtn')

  switch (e.key) {
    case 'Escape':
      e.preventDefault(); e.stopPropagation()
      closeMenus()
      return
    case 'ArrowDown':
      e.preventDefault(); e.stopPropagation()
      if (inIconRow) { root.el.focus(); moveActive(root, 1); return }
      moveActive(lvl, 1)
      return
    case 'ArrowUp':
      e.preventDefault(); e.stopPropagation()
      if (inIconRow) { root.el.focus(); moveActive(root, -1); return }
      moveActive(lvl, -1)
      return
    case 'Home':
      e.preventDefault(); e.stopPropagation()
      moveTo(lvl, 'first')
      return
    case 'End':
      e.preventDefault(); e.stopPropagation()
      moveTo(lvl, 'last')
      return
    case 'ArrowRight': {
      e.preventDefault(); e.stopPropagation()
      if (inIconRow) { cycleIconRow(1); return }
      const it = lvl.items[lvl.activeIndex]
      if (it?.submenu && !it.disabled) {
        const sub = openSubmenu(lvl, lvl.activeIndex)
        if (sub) moveTo(sub, 'first')
      }
      return
    }
    case 'ArrowLeft':
      e.preventDefault(); e.stopPropagation()
      if (inIconRow) { cycleIconRow(-1); return }
      if (lvl.parent) closeChild(lvl.parent)
      return
    case 'Enter':
    case ' ': {
      if (inIconRow) return   // let the native button click fire
      e.preventDefault(); e.stopPropagation()
      const it = lvl.items[lvl.activeIndex]
      if (!it || it.disabled) return
      if (it.submenu) {
        const sub = openSubmenu(lvl, lvl.activeIndex)
        if (sub) moveTo(sub, 'first')
      } else {
        activate(it)
      }
      return
    }
    case 'Tab':
      e.preventDefault(); e.stopPropagation()
      tabCycle()
      return
    default:
      if (e.key.length === 1 && !e.ctrlKey && !e.altKey && !e.metaKey) {
        e.preventDefault(); e.stopPropagation()
        letterJump(lvl, e.key.toLowerCase())
      }
  }
}

function addGlobalListeners(): void {
  document.addEventListener('mousedown', onDocMousedown, true)
  document.addEventListener('keydown', onDocKeydown, true)
  window.addEventListener('blur', onWinBlur)
  window.addEventListener('resize', onWinResize)
}

function removeGlobalListeners(): void {
  document.removeEventListener('mousedown', onDocMousedown, true)
  document.removeEventListener('keydown', onDocKeydown, true)
  window.removeEventListener('blur', onWinBlur)
  window.removeEventListener('resize', onWinResize)
}
