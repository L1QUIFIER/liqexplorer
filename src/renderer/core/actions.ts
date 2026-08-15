// Centralized commands. Command bar, context menus, and keyboard shortcuts all
// call these — one implementation per verb, Explorer semantics.
import { app, liq, Tab } from './app'
import { isArchiveName, isArchiveUri, archiveUri, parseArchiveUri } from '../../shared/archive'
import { confirmTransfer } from './confirmmove'
import { openInMediaViewer } from '../media/overlay'
import { viewKindFor } from '../media/render'
import { archiveMemberPath } from '../views/items'
import type { FileEntry } from '../../shared/types'

/** extract one member to the on-disk cache and open it with its default app */
async function openArchiveMember(uri: string): Promise<void> {
  const p = parseArchiveUri(uri)
  if (!p) return
  const map = await liq.invoke('archiveMembers', {
    archive: p.archive, members: [p.inner],
  }) as Record<string, string>
  const local = map[p.inner]
  if (local) await liq.openPath(local)
}

/** how many siblings to pull out of an archive so ←/→ has somewhere to go.
 *  Bounded because "open this picture" must not become "unpack 4 GB". */
const ARCHIVE_PLAYLIST_MAX = 60

/**
 * Show a file that lives inside an archive in the floating viewer.
 *
 * liqfile:// serves real paths, so a member has to reach the extraction cache
 * before anything can display it. The clicked file is extracted first and on
 * its own, so the viewer opens straight away; its viewable siblings follow in
 * one batched 7z run, which is what makes ←/→ through a zip full of photos
 * feel like a gallery rather than a series of stalls.
 *
 * Returns false when the viewer declined it (wrong kind, or switched off), so
 * the caller can fall back to extracting and handing it to the default app.
 */
async function viewArchiveMember(entry: FileEntry, rows: FileEntry[]): Promise<boolean> {
  // viewKindFor, not isViewable: isViewable also insists the path is a real
  // one, which an archive member is not YET — that is what extracting fixes
  const kindOf = (e: FileEntry): string => viewKindFor({
    path: e.path, name: e.name, ext: e.ext, mime: e.mime, size: e.size, isDir: e.isDir,
  })
  if (entry.isDir || kindOf(entry) === 'other') return false

  const localFor = async (e: FileEntry): Promise<FileEntry | null> => {
    const local = await archiveMemberPath(e.path)
    // keep the member's own name and metadata: only where the bytes live changes
    return local ? { ...e, path: local } : null
  }

  const clicked = await localFor(entry)
  if (!clicked) return false
  if (!openInMediaViewer(clicked, [clicked])) return false

  // siblings afterwards: the panel is already up, so this only widens ←/→
  const siblings = rows
    .filter(e => !e.isDir && e.path !== entry.path && kindOf(e) !== 'other')
    .slice(0, ARCHIVE_PLAYLIST_MAX)
  const locals = (await Promise.all(siblings.map(localFor))).filter(Boolean) as FileEntry[]
  if (!locals.length) return true

  // rebuild the playlist in the original row order, with the clicked file still
  // the one on screen; openInMediaViewer re-uses the open panel in place
  const byOriginal = new Map(locals.map((l, i) => [siblings[i].path, l]))
  const playlist = rows.map(e => (e.path === entry.path ? clicked : byOriginal.get(e.path)))
    .filter(Boolean) as FileEntry[]
  openInMediaViewer(clicked, playlist, { force: true })
  return true
}

/** This PC rows are real mount points and user folders, and archive:// rows live
 * inside a zip — cut/rename/delete there would act on a whole drive or on a path
 * the file engine cannot touch, so those verbs are inert (Explorer greys them
 * for drives). trash:// is excluded: its own permanent delete is legitimate. */
function noFileOps(tab: Tab): boolean { return tab.isVirtual && tab.path !== 'trash://' }

export const actions = {
  // --- clipboard ---
  async cut(tab = app.activeTab): Promise<void> {
    if (tab.isVirtual) return           // incl. trash://: cutting a trashed item is not a move
    const paths = [...tab.selection]
    if (paths.length) await liq.clipboardSet({ op: 'cut', paths })
  },
  async copy(tab = app.activeTab): Promise<void> {
    // matches the greyed command-bar button: a This PC row is a mount point, so
    // pasting it elsewhere would copy an entire filesystem
    if (tab.path === 'computer://') return
    const paths = [...tab.selection]
    if (paths.length) await liq.clipboardSet({ op: 'copy', paths })
  },
  async paste(tab = app.activeTab): Promise<void> {
    const clip = await liq.clipboardGet()
    if (!clip || !clip.paths.length || tab.isVirtual) return
    const moving = clip.op === 'cut'
    const run = async (): Promise<void> => {
      await liq.startOp({ kind: moving ? 'move' : 'copy', sources: clip.paths, dest: tab.path })
      if (moving) await liq.clipboardClear()
    }
    confirmTransfer({
      kind: moving ? 'move' : 'copy',
      sources: clip.paths,
      dest: tab.path,
      always: moving && app.settings.confirmMove,
      run: () => { void run() },
    })
  },
  async copyPath(tab = app.activeTab): Promise<void> {
    const sel = tab.selectedEntries()
    const text = (sel.length ? sel.map(e => `"${e.path}"`) : [`"${tab.path}"`]).join('\n')
    await liq.copyTextToClipboard(text)
  },

  // --- file ops ---
  async delete(tab = app.activeTab, permanent = false): Promise<void> {
    if (noFileOps(tab)) return
    const sel = tab.selectedEntries()
    if (!sel.length) return
    const paths = sel.map(e => e.path)
    const what = sel.length === 1 ? `'${sel[0].name}'` : `these ${sel.length} items`
    if (permanent || tab.path === 'trash://') {
      // Win11 always confirms a permanent delete (Shift+Delete / delete in trash)
      app.emit('show-confirm', {
        title: sel.length === 1
          ? (sel[0].isDir ? 'Delete Folder' : 'Delete File')
          : 'Delete Multiple Items',
        message: `Are you sure you want to permanently delete ${what}?`,
        okLabel: 'Yes',
        danger: true,
        onOk: () => { void liq.startOp({ kind: 'delete', sources: paths }) },
      })
      return
    }
    const doTrash = (): void => { void liq.startOp({ kind: 'trash', sources: paths }) }
    if (app.settings.confirmTrash) {
      app.emit('show-confirm', {
        title: 'Delete',
        message: `Are you sure you want to move ${what} to the Recycle Bin?`,
        okLabel: 'Yes',
        onOk: doTrash,
      })
    } else {
      doTrash()
    }
  },
  async newFolder(tab = app.activeTab): Promise<string | null> {
    // home:// / trash:// / computer:// are not directories: main would join the
    // scheme onto a name and mkdir it relative to its own cwd (the command bar
    // greys the New button for these; Ctrl+Shift+N used to slip past)
    if (tab.isVirtual) return null
    const r = await liq.newFolder(tab.path)
    if (r.ok && r.path) { await tab.refresh(); return r.path }
    return null
  },
  async newFile(tab = app.activeTab, template?: string): Promise<string | null> {
    if (tab.isVirtual) return null
    const r = await liq.newFile(tab.path, template)
    if (r.ok && r.path) { await tab.refresh(); return r.path }
    return null
  },
  async undo(): Promise<void> { await liq.undo(); app.activeTab?.refresh() },
  async redo(): Promise<void> { await liq.redo(); app.activeTab?.refresh() },
  async compress(tab = app.activeTab): Promise<void> {
    // needs a real destination directory. On computer:// the rows are drive
    // mount points, so this would enumerate a whole filesystem (uncancellable,
    // and the op queue runs one job at a time) and then write to the relative
    // path 'computer:/x.zip'; on archive:// the sources are not real files.
    if (tab.isVirtual) return
    const paths = [...tab.selection]
    if (paths.length) await liq.startOp({ kind: 'compress', sources: paths, dest: tab.path, format: 'zip' })
  },
  /**
   * Explorer has three extract verbs:
   *   'here'  — single-root policy: one top-level entry extracts in place,
   *             several get wrapped in <archive-name>/ (no more tar bombs)
   *   'named' — always create <archive-name>/
   *   'to'    — caller supplies the destination ("Extract All...")
   * The destination policy itself lives in the main-process archive backend;
   * the renderer only says which verb the user picked.
   */
  async extract(tab = app.activeTab, mode: 'auto' | 'named' | 'to' = 'auto', dest?: string): Promise<void> {
    if (tab.isVirtual) return           // no real folder to unpack into
    const sel = tab.selectedEntries().filter(e => isArchiveName(e.name))
    if (!sel.length) return
    // the backend groups multi-part sets and applies the destination policy
    if (mode === 'to') {
      await liq.invoke('extractArchives', { archives: sel.map(e => e.path), mode, dest: dest ?? tab.path })
      return
    }
    // 'auto'/'named' unpack BESIDE each archive, which is not tab.path: a search
    // tab keeps the searched root as its path while listing hits from anywhere
    // underneath it, so sending tab.path dumps ~/Downloads/pkg/foo.zip into ~.
    // One op per source folder also keeps a mixed selection in the right places.
    const byDir = new Map<string, string[]>()
    for (const e of sel) {
      const d = e.path.slice(0, e.path.lastIndexOf('/')) || '/'
      const g = byDir.get(d)
      if (g) g.push(e.path); else byDir.set(d, [e.path])
    }
    for (const [d, archives] of byDir) {
      await liq.invoke('extractArchives', { archives, mode, dest: d })
    }
  },

  // --- open ---
  async open(tab = app.activeTab): Promise<void> {
    const sel = tab.selectedEntries()
    if (!sel.length) return
    const dirs = sel.filter(e => e.isDir)
    if (dirs.length === 1 && sel.length === 1) { tab.navigate(dirs[0].path); return }
    for (const d of dirs) app.newTab(d.path, true)
    for (const f of sel.filter(e => !e.isDir)) {
      // Explorer opens a zip as a folder; we do it for every readable format
      if (isArchiveName(f.name) && !isArchiveUri(f.path)) { tab.navigate(archiveUri(f.path)); continue }
      // a file INSIDE an archive: pictures and clips go straight to the
      // floating viewer (browsing a zip of photos should not mean extracting it
      // first); anything else is extracted to the member cache and handed to
      // the desktop's default app
      if (isArchiveUri(f.path)) {
        if (await viewArchiveMember(f, tab.rows)) continue
        await openArchiveMember(f.path)
        continue
      }
      // pictures/video/audio/PDF/text open in the floating viewer (Options >
      // View); it declines folders, archives and anything switched off there,
      // and those fall through to the default app exactly as before
      if (openInMediaViewer(f, tab.rows)) continue
      await liq.openPath(f.path)
    }
  },
  async openTerminal(tab = app.activeTab): Promise<void> {
    if (!tab.isVirtual) await liq.openTerminalAt(tab.path)
  },
  async properties(tab = app.activeTab): Promise<void> {
    const paths = tab.selection.size ? [...tab.selection] : [tab.path]
    app.emit('show-properties', paths)
  },

  // --- selection (delegates to Tab) ---
  selectAll(tab = app.activeTab): void { tab.selectAll() },
  selectNone(tab = app.activeTab): void { tab.selectNone() },
  invertSelection(tab = app.activeTab): void { tab.invertSelection() },

  // --- rename: view listens and starts inline editor on the focused/selected item ---
  rename(tab = app.activeTab): void {
    if (tab.isVirtual) return           // incl. trash://: renaming in the bin does nothing
    const sel = tab.selectedEntries()
    if (sel.length) app.emit('start-rename', sel[0].path)
  },

  refresh(tab = app.activeTab): void { tab.refresh() },
}
