// The accept/cancel bar that turns LiqExplorer into a file dialog.
//
// Everything above this bar is the ordinary file manager — tabs, dual pane,
// columns, sort, group, search, the nav pane, the preview pane. That IS the
// point: the reason the GTK portal dialog is painful is that it reimplements a
// file manager badly, and the way out is not to reimplement it slightly less
// badly but to put an Open button on the real one.
//
// Three things change in pick mode, and nothing else:
//   1. this bar appears,
//   2. rows the caller's filter excludes are hidden (app.rowFilter),
//   3. activating a file returns it instead of launching it (setOpenIntercept).

import { app, liq } from '../core/app'
import { setOpenIntercept } from '../core/actions'
import { filterMatches, type PickFilter, type PickRequest } from '../../shared/pick'
import type { FileEntry } from '../../shared/types'

let req: PickRequest | null = null
let filterIndex = 0
let nameInput: HTMLInputElement | null = null
let answered = false

/** The filter the user has selected, or null when the caller sent none. */
function activeFilter(): PickFilter | null {
  return req?.filters?.[filterIndex] ?? null
}

/**
 * Read the request and install the row filter BEFORE the app lists anything.
 *
 * Called ahead of app.init() from the renderer bootstrap: the first folder
 * starts listing inside init(), and a filter installed after that would leave
 * the opening view showing files the caller excluded until something forced a
 * recompute.
 *
 * Returns null for an ordinary window, which is every window but these.
 */
export async function initPick(): Promise<PickRequest | null> {
  if (new URLSearchParams(location.search).get('pick') !== '1') return null
  try { req = await liq.invoke('pickRequest') } catch { req = null }
  if (!req) return null
  app.pickMode = true
  filterIndex = Math.max(0, Math.min((req.filters?.length ?? 1) - 1, req.currentFilter ?? 0))
  applyRowFilter()
  setOpenIntercept(() => accept())
  return req
}

/**
 * Hide what the caller cannot accept.
 *
 * Directories are ALWAYS shown in file mode — they are how you reach the file,
 * and a filter that hid them would make the dialog useless. In folder mode the
 * inverse holds: files are noise, so they go, exactly as every folder picker
 * on every platform does it.
 */
function applyRowFilter(): void {
  if (!req) return
  const mode = req.mode
  const filter = activeFilter()
  app.rowFilter = (e: FileEntry): boolean => {
    if (e.isDir) return true
    if (mode === 'folder') return false
    return filterMatches(filter, e.name, e.mime)
  }
}

/** Re-derive every open pane against the new filter. */
function refilter(): void {
  applyRowFilter()
  for (const t of app.allTabs()) { t.recompute(); app.emit('tab-listing', t) }
}

export function mountPickBar(el: HTMLElement): void {
  if (!req) return
  const r = req
  el.hidden = false
  el.classList.add('pk-bar')

  const isSave = r.mode === 'save'
  const label = r.acceptLabel?.replace(/_/g, '') || (isSave ? 'Save' : 'Open')

  el.innerHTML = `
    <label class="pk-label" for="pk-name">${isSave ? 'File name:' : r.mode === 'folder' ? 'Folder:' : 'File name:'}</label>
    <input id="pk-name" class="pk-name" type="text" spellcheck="false" autocomplete="off">
    <select id="pk-filter" class="pk-filter"></select>
    <button id="pk-accept" class="pk-btn pk-primary"></button>
    <button id="pk-cancel" class="pk-btn">Cancel</button>`

  nameInput = el.querySelector<HTMLInputElement>('#pk-name')!
  const filterSel = el.querySelector<HTMLSelectElement>('#pk-filter')!
  const acceptBtn = el.querySelector<HTMLButtonElement>('#pk-accept')!
  acceptBtn.textContent = label

  // No filters from the caller means no dropdown — an empty <select> next to
  // the button reads as a control that is broken rather than absent.
  if (r.filters?.length) {
    for (const [i, f] of r.filters.entries()) {
      const opt = document.createElement('option')
      opt.value = String(i)
      opt.textContent = f.name
      filterSel.append(opt)
    }
    filterSel.value = String(filterIndex)
    filterSel.addEventListener('change', () => {
      filterIndex = Number(filterSel.value) || 0
      refilter()
    })
  } else {
    filterSel.hidden = true
  }

  if (isSave) nameInput.value = r.currentName || basename(r.currentFile) || ''
  nameInput.readOnly = r.mode === 'folder'

  acceptBtn.addEventListener('click', () => { void accept() })
  el.querySelector('#pk-cancel')!.addEventListener('click', () => cancel())
  nameInput.addEventListener('keydown', (e) => {
    e.stopPropagation()                     // the file view owns type-to-find
    if (e.key === 'Enter') { e.preventDefault(); void accept() }
    if (e.key === 'Escape') { e.preventDefault(); cancel() }
  })

  // Selecting in the file view fills the name box, the way both Explorer and
  // the GTK dialog do — including in save mode, where clicking an existing file
  // is how you say "overwrite that one".
  app.on('tab-selection', () => syncName())
  app.on('tab-navigated', () => syncName())
  syncName()

  // Escape cancels the dialog, but only when it is not doing something else:
  // a menu, a confirm box or an open search all consume it first.
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || e.defaultPrevented) return
    if (document.getElementById('menu-layer')?.childElementCount) return
    if (document.getElementById('dialog-layer')?.childElementCount) return
    cancel()
  })

  // Give the file view the focus, not the text box: arrows and type-to-find are
  // how a file gets picked, and typing a full name is the fallback.
  if (isSave) { nameInput.focus(); nameInput.select() }

  // Pressing Save with a folder open and nothing typed is a no-op, so keep the
  // button honest about it.
  const sync = (): void => { acceptBtn.disabled = !canAccept() }
  app.on('tab-selection', sync)
  app.on('tab-navigated', sync)
  nameInput.addEventListener('input', sync)
  sync()
}

function basename(p: string | undefined): string {
  return p ? p.slice(p.lastIndexOf('/') + 1) : ''
}

/** Fill the name box from the current selection. */
function syncName(): void {
  if (!req || !nameInput) return
  const tab = app.activeTab
  if (!tab) return
  const sel = tab.selectedEntries()
  if (req.mode === 'folder') {
    const dir = sel.find(e => e.isDir)
    nameInput.value = dir ? dir.path : realDir(tab.path) ?? ''
    return
  }
  const files = sel.filter(e => !e.isDir)
  if (!files.length) {
    // Save keeps whatever the user typed; Open has nothing to show.
    if (req.mode !== 'save') nameInput.value = ''
    return
  }
  nameInput.value = files.length === 1
    ? files[0].name
    : files.map(f => `"${f.name}"`).join(' ')
}

/** A virtual location (home://, computer://, trash://) is not a real folder. */
function realDir(p: string): string | null {
  return p && p.startsWith('/') && !p.includes('://') ? p : null
}

function canAccept(): boolean {
  if (!req) return false
  const tab = app.activeTab
  if (!tab) return false
  const sel = tab.selectedEntries()
  if (req.mode === 'folder') return !!(sel.some(e => e.isDir) || realDir(tab.path))
  if (req.mode === 'save') return !!(nameInput?.value.trim() && realDir(tab.path))
  return sel.some(e => !e.isDir && e.path.startsWith('/')) || !!nameInput?.value.trim()
}

/**
 * What the caller gets back, or null when the request cannot be answered yet.
 *
 * Only real filesystem paths are ever returned. A row on home:// or computer://
 * carries one, so picking from those pages works; a row in the recycle bin does
 * not, and handing a caller `trash:///...` would be worse than refusing.
 */
function resolvePaths(): string[] | null {
  if (!req) return null
  const tab = app.activeTab
  if (!tab) return null
  const dir = realDir(tab.path)
  const sel = tab.selectedEntries()
  const typed = nameInput?.value.trim() ?? ''

  if (req.mode === 'folder') {
    const dirs = sel.filter(e => e.isDir && e.path.startsWith('/')).map(e => e.path)
    if (dirs.length) return req.multiple ? dirs : dirs.slice(0, 1)
    return dir ? [dir] : null
  }

  if (req.mode === 'save') {
    if (!dir || !typed) return null
    // An absolute path typed into the box wins over the browsed folder — that
    // is the one thing the GTK dialog does well, and people rely on it.
    return [typed.startsWith('/') ? typed : `${dir.replace(/\/+$/, '')}/${typed}`]
  }

  const files = sel.filter(e => !e.isDir && e.path.startsWith('/')).map(e => e.path)
  if (files.length) return req.multiple ? files : files.slice(0, 1)
  if (!typed) return null
  if (typed.startsWith('/')) return [typed]
  return dir ? [`${dir.replace(/\/+$/, '')}/${typed}`] : null
}

/**
 * Accept. Returns true when it took responsibility for the activation, which is
 * what makes double-click and Enter in the file view mean "pick this".
 */
function accept(): boolean {
  if (!req || answered) return true
  const paths = resolvePaths()
  if (!paths?.length) return true          // nothing valid — stay open

  if (req.mode === 'save') {
    void liq.invoke('pickExists', paths[0]).then((kind: string | null) => {
      if (kind === 'dir') return           // a folder of that name: refuse quietly
      if (kind !== 'file') { finish(paths); return }
      app.emit('show-confirm', {
        title: 'Confirm Save As',
        message: `${basename(paths[0])} already exists.\nDo you want to replace it?`,
        okLabel: 'Replace',
        danger: true,
        onOk: () => finish(paths),
      })
    })
    return true
  }
  finish(paths)
  return true
}

function finish(paths: string[]): void {
  if (answered) return
  answered = true
  void liq.invoke('pickResult', { ok: true, paths, filterIndex })
}

function cancel(): void {
  if (answered) return
  answered = true
  void liq.invoke('pickResult', { ok: false, paths: [] })
}
