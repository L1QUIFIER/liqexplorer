// Dialog hub: mounts every dialog sub-module and provides the shared modal
// scaffolding (overlay, focus trap, Esc/Enter handling, modal stack) that all
// of them build on. Sub-modules import { openModal, el, iconImg } from here.
import { mountOps } from './ops'
import { mountConflict } from './conflict'
import { mountConfirm } from './confirm'
import { mountProperties } from './properties'
import { mountOpenWith } from './openwith'
import { mountOptions } from './options'
import { mountPassword } from './password'
import { mountBulkRename } from './bulkrename'
import { mountFolderIcon } from './foldericon'
import { mountFixNames } from './fixnames'
import { mountHistory } from './history'
import { mountDuplicates } from './duplicates'
import { mountBetterImage } from './betterimage'
import { mountPdfExport } from './pdfexport'
import { mountBetterBatch } from './betterbatch'
import { mountSimilar } from './similar'

export function mountDialogs(): void {
  mountOps()
  mountConflict()
  mountConfirm()
  mountProperties()
  mountOpenWith()
  mountOptions()
  mountPassword()
  mountBulkRename()
  mountFolderIcon()
  mountFixNames()
  mountHistory()
  mountDuplicates()
  mountBetterImage()
  mountPdfExport()
  mountBetterBatch()
  mountSimilar()
}

// ---------------------------------------------------------------- modal stack

export interface ModalOptions {
  width?: number
  className?: string
  /** show an ✕ close button in the title row (caller supplies the title row via .dlg-title) */
  onEnter?: () => void
  /** Esc / ✕ / programmatic dismissal path. Defaults to close(). Must be idempotent. */
  onDismiss?: () => void
}

export interface ModalHandle {
  overlay: HTMLDivElement
  dlg: HTMLDivElement
  close: () => void
  /** true once close() ran */
  readonly closed: boolean
}

interface StackEntry {
  overlay: HTMLDivElement
  dlg: HTMLDivElement
  opts: ModalOptions
  prevFocus: HTMLElement | null
  dismiss: () => void
}

const stack: StackEntry[] = []
let keysInstalled = false

function focusables(root: HTMLElement): HTMLElement[] {
  const sel = 'button, input, select, textarea, a[href], [tabindex]:not([tabindex="-1"])'
  return [...root.querySelectorAll<HTMLElement>(sel)]
    .filter(n => !n.hasAttribute('disabled') && !n.hidden && n.offsetParent !== null)
}

function onModalKey(e: KeyboardEvent): void {
  const top = stack[stack.length - 1]
  if (!top) return
  // An open context menu owns the keyboard. menus/menu.ts has its own capture
  // listener on document, and its stopPropagation() cannot silence a sibling
  // capture listener here — acting too would double-handle Esc/Enter (e.g. an
  // Escape aimed at the menu also cancelling a conflict dialog's whole op).
  // .menu-root exists in #menu-layer exactly while a menu is open.
  if (document.querySelector('#menu-layer > .menu-root')) return
  if (e.key === 'Escape') {
    e.preventDefault()
    e.stopPropagation()
    top.dismiss()
    return
  }
  if (e.key === 'Enter' && top.opts.onEnter) {
    const t = e.target as HTMLElement | null
    // Enter on a focused button/link activates that control, not the primary.
    if (t && (t.tagName === 'BUTTON' || t.tagName === 'A' || t.tagName === 'TEXTAREA')) return
    e.preventDefault()
    e.stopPropagation()
    top.opts.onEnter()
    return
  }
  if (e.key === 'Tab') {
    const items = focusables(top.dlg)
    if (!items.length) { e.preventDefault(); e.stopPropagation(); return }
    const cur = document.activeElement as HTMLElement | null
    let idx = cur ? items.indexOf(cur) : -1
    if (idx === -1) idx = e.shiftKey ? 0 : items.length - 1
    const next = e.shiftKey
      ? items[(idx - 1 + items.length) % items.length]
      : items[(idx + 1) % items.length]
    e.preventDefault()
    e.stopPropagation()
    next.focus()
    return
  }
  // keep app-level shortcuts (F2, Delete, Ctrl+A on the file view...) from
  // firing underneath an open modal, but let normal typing through to inputs
  const t = e.target as HTMLElement | null
  const typing = !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)
  if (!typing && !top.dlg.contains(t)) e.stopPropagation()
}

function syncKeyHandler(): void {
  if (stack.length && !keysInstalled) {
    document.addEventListener('keydown', onModalKey, true)
    keysInstalled = true
  } else if (!stack.length && keysInstalled) {
    document.removeEventListener('keydown', onModalKey, true)
    keysInstalled = false
  }
}

/** Open a Win11-style modal: dimmed overlay + card in #dialog-layer. */
export function openModal(opts: ModalOptions = {}): ModalHandle {
  const layer = document.getElementById('dialog-layer')!
  const overlay = document.createElement('div')
  overlay.className = 'dlg-overlay'
  const dlg = document.createElement('div')
  dlg.className = 'dlg' + (opts.className ? ' ' + opts.className : '')
  if (opts.width) dlg.style.width = opts.width + 'px'
  dlg.tabIndex = -1
  overlay.appendChild(dlg)
  layer.appendChild(overlay)

  let closed = false
  const close = (): void => {
    if (closed) return
    closed = true
    const i = stack.findIndex(s => s.overlay === overlay)
    if (i >= 0) stack.splice(i, 1)
    overlay.remove()
    syncKeyHandler()
    const prev = entry.prevFocus
    if (prev && document.contains(prev)) prev.focus()
  }
  const dismiss = (): void => { (opts.onDismiss ?? close)() }

  const entry: StackEntry = {
    overlay, dlg, opts,
    prevFocus: document.activeElement instanceof HTMLElement ? document.activeElement : null,
    dismiss,
  }
  stack.push(entry)
  syncKeyHandler()

  // initial focus: primary button > first focusable > the card itself
  requestAnimationFrame(() => {
    if (closed) return
    const primary = dlg.querySelector<HTMLElement>('.btn-primary')
    const target = (primary && !primary.hasAttribute('disabled')) ? primary : (focusables(dlg)[0] ?? dlg)
    target.focus()
  })

  return {
    overlay, dlg, close,
    get closed() { return closed },
  }
}

// ------------------------------------------------------------- DOM utilities

/** tiny element builder */
export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K, className?: string, text?: string,
): HTMLElementTagNameMap[K] {
  const n = document.createElement(tag)
  if (className) n.className = className
  if (text !== undefined) n.textContent = text
  return n
}

/** themed icon <img> via liqicon:// with fallback names */
export function iconImg(names: string[] | undefined, size: number, className = ''): HTMLImageElement {
  const img = document.createElement('img')
  img.className = className
  img.width = size
  img.height = size
  img.draggable = false
  const list = (names && names.length ? names : ['application-x-generic']).join(',')
  img.src = `liqicon://${list}?size=${size}`
  img.addEventListener('error', () => {
    img.src = `liqicon://application-x-generic?size=${size}`
  }, { once: true })
  return img
}

/** ✕ button for dialog title rows */
export function closeX(onClick: () => void): HTMLButtonElement {
  const b = el('button', 'dlg-x')
  b.setAttribute('aria-label', 'Close')
  b.innerHTML = '<svg width="10" height="10" viewBox="0 0 10 10"><path d="M1 1l8 8M9 1l-8 8" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" fill="none"/></svg>'
  b.addEventListener('click', onClick)
  return b
}

/** middle-ellipsize long names the way the Explorer copy dialog does */
export function midEllipsize(s: string, max = 44): string {
  if (s.length <= max) return s
  const keep = max - 1
  const head = Math.ceil(keep * 0.6)
  const tail = keep - head
  return s.slice(0, head) + '…' + s.slice(s.length - tail)
}

/** "1.24 MB (1,301,234 bytes)" dual format used all over the properties sheet */
export function dualSize(bytes: number, formatted: string): string {
  return `${formatted} (${bytes.toLocaleString('en-US')} bytes)`
}
