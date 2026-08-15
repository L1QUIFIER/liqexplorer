// "Fix problem names…" — scan a folder or a selection for names that break on
// Windows/SMB, show every one with a plain-English reason and an editable
// proposal, and rename the checked ones in one undoable batch.
//
// Opened with app.emit('show-fixnames', { root } | { paths } [, recursive]).
// All the rules live in shared/names.ts; the scan and the renames run in main
// (platform/names.ts) over liq.invoke('scanNames' | 'fixNames', …).
import type {
  FixNameRequest, FixNamesResult, NameProblem, ScanNamesRequest, ScanNamesResult,
} from '../../shared/names'
import { ISSUE_INFO, analyzeName, describeIssues } from '../../shared/names'
import { app, liq } from '../core/app'
import { openModal, el, closeX, midEllipsize } from './dialogs'

/** detail for app.emit('show-fixnames', …) */
export type FixNamesRequest = ScanNamesRequest

let openCount = 0

export function mountFixNames(): void {
  app.on('show-fixnames', (req: FixNamesRequest) => { void show(req ?? {}) })
}

interface Row {
  problem: NameProblem
  checked: boolean
  /** the proposed name as edited by the user */
  value: string
  /** why the proposed name is not acceptable, or null */
  invalid: string | null
  /** error from the last Fix attempt */
  error: string | null
  /** renamed successfully — the row stays visible, greyed out */
  done: boolean
  node: HTMLDivElement
  check: HTMLInputElement
  input: HTMLInputElement
  note: HTMLDivElement
}

async function show(req: FixNamesRequest): Promise<void> {
  if (openCount) return                       // one scan window, like Options
  openCount++

  const modal = openModal({
    width: 720,
    className: 'dlg-fixnames',
    onDismiss: () => close(),
  })
  let busy = false
  const close = (): void => {
    if (busy) return                          // never vanish mid-rename
    openCount = 0
    modal.close()
  }

  const titleRow = el('div', 'dlg-title')
  titleRow.appendChild(el('span', 'dlg-title-text', 'Fix problem names'))
  titleRow.appendChild(closeX(close))

  const body = el('div', 'dlg-body fx-body')
  const status = el('div', 'fx-status', 'Scanning…')
  body.appendChild(status)

  const buttons = el('div', 'dlg-buttons')
  const fixBtn = el('button', 'btn btn-primary', 'Fix selected')
  const cancelBtn = el('button', 'btn', 'Cancel')
  fixBtn.disabled = true
  cancelBtn.addEventListener('click', close)
  buttons.append(fixBtn, cancelBtn)
  modal.dlg.append(titleRow, body, buttons)

  // ------------------------------------------------------------- scan
  let scan: ScanNamesResult
  try {
    scan = await liq.invoke('scanNames', req)
  } catch (e) {
    status.textContent = `The folder could not be scanned: ${String((e as Error)?.message ?? e)}`
    status.classList.add('err')
    cancelBtn.textContent = 'Close'
    return
  }
  if (modal.closed) return

  if (!scan.problems.length) {
    status.textContent = scan.windowsChecked
      ? 'No problem names found. Everything here is safe to open from Windows.'
      : 'No problem names found.'
    body.appendChild(scanNotes(scan, req))
    fixBtn.remove()
    cancelBtn.textContent = 'Close'
    cancelBtn.classList.add('btn-primary')
    cancelBtn.focus()
    return
  }

  // ------------------------------------------------------------- list
  status.remove()
  const head = el('div', 'fx-head')
  const all = el('input', 'fx-check')
  all.type = 'checkbox'
  all.checked = true
  all.title = 'Select all'
  const headCount = el('div', 'fx-count')
  head.append(all, headCount, el('div', 'fx-head-label', 'New name'))
  body.appendChild(head)

  const list = el('div', 'fx-list')
  body.appendChild(list)
  body.appendChild(scanNotes(scan, req))

  // rows print their folder only when the scan spans more than one
  const base = req.root ?? scan.problems[0].dir
  const rows: Row[] = scan.problems.map(p => buildRow(p))
  for (const r of rows) list.appendChild(r.node)

  function buildRow(problem: NameProblem): Row {
    const node = el('div', 'fx-row')
    const check = el('input', 'fx-check')
    check.type = 'checkbox'
    check.checked = true
    const meta = el('div', 'fx-meta')
    const nameEl = el('div', 'fx-name', visible(problem.name))
    nameEl.title = problem.path
    const where = relativeDir(problem.dir, base)
    if (where) {
      const loc = el('span', 'fx-where', ' — ' + midEllipsize(where, 48))
      loc.title = problem.dir
      nameEl.appendChild(loc)
    }
    const reason = el('div', 'fx-reason', describeIssues(problem.issues))
    const tags = el('div', 'fx-tags')
    for (const i of problem.issues) tags.appendChild(el('span', 'fx-tag', ISSUE_INFO[i.code].label))
    meta.append(nameEl, tags, reason)
    const input = el('input', 'fx-input')
    input.type = 'text'
    input.spellcheck = false
    input.value = problem.suggested
    const note = el('div', 'fx-note')
    node.append(check, meta, input, note)

    const row: Row = {
      problem, checked: true, value: problem.suggested, invalid: null, error: null,
      done: false, node, check, input, note,
    }
    // every edit can create or clear a clash with another row, so revalidate all
    check.addEventListener('change', () => { row.checked = check.checked; revalidate() })
    input.addEventListener('input', () => { row.value = input.value; revalidate() })
    return row
  }

  /** re-check an edited proposal against the same rules the scan used */
  function validate(row: Row): void {
    const p = row.problem
    const name = row.value
    row.error = null
    if (!name.trim()) { row.invalid = 'Type a name.'; return }
    if (name.includes('/')) { row.invalid = "A file name can't contain /"; return }
    if (name === p.name) { row.invalid = 'This is the current name.'; return }
    const left = analyzeName(name, {
      windows: p.windows,
      fullPath: p.dir + '/' + name,
      isDir: p.isDir,
    })
    row.invalid = left.length ? left[0].message : null
    // two checked rows in one folder must not aim at the same name
    if (!row.invalid) {
      const clash = rows.some(o => o !== row && o.checked && !o.done
        && o.problem.dir === p.dir && o.value.toLowerCase() === name.toLowerCase())
      if (clash) row.invalid = 'Another item in this list is being renamed to the same name.'
    }
  }

  function revalidate(): void {
    for (const r of rows) validate(r)
    sync()
  }

  function sync(): void {
    let will = 0
    let blocked = 0
    for (const r of rows) {
      if (r.done) { r.node.classList.add('done'); r.check.disabled = true; r.input.disabled = true }
      r.node.classList.toggle('off', !r.checked && !r.done)
      r.node.classList.toggle('bad', !!r.invalid && r.checked && !r.done)
      r.node.classList.toggle('err', !!r.error)
      r.note.textContent = r.error ?? (r.checked && !r.done ? (r.invalid ?? '') : '')
      if (r.done) continue
      if (r.checked) { will++; if (r.invalid) blocked++ }
    }
    const total = rows.filter(r => !r.done).length
    headCount.textContent = `${will} of ${total} problem${total === 1 ? '' : 's'} will be fixed`
    all.checked = rows.every(r => r.done || r.checked)
    fixBtn.disabled = busy || will === 0 || blocked > 0
    fixBtn.textContent = busy ? 'Renaming…' : 'Fix selected'
  }

  all.addEventListener('change', () => {
    for (const r of rows) {
      if (r.done) continue
      r.checked = all.checked
      r.check.checked = all.checked
    }
    revalidate()
  })

  revalidate()
  fixBtn.focus()

  // ------------------------------------------------------------- fix
  fixBtn.addEventListener('click', () => { void runFix() })

  async function runFix(): Promise<void> {
    const todo = rows.filter(r => r.checked && !r.done && !r.invalid)
    if (!todo.length || busy) return
    busy = true
    sync()
    const reqs: FixNameRequest[] = todo.map(r => ({
      from: r.problem.path,
      to: r.value,
      fromHex: r.problem.pathHex,
    }))
    let res: FixNamesResult
    try {
      res = await liq.invoke('fixNames', reqs)
    } catch (e) {
      busy = false
      for (const r of todo) r.error = String((e as Error)?.message ?? e)
      sync()
      return
    }
    busy = false
    todo.forEach((r, i) => {
      const out = res.results[i]
      if (out?.ok) { r.done = true; r.error = null }
      else r.error = out?.error ?? 'The item could not be renamed.'
    })
    app.activeTab?.refresh()
    if (rows.every(r => r.done)) { close(); return }
    sync()
  }
}

// ---------------------------------------------------------------- helpers

/** control characters rendered as visible Control Pictures instead of nothing */
function visible(name: string): string {
  let out = ''
  for (const ch of name) {
    const c = ch.codePointAt(0) ?? 0
    if (c < 0x20) out += String.fromCharCode(0x2400 + c)
    else if (c === 0x7f) out += '␡'
    else out += ch
  }
  return out
}

/** the row's folder, relative to the scanned base — empty when it IS the base */
function relativeDir(dir: string, base: string): string {
  if (!base || dir === base) return ''
  const prefix = base === '/' ? '/' : base + '/'
  return dir.startsWith(prefix) ? dir.slice(prefix.length) : dir
}

/** footnotes: unreadable folders, truncation, non-undoable rows, local-only scan */
function scanNotes(scan: ScanNamesResult, req: FixNamesRequest): HTMLDivElement {
  const box = el('div', 'fx-notes')
  if (!scan.windowsChecked && (req.windows ?? 'auto') === 'auto') {
    box.appendChild(el('div', 'fx-note-line',
      'This location is local, so names that only break on Windows are not reported here.'))
  }
  if (scan.problems.some(p => p.pathHex)) {
    box.appendChild(el('div', 'fx-note-line',
      'Names with invalid encoding are renamed directly and cannot be undone with Ctrl+Z.'))
  }
  if (scan.truncated) {
    box.appendChild(el('div', 'fx-note-line',
      `Showing the first ${scan.problems.length} problems — run the tool again afterwards to see the rest.`))
  }
  for (const e of scan.errors.slice(0, 5)) {
    box.appendChild(el('div', 'fx-note-line err', `${e.path}: ${e.error}`))
  }
  if (scan.errors.length > 5) {
    box.appendChild(el('div', 'fx-note-line err', `…and ${scan.errors.length - 5} more folders could not be read.`))
  }
  return box
}
