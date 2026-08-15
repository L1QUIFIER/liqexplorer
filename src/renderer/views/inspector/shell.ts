// The inspector: the right-hand pane, as a tab strip over swappable pages.
//
// It grew out of the preview pane, which is now simply the first tab. That pane
// already had the right bones — #sidepane is a flex column with a splitter and a
// remembered width — so the strip is a third flex child and nothing about the
// existing preview layout changes.
//
// WHY TABS RATHER THAN A SECOND PANE: Explorer has a Preview pane and a Details
// pane that are mutually exclusive. Two panes competing for one edge means two
// visibility flags, two splitters and a rule about what happens when both are
// on. One pane with tabs is the same feature with none of that.
//
// Pages mount LAZILY on first activation and then stay in the DOM hidden, which
// is what makes switching instant while a folder of thousands of files scrolls
// underneath. A page that owns something expensive (a playing video, a decoded
// bitmap) implements suspend() and is told when it goes off screen.
import { app } from '../../core/app'
import type { Tab } from '../../core/app'
import { isTextualMime } from '../../../shared/doc'
import type { FileEntry } from '../../../shared/types'

export type InspectorTabId = 'preview' | 'details' | 'rename' | 'edit' | 'doc'

/** what the pane is currently looking at */
export interface Subject {
  kind: 'none' | 'single' | 'multi' | 'folder'
  entries: FileEntry[]
  tab: Tab | null
}

export interface InspectorPage {
  el: HTMLElement
  render(sub: Subject): void
  /** deactivated or hidden: stop timers, pause media, drop bitmaps */
  suspend?(): void
  /** unsaved work — the shell will not silently throw it away */
  isDirty?(): boolean
}

interface TabDef {
  id: InspectorTabId
  label: string
  /** why it is greyed, when it is */
  reason: string
  enabled(sub: Subject): boolean
  /** built on first activation */
  create?(): InspectorPage
}

const TAB_KEY = 'sidepane-tab'

export interface InspectorHandle {
  /** the page a tab renders into, for tabs the host builds itself */
  register(id: InspectorTabId, page: InspectorPage): void
  /** re-render whichever tab is showing */
  refresh(): void
  activate(id: InspectorTabId): void
  current(): InspectorTabId
  subject(): Subject
}

/** injected at import time, not on first use: a stylesheet added in the same
 *  frame as the element applies a frame late and the pane flashes unstyled */
function ensureStyles(): void {
  if (document.querySelector('link[data-ins-style]')) return
  const link = document.createElement('link')
  link.rel = 'stylesheet'
  link.href = 'styles/inspector.css'
  link.setAttribute('data-ins-style', '1')
  document.head.appendChild(link)
}

/** what the Edit tab can actually open: a real file, and a raster format
 *  ImageMagick both reads and writes. RAW and HEIC are readable but a
 *  round-trip would silently re-encode to something else, so they stay out. */
const EDITABLE_IMAGE = new Set(['jpg', 'jpeg', 'png', 'webp', 'gif', 'bmp', 'tif', 'tiff'])
function isEditableImage(e: FileEntry | undefined): boolean {
  return !!e && !e.isDir && e.path.startsWith('/') && EDITABLE_IMAGE.has(e.ext)
}

function isDocument(e: FileEntry | undefined): boolean {
  if (!e || e.isDir || !e.path.startsWith('/')) return false
  return e.ext === 'pdf' || isTextualMime(e.mime || '')
}

export function mountInspector(root: HTMLElement, previewPage: HTMLElement): InspectorHandle {
  ensureStyles()
  const tabsEl = document.createElement('div')
  tabsEl.className = 'ins-tabs'
  tabsEl.setAttribute('role', 'tablist')

  const bodyEl = document.createElement('div')
  bodyEl.className = 'ins-body'
  bodyEl.appendChild(previewPage)

  root.append(tabsEl, bodyEl)

  const pages = new Map<InspectorTabId, InspectorPage>()
  pages.set('preview', { el: previewPage, render: () => { /* preview.ts drives itself */ } })

  const DEFS: TabDef[] = [
    {
      id: 'preview', label: 'Preview', reason: '',
      enabled: () => true,
    },
    {
      id: 'details', label: 'Details',
      reason: 'Nothing selected',
      enabled: (s) => s.kind !== 'none' || !!s.tab,
    },
    {
      id: 'rename', label: 'Rename',
      reason: 'Select the files to rename',
      enabled: (s) => s.entries.length > 0 && s.entries.every(e => e.path.startsWith('/')),
    },
    {
      id: 'edit', label: 'Edit',
      reason: 'Editing needs a picture on this computer',
      enabled: (s) => s.kind === 'single' && isEditableImage(s.entries[0]),
    },
    {
      id: 'doc', label: 'Doc',
      reason: 'Only text files and PDFs',
      enabled: (s) => s.kind === 'single' && isDocument(s.entries[0]),
    },
  ]

  let active: InspectorTabId = 'preview'
  const btns = new Map<InspectorTabId, HTMLButtonElement>()

  function subject(): Subject {
    const t = app.activeTab
    const sel = t ? t.selectedEntries() : []
    if (!t) return { kind: 'none', entries: [], tab: null }
    if (sel.length === 0) return { kind: 'none', entries: [], tab: t }
    if (sel.length > 1) return { kind: 'multi', entries: sel, tab: t }
    return { kind: sel[0].isDir ? 'folder' : 'single', entries: sel, tab: t }
  }

  /**
   * showDetailsPane has existed as a dead setting since the pane was built. It
   * now means exactly "the pane is open, ON Details" — a derived mirror, never
   * an independent switch, because two booleans controlling one element is how
   * you end up with a menu tick that disagrees with the screen. Written from
   * both ends: switching tabs, and the pane being shown or hidden.
   */
  function mirrorDetailsFlag(): void {
    const want = !!app.settings.showPreviewPane && active === 'details'
    if ((app.settings.showDetailsPane === true) !== want) {
      void app.setSettings({ showDetailsPane: want })
    }
  }

  function paintTabs(): void {
    const sub = subject()
    for (const def of DEFS) {
      const b = btns.get(def.id)
      if (!b) continue
      // a tab whose page has not been registered yet (built, but not wired, or
      // still being written) must not be clickable — it would blank the pane
      const on = (pages.has(def.id) || !!def.create) && def.enabled(sub)
      b.disabled = !on
      // greyed, never removed: a strip that changes length as you arrow down a
      // list is unusable, and the missing tab reads as a bug
      b.title = on ? def.label : `${def.label} — ${def.reason}`
      b.classList.toggle('active', def.id === active)
      b.setAttribute('aria-selected', String(def.id === active))
    }
  }

  function show(id: InspectorTabId): void {
    const def = DEFS.find(d => d.id === id)
    if (!def) return
    if (!pages.has(id) && !def.create) return
    if (!def.enabled(subject())) return
    if (id !== active) pages.get(active)?.suspend?.()
    active = id
    let page = pages.get(id)
    if (!page && def.create) { page = def.create(); pages.set(id, page); bodyEl.appendChild(page.el) }
    for (const [pid, p] of pages) p.el.hidden = pid !== id
    paintTabs()
    try { localStorage.setItem(TAB_KEY, id) } catch { /* storage disabled */ }
    mirrorDetailsFlag()
    page?.render(subject())
  }

  for (const def of DEFS) {
    const b = document.createElement('button')
    b.className = 'ins-tab'
    b.type = 'button'
    b.textContent = def.label
    b.setAttribute('role', 'tab')
    b.addEventListener('click', () => show(def.id))
    btns.set(def.id, b)
    tabsEl.appendChild(b)
  }

  // narrow pane: labels give way to the tab strip staying on one line
  const ro = new ResizeObserver(() => {
    root.classList.toggle('ins-narrow', root.clientWidth < 260)
  })
  ro.observe(root)

  function refresh(): void {
    paintTabs()
    const sub = subject()
    const def = DEFS.find(d => d.id === active)
    // the current tab stopped applying (a folder selected while on Edit):
    // fall back to Preview WITHOUT overwriting the stored preference, so
    // selecting a file again returns to where the user was
    if (def && !def.enabled(sub)) {
      pages.get(active)?.suspend?.()
      active = 'preview'
      for (const [pid, p] of pages) p.el.hidden = pid !== 'preview'
      paintTabs()
      return
    }
    pages.get(active)?.render(sub)
  }

  app.on('tab-selection', refresh)
  app.on('tab-navigated', refresh)
  app.on('tabs-changed', refresh)
  // a rating written anywhere comes back as a listing repaint; without this the
  // stars in Details would not follow a change made with the number keys
  app.on('tab-listing', refresh)

  // Alt+Shift+P / View menu: open the pane on Details, or close it if that is
  // already what is showing. Toggling the same thing twice must undo it.
  // the pane's visibility is owned by preview.ts; the flag has to follow it
  app.on('settings-changed', mirrorDetailsFlag)

  app.on('toggle-details-pane', () => {
    const open = !!app.settings.showPreviewPane
    if (open && active === 'details') { void app.setSettings({ showPreviewPane: false }); return }
    if (!open) void app.setSettings({ showPreviewPane: true })
    show('details')
  })
  app.on('set-inspector-tab', (id: InspectorTabId) => show(id))

  // restore the last tab, but only once the page that serves it exists
  let wanted: InspectorTabId = 'preview'
  try {
    const saved = localStorage.getItem(TAB_KEY) as InspectorTabId | null
    if (saved && DEFS.some(d => d.id === saved)) wanted = saved
  } catch { /* storage disabled */ }

  paintTabs()

  return {
    register(id, page) {
      pages.set(id, page)
      page.el.hidden = id !== active
      bodyEl.appendChild(page.el)
      const def = DEFS.find(d => d.id === id)
      if (def) def.create = () => page
      // the tab the user last had open only becomes reachable now
      if (id === wanted && wanted !== active) show(wanted)
      else paintTabs()
    },
    refresh,
    activate: show,
    current: () => active,
    subject,
  }
}
