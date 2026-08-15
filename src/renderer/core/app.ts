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
//   'panes-changed'       (Tab) the PRIMARY tab whose split/ratio/orientation changed
//   'pane-focus'          (Tab) the pane Tab that just took focus
//
// Dual pane (Krusader-style twin panels INSIDE one tab)
// ----------------------------------------------------
// A tab in `app.tabs` is always the LEFT/TOP pane. Splitting hangs a second Tab
// off it as `primary.secondary`; `primary.activePane` says which of the two has
// focus. `app.activeTab` resolves to the FOCUSED pane's Tab, so every component
// that already reads app.activeTab (breadcrumbs, search, command bar, status
// bar, context menus, nav-pane highlight, keyboard) follows the focused pane
// with no change at all. Only things that ITERATE tabs must use allTabs().

import type {
  AppSettings, ClipboardFiles, ConflictInfo, DirChunk, FileEntry, FolderViewState,
  FsEvent, OpProgress, Place, SearchChunk, SearchSource, UndoInfo,
} from '../../shared/types'
import { DEFAULT_VIEW_STATE, DEFAULT_SETTINGS, DEFAULT_SMART_RULES, FINDER_URI } from '../../shared/types'
import { PUSH } from '../../shared/ipc'
import { sortEntries, computeGroups, type Group } from '../../shared/sort'
import { archiveUri, isArchiveUri, parseArchiveUri } from '../../shared/archive'
import { classifyFolder } from '../../shared/foldertype'
import { pinnedOnly, sanitizeSession, type SessionState } from '../../shared/session'

declare global {
  interface Window {
    liq: any
  }
}
export const liq = window.liq

/** The Home page (Quick access / Favorites / Recent) — rendered by views/home.ts. */
export const HOME_URI = 'home://'

/** dual pane: 'h' = side by side (Krusader default), 'v' = stacked top/bottom */
export type SplitDir = 'h' | 'v'
/** fraction of the split box given to pane 0; the splitter clamps to these */
export const SPLIT_MIN = 0.15
export const SPLIT_MAX = 0.85
export const DEFAULT_SPLIT_RATIO = 0.5

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
  /** how the last search was answered — drives the results banner */
  searchInfo: { source?: SearchSource; truncated?: boolean; indexAgeHours?: number } | null = null
  private listReqId = 0
  /** main-side watch id; read by App's fsEvent router */
  watchId = 0
  private searchReqId = 0
  /** bumped whenever this tab starts a new listing/search; stale awaits check it */
  private listGen = 0

  // ---- dual pane (meaningful on a PRIMARY tab only) ----
  /** the second pane living inside this tab; null = single pane */
  secondary: Tab | null = null
  /** which pane owns focus: 0 = this tab, 1 = this.secondary */
  activePane: 0 | 1 = 0
  /** pinned tabs come back on every launch and cannot be closed by accident */
  pinned = false
  /** fraction of the split box given to pane 0 */
  splitRatio = DEFAULT_SPLIT_RATIO
  splitDir: SplitDir = 'h'

  /** `isSecondary` marks a Tab that IS the second pane of another tab: it never
   *  appears in app.tabs and owns no split state of its own. */
  constructor(private app: App, readonly isSecondary = false) {}

  get isVirtual(): boolean { return this.path.includes('://') }
  /** true when this (primary) tab is currently showing two panes */
  get isSplit(): boolean { return this.secondary !== null }

  /** smart view already ran (or was overruled) for the current folder */
  private smartDone = false
  /** this folder had a remembered per-folder view — the user's choice, not ours */
  private savedView = false

  async navigate(path: string, pushHistory = true): Promise<void> {
    // leaving an active search: cancel it and drop its reqId so late chunks are ignored
    if (this.searchReqId) { liq.cancelSearch(this.searchReqId); this.searchReqId = 0 }
    if (pushHistory) {
      this.history = this.history.slice(0, this.historyIndex + 1)
      this.history.push(path)
      this.historyIndex = this.history.length - 1
    }
    this.path = path
    const arc = parseArchiveUri(path)
    this.title = arc
      ? (arc.inner ? arc.inner.split('/').pop()! : arc.archive.split('/').pop()!)
      : path === HOME_URI ? 'Home'
        : path === 'trash://' ? 'Recycle Bin'
          : path === 'computer://' ? 'This PC'
            : path === 'starred://' ? 'Starred'
            : path === FINDER_URI ? 'Server Index'
          // the profile folder is titled with the user name (as the nav pane
          // does) — "Home" + the house icon belongs to the home:// page alone
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
  canUp(): boolean {
    // inside an archive, Up walks the inner path and finally leaves the archive
    if (isArchiveUri(this.path)) return true
    return !this.isVirtual && this.path !== '/'
  }

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
    const arc = parseArchiveUri(this.path)
    if (arc) {
      // one level up inside the archive, or out to the folder holding it
      const inner = arc.inner.split('/').slice(0, -1).join('/')
      this.navigate(arc.inner
        ? archiveUri(arc.archive, inner)
        : arc.archive.slice(0, arc.archive.lastIndexOf('/')) || '/')
      return
    }
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
    if (this.path === FINDER_URI) {
      // The server index has no contents to enumerate — it is a search surface,
      // not a folder. Landing here shows an empty prompt; typing in the search
      // box drives it, and the results then get the folder-path column and the
      // "Search Results in" crumb the search path already provides for free.
      this.entries = []
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
    if (isArchiveUri(this.path)) {
      // browsing inside an archive: the listing is synthesized by the main
      // process from 7z's table of contents — nothing is extracted to look
      const parsed = parseArchiveUri(this.path)
      try {
        const items: FileEntry[] = await liq.invoke('archiveList', this.path)
        if (gen !== this.listGen) return 0
        this.entries = items
      } catch (err) {
        if (gen !== this.listGen) return 0
        this.error = err instanceof Error ? err.message
          : `"${(parsed?.archive ?? this.path).split('/').pop()}" could not be read.`
      }
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
    if (c.done) this.applySmartView()
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
    if (c.done) {
      this.loading = false
      // only the final chunk carries these
      this.searchInfo = {
        source: c.source, truncated: c.truncated, indexAgeHours: c.indexAgeHours,
      }
    }
    this.recompute()
    this.app.emit('tab-listing', this)
    if (c.done) this.app.emit('tab-loading', this)
  }

  async startSearch(query: string, opts?: { live?: boolean }): Promise<void> {
    this.searchQuery = query
    this.searchInfo = null
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
      showHidden: this.app.settings.showHidden, live: opts?.live,
    })
    // the tab may have navigated away / ended the search during the round trip
    if (this.searchQuery !== query) { liq.cancelSearch(reqId); return }
    this.searchReqId = reqId
  }

  endSearch(): void {
    if (this.searchQuery === null) return
    this.searchQuery = null
    this.searchInfo = null
    if (this.searchReqId) { liq.cancelSearch(this.searchReqId); this.searchReqId = 0 }
    this.refresh()
    this.app.emit('tab-navigated', this)
  }

  /** derive rows/groups from entries + viewState */
  recompute(): void {
    const vs = this.viewState
    // computer:// is already in section order (Folders, then drives, then
    // network) and its groups are built from that order, so a re-sort would
    // interleave the sections and leave every group one row long
    if (this.path === 'computer://') {
      this.rows = this.entries
      this.groups = computeGroups(this.entries, vs)
      this.pruneSelection()
      return
    }
    let rows = sortEntries(this.entries, vs, this.app.settings.foldersFirst)
    if (vs.groupKey !== 'none') {
      // re-sort by group key; V8 sort is stable, so per-group order (sortKey) survives
      rows = sortEntries(rows, { ...vs, sortKey: vs.groupKey, sortDir: vs.groupDir }, false)
    }
    this.rows = rows
    this.groups = computeGroups(rows, vs)
    this.pruneSelection()
  }

  /** Drop selected paths that are no longer listed — but never mid-listing,
   *  when rows are empty or partial and pruning would wipe a live selection
   *  (e.g. a background fs event triggering a refresh). */
  private pruneSelection(): void {
    if (!this.selection.size || this.loading) return
    const have = new Set(this.rows.map(r => r.path))
    for (const p of [...this.selection]) if (!have.has(p)) this.selection.delete(p)
  }

  async loadViewState(): Promise<void> {
    this.smartDone = false
    if (!this.app.settings.rememberPerFolder) {
      this.viewState = { ...this.app.settings.defaultView }
      this.savedView = false
      return
    }
    const st = await liq.getViewState(this.path)
    this.savedView = !!st
    this.viewState = st ?? structuredClone(this.app.settings.defaultView)
    this.app.emit('tab-viewstate', this)
  }

  /**
   * Smart view: pick the view mode from what the folder actually holds, the way
   * Explorer's folder templates do — but from content rather than from a name
   * or a registry flag. Runs once per navigation, after the listing completes,
   * and never overrules a choice the user has made for this folder: a saved
   * per-folder view wins, and changing the mode by hand marks the folder done
   * so a background refresh cannot snap it back.
   */
  private applySmartView(): void {
    if (this.smartDone || this.savedView) return
    this.smartDone = true
    const s = this.app.settings
    if (!s.smartView || this.isVirtual || this.searchQuery !== null) return
    const verdict = classifyFolder(this.entries, s.smartViewThreshold ?? 0.6)
    // too few files to read anything into: a folder holding three items is not
    // evidence of what it is for, and switching its view would just be noise
    if (verdict.counted < 4) return
    const rule = (s.smartViewRules ?? DEFAULT_SMART_RULES)[verdict.kind]
      ?? DEFAULT_SMART_RULES[verdict.kind]
    if (!rule) return
    if (rule.mode !== this.viewState.mode) {
      // straight to the field: setViewState would persist this as if the user
      // had chosen it, and then smart view could never revise its own guess
      this.viewState = { ...this.viewState, mode: rule.mode }
      this.recompute()
      this.app.emit('tab-viewstate', this)
      this.app.emit('tab-listing', this)
    }
    // Only OPEN it, never close: the rules say which folders deserve a preview
    // pane, not which ones deserve it taken away. Turning this off is a
    // per-kind checkbox in Options, which is the honest place for it.
    if (rule.preview && !s.showPreviewPane) this.app.emit('set-preview-pane', true)
  }

  setViewState(patch: Partial<FolderViewState>): void {
    // a deliberate choice: stop smart view from second-guessing it
    if (patch.mode !== undefined) this.smartDone = true
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

  /** Take over another pane's location and history. Used when the split is
   *  closed while the SECOND pane has focus: the surviving tab object is always
   *  the primary, so it has to inherit what the user was actually looking at. */
  async adoptLocation(from: Tab): Promise<void> {
    this.history = [...from.history]
    this.historyIndex = from.historyIndex
    this.collapsedGroups = new Set(from.collapsedGroups)
    const keep = [...from.selection]
    const focus = from.focusPath
    await this.navigate(from.path, false)
    // rows stream in after navigate() resolves for real directories; prune to
    // what actually exists once (recompute() drops the rest as chunks land)
    if (keep.length) { this.anchorPath = focus; this.setSelection(keep, focus) }
  }

  dispose(): void {
    // Bumping the generation first is what stops the leaks that only exist
    // WHILE an await is in flight: startListing's continuations see a stale gen
    // and cancel the listing / release the watch they were about to install on
    // a tab that no longer exists (main only has MAX_WATCHES of them).
    this.listGen++
    // a search is never cancelled by anything else: without this its flush
    // timer, tree walker and any spawned `rg` child outlive the tab
    if (this.searchReqId) { liq.cancelSearch(this.searchReqId); this.searchReqId = 0 }
    this.searchQuery = null
    if (this.watchId) { liq.unwatchDir(this.watchId); this.watchId = 0 }
    if (this.listReqId) { liq.cancelList(this.listReqId); this.listReqId = 0 }
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
    if (i < folderPaths.length) {
      st = { ...st, section: 'Folders' }
    } else {
      // drive / network mount: Explorer-style "Label (mount point)" + drive icon
      const p0 = st.path
      const drive = drives.find((d: { mountPoint: string }) => d.mountPoint === p0)
      const net = places.find((p: Place) => p.kind === 'network-drive' && p.path === p0)
      const label = drive?.label ?? net?.label ?? st.name
      const isNet = !!net || !!drive?.isNetwork
      st = {
        ...st,
        name: st.path === '/' ? `${label} (/)` : `${label} (${st.path})`,
        icons: isNet ? ['folder-remote', 'network-server']
          : drive?.isRemovable ? ['drive-removable-media', 'drive-harddisk']
            : ['drive-harddisk'],
        // a mount point IS a directory, so the mime-derived label is "File
        // folder" — true, and useless next to a drive icon under a heading
        // that already says these are drives
        typeLabel: isNet ? 'Network drive' : drive?.isRemovable ? 'Removable drive' : 'Local disk',
        section: isNet ? 'Network locations' : 'Devices and drives',
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
  /** seed geometry for the NEXT split; views/panes.ts keeps these in
   *  localStorage so the splitter lands where the user last left it */
  defaultSplitRatio = DEFAULT_SPLIT_RATIO
  defaultSplitDir: SplitDir = 'h'

  /** The FOCUSED pane of the active tab — what every component means by "the
   *  current folder". Single-pane tabs resolve to themselves. */
  get activeTab(): Tab {
    const t = this.tabs[this.activeTabIndex]
    if (!t) return t
    return t.activePane === 1 && t.secondary ? t.secondary : t
  }

  /** The active tab strip entry, i.e. pane 0 (never the secondary). */
  get activePrimary(): Tab | null { return this.tabs[this.activeTabIndex] ?? null }

  /** Is the active tab showing two panes? */
  get isSplit(): boolean { return !!this.activePrimary?.secondary }

  /** Every live Tab, both panes of every tab — for chunk/watch routing. */
  allTabs(): Tab[] {
    const out: Tab[] = []
    for (const t of this.tabs) { out.push(t); if (t.secondary) out.push(t.secondary) }
    return out
  }

  /** The pane of the active tab that does NOT have focus (null when unsplit). */
  otherPane(): Tab | null {
    const p = this.activePrimary
    if (!p || !p.secondary) return null
    return p.activePane === 1 ? p : p.secondary
  }

  /** Re-emit the tab-scoped events so chrome that filters on `app.activeTab`
   *  (breadcrumbs, search box, command bar, status bar, nav pane, preview)
   *  re-reads the newly focused pane. */
  syncActiveTabChrome(): void {
    const t = this.activeTab
    if (!t) return
    this.emit('tab-navigated', t)
    this.emit('tab-viewstate', t)
    this.emit('tab-listing', t)
    this.emit('tab-selection', t)
    this.emit('tab-loading', t)
  }

  /** Move focus between panes. Ignored when the tab is not split. */
  focusPane(i: 0 | 1): void {
    const p = this.activePrimary
    if (!p) return
    const want: 0 | 1 = i === 1 && p.secondary ? 1 : 0
    if (p.activePane === want) return
    p.activePane = want
    this.emit('pane-focus', this.activeTab)
    this.syncActiveTabChrome()
  }

  toggleFocusedPane(): void {
    const p = this.activePrimary
    if (!p || !p.secondary) return
    this.focusPane(p.activePane === 0 ? 1 : 0)
  }

  /**
   * Open / close the second pane of the active tab.
   * Opening: the new pane lands on Home (the user's spec) and takes focus.
   * Closing: the INACTIVE pane goes and the focused one survives — when that is
   * the second pane, the primary tab adopts its location so nothing moves.
   */
  setSplit(on: boolean, primary = this.activePrimary): void {
    if (!primary || primary.isSecondary) return
    if (on === !!primary.secondary) return
    if (on) {
      const sec = new Tab(this, true)
      primary.splitRatio = this.defaultSplitRatio
      primary.splitDir = this.defaultSplitDir
      primary.secondary = sec
      primary.activePane = 1
      this.emit('panes-changed', primary)
      // navigate BEFORE announcing focus: the pane swaps its file view for the
      // Home page as soon as the path is set, and 'pane-focus' is what moves
      // DOM focus into whichever of the two ends up visible
      void sec.navigate(HOME_URI)
      this.emit('pane-focus', sec)
      this.syncActiveTabChrome()
    } else {
      const sec = primary.secondary!
      const keepSecondary = primary.activePane === 1
      primary.secondary = null
      primary.activePane = 0
      sec.dispose()
      this.emit('panes-changed', primary)
      if (keepSecondary) {
        // same reason: only announce focus once the surviving pane is showing
        // the location it just inherited
        void primary.adoptLocation(sec).then(() => this.emit('pane-focus', primary))
      } else {
        this.emit('pane-focus', primary)
      }
      this.syncActiveTabChrome()
    }
  }

  toggleSplit(): void { this.setSplit(!this.activePrimary?.secondary) }

  /** Send a folder to the pane that does not have focus, splitting if needed.
   *  Focus deliberately stays where it is (Krusader/TC "open in other panel"). */
  async openInOtherPane(path: string): Promise<void> {
    const p = this.activePrimary
    if (!p) return
    if (!p.secondary) {
      const sec = new Tab(this, true)
      p.splitRatio = this.defaultSplitRatio
      p.splitDir = this.defaultSplitDir
      p.secondary = sec
      p.activePane = 0                     // the source pane keeps focus
      this.emit('panes-changed', p)
      await sec.navigate(path)
      this.syncActiveTabChrome()
      return
    }
    const other = this.otherPane()
    if (other) await other.navigate(path)
  }

  /** Exchange what the two panes are showing (Krusader Ctrl+U). */
  async swapPanes(): Promise<void> {
    const p = this.activePrimary
    const sec = p?.secondary
    if (!p || !sec) return
    const a = { path: p.path, history: [...p.history], idx: p.historyIndex }
    const b = { path: sec.path, history: [...sec.history], idx: sec.historyIndex }
    p.history = b.history; p.historyIndex = b.idx
    sec.history = a.history; sec.historyIndex = a.idx
    await Promise.all([p.navigate(b.path, false), sec.navigate(a.path, false)])
    this.syncActiveTabChrome()
  }

  setSplitRatio(r: number): void {
    const p = this.activePrimary
    if (!p) return
    p.splitRatio = Math.min(SPLIT_MAX, Math.max(SPLIT_MIN, r))
    this.defaultSplitRatio = p.splitRatio
    this.emit('panes-changed', p)
  }

  setSplitDir(dir: SplitDir): void {
    this.defaultSplitDir = dir
    const p = this.activePrimary
    if (!p || p.splitDir === dir) return
    p.splitDir = dir
    this.emit('panes-changed', p)
  }

  emit(name: string, detail?: unknown): void {
    this.events.dispatchEvent(new CustomEvent(name, { detail }))
  }
  /** Returns an unsubscribe. Callers that live as long as the app can ignore
   *  it; anything created per-open (the media viewer's triage deck) must not,
   *  or every open leaves a listener behind. */
  on(name: string, cb: (detail: any) => void): () => void {
    const wrapped = (e: Event): void => cb((e as CustomEvent).detail)
    this.events.addEventListener(name, wrapped)
    return () => this.events.removeEventListener(name, wrapped)
  }

  async init(): Promise<void> {
    this.settings = await liq.getSettings()
    this.theme = await liq.getTheme()
    document.documentElement.dataset.theme = this.theme
    this.homePath = await liq.homeDir()
    this.places = await liq.getPlaces()
    this.clipboard = await liq.clipboardGet()
    this.undoInfo = await liq.getUndoInfo()

    // every router below walks allTabs(): a split tab has TWO panes listing,
    // searching and watching independently
    liq.on(PUSH.dirChunk, (c: DirChunk) => { for (const t of this.allTabs()) t.onChunk(c) })
    liq.on(PUSH.searchChunk, (c: SearchChunk) => { for (const t of this.allTabs()) t.onSearchChunk(c) })
    liq.on(PUSH.fsEvent, (ev: FsEvent) => {
      // route to the tab that owns the watch — never refresh unrelated tabs
      const t = this.allTabs().find(t => t.watchId === ev.watchId)
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

    // A path on argv always wins: the user asked for that folder, now.
    const q = new URLSearchParams(location.search)
    const argvPath = q.get('open')
    if (argvPath) {
      await this.newTab(argvPath)
      // "Show in folder" from another application: the folder is only half the
      // request — the point is WHICH file, so select it once the listing has
      // arrived, and open its properties when that is what was asked for.
      const select = q.get('select')
      if (select) await this.revealOnStartup(select, q.get('properties') === '1')
      return
    }
    if (await this.restoreSession()) return
    await this.newTab(this.startLocation())
  }

  /**
   * Select an item once the folder it lives in has finished listing.
   *
   * newTab() resolves when the navigation is under way, not when the rows have
   * arrived — on the CIFS share those are seconds apart — so selecting straight
   * away would set a selection against an empty list and lose it. This waits
   * for the row to actually exist, with a deadline so a folder that never
   * lists (dead mount) leaves the app usable rather than hanging on startup.
   */
  private async revealOnStartup(target: string, alsoProperties: boolean): Promise<void> {
    const DEADLINE_MS = 15_000
    const started = Date.now()
    const tab = this.activeTab
    while (Date.now() - started < DEADLINE_MS) {
      if (!tab.loading && tab.rows.some(r => r.path === target)) {
        tab.setSelection([target], target)
        this.emit('reveal-item', target)
        if (alsoProperties) this.emit('show-properties', [target])
        return
      }
      await new Promise(r => setTimeout(r, 120))
    }
  }

  /**
   * Reopen the previous session. Pinned tabs come back on EVERY launch (that is
   * what pinning a tab means, in every browser); the rest only when the user
   * asked to open to the last session.
   *
   * Returns false when there was nothing to restore, so the caller falls back
   * to the ordinary start location.
   */
  private async restoreSession(): Promise<boolean> {
    let saved: SessionState
    try { saved = sanitizeSession(await liq.invoke('readSession')) } catch { return false }
    const wanted = this.settings.openTo === 'lastSession' ? saved : pinnedOnly(saved)
    if (!wanted.tabs.length) return false

    // Tabs are created in order and navigated in parallel: a session with a
    // folder on a dead network mount would otherwise hold up every tab behind
    // it, and the window would sit empty until that one timed out.
    const made = wanted.tabs.map(st => {
      const tab = new Tab(this)
      tab.pinned = !!st.pinned
      this.tabs.push(tab)
      return { tab, st }
    })
    this.activeTabIndex = Math.min(wanted.active, this.tabs.length - 1)
    this.emit('tabs-changed')
    await Promise.all(made.map(async ({ tab, st }) => {
      await tab.navigate(st.path)
      if (!st.secondary) return
      const second = new Tab(this, true)
      tab.secondary = second
      tab.splitDir = st.splitDir ?? this.defaultSplitDir
      tab.splitRatio = st.splitRatio ?? this.defaultSplitRatio
      tab.activePane = st.activePane === 1 ? 1 : 0
      await second.navigate(st.secondary)
    }))
    this.emit('tabs-changed')
    this.emit('panes-changed', this.activePrimary)
    this.emit('tab-navigated', this.activeTab)
    return true
  }

  /** where a fresh tab (and the first window) lands, per settings.openTo */
  startLocation(): string {
    const to = this.settings.openTo
    if (to === 'home') return HOME_URI
    // 'lastSession' is handled at boot by restoreSession(); reaching here means
    // there was no session to restore, or this is a brand-new tab
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

  closeTab(index: number, force = false): void {
    const t = this.tabs[index]
    if (!t) return
    // Pinning exists to stop exactly this. Unpin first (the tab's own ✕ and its
    // context menu pass force, so there is always a deliberate way out).
    if (t.pinned && !force) return
    t.secondary?.dispose()               // the split pane dies with its tab
    t.secondary = null
    t.dispose()
    this.tabs.splice(index, 1)
    if (this.tabs.length === 0) { liq.windowControl('close'); return }
    if (this.activeTabIndex >= this.tabs.length) this.activeTabIndex = this.tabs.length - 1
    else if (index <= this.activeTabIndex && this.activeTabIndex > 0) this.activeTabIndex--
    this.emit('tabs-changed')
    this.emit('tab-navigated', this.activeTab)
    this.rememberSession()
  }

  activateTab(index: number): void {
    if (index < 0 || index >= this.tabs.length || index === this.activeTabIndex) return
    this.activeTabIndex = index
    this.emit('tabs-changed')
    this.emit('tab-navigated', this.activeTab)
    this.emit('tab-listing', this.activeTab)
    // which tab was in front is part of the session: without this, reopening
    // always lands on whichever tab happened to navigate last
    this.rememberSession()
  }

  async setSettings(patch: Partial<AppSettings>): Promise<void> {
    this.settings = await liq.setSettings(patch)
    this.emit('settings-changed', this.settings)
    // both panes of the active tab are on screen: neither may be left stale
    const shown = [this.activePrimary, this.activePrimary?.secondary].filter(Boolean) as Tab[]
    if ('showHidden' in patch) for (const t of shown) t.refresh()
    if ('foldersFirst' in patch || 'compactView' in patch) {
      for (const t of shown) { t.recompute(); this.emit('tab-listing', t) }
    }
  }

  /**
   * Snapshot the open folders. Called on every navigation, so the write itself
   * is debounced in main — this end only has to be cheap and never throw.
   */
  rememberSession(): void {
    if (!this.tabs.length) return
    const state: SessionState = {
      tabs: this.tabs.map(t => ({
        path: t.path,
        pinned: t.pinned || undefined,
        secondary: t.secondary?.path,
        splitDir: t.secondary ? t.splitDir : undefined,
        splitRatio: t.secondary ? t.splitRatio : undefined,
        activePane: t.secondary ? t.activePane : undefined,
      })),
      active: this.activeTabIndex,
    }
    try { void liq.invoke('saveSession', state) } catch { /* never block a navigation */ }
  }

  /** Pin/unpin a tab. Pinned tabs sort to the front, as in every browser. */
  setTabPinned(index: number, pinned: boolean): void {
    const t = this.tabs[index]
    if (!t || t.pinned === pinned) return
    t.pinned = pinned
    this.tabs.splice(index, 1)
    const firstUnpinned = this.tabs.findIndex(x => !x.pinned)
    const at = pinned
      ? (firstUnpinned < 0 ? this.tabs.length : firstUnpinned)
      : this.tabs.length
    this.tabs.splice(at, 0, t)
    this.activeTabIndex = this.tabs.indexOf(t)
    this.emit('tabs-changed')
    this.rememberSession()
  }
}

export const app = new App()
