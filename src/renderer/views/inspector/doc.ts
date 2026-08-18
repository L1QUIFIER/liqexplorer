// The Doc tab: edit a text file, or rearrange the pages of a PDF.
//
// Two pages in one tab because they answer the same question — "this is a
// document, let me change it" — and because the tab strip is already the
// widest thing in a 260px pane.
//
// TEXT. The renderer holds the text and nothing else: encoding, line endings,
// the final newline and the BOM all live in main (ops/textfile.ts), travel back
// as data, and are re-applied on save, so opening a CRLF/latin-1 file and
// saving it unchanged rewrites the same bytes. A <textarea> normalises its own
// value to \n, which is exactly why the real line ending cannot be inferred
// from what the editor hands back and has to be carried separately.
//
// UNDO is this tab's own (inspector/history.ts), not the file list's. The save
// does not go through the ops engine, so Ctrl+Z on the file list will never
// bring old text back; instead the editor keeps a per-file history that
// survives switching files, and a completed save can be taken back with "Undo
// the save", which rewrites the previous contents through the normal save path.
// The <name>~ backup main writes on the FIRST save of a session is the
// disk-level backstop underneath all of that.
//
// PDF. Page thumbnails are real JPEGs rendered by pdftoppm into the cache and
// loaded over liqfile://; the strip renders them lazily in windows of 12 as it
// scrolls. Writes take one of two routes depending on what is installed
// (PdfInfo.engine): qpdf edits the page tree, so a reorder keeps the outline and
// rotation is possible at all; without it, pdfseparate+pdfunite rebuilds the
// document and loses the outline, form fields and encryption — which is said out
// loud before the write, and only when it is actually true. Page edits are
// undoable one step at a time, and Ctrl+Z inside the strip is CAPTURED so it
// cannot fall through to the file list and undo an unrelated move.
import { app, liq } from '../../core/app'
import type { FileEntry } from '../../../shared/types'
import { formatSize } from '../../../shared/sort'
import {
  DOC, PDF_REBUILD_WARNING,
  type DocDest, type PdfInfo, type PdfResult, type PdfThumbs,
  type TextFile, type TextWriteResult, isTextualMime,
} from '../../../shared/doc'
import type { InspectorPage, Subject } from './shell'
import { TextHistory, kindOf, type Caret } from './history'

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K, cls?: string, text?: string,
): HTMLElementTagNameMap[K] {
  const n = document.createElement(tag)
  if (cls) n.className = cls
  if (text !== undefined) n.textContent = text
  return n
}

/** injected at import time, not on first use: a stylesheet added in the same
 *  frame as the element applies a frame late and the pane flashes unstyled
 *  (the rule shell.ts follows for inspector.css) */
function ensureStyles(): void {
  if (document.querySelector('link[data-doc-style]')) return
  const link = document.createElement('link')
  link.rel = 'stylesheet'
  link.href = 'styles/doc.css'
  link.setAttribute('data-doc-style', '1')
  document.head.appendChild(link)
}
ensureStyles()

const EOL_LABEL = { lf: 'LF', crlf: 'CRLF', cr: 'CR' } as const

export function createDocPage(): InspectorPage {
  const root = el('div', 'ins-page ins-doc')
  root.dataset.tab = 'doc'

  const head = el('div', 'dc-head')
  const body = el('div', 'dc-body')
  const foot = el('div', 'dc-foot')
  root.append(head, body, foot)

  let entry: FileEntry | null = null
  let mode: 'none' | 'text' | 'pdf' | 'blocked' = 'none'
  /** bumped per load; late IPC replies that no longer match are dropped */
  let gen = 0

  // ---- text state ----
  let loaded: TextFile | null = null
  let asUtf8 = false
  /** paths already backed up in this session — <name>~ is written once, so a
   *  second save cannot overwrite the backup with the text being replaced */
  const backedUp = new Set<string>()
  /** unsaved edits, kept per path: selecting another file must never silently
   *  throw away typing, and the shell does not ask isDirty() before switching */
  const stash = new Map<string, string>()
  /**
   * Undo history per path, for the same reason the stash is per path — and for
   * one more: assigning textarea.value (which loading a file and restoring a
   * stash both do) wipes the NATIVE undo stack, so before this existed,
   * clicking another file and coming back left you with typing you could not
   * take back. Keyed by path so the history survives that round trip.
   */
  const histories = new Map<string, TextHistory>()
  /** the text as the textarea last had it, to diff the next edit against */
  let lastText = ''
  /** what the file held before the most recent save, so the save can be undone */
  let lastSave: { path: string; before: string; after: string } | null = null

  // ---- pdf state ----
  let info: PdfInfo | null = null
  /** 1-based source pages in output order */
  let order: number[] = []
  let baseOrder: number[] = []
  const selected = new Set<number>()          // indices into `order`
  const cards = new Map<number, HTMLElement>() // order index -> card
  const thumbUrl = new Map<number, string>()   // source page -> url
  const askedWindows = new Set<number>()
  let strip: HTMLElement | null = null
  let stripRo: ResizeObserver | null = null
  let scanTimer = 0
  /**
   * Quarter-turns added to a SOURCE page, keyed by source page number.
   *
   * Keyed by source and not by position because that is what the user means:
   * turn page 3, move it to the front, and page 3 is still the turned one. The
   * conversion to qpdf's output-relative ranges happens in main.
   */
  let rot = new Map<number, number>()

  /** one undoable page edit; orders are short arrays of integers, so unlike the
   *  text editor these can simply be snapshots */
  interface PdfStep {
    label: string
    before: { order: number[]; rot: Map<number, number> }
    after: { order: number[]; rot: Map<number, number> }
  }
  let pdfSteps: PdfStep[] = []
  /** how many steps are applied; anything above is redo */
  let pdfAt = 0

  function pdfSnapshot(): { order: number[]; rot: Map<number, number> } {
    return { order: order.slice(), rot: new Map(rot) }
  }

  /**
   * Run a page edit and put it on the undo stack.
   *
   * Everything that changes `order` or `rot` goes through here, so there is
   * exactly one place that can forget to make a change undoable.
   */
  function pdfEdit(label: string, mutate: () => void): void {
    const before = pdfSnapshot()
    mutate()
    const after = pdfSnapshot()
    if (before.order.join() === after.order.join() && sameRot(before.rot, after.rot)) return
    pdfSteps.length = pdfAt              // drop the redo branch
    pdfSteps.push({ label, before, after })
    pdfAt = pdfSteps.length
  }

  function sameRot(a: Map<number, number>, b: Map<number, number>): boolean {
    if (a.size !== b.size) return false
    for (const [k, v] of a) if (b.get(k) !== v) return false
    return true
  }

  function pdfRestore(s: { order: number[]; rot: Map<number, number> }): void {
    order = s.order.slice()
    rot = new Map(s.rot)
    selected.clear()
    paintStrip()
    buildPdfFoot()
  }

  function pdfUndo(): void {
    if (pdfAt <= 0) return
    const s = pdfSteps[--pdfAt]
    pdfRestore(s.before)
    say(`Undid: ${s.label}.`)
  }

  function pdfRedo(): void {
    if (pdfAt >= pdfSteps.length) return
    const s = pdfSteps[pdfAt++]
    pdfRestore(s.after)
    say(`Redid: ${s.label}.`)
  }

  const status = el('div', 'dc-status')

  function say(text: string, kind: '' | 'bad' | 'good' = ''): void {
    status.textContent = text
    status.className = 'dc-status' + (kind ? ` is-${kind}` : '')
  }

  function button(into: HTMLElement, label: string, title: string, fn: () => void, cls = 'dc-btn'): HTMLButtonElement {
    const b = el('button', cls, label)
    b.type = 'button'
    b.title = title
    b.addEventListener('click', fn)
    into.appendChild(b)
    return b
  }

  function clear(): void {
    head.textContent = ''
    body.textContent = ''
    foot.textContent = ''
    stripRo?.disconnect()
    stripRo = null
    strip = null
    cards.clear()
    askedWindows.clear()
    selected.clear()
  }

  function titleRow(e: FileEntry, facts: string): void {
    const t = el('div', 'dc-title', e.name)
    t.title = e.path
    head.append(t, el('div', 'dc-facts', facts))
  }

  // ------------------------------------------------------------------ blocked

  /** binary / too big / unreadable: say why, and give the way out. */
  function showBlocked(e: FileEntry, message: string, canOpen = true): void {
    clear()
    mode = 'blocked'
    titleRow(e, formatSize(e.size))
    const box = el('div', 'dc-notice')
    box.appendChild(el('div', 'dc-notice-text', message))
    if (canOpen) {
      button(box, 'Open with…', 'Open with the default application',
        () => { void liq.openPath(e.path) }, 'btn')
    }
    body.appendChild(box)
    foot.appendChild(status)
    say('')
  }

  // --------------------------------------------------------------------- text

  const ta = el('textarea', 'dc-ta')
  ta.spellcheck = false
  ta.wrap = 'off'
  ta.setAttribute('autocomplete', 'off')
  ta.setAttribute('autocapitalize', 'off')

  function textDirty(): boolean {
    return mode === 'text' && !!loaded && ta.value !== loaded.text
  }

  async function loadText(e: FileEntry): Promise<void> {
    const my = ++gen
    clear()
    mode = 'text'
    titleRow(e, 'Reading…')
    body.appendChild(el('div', 'dc-notice', 'Reading…'))

    const r = await liq.invoke('textRead', e.path).catch((err: Error) => (
      { ok: false, error: String(err?.message ?? err) } as TextFile
    )) as TextFile
    if (my !== gen) return

    if (!r.ok) {
      showBlocked(e, r.error || 'This file could not be read.', r.refusal !== 'not-a-file')
      return
    }

    loaded = r
    asUtf8 = false
    clear()
    mode = 'text'

    const facts = [
      r.encoding + (r.bom ? ' with BOM' : ''),
      EOL_LABEL[r.eol],
      `${r.size.toLocaleString()} bytes`,
    ].join(' · ')
    titleRow(e, facts)

    const flags: string[] = []
    if (!r.hadFinalNewline) flags.push('no newline at end of file — kept that way')
    if (r.mixedEol) flags.push(`mixed line endings — a save writes ${EOL_LABEL[r.eol]} throughout`)
    if (!r.lossless) flags.push('no encoding reproduced this file exactly; save as UTF-8 to be safe')
    if (r.realPath) flags.push(`a link to ${r.realPath}, which is what a save writes`)
    if (flags.length) head.appendChild(el('div', 'dc-flags', flags.join(' · ')))

    ta.value = r.text
    lastText = r.text
    // a history already here means the user is coming BACK to this file, and
    // the steps in it are still the steps that produced the stashed text
    let h = histories.get(e.path)
    if (!h) {
      h = new TextHistory(r.text)
      histories.set(e.path, h)
    }
    const kept = stash.get(e.path)
    if (kept !== undefined && kept !== r.text) {
      ta.value = kept
      // if the history was lost but the stash survived, make the restored text
      // one undoable step rather than an unexplained starting point
      if (!h.canUndo()) h.record(r.text, kept, 'other', { start: 0, end: 0 }, { start: 0, end: 0 })
      lastText = kept
      say('Unsaved changes from earlier are back in the editor.', 'bad')
    }
    body.appendChild(ta)
    buildTextFoot()
    if (kept === undefined) say('')
  }

  /** live references, so typing can update the buttons without rebuilding the
   *  footer on every keystroke */
  let undoBtn: HTMLButtonElement | null = null
  let redoBtn: HTMLButtonElement | null = null
  let saveUndoBtn: HTMLButtonElement | null = null

  function syncUndo(): void {
    const h = history()
    if (undoBtn) {
      undoBtn.disabled = !h?.canUndo()
      undoBtn.title = h?.canUndo() ? `Undo ${h.undoLabel()} (Ctrl+Z)` : 'Nothing to undo'
    }
    if (redoBtn) {
      redoBtn.disabled = !h?.canRedo()
      redoBtn.title = h?.canRedo() ? `Redo ${h.redoLabel()} (Ctrl+Shift+Z)` : 'Nothing to redo'
    }
    if (saveUndoBtn) {
      // only offer to undo the save while the editor still holds what was
      // saved; once it has been edited again, "undo the save" is ambiguous
      const live = !!lastSave && lastSave.path === entry?.path && ta.value === lastSave.after
      saveUndoBtn.hidden = !live
    }
  }

  function buildTextFoot(): void {
    foot.textContent = ''
    const r = loaded
    if (!r) return
    undoBtn = redoBtn = saveUndoBtn = null

    const undoRow = el('div', 'dc-actions dc-undorow')
    undoBtn = button(undoRow, '↶ Undo', 'Nothing to undo', () => doUndo())
    redoBtn = button(undoRow, '↷ Redo', 'Nothing to redo', () => doRedo())
    saveUndoBtn = button(undoRow, 'Undo save', 'Restore the previous contents and save',
      () => void undoSave())
    saveUndoBtn.classList.add('dc-undosave')
    saveUndoBtn.hidden = true
    foot.appendChild(undoRow)

    const note = el('div', 'dc-note')
    note.textContent = 'Undo here covers this editor and the last save. It is separate from the '
      + `file list's own undo. The contents from before the first save of this session are kept as "${entry?.name ?? ''}~".`
    foot.appendChild(note)

    const actions = el('div', 'dc-actions')
    const save = button(actions, 'Save', `Write this back as ${r.encoding}${r.bom ? ' with BOM' : ''}, ${EOL_LABEL[r.eol]} line endings`,
      () => void doSave(false), 'btn btn-primary')
    save.classList.add('dc-save')
    if (r.encoding !== 'UTF-8' || r.bom) {
      // encoding only: the line endings stay whatever the file already used,
      // because changing two things behind one button is how a diff fills up
      // with lines nobody edited
      const u = button(actions, 'Save as UTF-8', `Convert this file from ${r.encoding} to UTF-8, keeping its ${EOL_LABEL[r.eol]} line endings`,
        () => { asUtf8 = true; void doSave(false) }, 'btn')
      u.classList.add('dc-utf8')
    }
    button(actions, 'Reload', 'Discard changes and reload from disk', () => {
      const e = entry
      if (!e) return
      // a reload is a deliberate "forget what I did", so the history goes with
      // the stash — keeping it would let Ctrl+Z resurrect text the user just
      // confirmed they wanted gone
      const forget = () => { stash.delete(e.path); histories.delete(e.path); lastSave = null }
      if (!textDirty()) { forget(); void loadText(e); return }
      app.emit('show-confirm', {
        title: 'Discard your changes?',
        message: `The edits you made to "${e.name}" here have not been saved. Reloading throws them away.`,
        okLabel: 'Discard',
        danger: true,
        onOk: () => { forget(); void loadText(e) },
      })
    }, 'btn')
    foot.append(actions, status)
    syncUndo()
  }

  async function doSave(force: boolean): Promise<void> {
    const e = entry
    const r = loaded
    if (!e || !r) return
    const text = ta.value
    say('Saving…')

    const res = await liq.invoke('textWrite', e.path, text, {
      encoding: asUtf8 ? 'UTF-8' : r.encoding,
      bom: asUtf8 ? false : r.bom,
      eol: r.eol,
      finalNewline: r.hadFinalNewline,
      expectMtime: r.mtime,
      expectSize: r.size,
      backup: !backedUp.has(e.path),
      force,
    }).catch((err: Error) => ({ ok: false, error: String(err?.message ?? err) } as TextWriteResult)) as TextWriteResult

    if (!res.ok && res.conflict) {
      showConflict()
      return
    }
    if (!res.ok) {
      asUtf8 = false
      say(res.error || 'That did not work.', 'bad')
      return
    }

    backedUp.add(e.path)
    stash.delete(e.path)
    // what the file held BEFORE this write, so the write itself can be taken
    // back. The <name>~ backup only ever holds the state before the FIRST save
    // of the session, so on a second save it is not the answer to "undo that".
    lastSave = { path: e.path, before: r.text, after: text }
    history()?.markSaved()
    loaded = {
      ...r,
      text,
      encoding: asUtf8 ? 'UTF-8' : r.encoding,
      bom: asUtf8 ? false : r.bom,
      mtime: res.mtime ?? r.mtime,
      size: res.size ?? r.size,
    }
    asUtf8 = false
    buildTextFoot()
    const facts = [
      loaded.encoding + (loaded.bom ? ' with BOM' : ''),
      EOL_LABEL[loaded.eol],
      `${loaded.size.toLocaleString()} bytes`,
    ].join(' · ')
    const factsEl = head.querySelector('.dc-facts')
    if (factsEl) factsEl.textContent = facts
    say(res.backupError
      ? `Saved. The ${entry?.name}~ backup could not be written: ${res.backupError}`
      : res.backup ? 'Saved. Previous contents kept as ' + res.backup.split('/').pop() : 'Saved.', 'good')
    void app.activeTab?.refresh()
  }

  /**
   * Put the file back to what it held before the last save — the answer to
   * "I saved that by accident".
   *
   * It goes through the editor and then through a normal save, rather than
   * restoring bytes behind the pane's back: the restore is then one more step
   * on the undo stack (so undoing the undo works), the encoding and line
   * endings are re-applied exactly as any other save, and if something else has
   * touched the file since, the same conflict guard catches it instead of this
   * quietly clobbering it.
   */
  async function undoSave(): Promise<void> {
    const s = lastSave
    if (!s || !entry || s.path !== entry.path) return
    const h = history()
    const before: Caret = { start: ta.selectionStart, end: ta.selectionEnd }
    ta.value = s.before
    h?.record(lastText, s.before, 'other', before, { start: 0, end: 0 })
    lastText = s.before
    syncStash()
    lastSave = null
    await doSave(false)
    if (loaded?.text === s.before) say('The save was undone — the file is back to what it was.', 'good')
    syncUndo()
  }

  /** The file moved under us. Refusing and offering both ways out is the whole
   *  point of the optimistic lock — overwriting silently is what it prevents. */
  function showConflict(): void {
    const bar = el('div', 'dc-conflict')
    bar.appendChild(el('div', 'dc-notice-text',
      'This file changed on disk after it was opened here. Reloading throws away your edits; '
      + 'overwriting throws away whatever the other program wrote.'))
    const row = el('div', 'dc-actions')
    button(row, 'Reload', 'Read the file from disk again', () => {
      bar.remove()
      if (entry) { stash.delete(entry.path); void loadText(entry) }
    }, 'btn')
    button(row, 'Overwrite anyway', 'Write my version over what is on disk now', () => {
      bar.remove()
      void doSave(true)
    }, 'btn btn-danger')
    bar.appendChild(row)
    foot.insertBefore(bar, foot.firstChild)
    say('Not saved.', 'bad')
  }

  function history(): TextHistory | null {
    if (!entry) return null
    return histories.get(entry.path) ?? null
  }

  /** keep the stash in step with the editor, whatever moved the text */
  function syncStash(): void {
    if (!entry || !loaded) return
    if (ta.value === loaded.text) stash.delete(entry.path)
    else stash.set(entry.path, ta.value)
  }

  /** the caret before an edit; captured on the way IN, since the input event
   *  only ever reports where it ended up */
  let caretBefore: Caret = { start: 0, end: 0 }
  function noteCaret(): void {
    caretBefore = { start: ta.selectionStart, end: ta.selectionEnd }
  }
  ta.addEventListener('keydown', noteCaret)
  ta.addEventListener('pointerdown', noteCaret)
  ta.addEventListener('beforeinput', (ev) => {
    // Ctrl+Z from the keyboard AND Undo from the textarea's own right-click
    // menu both arrive here. Both are taken over: the native stack is not the
    // one being shown in the pane, and letting the two run side by side would
    // undo two different things depending on how you asked.
    if (ev.inputType === 'historyUndo') { ev.preventDefault(); doUndo(); return }
    if (ev.inputType === 'historyRedo') { ev.preventDefault(); doRedo(); return }
    noteCaret()
  })

  ta.addEventListener('input', (ev) => {
    const it = (ev as InputEvent).inputType || ''
    if (it === 'historyUndo' || it === 'historyRedo') {
      // A native undo that neither keydown nor beforeinput could cancel — the
      // textarea's own right-click Undo takes this route. The native stack is a
      // stale shadow of a stack that has been reassigned out from under it, so
      // its result is discarded and the real one runs instead. Recording it
      // as an edit (what happened before this guard) made a second press of
      // undo go FORWARD, which is the worst possible answer to "undo".
      ta.value = lastText
      if (it === 'historyUndo') doUndo()
      else doRedo()
      return
    }
    const h = history()
    if (h) {
      h.record(lastText, ta.value, kindOf(it), caretBefore,
        { start: ta.selectionStart, end: ta.selectionEnd })
    }
    lastText = ta.value
    syncStash()
    syncUndo()
  })

  /** put text back, restore the caret, and keep everything else in step */
  function applyHistory(r: { text: string; caret: Caret } | null): void {
    if (!r) return
    ta.value = r.text
    lastText = r.text
    ta.setSelectionRange(r.caret.start, r.caret.end)
    ta.focus()
    // scroll the caret into view: undoing something off-screen with no visible
    // effect reads as the button being broken
    const line = ta.value.slice(0, r.caret.start).split('\n').length - 1
    const lh = parseFloat(getComputedStyle(ta).lineHeight) || 16
    const want = line * lh
    if (want < ta.scrollTop || want > ta.scrollTop + ta.clientHeight - lh) {
      ta.scrollTop = Math.max(0, want - ta.clientHeight / 2)
    }
    syncStash()
    syncUndo()
  }

  function doUndo(): void {
    const h = history()
    if (!h?.canUndo()) return
    applyHistory(h.undo(ta.value))
  }

  function doRedo(): void {
    const h = history()
    if (!h?.canRedo()) return
    applyHistory(h.redo(ta.value))
  }

  // the global keyboard handler bails out on TEXTAREA, so these are free here.
  //
  // Ctrl+Z is caught HERE and not left to the beforeinput hook above, which is
  // where it was first put. Measured: Chromium does not deliver a cancelable
  // beforeinput for an undo, so the native undo ran anyway, changed the text
  // behind this stack's back, and arrived at the input handler as a brand new
  // edit — pressing undo twice went forward instead of back. keydown is the
  // only place the native behaviour can actually be stopped.
  ta.addEventListener('keydown', (ev) => {
    if (!ev.ctrlKey || ev.altKey) return
    const k = ev.key.toLowerCase()
    if (k === 's' && !ev.shiftKey) { ev.preventDefault(); void doSave(false); return }
    // Ctrl+Y and Ctrl+Shift+Z are both redo; Chromium only maps the latter
    if (k === 'y' && !ev.shiftKey) { ev.preventDefault(); doRedo(); return }
    if (k === 'z' && ev.shiftKey) { ev.preventDefault(); doRedo(); return }
    if (k === 'z') { ev.preventDefault(); doUndo() }
  })

  // ---------------------------------------------------------------------- pdf

  function pdfDirty(): boolean {
    if (mode !== 'pdf') return false
    if (order.length !== baseOrder.length || order.some((n, i) => n !== baseOrder[i])) return true
    for (const v of rot.values()) if (v % 360 !== 0) return true
    return false
  }

  async function loadPdf(e: FileEntry): Promise<void> {
    const my = ++gen
    clear()
    mode = 'pdf'
    titleRow(e, 'Reading…')
    body.appendChild(el('div', 'dc-notice', 'Reading…'))

    const r = await liq.invoke('pdfDocInfo', e.path).catch((err: Error) => (
      { ok: false, error: String(err?.message ?? err) } as PdfInfo
    )) as PdfInfo
    if (my !== gen) return

    info = r
    if (!r.ok || r.encrypted || r.needsPassword) {
      showBlocked(e, r.error
        || (r.encrypted ? 'This PDF is encrypted. Page editing would have to strip that protection, so it is not offered here.' : 'This PDF could not be read.'))
      return
    }

    order = Array.from({ length: r.pages }, (_, i) => i + 1)
    baseOrder = order.slice()
    rot = new Map()
    pdfSteps = []
    pdfAt = 0
    thumbUrl.clear()

    clear()
    mode = 'pdf'
    titleRow(e, [
      `${r.pages} page${r.pages === 1 ? '' : 's'}`,
      r.pageSize ? r.pageSize.replace(/\s*\(.*\)$/, '') : '',
      formatSize(r.fileSize ?? e.size),
      r.version ? `PDF ${r.version}` : '',
    ].filter(Boolean).join(' · '))
    if (r.title) head.appendChild(el('div', 'dc-flags', r.title))

    strip = el('div', 'dc-strip')
    // focusable so Ctrl+Z reaches the handler on root; without it the keystroke
    // goes straight to the window listener and undoes a FILE operation instead
    strip.tabIndex = 0
    body.appendChild(strip)
    strip.addEventListener('scroll', scheduleScan, { passive: true })
    // a wider pane fits more cards per row, so the visible set changes without
    // a scroll. This only fires while the window is actually being rendered,
    // which is exactly when it matters (see scanVisible).
    stripRo?.disconnect()
    stripRo = new ResizeObserver(scheduleScan)
    stripRo.observe(strip)
    paintStrip()
    buildPdfFoot()
    say('')
  }

  /** windows of DOC.thumbWindow pages, aligned so scrolling back never
   *  re-renders a half-window it already has */
  function windowStart(page: number): number {
    return Math.floor((page - 1) / DOC.thumbWindow) * DOC.thumbWindow + 1
  }

  /**
   * Which windows the strip is actually showing, measured rather than observed.
   *
   * An IntersectionObserver is the obvious tool and was the first one used, but
   * it is delivered from the rendering lifecycle — which Chromium suspends
   * whenever the window is hidden or occluded (measured here: document.hidden
   * is true under Xvfb, and rAF, ResizeObserver and IntersectionObserver all
   * stop with it). A pane laid out in that state then never asks for a single
   * thumbnail. getBoundingClientRect forces layout instead of waiting for a
   * frame, so this answers the same question in any state.
   */
  function scanVisible(): void {
    if (!strip || !cards.size) return
    const box = strip.getBoundingClientRect()
    // one screen of slack either way, so scrolling meets rendered pages
    const top = box.top - box.height
    const bottom = box.bottom + box.height
    for (const [idx, card] of cards) {
      const r = card.getBoundingClientRect()
      if (r.bottom >= top && r.top <= bottom) void askWindow(windowStart(order[idx]))
    }
  }

  /** debounced with a timer, NOT rAF: rAF is suspended in exactly the case
   *  scanVisible exists to survive */
  function scheduleScan(): void {
    window.clearTimeout(scanTimer)
    scanTimer = window.setTimeout(scanVisible, 80)
  }

  async function askWindow(start: number): Promise<void> {
    if (!entry || !info || askedWindows.has(start)) return
    askedWindows.add(start)
    const my = gen
    const end = Math.min(info.pages, start + DOC.thumbWindow - 1)
    const r = await liq.invoke('pdfThumbs', entry.path, start, end)
      .catch(() => ({ ok: false, thumbs: [] } as PdfThumbs)) as PdfThumbs
    if (my !== gen) return
    if (!r.ok) {
      // let it be retried: a failed window is usually a busy or slow mount
      askedWindows.delete(start)
      if (r.error) say(r.error, 'bad')
      return
    }
    for (const t of r.thumbs) thumbUrl.set(t.page, t.url)
    for (const [idx, card] of cards) {
      const page = order[idx]
      const url = thumbUrl.get(page)
      const img = card.querySelector('img')
      if (url && img && !img.src) img.src = url
    }
  }

  function paintStrip(): void {
    if (!strip) return
    strip.textContent = ''
    cards.clear()
    for (let i = 0; i < order.length; i++) {
      const page = order[i]
      const card = el('div', 'dc-pg')
      card.dataset.page = String(page)
      card.dataset.idx = String(i)
      card.classList.toggle('is-sel', selected.has(i))
      const img = el('img', 'dc-pg-img')
      img.alt = `Page ${page}`
      img.draggable = false
      const url = thumbUrl.get(page)
      if (url) img.src = url
      // show the turn rather than only promising it: the card is the only
      // feedback there is until the file is written
      const turn = rot.get(page) ?? 0
      if (turn) img.classList.add(`rot-${turn}`)
      const label = page === i + 1 ? String(page) : `${i + 1} (was ${page})`
      const cap = el('div', 'dc-pg-cap', turn ? `${label} · ${turn}°` : label)
      card.append(img, cap)
      card.addEventListener('click', (ev) => {
        if (!ev.ctrlKey && !ev.shiftKey) {
          const only = selected.size === 1 && selected.has(i)
          selected.clear()
          if (!only) selected.add(i)
        } else if (selected.has(i)) selected.delete(i)
        else selected.add(i)
        paintSelection()
        buildPdfFoot()
      })
      cards.set(i, card)
      strip.appendChild(card)
    }
    // the first screen must appear without the user scrolling first
    scanVisible()
  }

  function paintSelection(): void {
    for (const [idx, card] of cards) card.classList.toggle('is-sel', selected.has(idx))
  }

  function selectedIdx(): number[] {
    return [...selected].sort((a, b) => a - b)
  }

  function reselect(pages: number[]): void {
    selected.clear()
    for (let i = 0; i < order.length; i++) if (pages.includes(order[i])) selected.add(i)
  }

  function buildPdfFoot(): void {
    foot.textContent = ''
    const sel = selectedIdx()
    const n = sel.length

    // undo first and on its own row: it is the control you want when you have
    // just done something wrong, and hunting for it among six page tools is
    // exactly the wrong moment to be hunting
    const undoRow = el('div', 'dc-actions dc-undorow')
    const u = button(undoRow, '↶ Undo', pdfAt > 0 ? `Undo ${pdfSteps[pdfAt - 1].label} (Ctrl+Z)` : 'Nothing to undo', pdfUndo)
    u.disabled = pdfAt <= 0
    const rd = button(undoRow, '↷ Redo', pdfAt < pdfSteps.length ? `Redo ${pdfSteps[pdfAt].label} (Ctrl+Shift+Z)` : 'Nothing to redo', pdfRedo)
    rd.disabled = pdfAt >= pdfSteps.length
    const reset = button(undoRow, 'Reset', 'Put every page back where it started', () => {
      pdfEdit('reset', () => { order = baseOrder.slice(); rot = new Map() })
      selected.clear()
      paintStrip()
      buildPdfFoot()
      say('')
    })
    reset.disabled = !pdfDirty()
    foot.appendChild(undoRow)

    const tools = el('div', 'dc-actions')
    const del = button(tools, 'Delete', 'Leave these pages out of the new PDF', () => {
      const drop = new Set(sel)
      pdfEdit(`delete of ${n} page${n === 1 ? '' : 's'}`, () => {
        order = order.filter((_, i) => !drop.has(i))
      })
      selected.clear()
      paintStrip()
      buildPdfFoot()
      say(`${n} page${n === 1 ? '' : 's'} removed — nothing is written until you save.`)
    })
    del.disabled = n === 0 || n >= order.length

    const left = button(tools, '◀ Move', 'Move these pages one place earlier', () => moveBy(-1))
    left.disabled = n === 0 || sel[0] === 0
    const right = button(tools, 'Move ▶', 'Move these pages one place later', () => moveBy(1))
    right.disabled = n === 0 || sel[n - 1] === order.length - 1

    // glyphs only: five labelled buttons wrap in a 260px pane, and a lone
    // wrapped one stretches to the full width, which reads as a different kind
    // of control. The quarter turn is in the tooltip.
    const canRot = !!info?.canRotate
    const rotL = button(tools, '⟲', canRot ? 'Turn these pages a quarter turn anticlockwise' : 'Install qpdf to rotate pages',
      () => rotateBy(-90))
    rotL.classList.add('dc-rot')
    rotL.disabled = !canRot || n === 0
    const rotR = button(tools, '⟳', canRot ? 'Turn these pages a quarter turn clockwise' : 'Install qpdf to rotate pages',
      () => rotateBy(90))
    rotR.classList.add('dc-rot')
    rotR.disabled = !canRot || n === 0
    foot.appendChild(tools)

    // shown only when it is TRUE: with qpdf the page tree is edited in place and
    // the outline survives, so warning about losing it would be a lie
    if (info?.engine !== 'qpdf') {
      const warn = el('div', 'dc-note dc-warn')
      warn.textContent = PDF_REBUILD_WARNING
      foot.appendChild(warn)
    }

    const saves = el('div', 'dc-actions')
    const copy = button(saves, 'Save a copy', 'Save as a new PDF next to the original',
      () => void applyPages({ mode: 'copy' }, 'edited'), 'btn btn-primary')
    copy.disabled = !pdfDirty()
    const extract = button(saves, `Extract${n ? ` ${n}` : ''}`, 'Save the selected pages as a new PDF',
      () => void applyPages({ mode: 'copy' }, 'pages', order.filter((_, i) => selected.has(i))), 'btn')
    extract.disabled = n === 0
    button(saves, 'Folder…', 'Save to a folder you choose', () => void saveToFolder(), 'btn')
    button(saves, 'Add PDF…', 'Add another PDF to the end', () => void addPdf(), 'btn')
    // Pictures, not another PDF. The page number is handed over so the dialog
    // can offer "this page" — from here the user is looking at a specific one,
    // and re-finding it in a page-range box would be busywork.
    button(saves, 'As pictures…', 'Save these pages as image files (PNG, JPEG, WebP, SVG…)', () => {
      const first = [...selected].sort((a, b) => a - b)[0]
      app.emit('show-pdf-export', {
        path: entry?.path,
        // `order` holds ORIGINAL page numbers, so a reordered document still
        // names the page the export engine will actually render
        page: first === undefined ? undefined : order[first] + 1,
      })
    }, 'btn')
    const rep = button(saves, 'Replace…', 'Replace the original (moved to the Recycle Bin first)', () => {
      app.emit('show-confirm', {
        title: 'Replace the original?',
        message: `"${entry?.name}" will be rebuilt with ${order.length} page${order.length === 1 ? '' : 's'}. `
          + `The original goes to the Recycle Bin, so this can be undone. ${PDF_REBUILD_WARNING}`,
        okLabel: 'Replace',
        danger: true,
        onOk: () => void applyPages({ mode: 'replace' }, 'edited'),
      })
    }, 'btn btn-danger')
    rep.disabled = !pdfDirty()
    foot.append(saves, status)
  }

  function moveBy(delta: number): void {
    const sel = selectedIdx()
    if (!sel.length) return
    // bail BEFORE mutating: a half-applied move is not something undo should
    // have to describe
    if (sel.some(i => i + delta < 0 || i + delta >= order.length)) return
    const pages = sel.map(i => order[i])
    pdfEdit(`move of ${sel.length} page${sel.length === 1 ? '' : 's'}`, () => {
      const list = sel.slice()
      if (delta > 0) list.reverse()
      for (const i of list) {
        const j = i + delta
        const tmp = order[i]
        order[i] = order[j]
        order[j] = tmp
      }
    })
    reselect(pages)
    paintStrip()
    buildPdfFoot()
    say('Reordered — nothing is written until you save.')
  }

  /** turn the selected pages, accumulating onto whatever they already carry */
  function rotateBy(delta: number): void {
    const sel = selectedIdx()
    if (!sel.length || !info?.canRotate) return
    const pages = sel.map(i => order[i])
    pdfEdit(`rotation of ${sel.length} page${sel.length === 1 ? '' : 's'}`, () => {
      for (const p of pages) {
        const next = (((rot.get(p) ?? 0) + delta) % 360 + 360) % 360
        if (next) rot.set(p, next)
        else rot.delete(p)          // back to square: not a change at all
      }
    })
    reselect(pages)
    paintStrip()
    buildPdfFoot()
    say('Turned — nothing is written until you save.')
  }

  async function saveToFolder(): Promise<void> {
    const dirs = await liq.invoke('pdfPick', 'folder', entry?.path).catch(() => [] as string[]) as string[]
    if (!dirs.length) return
    await applyPages({ mode: 'folder', dir: dirs[0] }, 'edited')
  }

  async function addPdf(): Promise<void> {
    if (!entry) return
    const files = await liq.invoke('pdfPick', 'pdf', entry.path).catch(() => [] as string[]) as string[]
    if (!files.length) return
    say('Merging…')
    const r = await liq.invoke('pdfMerge', { path: entry.path, append: files, dest: { mode: 'copy' } })
      .catch((e: Error) => ({ ok: false, error: String(e?.message ?? e) } as PdfResult)) as PdfResult
    afterWrite(r, 'Merged into')
  }

  async function applyPages(dest: DocDest, suffix: string, override?: number[]): Promise<void> {
    if (!entry) return
    const use = override ?? order
    if (!use.length) { say('That would leave no pages at all.', 'bad'); return }
    say('Working…')
    const rotate: Record<number, number> = {}
    for (const [page, turn] of rot) if (use.includes(page)) rotate[page] = turn
    const r = await liq.invoke('pdfApplyPages', { path: entry.path, order: use, dest, suffix, rotate })
      .catch((e: Error) => ({ ok: false, error: String(e?.message ?? e) } as PdfResult)) as PdfResult
    afterWrite(r, dest.mode === 'replace' ? 'Replaced —' : 'Wrote')
    if (r.ok && dest.mode === 'replace' && entry) {
      // the file on disk is now what the strip shows: re-read it so the page
      // cache key and the base order match reality again. The reload resets the
      // status line, so the confirmation is put back after it.
      const said = status.textContent
      await loadPdf(entry)
      say(said || '', 'good')
    }
  }

  function afterWrite(r: PdfResult, verb: string): void {
    if (!r.ok) { say(r.error || 'That did not work.', 'bad'); return }
    say(`${verb} ${r.out?.split('/').pop()} — ${r.pages} page${r.pages === 1 ? '' : 's'}.`, 'good')
    void app.activeTab?.refresh()
  }

  /**
   * Ctrl+Z inside the page strip.
   *
   * This has to stop the event rather than merely act on it. The application's
   * global handler steps aside for INPUT and TEXTAREA — which covers the text
   * editor — but the PDF strip is a plain div, so without this the keystroke
   * would fall through to the file list's undo and reverse the user's last
   * MOVE OR DELETE somewhere else in the app, having been pressed to take back
   * a page edit. Stopping propagation is the point, not a detail.
   */
  root.addEventListener('keydown', (ev) => {
    if (mode !== 'pdf' || !ev.ctrlKey || ev.altKey) return
    const k = ev.key.toLowerCase()
    if (k === 'z' && !ev.shiftKey) { ev.preventDefault(); ev.stopPropagation(); pdfUndo() }
    else if ((k === 'z' && ev.shiftKey) || k === 'y') { ev.preventDefault(); ev.stopPropagation(); pdfRedo() }
  })

  // --------------------------------------------------------------- lifecycle

  function render(sub: Subject): void {
    const e = sub.entries[0]
    if (!e || e.isDir || !e.path.startsWith('/')) {
      gen++
      entry = null
      loaded = null
      mode = 'none'
      clear()
      body.appendChild(el('div', 'ins-empty', 'Select a text file or a PDF.'))
      return
    }
    // same file: keep what the user is in the middle of, exactly as the Edit
    // tab keeps an in-progress crop
    if (entry?.path === e.path) return
    entry = e
    loaded = null
    info = null

    if (e.ext === 'pdf') void loadPdf(e)
    else if (isTextualMime(e.mime || '')) void loadText(e)
    else showBlocked(e, 'Only text files and PDFs can be edited here.')
  }

  return {
    el: root,
    render,
    isDirty: () => textDirty() || pdfDirty(),
    suspend() {
      // nothing is playing and nothing is decoded; the in-progress edit is kept
      // deliberately, and the stash means it survives a selection change too
      if (entry && textDirty()) stash.set(entry.path, ta.value)
    },
  }
}
