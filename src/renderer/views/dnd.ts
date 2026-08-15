// Drag & drop for the item views.
// Internal drags carry 'application/x-liq-paths' (JSON string[]) plus a
// text/uri-list for other apps. Drops accept internal paths, external OS files
// (mapped through liq.pathForFile / webUtils) and text/uri-list file:// lines.
// Semantics: internal = move unless Ctrl (copy); external = copy. Never drop a
// folder onto itself or a descendant.
import { app, liq, type Tab } from '../core/app'
import type { FileEntry } from '../../shared/types'
import { dirname, iconURL } from './items'
import { defaultDragEffect } from './rightdrag'
import { transferWithConfirm } from '../core/confirmmove'

export interface DnDHost {
  scroller: HTMLElement
  canvas: HTMLElement
  tab(): Tab | null
  entryFromEvent(target: EventTarget | null): FileEntry | null
  elForPath(path: string): HTMLElement | null
}

/** paths of a drag that started in THIS window (for dragover-time guards) */
let dragPaths: string[] | null = null

function toFileUrl(p: string): string {
  return 'file://' + p.split('/').map(encodeURIComponent).join('/')
}

function buildDragImage(entry: FileEntry, count: number): HTMLElement {
  const wrap = document.createElement('div')
  wrap.className = 'vh-dragimg'
  const layers = Math.min(3, count)
  for (let i = layers - 1; i >= 1; i--) {
    const card = document.createElement('div')
    card.className = 'vh-dragcard vh-dragstack'
    card.style.transform = `translate(${i * 5}px, ${i * 5}px)`
    wrap.appendChild(card)
  }
  const main = document.createElement('div')
  main.className = 'vh-dragcard'
  const img = document.createElement('img')
  img.src = iconURL(entry, 32)
  img.width = 32
  img.height = 32
  main.appendChild(img)
  wrap.appendChild(main)
  if (count > 1) {
    const b = document.createElement('span')
    b.className = 'vh-dragbadge'
    b.textContent = String(count)
    wrap.appendChild(b)
  }
  return wrap
}

function edgeScroll(scroller: HTMLElement, clientY: number): void {
  const r = scroller.getBoundingClientRect()
  if (clientY < r.top + 12) {
    scroller.scrollTop -= Math.min(64, 4 + (r.top + 12 - clientY) * 1.5)
  } else if (clientY > r.bottom - 12) {
    scroller.scrollTop += Math.min(64, 4 + (clientY - (r.bottom - 12)) * 1.5)
  }
}

export function wireDnD(host: DnDHost): void {
  let dropEl: HTMLElement | null = null

  const clearMarks = (): void => {
    dropEl?.classList.remove('drop-target')
    dropEl = null
    host.scroller.classList.remove('vh-drop-bg')
  }

  host.canvas.addEventListener('dragstart', (e) => {
    const entry = host.entryFromEvent(e.target)
    const t = host.tab()
    if (!entry || !t || !e.dataTransfer) { e.preventDefault(); return }
    if (!t.selection.has(entry.path)) {
      t.anchorPath = entry.path
      t.setSelection([entry.path], entry.path)
    }
    const paths = t.selectedEntries().map(x => x.path)
    dragPaths = paths
    e.dataTransfer.setData('application/x-liq-paths', JSON.stringify(paths))
    e.dataTransfer.setData('text/uri-list', paths.map(toFileUrl).join('\r\n'))
    e.dataTransfer.effectAllowed = 'copyMove'
    const img = buildDragImage(entry, paths.length)
    document.body.appendChild(img)
    e.dataTransfer.setDragImage(img, 20, 20)
    setTimeout(() => img.remove())
  })

  host.canvas.addEventListener('dragend', () => {
    dragPaths = null
    clearMarks()
  })

  host.scroller.addEventListener('dragover', (e) => {
    const dt = e.dataTransfer
    const t = host.tab()
    if (!dt || !t) return
    const types = Array.from(dt.types)
    const internal = types.includes('application/x-liq-paths')
    const external = types.includes('Files') || types.includes('text/uri-list')
    if (!internal && !external) return

    const over = host.entryFromEvent(e.target)
    const folder = over && over.isDir ? over : null
    const dest = folder ? folder.path : t.path
    // Explorer modifiers: Ctrl copies, Shift moves, otherwise the default is
    // move within a volume and copy across volumes. (Alt = make a shortcut is
    // handled on drop — the DataTransfer API has no 'link into folder' effect.)
    let effect: 'copy' | 'move' | 'none' = !internal ? 'copy'
      : e.ctrlKey ? 'copy'
        : e.shiftKey ? 'move'
          : dragPaths?.length ? defaultDragEffect(dragPaths[0], dest) : 'move'
    if (dest.includes('://')) {
      // only meaningful virtual target: dropping on the Recycle Bin background
      effect = internal && t.path === 'trash://' && !folder ? 'move' : 'none'
    }
    if (effect !== 'none' && internal && dragPaths) {
      if (dragPaths.some(p => dest === p || dest.startsWith(p + '/'))) effect = 'none'
      else if (!folder && effect === 'move' && dragPaths.every(p => dirname(p) === dest)) effect = 'none'
    }
    if (effect === 'none') { clearMarks(); return }
    e.preventDefault()
    dt.dropEffect = effect
    const el = folder ? host.elForPath(folder.path) : null
    if (el !== dropEl) {
      dropEl?.classList.remove('drop-target')
      dropEl = el
      el?.classList.add('drop-target')
    }
    host.scroller.classList.toggle('vh-drop-bg', !folder)
    edgeScroll(host.scroller, e.clientY)
  })

  host.scroller.addEventListener('dragleave', (e) => {
    if (!host.scroller.contains(e.relatedTarget as Node)) clearMarks()
  })

  host.scroller.addEventListener('drop', (e) => {
    const dt = e.dataTransfer
    const t = host.tab()
    if (!dt || !t) return
    e.preventDefault()
    const over = host.entryFromEvent(e.target)
    const folder = over && over.isDir ? over : null
    const dest = folder ? folder.path : t.path
    clearMarks()

    let sources: string[] = []
    let internal = false
    const internalRaw = dt.getData('application/x-liq-paths')
    if (internalRaw) {
      internal = true
      try { sources = JSON.parse(internalRaw) as string[] } catch { sources = [] }
    } else if (dt.files && dt.files.length) {
      for (const f of Array.from(dt.files)) {
        try {
          const p = liq.pathForFile(f)
          if (p) sources.push(p)
        } catch { /* not a filesystem file */ }
      }
    } else {
      for (const line of dt.getData('text/uri-list').split(/\r?\n/)) {
        const s = line.trim()
        if (!s || s.startsWith('#') || !s.startsWith('file://')) continue
        try { sources.push(decodeURIComponent(new URL(s).pathname)) } catch { /* bad uri */ }
      }
    }
    dragPaths = null
    if (!sources.length) return

    if (t.path === 'trash://' && !folder) {
      if (internal) void liq.startOp({ kind: 'trash', sources })
      return
    }
    if (dest.includes('://')) return

    // Alt (or Ctrl+Shift) drops a shortcut, like Explorer
    const kind: 'copy' | 'move' | 'symlink' = !internal ? 'copy'
      : (e.altKey || (e.ctrlKey && e.shiftKey)) ? 'symlink'
        : e.ctrlKey ? 'copy'
          : e.shiftKey ? 'move'
            : defaultDragEffect(sources[0], dest)
    let filtered = sources.filter(s => dest !== s && !dest.startsWith(s + '/'))
    if (kind === 'move') filtered = filtered.filter(s => dirname(s) !== dest)
    else if (!folder && !internal && kind === 'copy') filtered = filtered.filter(s => dirname(s) !== dest)
    if (!filtered.length) return
    // opt-in guard against the stray drag that silently moves a folder, plus
    // safe mode's check for the drop that was clearly not intended
    transferWithConfirm(kind, filtered, dest, app.settings.confirmDrop)
  })
}
