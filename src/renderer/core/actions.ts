// Centralized commands. Command bar, context menus, and keyboard shortcuts all
// call these — one implementation per verb, Explorer semantics.
import { app, liq, Tab } from './app'

/** This PC rows are real mount points — cut/rename/delete there would act on a
 * whole drive, so those verbs are inert (Explorer greys them for drives). */
function noFileOps(tab: Tab): boolean { return tab.path === 'computer://' }

export const actions = {
  // --- clipboard ---
  async cut(tab = app.activeTab): Promise<void> {
    if (noFileOps(tab)) return
    const paths = [...tab.selection]
    if (paths.length) await liq.clipboardSet({ op: 'cut', paths })
  },
  async copy(tab = app.activeTab): Promise<void> {
    const paths = [...tab.selection]
    if (paths.length) await liq.clipboardSet({ op: 'copy', paths })
  },
  async paste(tab = app.activeTab): Promise<void> {
    const clip = await liq.clipboardGet()
    if (!clip || !clip.paths.length || tab.isVirtual) return
    await liq.startOp({ kind: clip.op === 'cut' ? 'move' : 'copy', sources: clip.paths, dest: tab.path })
    if (clip.op === 'cut') await liq.clipboardClear()
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
    const r = await liq.newFolder(tab.path)
    if (r.ok && r.path) { await tab.refresh(); return r.path }
    return null
  },
  async newFile(tab = app.activeTab, template?: string): Promise<string | null> {
    const r = await liq.newFile(tab.path, template)
    if (r.ok && r.path) { await tab.refresh(); return r.path }
    return null
  },
  async undo(): Promise<void> { await liq.undo(); app.activeTab?.refresh() },
  async redo(): Promise<void> { await liq.redo(); app.activeTab?.refresh() },
  async compress(tab = app.activeTab): Promise<void> {
    const paths = [...tab.selection]
    if (paths.length) await liq.startOp({ kind: 'compress', sources: paths, dest: tab.path, format: 'zip' })
  },
  async extract(tab = app.activeTab): Promise<void> {
    const sel = tab.selectedEntries().filter(e => /\.(zip|7z|rar|tar|gz|bz2|xz)$/i.test(e.name))
    if (sel.length) await liq.startOp({ kind: 'extract', sources: sel.map(e => e.path), dest: tab.path })
  },

  // --- open ---
  async open(tab = app.activeTab): Promise<void> {
    const sel = tab.selectedEntries()
    if (!sel.length) return
    const dirs = sel.filter(e => e.isDir)
    if (dirs.length === 1 && sel.length === 1) { tab.navigate(dirs[0].path); return }
    for (const d of dirs) app.newTab(d.path, true)
    for (const f of sel.filter(e => !e.isDir)) await liq.openPath(f.path)
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
    if (noFileOps(tab)) return
    const sel = tab.selectedEntries()
    if (sel.length) app.emit('start-rename', sel[0].path)
  },

  refresh(tab = app.activeTab): void { tab.refresh() },
}
