// The Rename tab: bulk rename without a modal in the way.
//
// The dialog is still there and still better for a big job on a wide screen.
// This exists because the modal covers the list it is renaming: you cannot
// re-sort the pane, glance at the file you forgot, or fix the one row that is
// wrong without closing it and starting again. Docked, the rules sit beside the
// listing and the listing stays live.
//
// The rules mean exactly what they mean in the dialog — both call
// planRenames() — with one deliberate difference: numbering here follows
// tab.rows, the pane's CURRENT sort. That is the whole trick behind "sort by
// date modified, then number these photos": re-sort the pane and {n} follows.
//
// Everything that actually touches the disk is liq.invoke('fixNames', …), which
// owns deepest-first ordering, the CIFS case-only dance, raw-byte paths and —
// the one nothing may reimplement — a single undo entry for the whole batch.
import { app, liq } from '../../core/app'
import type { Tab } from '../../core/app'
import type { FileEntry } from '../../../shared/types'
import type { FixNamesResult } from '../../../shared/names'
import {
  planRenames, runnableRows, summarizePlan, folderNamesFrom, rulesAreEmpty,
  DEFAULT_RENAME_RULES, RENAME_TOKENS,
  type RenameRules, type RenameRow, type CaseRule, type SpaceRule,
} from '../../../shared/renameplan'
import type { InspectorPage, Subject } from './shell'

/**
 * A pane this narrow cannot show thousands of rows usefully, and building them
 * on every keystroke is the one thing that would make typing a rule feel slow.
 * The cap is on the PREVIEW only — the run still covers every selected file.
 */
const PREVIEW_LIMIT = 200

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K, cls?: string, text?: string,
): HTMLElementTagNameMap[K] {
  const n = document.createElement(tag)
  if (cls) n.className = cls
  if (text !== undefined) n.textContent = text
  return n
}

export function createRenamePage(): InspectorPage {
  const root = el('div', 'ins-page ins-rename')
  root.dataset.tab = 'rename'

  const rules: RenameRules = { ...DEFAULT_RENAME_RULES }
  /** the entries the plan is over, in tab.rows order */
  let entries: FileEntry[] = []
  let folderNames = new Map<string, string[]>()
  /** the rows ON SCREEN are the rows a run submits — never re-planned at submit */
  let rows: RenameRow<FileEntry>[] = []
  let running = false
  /** these exact rules have already been applied to this selection */
  let applied = false
  let subjectKey = ''
  /** outcome of the last run, shown until the rules change */
  let note = ''
  /** the next subject change is this page's own rename landing, not a new job */
  let ownRun = false

  // ------------------------------------------------------------ form (built once)
  // Built at construction, not per render: render() runs on every selection
  // change, and rebuilding the inputs would take the caret out of the field
  // being typed into.

  const scroll = el('div', 'rnm-scroll')
  const head = el('div', 'rnm-head')

  const modes = el('div', 'rnm-modes')
  const modeReplace = el('button', 'rnm-mode active', 'Replace')
  const modePattern = el('button', 'rnm-mode', 'Pattern')
  modeReplace.type = 'button'
  modePattern.type = 'button'
  modes.append(modeReplace, modePattern)

  const replaceForm = el('div', 'rnm-form')
  field(replaceForm, 'Find', v => { rules.find = v; changed() })
  field(replaceForm, 'Replace with', v => { rules.replace = v; changed() })
  const optRow = el('div', 'rnm-opts')
  checkbox(optRow, 'Regex', v => { rules.useRegex = v; changed() })
  checkbox(optRow, 'Match case', v => { rules.matchCase = v; changed() })
  replaceForm.appendChild(optRow)
  replaceForm.appendChild(labelled('Apply to', select<'name' | 'ext' | 'full'>([
    ['name', 'Name only'], ['ext', 'Extension only'], ['full', 'Whole file name'],
  ], rules.scope, v => { rules.scope = v; changed() })))

  const patternForm = el('div', 'rnm-form')
  patternForm.hidden = true
  const patternIn = field(patternForm, 'Pattern', v => { rules.pattern = v; changed() })
  patternIn.value = rules.pattern
  const numRow = el('div', 'rnm-nums')
  numberField(numRow, 'Start', rules.start, v => { rules.start = v; changed() })
  numberField(numRow, 'Step', rules.step, v => { rules.step = v; changed() })
  numberField(numRow, 'Digits', rules.pad, v => { rules.pad = v; changed() })
  patternForm.appendChild(numRow)
  const tokenHelp = el('div', 'rnm-tokens')
  for (const t of RENAME_TOKENS) {
    // clicking beats retyping "{mtime:YYYY-MM-DD}" into a 180px field
    const chip = el('button', 'rnm-token', t.token)
    chip.type = 'button'
    chip.title = t.help
    chip.addEventListener('click', () => {
      insertAtCaret(patternIn, t.token)
      rules.pattern = patternIn.value
      changed()
    })
    tokenHelp.appendChild(chip)
  }
  patternForm.appendChild(tokenHelp)

  const tidy = el('div', 'rnm-form rnm-tidy')
  tidy.appendChild(labelled('Case', select<CaseRule>([
    ['leave', 'Leave case'], ['lower', 'lower case'], ['upper', 'UPPER CASE'],
    ['title', 'Title Case'], ['sentence', 'Sentence case'],
  ], rules.caseRule, v => { rules.caseRule = v; changed() })))
  tidy.appendChild(labelled('Spaces', select<SpaceRule>([
    ['leave', 'Keep spaces'], ['underscore', 'Spaces to _'], ['dash', 'Spaces to -'],
  ], rules.spaces, v => { rules.spaces = v; changed() })))
  const tidyOpts = el('div', 'rnm-opts')
  checkbox(tidyOpts, 'Trim', v => { rules.trim = v; changed() })
  checkbox(tidyOpts, 'Collapse spaces', v => { rules.collapseSpaces = v; changed() })
  tidy.appendChild(tidyOpts)

  const errorEl = el('div', 'rnm-error')
  errorEl.hidden = true
  const list = el('div', 'rnm-list')

  scroll.append(head, modes, replaceForm, patternForm, tidy, errorEl, list)

  // ------------------------------------------------------------ sticky footer

  const foot = el('div', 'rnm-foot')
  const status = el('div', 'rnm-status')
  const actions = el('div', 'rnm-actions')
  const runBtn = el('button', 'btn btn-primary rnm-run', 'Rename')
  const dlgBtn = el('button', 'btn rnm-open', 'Open in dialog…')
  runBtn.type = 'button'
  dlgBtn.type = 'button'
  actions.append(runBtn, dlgBtn)
  foot.append(status, actions)

  root.append(scroll, foot)

  // ------------------------------------------------------------ wiring

  function setMode(m: 'replace' | 'pattern'): void {
    rules.mode = m
    modeReplace.classList.toggle('active', m === 'replace')
    modePattern.classList.toggle('active', m === 'pattern')
    replaceForm.hidden = m !== 'replace'
    patternForm.hidden = m !== 'pattern'
    changed()
  }
  modeReplace.addEventListener('click', () => setMode('replace'))
  modePattern.addEventListener('click', () => setMode('pattern'))

  /** a rule was edited: the last run no longer describes what is on screen */
  function changed(): void {
    applied = false
    note = ''
    repaint()
  }

  // Enter anywhere in the page runs the batch — the rules are a form, and a
  // form you have finished typing should not need a trip to the mouse.
  root.addEventListener('keydown', (ev) => {
    if (ev.key !== 'Enter' || ev.shiftKey || ev.ctrlKey || ev.altKey) return
    ev.preventDefault()
    if (!runBtn.disabled) void run()
  })

  runBtn.addEventListener('click', () => { void run() })

  /** files a finished run is waiting to re-select, once their listing arrives */
  let pending: { tab: Tab; paths: string[] } | null = null

  // app.on has no matching off, so this lives for the life of the page and does
  // nothing at all unless a run has just left something pending.
  app.on('tab-listing', () => {
    if (!pending) return
    const { tab, paths } = pending
    if (tab.loading) return                 // only the final chunk has every row
    pending = null
    if (app.activeTab !== tab) return       // the user moved on; leave them there
    const have = new Set(tab.rows.map(r => r.path))
    const want = paths.filter(p => have.has(p))
    if (!want.length) return
    tab.setSelection(want)
    app.emit('set-inspector-tab', 'rename')
  })

  dlgBtn.addEventListener('click', () => {
    // hand the rules over rather than the result: the dialog re-plans them
    // against the same planner, so the preview it opens on is identical
    app.emit('show-bulk-rename', { paths: entries.map(e => e.path), rules: { ...rules } })
  })

  // ------------------------------------------------------------ preview

  function repaint(): void {
    const plan = planRenames(entries, rules, { folderNames })
    rows = plan.rows
    const planError = plan.error ?? ''
    const { runnable, blocked, total } = summarizePlan(rows)

    head.textContent = total
      ? `${total} item${total === 1 ? '' : 's'} selected`
      : 'Select the files to rename'

    errorEl.hidden = !planError
    errorEl.textContent = planError

    list.textContent = ''
    const shown = Math.min(rows.length, PREVIEW_LIMIT)
    for (let i = 0; i < shown; i++) {
      const r = rows[i]
      const row = el('div', 'rnm-row' + (r.problem ? ' is-bad' : r.changed ? '' : ' is-same'))
      // old above, new below: at 180px a side-by-side old → new shows about
      // four characters of each, which is worse than useless
      row.appendChild(el('div', 'rnm-old', r.entry.name))
      const to = el('div', 'rnm-new', (r.problem ? '' : '→ ') + (r.problem ?? r.to))
      to.title = r.problem ?? r.to
      row.appendChild(to)
      list.appendChild(row)
    }
    if (rows.length > shown) {
      list.appendChild(el('div', 'rnm-more', `…and ${rows.length - shown} more`))
    }

    status.textContent = note || (planError ? 'Nothing will be renamed.'
      : blocked ? `${runnable} to rename · ${blocked} blocked`
        : `${runnable} of ${total} will be renamed`)
    status.classList.toggle('has-problems', !!planError || blocked > 0)
    // ANY blocked row stops the whole run, unlike the dialog, which quietly
    // skips them. The rules live on here and are meant to be edited until they
    // are right; running the half of a collision that happens to be first takes
    // the name the other row wanted and leaves a job that cannot be finished.
    runBtn.disabled = running || runnable === 0 || blocked > 0
    runBtn.title = blocked ? 'Fix the rows in red first' : ''
    runBtn.textContent = runnable ? `Rename ${runnable}` : 'Rename'
    dlgBtn.disabled = entries.length === 0
  }

  // ------------------------------------------------------------ run

  async function run(): Promise<void> {
    const todo = runnableRows(rows)
    if (!todo.length || running) return
    running = true
    runBtn.disabled = true
    const tab = app.activeTab
    try {
      const res = await liq.invoke(
        'fixNames', todo.map(r => ({ from: r.entry.path, to: r.to })),
      ) as FixNamesResult
      const ok = res?.results?.filter(r => r.ok) ?? []
      note = res?.failed
        ? `Renamed ${res.fixed} · ${res.failed} failed`
        : `Renamed ${res?.fixed ?? todo.length}`
      applied = true
      ownRun = true
      // Re-select the files under their NEW names once the listing lands.
      // Without this the selection prunes to nothing, and the shell — which
      // drops to Preview whenever the active tab stops applying — takes this
      // pane away at the exact moment the rules are worth keeping for the next
      // folder. It cannot be done straight after refresh(): that resolves when
      // the listing has been REQUESTED, and the rows arrive in pushed chunks
      // afterwards, so setSelection() would land on the pre-rename listing and
      // be pruned. reselect() waits for the last chunk instead.
      if (tab && ok.length) pending = { tab, paths: ok.map(r => r.to) }
      await tab?.refresh()
    } catch {
      note = 'The rename could not be run.'
    } finally {
      running = false
      // rules are deliberately NOT reset: the same rule usually runs again on
      // the next folder, and retyping it is the reason people give up on this
      repaint()
    }
  }

  // ------------------------------------------------------------ page contract

  function render(sub: Subject): void {
    const tab = sub.tab
    // tab.rows order, not selection order: {n} must follow the pane's sort, and
    // selectedEntries() already derives from rows — this keeps that true even
    // if a caller ever hands the subject over in some other order.
    const index = new Map<string, number>()
    if (tab) tab.rows.forEach((r, i) => index.set(r.path, i))
    entries = sub.entries.slice()
      .sort((a, b) => (index.get(a.path) ?? 0) - (index.get(b.path) ?? 0))

    // Siblings for the collision check come from the listing already in memory:
    // clashing with an UNSELECTED file must show up in this preview, not as a
    // failed row after the batch runs.
    folderNames = folderNamesFrom(tab ? tab.rows : entries)

    const key = entries.map(e => e.path).join('\n')
    if (key !== subjectKey && ownRun) {
      // The subject only changed because this page just renamed these files.
      // Treating that as "different files, forget everything" would wipe the
      // "3 failed" line a tenth of a second after it appeared, and would make
      // isDirty() claim the rules are unapplied work the instant they ran.
      ownRun = false
      subjectKey = key
    } else if (key !== subjectKey) {
      subjectKey = key
      // a different set of files has not had these rules applied to it
      applied = false
      note = ''
    }
    repaint()
  }

  return {
    el: root,
    render,
    isDirty() {
      // rules typed but never run: the shell must not throw them away silently
      return !rulesAreEmpty(rules) && !applied
    },
  }
}

// ---------------------------------------------------------------- form helpers
// Stacked label-above-control, unlike the dialog's label-beside-control: the
// pane is 180px at its narrowest and a 110px label column would leave nothing.

function labelled(label: string, control: HTMLElement): HTMLElement {
  const wrap = el('label', 'rnm-field')
  wrap.appendChild(el('span', 'rnm-label', label))
  wrap.appendChild(control)
  return wrap
}

function field(parent: HTMLElement, label: string, onInput: (v: string) => void): HTMLInputElement {
  const input = el('input', 'dlg-input')
  input.spellcheck = false
  input.addEventListener('input', () => onInput(input.value))
  parent.appendChild(labelled(label, input))
  return input
}

function numberField(
  parent: HTMLElement, label: string, value: number, onInput: (v: number) => void,
): void {
  const input = el('input', 'dlg-input')
  input.type = 'number'
  input.value = String(value)
  input.addEventListener('input', () => onInput(Number(input.value) || 0))
  parent.appendChild(labelled(label, input))
}

function checkbox(parent: HTMLElement, label: string, onChange: (v: boolean) => void): void {
  const wrap = el('label', 'opt-check')
  const box = el('input')
  box.type = 'checkbox'
  box.addEventListener('change', () => onChange(box.checked))
  wrap.append(box, el('span', '', label))
  parent.appendChild(wrap)
}

function select<T extends string>(
  options: [T, string][], value: T, onPick: (v: T) => void,
): HTMLSelectElement {
  const sel = el('select', 'dlg-input rnm-select')
  for (const [v, text] of options) {
    const o = el('option', '', text)
    o.value = v
    sel.appendChild(o)
  }
  sel.value = value
  sel.addEventListener('change', () => onPick(sel.value as T))
  return sel
}

function insertAtCaret(input: HTMLInputElement, text: string): void {
  const at = input.selectionStart ?? input.value.length
  const end = input.selectionEnd ?? at
  input.value = input.value.slice(0, at) + text + input.value.slice(end)
  input.setSelectionRange(at + text.length, at + text.length)
  input.focus()
}
