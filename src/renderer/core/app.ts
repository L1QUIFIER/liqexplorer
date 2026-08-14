// Renderer core: App singleton + Tab model. All UI components render FROM this
// state and mutate THROUGH it. Components listen via app.events / tab callbacks.
//
// Events dispatched on app.events (CustomEvent detail in parens):
//   'tabs-changed'        () tab list or active tab changed
//   'tab-navigated'       (tab) active path changed (history move or navigate)
//   'tab-listing'         (tab) listing entries updated (chunk arrived / refresh)
//   'tab-viewstate'       (tab) view mode / sort / group / columns changed
//   'tab-selection'       (tab) selection changed
//   'tab-loading'         (tab) loading state toggled
//   'places-changed'      (Place[])
//   'clipboard-changed'   (ClipboardFiles | null)
//   'theme-changed'       ('light'|'dark')
//   'settings-changed'    (AppSettings)
//   'ops-changed'         (OpProgress[]) live operations for the progress UI
//   'op-conflict'         (ConflictInfo)
//   'undo-changed'        (UndoInfo)

import type {
  AppSettings, ClipboardFiles, ConflictInfo, DirChunk, FileEntry, FolderViewState,
  FsEvent, OpProgress, Place, SearchChunk, UndoInfo,
} from '../../shared/types'
import { DEFAULT_VIEW_STATE, DEFAULT_SETTINGS } from '../../shared/types'
import { PUSH } from '../../shared/ipc'
import { sortEntries, computeGroups, type Group } from '../../shared/sort'

declare global {
  interface Window {
    liq: any
  }
}
export const liq = window.liq

/** The Home page (Quick access / Favorites / Recent) — rendered by views/home.ts. */
export const HOME_URI = 'home://'

let nextTabId = 1

export class Tab {
  readonly id = nextTabId++
  path = ''
  title = ''
  history: string[] = []
  historyIndex = -1
  loading = false
  error: string | null = null
  /** raw entries as listed (unsorted) */
  entries: FileEntry[] = []
  /** derived, render-ready */
  rows: FileEntry[] = []
  groups: Group[] = []
  collapsedGroups = new Set<string>()
  viewState: FolderViewState = { ...DEFAULT_VIEW_STATE }
  /** selection by path */
  selection = new Set<string>()
  anchorPath: string | null = null
  focusPath: string | null = null
  /** search mode: non-null while showing search results */
  searchQuery: string | null = null
  private listReqId = 0
  /** main-side watch id; read by App's fsEvent router */
  watchId = 0
  private searchReqId = 0
  /** bumped whenever this tab starts a new listing/search; stale awaits check it */
  private listGen = 0

  constructor(private app: App) {}

  get isVirtual(): boolean { return this.path.includes('://') }

  async navigate(path: string, pushHistory = true): Promise<void> {
    // leaving an active search: cancel it and drop its reqId so late chunks are ignored
    if (this.searchReqId) { liq.cancelSearch(this.searchReqId); this.searchReqId = 0 }
    if (pushHistory) {
      this.history = this.history.slice(0, this.historyIndex + 1)
      this.history.push(path)
      this.historyIndex = this.history.length - 1
    }
    this.path = path
    this.title = path === HOME_URI ? 'Home'
      : path === 'trash://' ? 'Recycle Bin'
        : path === 'computer://' ? 'This PC'
          : path === this.app.homePath ? 'Home'
            : (path.split('/').filter(Boolean).pop() ?? path)
    this.searchQuery = null
    this.error = null
    this.app.emit('tab-navigated', this)
    await this.loadViewState()
    await this.refresh()
    this.app.rememberSession()
  }

  canBack(): boolean { return this.searchQuery !== null || this.historyIndex > 0 }
  canForward(): boolean { return this.historyIndex < this.history.length - 1 }
  canUp(): boolean { return !this.isVirtual && this.path !== '/' }

  back(): void {
    // Back from search results returns to the folder being searched (Win11),
    // without consuming a history entry
    if (this.searchQuery !== null) { this.endSearch(); return }
    if (!this.canBack()) return
    this.historyIndex--
    this.navigate(this.history[this.historyIndex], false)
  }

  forward(): void {
    if (this.searchQuery !== null) { this.endSearch(); return }
    if (!this.canForward()) return
    this.historyIndex++
    this.navigate(this.history[this.historyIndex], false)
  }

  up(): void {
    if (!this.canUp()) return
    const parent = this.path.replace(/\/+$/, '').split('/').slice(0, -1).join('/') || '/'
    this.navigate(parent)
  }

  async refresh(): Promise<void> {
    const myReq = await this.startListing()
    void myReq
  }

  private async startListing(): Promise<number> {
    const gen = ++this.listGen
    this.loading = true
    this.entries = []
    this.recompute()
    this.app.emit('tab-loading', this)
    // cancel the previous listing so its in-flight chunks are dropped
    // (covers the virtual-path early returns too), and stop the old watch
    if (this.listReqId) { liq.cancelList(this.listReqId); this.listReqId = 0 }
    if (this.watchId) { liq.unwatchDir(this.watchId); this.watchId = 0 }
    if (this.path === HOME_URI) {
      // the Home page owns its own data (favorites/recent) — nothing to list or watch
      this.loading = false
      this.recompute()
      this.app.emit('tab-listing', this)
      this.app.emit('tab-loading', this)
      return 0
    }
    if (this.path === 'trash://') {
      const items = await liq.listTrash()
      if (gen !== this.listGen) return 0
      this.entries = items
      this.loading = false
      this.recompute()
      this.app.emit('tab-listing', this)
      this.app.emit('tab-loading', this)
      return 0
    }
    if (this.path === 'computer://') {
      const items = await computerEntries()
      if (gen !== this.listGen) return 0
      this.entries = items
      this.loading = false
      this.recompute()
      this.app.emit('tab-listing', this)
      this.app.emit('tab-loading', this)
      return 0
    }
    const path = this.path
    const reqId: number = await liq.listDir(path, { showHidden: this.app.settings.showHidden })
    if (gen !== this.listGen) { liq.cancelList(reqId); return 0 }
    this.listReqId = reqId
    liq.watchDir(path).then((id: number) => {
      // the tab may have moved on (or a newer watch won) while this resolved
      if (gen !== this.listGen || this.watchId) { liq.unwatchDir(id); return }
      this.watchId = id
    })
    return reqId
  }

  /** called by App for PUSH.dirChunk events belonging to this tab */
  onChunk(c: DirChunk): void {
    if (c.reqId !== this.listReqId) return
    if (c.error) {
      this.error = c.error
      this.loading = false
      this.app.emit('tab-listing', this)
      this.app.emit('tab-loading', this)
      return
    }
    this.entries.push(...c.entries)
    if (c.done) this.loading = false
    this.recompute()
    this.app.emit('tab-listing', this)
    if (c.done) this.app.emit('tab-loading', this)
  }

  onSearchChunk(c: SearchChunk): void {
    if (this.searchQuery === null || c.reqId !== this.searchReqId) return
    if (c.error) {
      this.error = c.error
      this.loading = false
      this.app.emit('tab-listing', this)
      this.app.emit('tab-loading', this)
      return
    }
    this.entries.push(...c.entries)
    if (c.done) this.loading = false
    this.recompute()
    this.app.emit('tab-listing', this)
    if (c.done) this.app.emit('tab-loading', this)
  }

  async startSearch(query: string): Promise<void> {
    this.searchQuery = query
    this.loading = true
    this.entries = []
    // invalidate any in-flight dir listing so its chunks don't mix into results
    this.listGen++
    if (this.listReqId) { liq.cancelList(this.listReqId); this.listReqId = 0 }
    if (this.searchReqId) { liq.cancelSearch(this.searchReqId); this.searchReqId = 0 }
    this.recompute()
    this.app.emit('tab-navigated', this)
    this.app.emit('tab-loading', this)
    const reqId: number = await liq.startSearch({
      root: this.path, query, contents: false, subfolders: true,
      showHidden: this.app.settings.showHidden,
    })
    // the tab may have navigated away / ended the search during the round trip
    if (this.searchQuery !== query) { liq.cancelSearch(reqId); return }
    this.searchReqId = reqId
  }

  endSearch(): void {
    if (this.searchQuery === null) return
    this.searchQuery = null
    if (this.searchReqId) { liq.cancelSearch(this.searchReqId); this.searchReqId = 0 }
    this.refresh()
    this.app.emit('tab-navigated', this)
  }

  /** derive rows/groups from entries + viewState */
  recompute(): void {
    const vs = this.viewState
    let rows = sortEntries(this.entries, vs, this.app.settings.foldersFirst)
    if (vs.groupKey !== 'none') {
      // re-sort by group key; V8 sort is stable, so per-group order (sortKey) survives
      rows = sortEntries(rows, { ...vs, sortKey: vs.groupKey, sortDir: vs.groupDir }, false)
    }
    this.rows = rows
    this.groups = computeGroups(rows, vs)
    // prune selection of removed entries — but not mid-listing, when rows are
    // empty/partial and pruning would wipe a live selection (e.g. a background
    // fs event triggering a refresh)
    if (this.selection.size && !this.loading) {
      const have = new Set(rows.map(r => r.path))
      for (const p of [...this.selection]) if (!have.has(p)) this.selection.delete(p)
    }
  }

  async loadViewState(): Promise<void> {
    if (!this.app.settings.rememberPerFolder) { this.viewState = { ...this.app.settings.defaultView }; return }
    const st = await liq.getViewState(this.path)
    this.viewState = st ?? structuredClone(this.app.settings.defaultView)
    this.app.emit('tab-viewstate', this)
  }

  setViewState(patch: Partial<FolderViewState>): void {
    this.viewState = { ...this.viewState, ...patch }
    this.recompute()
    this.app.emit('tab-viewstate', this)
    this.app.emit('tab-listing', this)
    if (this.app.settings.rememberPerFolder && !this.isVirtual) {
      liq.setViewState(this.path, this.viewState)
    }
  }

  // ---- selection ----
  setSelection(paths: Iterable<string>, focus?: string | null): void {
    this.selection = new Set(paths)
    if (focus !== undefined) this.focusPath = focus
    this.app.emit('tab-selection', this)
  }
  selectAll(): void { this.setSelection(this.rows.map(r => r.path)) }
  selectNone(): void { this.setSelection([]) }
  invertSelection(): void {
    const inv = this.rows.map(r => r.path).filter(p => !this.selection.has(p))
    this.setSelection(inv)
  }
  selectedEntries(): FileEntry[] { return this.rows.filter(r => this.selection.has(r.path)) }

  dispose(): void {
    if (this.watchId) liq.unwatchDir(this.watchId)
    if (this.listReqId) liq.cancelList(this.listReqId)
  }
}

/** This PC: the six Win11 user folders, then local drives, then network mounts. */
const COMPUTER_DIR_KEYS = ['DESKTOP', 'DOCUMENTS', 'DOWNLOAD', 'MUSIC', 'PICTURES', 'VIDEOS']

async function computerEntries(): Promise<FileEntry[]> {
  const [dirs, drives, places] = await Promise.all([
    liq.userDirs(), liq.getDriveDetails(), liq.getPlaces(),
  ])
  const folderPaths: string[] = COMPUTER_DIR_KEYS.map(k => dirs[k]).filter(Boolean)
  const drivePaths: string[] = drives.map((d: { mountPoint: string }) => d.mountPoint)
  const netPaths: string[] = places
    .filter((p: Place) => p.kind === 'network-drive' && !drivePaths.includes(p.path))
    .map((p: Place) => p.path)
  const stats: (FileEntry | null)[] =
    await liq.statEntries([...folderPaths, ...drivePaths, ...netPaths])
  const out: FileEntry[] = []
  stats.forEach((maybe, i) => {
    if (!maybe) return
    let st = maybe
    if (i >= folderPaths.length) {
      // drive / network mount: Explorer-style "Label (mount point)" + drive icon
      const p0 = st.path
      const drive = drives.find((d: { mountPoint: string }) => d.mountPoint === p0)
      const net = places.find((p: Place) => p.kind === 'network-drive' && p.path === p0)
      const label = drive?.label ?? net?.label ?? st.name
      st = {
        ...st,
        name: st.path === '/' ? `${label} (/)` : `${label} (${st.path})`,
        icons: net || drive?.isNetwork ? ['folder-remote', 'network-server']
          : drive?.isRemovable ? ['drive-removable-media', 'drive-harddisk']
            : ['drive-harddisk'],
      }
    }
    out.push(st)
  })
  return out
}

export class App {
  events = new EventTarget()
  tabs: Tab[] = []
  activeTabIndex = 0
  settings: AppSettings = { ...DEFAULT_SETTINGS }
  places: Place[] = []
  clipboard: ClipboardFiles | null = null
  theme: 'light' | 'dark' = 'light'
  ops: OpProgress[] = []
  undoInfo: UndoInfo = { undoLabel: null, redoLabel: null }
  homePath = ''

  get activeTab(): Tab { return this.tabs[this.activeTabIndex] }

  emit(name: string, detail?: unknown): void {
    this.events.dispatchEvent(new CustomEvent(name, { detail }))
  }
  on(name: string, cb: (detail: any) => void): void {
    this.events.addEventListener(name, (e) => cb((e as CustomEvent).detail))
  }

  async init(): Promise<void> {
    this.settings = await liq.getSettings()
    this.theme = await liq.getTheme()
    document.documentElement.dataset.theme = this.theme
    this.homePath = await liq.homeDir()
    this.places = await liq.getPlaces()
    this.clipboard = await liq.clipboardGet()
    this.undoInfo = await liq.getUndoInfo()

    liq.on(PUSH.dirChunk, (c: DirChunk) => { for (const t of this.tabs) t.onChunk(c) })
    liq.on(PUSH.searchChunk, (c: SearchChunk) => { for (const t of this.tabs) t.onSearchChunk(c) })
    liq.on(PUSH.fsEvent, (ev: FsEvent) => {
      // route to the tab that owns the watch — never refresh unrelated tabs
      const t = this.tabs.find(t => t.watchId === ev.watchId)
      if (t && !t.loading && t.searchQuery === null) t.refresh()
    })
    liq.on(PUSH.placesChanged, (p: Place[]) => { this.places = p; this.emit('places-changed', p) })
    liq.on(PUSH.clipboardChanged, (c: ClipboardFiles | null) => { this.clipboard = c; this.emit('clipboard-changed', c) })
    liq.on(PUSH.themeChanged, (t: 'light' | 'dark') => {
      this.theme = t
      document.documentElement.dataset.theme = t
      this.emit('theme-changed', t)
    })
    liq.on(PUSH.opProgress, (p: OpProgress) => {
      const i = this.ops.findIndex(o => o.opId === p.opId)
      if (i >= 0) this.ops[i] = p; else this.ops.push(p)
      if (p.status === 'done' || p.status === 'cancelled') {
        setTimeout(() => {
          this.ops = this.ops.filter(o => o.opId !== p.opId)
          this.emit('ops-changed', this.ops)
        }, 1200)
      }
      this.emit('ops-changed', this.ops)
    })
    liq.on(PUSH.opConflict, (c: ConflictInfo) => this.emit('op-conflict', c))
    liq.on(PUSH.opPassword, (r: unknown) => this.emit('op-password', r))
    liq.on(PUSH.undoChanged, (u: UndoInfo) => { this.undoInfo = u; this.emit('undo-changed', u) })
    liq.on(PUSH.openPathRequest, (d: { path: string }) => this.newTab(d.path))

    // openTo: 'home' = the Home page, 'homeFolder' = ~, 'lastSession' (v1.1:
    // falls back to ~), or a literal path. A path on argv always wins.
    const q = new URLSearchParams(location.search)
    await this.newTab(q.get('open') || this.startLocation())
  }

  /** where a fresh tab (and the first window) lands, per settings.openTo */
  startLocation(): string {
    const to = this.settings.openTo
    if (to === 'home') return HOME_URI
    if (to === 'homeFolder' || to === 'lastSession') return this.homePath
    return to || HOME_URI
  }

  async newTab(path?: string, background = false): Promise<Tab> {
    const tab = new Tab(this)
    this.tabs.push(tab)
    if (!background) this.activeTabIndex = this.tabs.length - 1
    this.emit('tabs-changed')
    // a new tab opens wherever the app is configured to start (Home by default)
    await tab.navigate(path ?? this.startLocation())
    return tab
  }

  closeTab(index: number): void {
    const t = this.tabs[index]
    if (!t) return
    t.dispose()
    this.tabs.splice(index, 1)
    if (this.tabs.length === 0) { liq.windowControl('close'); return }
    if (this.activeTabIndex >= this.tabs.length) this.activeTabIndex = this.tabs.length - 1
    else if (index <= this.activeTabIndex && this.activeTabIndex > 0) this.activeTabIndex--
    this.emit('tabs-changed')
    this.emit('tab-navigated', this.activeTab)
  }

  activateTab(index: number): void {
    if (index < 0 || index >= this.tabs.length || index === this.activeTabIndex) return
    this.activeTabIndex = index
    this.emit('tabs-changed')
    this.emit('tab-navigated', this.activeTab)
    this.emit('tab-listing', this.activeTab)
  }

  async setSettings(patch: Partial<AppSettings>): Promise<void> {
    this.settings = await liq.setSettings(patch)
    this.emit('settings-changed', this.settings)
    if ('showHidden' in patch) this.activeTab?.refresh()
    if ('foldersFirst' in patch || 'compactView' in patch) {
      this.activeTab?.recompute()
      this.emit('tab-listing', this.activeTab)
    }
  }

  rememberSession(): void { /* session restore: v1.1 */ }
}

export const app = new App()
