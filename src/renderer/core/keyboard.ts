// Global keyboard shortcuts — the full Explorer chrome table.
//
// Division of labor: this handler owns global chords (Ctrl/Alt combos, F-keys,
// Delete/Enter/Backspace). Plain Arrow/Space/Home/End/PgUp/PgDn and letter
// type-ahead are deliberately NOT handled here — the views layer owns them —
// so they fall through untouched when focus is inside #viewhost (or anywhere
// else). While an input/textarea/contenteditable has focus, nothing global
// runs: editors own their keys, including Escape.
import { app, liq } from './app'
import { actions } from './actions'
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
      }
      return
    }

    if (ctrl || alt) return

    // ---- unmodified / shift-only keys ----
    switch (k) {
      case 'f2': actions.rename(); done(); return
      case 'f3': app.emit('focus-search'); done(); return
      case 'f4': app.emit('edit-address'); done(); return
      case 'f5': actions.refresh(); done(); return
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
