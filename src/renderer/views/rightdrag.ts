// Windows-style RIGHT-button drag: press the right button on an item, drag it
// onto a folder / nav-pane place / breadcrumb, release, and choose from
// "Copy here / Move here / Create shortcuts here / Cancel" (Explorer bolds the
// action a left-drag would have done: same volume moves, across volumes copies).
//
// This cannot ride on HTML5 drag-and-drop — Chromium only starts native drags
// for the left button. So the gesture is driven by mouse events with our own
// ghost + drop highlight, and it is confined to this window.
//
// Timing note: on Linux, `contextmenu` fires on mouse DOWN, so the plain
// right-click menu has to be deferred to mouse UP or every right-press would
// pop a menu before the drag could start. view-host therefore suppresses
// `contextmenu` and asks openMenuOnMouseUp() what the gesture turned out to be.
import { app, liq, Tab } from '../core/app'
import type { FileEntry } from '../../shared/types'
import { showMenu } from '../menus/menu'
import type { MenuItem } from '../menus/menu-types'
import { iconURL } from './items'
import { isArchiveName, archiveStem } from '../../shared/archive'
import { volumeOf } from '../core/mounts'

const DRAG_THRESHOLD = 6

export interface RightDragHost {
  scroller: HTMLElement
  tab(): Tab | null
  entryFromEvent(target: EventTarget | null): FileEntry | null
  /**
   * True when this press landed past the end of a row's visible content — the
   * empty strip to the right of the last column in details view. Supplied by
   * the view host so there is ONE definition of where a row stops, shared with
   * the context-menu logic.
   */
  pastRowContent(target: EventTarget | null, clientX: number): boolean
}

interface Armed {
  x: number
  y: number
  paths: string[]
  entries: FileEntry[]
}

interface DropTarget {
  path: string
  label: string
}

/** Explorer's default drag action: move within a volume, copy across volumes. */
export function defaultDragEffect(srcPath: string, destPath: string): 'copy' | 'move' {
  const a = volumeOf(srcPath), b = volumeOf(destPath)
  if (!a || !b) return 'move'
  return a === b ? 'move' : 'copy'
}

function baseName(p: string): string {
  return p.replace(/\/+$/, '').split('/').pop() || p
}

export interface RightDragHandle {
  /** true when the just-finished right-press was a drag, so no context menu */
  consumedMenu(): boolean
}

/** Every mounted view host, so a right-drag started in one pane can resolve a
 *  destination in the OTHER pane — each host closes over its own layout, so the
 *  element under the cursor has to be handed back to whichever host owns it. */
const hosts: RightDragHost[] = []

function hostAt(el: Node): RightDragHost | null {
  for (const h of hosts) if (h.scroller.contains(el)) return h
  return null
}

export function initRightDrag(host: RightDragHost): RightDragHandle {
  hosts.push(host)
  let armed: Armed | null = null
  let dragging = false
  let ghost: HTMLElement | null = null
  let marked: HTMLElement | null = null
  let target: DropTarget | null = null
  /** set while the gesture is resolving so view-host does not also open a menu */
  let consumedMenu = false

  function clearMark(): void {
    marked?.classList.remove('drop-target')
    marked = null
  }

  function endGesture(): void {
    armed = null
    dragging = false
    ghost?.remove()
    ghost = null
    clearMark()
    target = null
    document.body.classList.remove('is-rightdragging')
  }

  /** same visual as the left-drag image in dnd.ts, but we position it ourselves */
  function buildGhost(entries: FileEntry[]): HTMLElement {
    const wrap = document.createElement('div')
    wrap.className = 'vh-dragimg vh-rightghost'
    const count = entries.length
    for (let i = Math.min(3, count) - 1; i >= 1; i--) {
      const card = document.createElement('div')
      card.className = 'vh-dragcard vh-dragstack'
      card.style.transform = `translate(${i * 5}px, ${i * 5}px)`
      wrap.appendChild(card)
    }
    const main = document.createElement('div')
    main.className = 'vh-dragcard'
    const img = document.createElement('img')
    img.width = 32
    img.height = 32
    img.src = iconURL(entries[0], 32)
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

  /** what is under the cursor: a folder row, the folder being viewed, a place, a crumb */
  function targetAt(x: number, y: number): DropTarget | null {
    const el = document.elementFromPoint(x, y) as HTMLElement | null
    if (!el) return null

    // an element that declares its own path (nav pane rows, breadcrumb segments)
    const declared = el.closest<HTMLElement>('[data-liq-path]')
    if (declared) {
      const p = declared.dataset.liqPath!
      if (p.includes('://')) return null
      return { path: p, label: declared.dataset.liqLabel || baseName(p) }
    }

    // the drop may land in either pane, so ask whichever host owns the element
    const h = hostAt(el)
    if (h) {
      const entry = h.entryFromEvent(el)
      if (entry?.isDir) return { path: entry.path, label: entry.name }
      const t = h.tab()
      if (!t || t.isVirtual) return null
      return { path: t.path, label: baseName(t.path) }
    }
    return null
  }

  function markTarget(x: number, y: number): void {
    const el = document.elementFromPoint(x, y) as HTMLElement | null
    const row = el?.closest<HTMLElement>('.vh-item, [data-liq-path]') ?? null
    if (row === marked) return
    clearMark()
    // only highlight when the row itself is the destination (not the folder background)
    if (row && target && (row.dataset.liqPath === target.path ||
        hostAt(row)?.entryFromEvent(row)?.path === target.path)) {
      row.classList.add('drop-target')
      marked = row
    }
  }

  function onMove(e: MouseEvent): void {
    if (!armed) return
    if (!dragging) {
      if (Math.abs(e.clientX - armed.x) < DRAG_THRESHOLD &&
          Math.abs(e.clientY - armed.y) < DRAG_THRESHOLD) return
      dragging = true
      ghost = buildGhost(armed.entries)
      document.body.appendChild(ghost)
      document.body.classList.add('is-rightdragging')
    }
    if (ghost) {
      ghost.style.left = `${e.clientX + 12}px`
      ghost.style.top = `${e.clientY + 12}px`
    }
    target = targetAt(e.clientX, e.clientY)
    markTarget(e.clientX, e.clientY)
  }

  function dropMenu(sources: string[], dest: DropTarget, x: number, y: number): void {
    const dflt = defaultDragEffect(sources[0], dest.path)
    const sameFolder = sources.every(p => p.slice(0, p.lastIndexOf('/')) === dest.path)
    const plural = sources.length > 1
    // 7-Zip's shell extension puts extraction verbs in the right-drag menu, and
    // it is exactly where you want them: drag an archive onto a folder and
    // unpack it straight in, without navigating there first.
    const archives = sources.filter(p => isArchiveName(p.split('/').pop() ?? ''))
    const extractItems: MenuItem[] = archives.length ? [
      { separator: true },
      {
        label: archives.length > 1 ? `Extract ${archives.length} archives here` : 'Extract here',
        onClick: () => {
          void liq.invoke('extractArchives', { archives, mode: 'auto', dest: dest.path })
        },
      },
      {
        label: archives.length > 1 ? 'Extract each to its own folder' : `Extract to ${archiveStem(archives[0].split('/').pop() ?? '')}\\`,
        onClick: () => {
          void liq.invoke('extractArchives', { archives, mode: 'named', dest: dest.path })
        },
      },
    ] : []
    const items: MenuItem[] = [
      {
        label: 'Copy here', bold: dflt === 'copy' && !sameFolder,
        onClick: () => { void liq.startOp({ kind: 'copy', sources, dest: dest.path }) },
      },
      {
        label: 'Move here', bold: dflt === 'move' && !sameFolder, disabled: sameFolder,
        onClick: () => { void liq.startOp({ kind: 'move', sources, dest: dest.path }) },
      },
      {
        label: plural ? 'Create shortcuts here' : 'Create shortcut here',
        onClick: () => { void liq.startOp({ kind: 'symlink', sources, dest: dest.path }) },
      },
      ...extractItems,
      { separator: true },
      { label: 'Cancel' },
    ]
    showMenu(items, { x, y, minWidth: 200 })
  }

  function onUp(e: MouseEvent): void {
    if (e.button !== 2 || !armed) return
    const a = armed
    const wasDragging = dragging
    const dest = target
    endGesture()
    if (!wasDragging) { consumedMenu = false; return }
    consumedMenu = true            // the gesture was a drag: no context menu
    if (!dest) return
    // never drop a folder into itself or its own subtree
    if (a.paths.some(p => dest.path === p || dest.path.startsWith(p + '/'))) return
    dropMenu(a.paths, dest, e.clientX, e.clientY)
  }

  host.scroller.addEventListener('mousedown', (e) => {
    if (e.button !== 2) return
    const t = host.tab()
    if (!t || t.isVirtual) return
    const entry = host.entryFromEvent(e.target)
    if (!entry) return
    // The empty strip past the last column is the folder's, not the row's: a
    // right-press there must neither select the row nor arm a right-drag of it,
    // or the menu that follows would be the file's. An already-selected row is
    // the exception — then the press is plainly about that selection.
    if (!t.selection.has(entry.path) && host.pastRowContent(e.target, e.clientX)) return
    // right-press selects the item first, exactly like a left-press would
    if (!t.selection.has(entry.path)) {
      t.anchorPath = entry.path
      t.setSelection([entry.path], entry.path)
    }
    const entries = t.selectedEntries()
    armed = { x: e.clientX, y: e.clientY, paths: entries.map(x => x.path), entries }
    consumedMenu = false
  })

  window.addEventListener('mousemove', onMove)
  window.addEventListener('mouseup', onUp)
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && armed) { consumedMenu = dragging; endGesture() }
  }, true)
  // a drag that leaves the window (or loses focus) is abandoned, not applied
  window.addEventListener('blur', () => { if (armed) { consumedMenu = dragging; endGesture() } })

  return { consumedMenu: () => consumedMenu }
}
