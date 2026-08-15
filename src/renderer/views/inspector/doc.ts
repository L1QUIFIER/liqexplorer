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
// The save does NOT go through the ops engine, so Ctrl+Z on the file list will
// not bring the old text back — the only physical undo is the <name>~ backup
// main writes on the first save. Both facts are said in the pane rather than
// discovered.
//
// PDF. Page thumbnails are real JPEGs rendered by pdftoppm into the cache and
// loaded over liqfile://; the strip renders them lazily in windows of 12 as it
// scrolls. Every write is a pdfseparate+pdfunite rebuild, which loses the
// outline, form fields and encryption — said out loud before the write, because
// the alternative (qpdf) is not installed on this machine. Rotation needs qpdf
// too, so its control is disabled and says so instead of quietly re-rendering
// the whole document through Ghostscript.
import { app, liq } from '../../core/app'
import type { FileEntry } from '../../../shared/types'
import { formatSize } from '../../../shared/sort'
import {
  DOC, PDF_REBUILD_WARNING,
  type DocDest, type PdfInfo, type PdfResult, type PdfThumbs,
  type TextFile, type TextWriteResult,
} from '../../../shared/doc'
import type { InspectorPage, Subject } from './shell'

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
      button(box, 'Open in another app', 'Hand this file to the app the system opens it with',
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
    const kept = stash.get(e.path)
    if (kept !== undefined && kept !== r.text) {
      ta.value = kept
      say('Unsaved changes from earlier are back in the editor.', 'bad')
    }
    body.appendChild(ta)
    buildTextFoot()
    if (kept === undefined) say('')
  }

  function buildTextFoot(): void {
    foot.textContent = ''
    const r = loaded
    if (!r) return

    const note = el('div', 'dc-note')
    note.textContent = 'Ctrl+Z works inside this editor only — a save is not on the app\'s undo list. '
      + `The previous contents are kept once per session as "${entry?.name ?? ''}~".`
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
    button(actions, 'Reload', 'Throw away changes here and read the file again', () => {
      const e = entry
      if (!e) return
      if (!textDirty()) { stash.delete(e.path); void loadText(e); return }
      app.emit('show-confirm', {
        title: 'Discard your changes?',
        message: `The edits you made to "${e.name}" here have not been saved. Reloading throws them away.`,
        okLabel: 'Discard',
        danger: true,
        onOk: () => { stash.delete(e.path); void loadText(e) },
      })
    }, 'btn')
    foot.append(actions, status)
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

  ta.addEventListener('input', () => {
    if (entry && loaded) {
      if (ta.value === loaded.text) stash.delete(entry.path)
      else stash.set(entry.path, ta.value)
    }
  })
  // the global keyboard handler bails out on TEXTAREA, so Ctrl+S is free here
  // and Ctrl+Z is the textarea's own undo rather than the app's file undo
  ta.addEventListener('keydown', (ev) => {
    if (ev.ctrlKey && !ev.shiftKey && !ev.altKey && ev.key.toLowerCase() === 's') {
      ev.preventDefault()
      void doSave(false)
    }
  })

  // ---------------------------------------------------------------------- pdf

  function pdfDirty(): boolean {
    return mode === 'pdf' && (order.length !== baseOrder.length || order.some((n, i) => n !== baseOrder[i]))
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
      const cap = el('div', 'dc-pg-cap', page === i + 1 ? String(page) : `${i + 1} (was ${page})`)
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

    const tools = el('div', 'dc-actions')
    const del = button(tools, 'Delete', 'Leave these pages out of the new PDF', () => {
      const drop = new Set(sel)
      order = order.filter((_, i) => !drop.has(i))
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

    const rot = button(tools, 'Rotate', '', () => { /* never enabled */ })
    rot.disabled = true
    // Ghostscript could rotate, but only by re-rendering the whole document —
    // recompressing every image to turn one page. Saying so beats doing it.
    rot.title = info?.canRotate
      ? 'Rotating pages is not built yet'
      : 'Install qpdf to rotate pages'

    const reset = button(tools, 'Reset', 'Put every page back where it started', () => {
      order = baseOrder.slice()
      selected.clear()
      paintStrip()
      buildPdfFoot()
      say('')
    })
    reset.disabled = !pdfDirty()
    foot.appendChild(tools)

    const warn = el('div', 'dc-note dc-warn')
    warn.textContent = PDF_REBUILD_WARNING
    foot.appendChild(warn)

    const saves = el('div', 'dc-actions')
    const copy = button(saves, 'Save a copy', 'Write a new PDF beside the original',
      () => void applyPages({ mode: 'copy' }, 'edited'), 'btn btn-primary')
    copy.disabled = !pdfDirty()
    const extract = button(saves, `Extract${n ? ` ${n}` : ''}`, 'Write just the selected pages to a new PDF',
      () => void applyPages({ mode: 'copy' }, 'pages', order.filter((_, i) => selected.has(i))), 'btn')
    extract.disabled = n === 0
    button(saves, 'Folder…', 'Write the new PDF into a folder you choose', () => void saveToFolder(), 'btn')
    button(saves, 'Add PDF…', 'Append another PDF to the end of this one', () => void addPdf(), 'btn')
    const rep = button(saves, 'Replace…', 'Replace the original (it goes to the Recycle Bin first)', () => {
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
    const pages = sel.map(i => order[i])
    const list = sel.slice()
    if (delta > 0) list.reverse()
    for (const i of list) {
      const j = i + delta
      if (j < 0 || j >= order.length) return
      const tmp = order[i]
      order[i] = order[j]
      order[j] = tmp
    }
    reselect(pages)
    paintStrip()
    buildPdfFoot()
    say('Reordered — nothing is written until you save.')
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
    const r = await liq.invoke('pdfApplyPages', { path: entry.path, order: use, dest, suffix })
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

  // --------------------------------------------------------------- lifecycle

  const TEXTY = /^(text\/|application\/(json|xml|x-sh|javascript|toml|yaml|x-yaml))/

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
    else if (TEXTY.test(e.mime || '')) void loadText(e)
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
