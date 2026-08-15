// Global keyboard shortcuts — the full Explorer chrome table.
//
// Division of labor: this handler owns global chords (Ctrl/Alt combos, F-keys,
// Delete/Enter/Backspace). Plain Arrow/Space/Home/End/PgUp/PgDn and letter
// type-ahead are deliberately NOT handled here — the views layer owns them —
// so they fall through untouched when focus is inside #viewhost (or anywhere
// else). While an input/textarea/contenteditable has focus, nothing global
// runs: editors own their keys, including Escape.
//
// Dual pane keys (Krusader / Total Commander muscle memory):
//   F3            toggle the split          (Nemo and Dolphin both use F3)
//   Ctrl+Shift+D  same, for anyone who wants a chord
//   Tab           move focus to the other pane (only from inside a pane)
//   F5 / F6       copy / move the selection to the other pane WHILE SPLIT;
//                 with one pane F5 keeps its Explorer meaning (refresh), and
//                 Shift+F5 refreshes either way
//   Ctrl+U        swap what the two panes show
import { app, liq } from './app'
import { actions } from './actions'
import { canTransferToOtherPane } from '../views/panes'
import type { ViewMode } from '../../shared/types'

/** Canonical Win11 order: Ctrl+Shift+1..8 */
const VIEW_MODE_ORDER: ViewMode[] = [
  'extra-large', 'large', 'medium', 'small', 'list', 'details', 'tiles', 'content',
]

export function mountKeyboard(): void {
  window.addEventListener('keydown', (e) => {
    const t = app.activeTab
    if (!t) return
    const target = e.target as HTMLElement | null
    const tag = target?.tagName
    const editing = tag === 'INPUT' || tag === 'TEXTAREA' || !!target?.isContentEditable
    if (editing || e.metaKey) return

    const k = e.key.toLowerCase()
    const ctrl = e.ctrlKey
    const alt = e.altKey
    const shift = e.shiftKey
    const digit = e.code.startsWith('Digit') ? Number(e.code.slice(5)) : 0
    const done = () => e.preventDefault()

    // ---- Ctrl+Shift chords ----
    if (ctrl && shift && !alt) {
      if (digit >= 1 && digit <= 8) { t.setViewState({ mode: VIEW_MODE_ORDER[digit - 1] }); done(); return }
      if (k === 'n') {
        void actions.newFolder().then(p => { if (p) app.emit('start-rename', p) })
        done(); return
      }
      if (k === 'c') { void actions.copyPath(); done(); return }
      if (k === 'e') { app.emit('nav-expand-to-current'); done(); return }
      if (k === 'd') { app.emit('toggle-dual-pane'); done(); return }
      if (k === 'tab') { cycleTab(-1); done(); return }
      // Ctrl+Shift+T (reopen closed tab): intentionally not implemented
      return
    }

    // ---- Ctrl chords ----
    if (ctrl && !shift && !alt) {
      if (digit >= 1 && digit <= 9) {
        const idx = digit === 9 ? app.tabs.length - 1 : digit - 1
        if (idx >= 0 && idx < app.tabs.length) app.activateTab(idx)
        done(); return
      }
      switch (k) {
        case 'x': void actions.cut(); done(); return
        case 'c': void actions.copy(); done(); return
        case 'v': void actions.paste(); done(); return
        case 'a': actions.selectAll(); done(); return
        case 'z': void actions.undo(); done(); return
        case 'y': void actions.redo(); done(); return
        case 't': void app.newTab(); done(); return
        case 'w': app.closeTab(app.activeTabIndex); done(); return
        case 'n': void liq.newWindow(t.path); done(); return
        case 'l': app.emit('edit-address'); done(); return
        case 'e': app.emit('focus-search'); done(); return
        case 'f': app.emit('focus-search'); done(); return
        case 'r': actions.refresh(); done(); return
        case 'd': void actions.delete(); done(); return
        case 'u': if (app.isSplit) { app.emit('swap-panes'); done() } return
        case 'tab': cycleTab(1); done(); return
      }
      return
    }

    // ---- Alt chords ----
    if (alt && !ctrl) {
      switch (k) {
        case 'arrowleft': t.back(); done(); return
        case 'arrowright': t.forward(); done(); return
        case 'arrowup': t.up(); done(); return
        case 'd': app.emit('edit-address'); done(); return
        case 'enter': void actions.properties(); done(); return
        // Alt+P opens the pane on whichever tab was last used; Alt+Shift+P
        // opens it on Details. One pane with tabs, so these are not two
        // competing surfaces — Shift just says which tab you meant.
        case 'p': app.emit(shift ? 'toggle-details-pane' : 'toggle-preview-pane'); done(); return
      }
      return
    }

    if (ctrl || alt) return

    // ---- unmodified / shift-only keys ----
    switch (k) {
      case 'tab': {
        // Krusader's pane switch. Only from inside a pane, so Tab still walks
        // the chrome normally everywhere else; the `editing` guard above has
        // already let the address bar, search box and inline rename keep it.
        if (!app.isSplit) return
        if (!target?.closest('.pn-pane')) return
        app.emit('pane-focus-toggle')
        done(); return
      }
      case 'f2': actions.rename(); done(); return
      // F3 is the dual-pane toggle (Nemo and Dolphin both use it, and it is
      // where a Krusader/TC user reaches). Focus-search keeps Ctrl+F and
      // Ctrl+E, the two bindings anyone actually types for it.
      case 'f3': app.emit('toggle-dual-pane'); done(); return
      case 'f4': app.emit('edit-address'); done(); return
      case 'f5':
        // Krusader's copy-to-other-panel when that is meaningful; otherwise
        // (one pane, nothing selected, virtual pane) Explorer's refresh, so F5
        // never becomes a key that does nothing. Shift+F5 always refreshes.
        if (!shift && canTransferToOtherPane()) { app.emit('pane-copy-to-other'); done(); return }
        actions.refresh(); done(); return
      case 'f6':
        if (canTransferToOtherPane()) { app.emit('pane-move-to-other'); done() }
        return
      case 'f10': if (shift) { app.emit('context-menu-key'); done() } return
      case 'contextmenu': app.emit('context-menu-key'); done(); return
      case 'delete': void actions.delete(undefined, shift); done(); return
      case 'backspace': t.back(); done(); return
      case 'enter':
        if (!shift && t.selection.size) { void actions.open(); done() }
        return
      // Arrows / Space / Home / End / PgUp / PgDn / letters: views layer owns them.
    }
  })
}

function cycleTab(dir: 1 | -1): void {
  const n = app.tabs.length
  if (n < 2) return
  app.activateTab((app.activeTabIndex + dir + n) % n)
}
