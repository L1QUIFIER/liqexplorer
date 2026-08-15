// Bulk rename — the operation people leave a file manager for (PowerToys
// PowerRename is the reference; Explorer itself only offers "name (1), name (2)").
//
// Two modes that cover almost every real job:
//   Find & replace — plain text or a regular expression, optionally case-
//                    sensitive, applied to the name, the extension or both.
//   Pattern        — a template with {name} {ext} {n} {parent} {date} …, which
//                    is how you number a folder of photos.
// Either result then goes through the tidying rules (case, spaces).
//
// This file is now only the FORM. What the rules mean lives in
// shared/renameplan.ts, which the docked Rename tab calls with the same rules
// object — the two surfaces cannot preview different answers, and the planner
// is the piece that can be tested without a window.
//
// Everything is previewed before anything happens, and the rename itself goes
// through the same batch path the name fixer uses, so the whole job is ONE
// Ctrl+Z.
import { app, liq } from '../core/app'
import type { FileEntry } from '../../shared/types'
import {
  planRenames, runnableRows, summarizePlan, folderNamesFrom,
  DEFAULT_RENAME_RULES, RENAME_TOKENS,
  type RenameRules, type RenameRow, type CaseRule, type SpaceRule,
} from '../../shared/renameplan'
import { openModal, el, closeX } from './dialogs'

const TOKEN_HELP = RENAME_TOKENS.map(t => `${t.token} ${t.help}`).join(' · ')

/** the docked Rename tab hands its rules over so nothing is retyped */
export interface BulkRenameRequest {
  paths: string[]
  rules?: RenameRules
}

export function mountBulkRename(): void {
  app.on('show-bulk-rename', (req: string[] | BulkRenameRequest) => {
    const { paths, rules } = Array.isArray(req) ? { paths: req, rules: undefined } : req
    void show(paths, rules)
  })
}

async function show(paths: string[], initial?: RenameRules): Promise<void> {
  if (!paths?.length) return
  const stats = await liq.statEntries(paths) as (FileEntry | null)[]
  const entries = stats.filter((e): e is FileEntry => !!e)
  if (!entries.length) return

  const rules: RenameRules = { ...DEFAULT_RENAME_RULES, ...initial }

  // Siblings come from the listing already in memory: a rule that lands on an
  // UNSELECTED file has to be caught here, not by fixNames refusing it later.
  const folderNames = folderNamesFrom([...app.activeTab.rows, ...entries])

  const modal = openModal({ width: 620, className: 'dlg-bulkrename', onDismiss: () => modal.close() })

  const titleRow = el('div', 'dlg-title')
  titleRow.appendChild(el('span', 'dlg-title-text', `Rename ${entries.length} items`))
  titleRow.appendChild(closeX(() => modal.close()))

  const body = el('div', 'dlg-body brn-body')

  // ---- mode tabs ----
  const tabs = el('div', 'dlg-tabs')
  const tabReplace = el('button', 'dlg-tab active', 'Find and replace')
  const tabPattern = el('button', 'dlg-tab', 'Pattern')
  tabs.append(tabReplace, tabPattern)

  const replaceForm = el('div', 'brn-form')
  const findIn = field(replaceForm, 'Find', rules.find, v => { rules.find = v; refresh() })
  field(replaceForm, 'Replace with', rules.replace, v => { rules.replace = v; refresh() })
  const optRow = el('div', 'brn-opts')
  checkbox(optRow, 'Regular expression', rules.useRegex, v => { rules.useRegex = v; refresh() })
  checkbox(optRow, 'Match case', rules.matchCase, v => { rules.matchCase = v; refresh() })
  replaceForm.appendChild(optRow)
  const scopeRow = el('div', 'brn-opts')
  radio(scopeRow, 'brn-scope', 'Name only', rules.scope === 'name', () => { rules.scope = 'name'; refresh() })
  radio(scopeRow, 'brn-scope', 'Extension only', rules.scope === 'ext', () => { rules.scope = 'ext'; refresh() })
  radio(scopeRow, 'brn-scope', 'Whole file name', rules.scope === 'full', () => { rules.scope = 'full'; refresh() })
  replaceForm.appendChild(scopeRow)

  const patternForm = el('div', 'brn-form')
  patternForm.hidden = true
  field(patternForm, 'Pattern', rules.pattern, v => { rules.pattern = v; refresh() })
  patternForm.appendChild(el('div', 'brn-hint', TOKEN_HELP))
  const numRow = el('div', 'brn-opts')
  numberField(numRow, 'Start at', rules.start, v => { rules.start = v; refresh() })
  numberField(numRow, 'Step', rules.step, v => { rules.step = v; refresh() })
  numberField(numRow, 'Digits', rules.pad, v => { rules.pad = v; refresh() })
  patternForm.appendChild(numRow)

  // ---- tidying: applies to whichever mode produced the name ----
  const tidyRow = el('div', 'brn-opts')
  select<CaseRule>(tidyRow, 'Case', [
    ['leave', 'Leave case'], ['lower', 'lower case'], ['upper', 'UPPER CASE'],
    ['title', 'Title Case'], ['sentence', 'Sentence case'],
  ], rules.caseRule, v => { rules.caseRule = v; refresh() })
  select<SpaceRule>(tidyRow, 'Spaces', [
    ['leave', 'Keep spaces'], ['underscore', 'Spaces to _'], ['dash', 'Spaces to -'],
  ], rules.spaces, v => { rules.spaces = v; refresh() })
  checkbox(tidyRow, 'Trim', rules.trim, v => { rules.trim = v; refresh() })
  checkbox(tidyRow, 'Collapse spaces', rules.collapseSpaces, v => { rules.collapseSpaces = v; refresh() })

  const summary = el('div', 'brn-summary')
  const list = el('div', 'brn-list')

  body.append(tabs, replaceForm, patternForm, tidyRow, summary, list)

  const buttons = el('div', 'dlg-buttons')
  const okBtn = el('button', 'btn btn-primary', 'Rename')
  const cancelBtn = el('button', 'btn', 'Cancel')
  buttons.append(okBtn, cancelBtn)
  cancelBtn.addEventListener('click', () => modal.close())

  const selectMode = (m: 'replace' | 'pattern'): void => {
    rules.mode = m
    tabReplace.classList.toggle('active', m === 'replace')
    tabPattern.classList.toggle('active', m === 'pattern')
    replaceForm.hidden = m !== 'replace'
    patternForm.hidden = m !== 'pattern'
    refresh()
  }
  tabReplace.addEventListener('click', () => selectMode('replace'))
  tabPattern.addEventListener('click', () => selectMode('pattern'))

  /** the rows on screen ARE the rows that run — never re-planned at submit time */
  let rows: RenameRow<FileEntry>[] = []

  function refresh(): void {
    const plan = planRenames(entries, rules, { folderNames })
    rows = plan.rows
    const { runnable, blocked, total } = summarizePlan(rows)

    summary.textContent = plan.error ? plan.error
      : blocked ? `${runnable} will be renamed · ${blocked} cannot be`
        : `${runnable} of ${total} will be renamed`
    summary.classList.toggle('has-problems', !!plan.error || blocked > 0)
    okBtn.disabled = runnable === 0
    okBtn.textContent = runnable ? `Rename ${runnable}` : 'Rename'

    list.textContent = ''
    for (const r of rows) {
      const row = el('div', 'brn-row' + (r.problem ? ' is-bad' : r.changed ? '' : ' is-same'))
      row.appendChild(el('span', 'brn-old', r.entry.name))
      row.appendChild(el('span', 'brn-arrow', '→'))
      row.appendChild(el('span', 'brn-new', r.problem ? r.problem : r.to))
      list.appendChild(row)
    }
  }

  okBtn.addEventListener('click', () => {
    const todo = runnableRows(rows)
    if (!todo.length) return
    okBtn.disabled = true
    // same batch path the name fixer uses: one operation, one undo entry
    void liq.invoke('fixNames', todo.map(r => ({ from: r.entry.path, to: r.to })))
      .then(() => { modal.close(); app.activeTab?.refresh() })
      .catch(() => { okBtn.disabled = false })
  })

  modal.dlg.append(titleRow, body, buttons)
  selectMode(rules.mode)
  findIn.focus()
}

// ---- small form helpers (match the Options dialog's shapes) ----

function field(
  parent: HTMLElement, label: string, value: string, onInput: (v: string) => void,
): HTMLInputElement {
  const wrap = el('label', 'brn-field')
  wrap.appendChild(el('span', 'brn-label', label))
  const input = el('input', 'dlg-input')
  input.value = value
  input.spellcheck = false
  input.addEventListener('input', () => onInput(input.value))
  wrap.appendChild(input)
  parent.appendChild(wrap)
  return input
}

function numberField(parent: HTMLElement, label: string, value: number, onInput: (v: number) => void): void {
  const wrap = el('label', 'brn-field brn-num')
  wrap.appendChild(el('span', 'brn-label', label))
  const input = el('input', 'dlg-input')
  input.type = 'number'
  input.value = String(value)
  input.addEventListener('input', () => onInput(Number(input.value) || 0))
  wrap.appendChild(input)
  parent.appendChild(wrap)
}

function checkbox(parent: HTMLElement, label: string, checked: boolean, onChange: (v: boolean) => void): void {
  const wrap = el('label', 'opt-check')
  const box = el('input')
  box.type = 'checkbox'
  box.checked = checked
  box.addEventListener('change', () => onChange(box.checked))
  wrap.append(box, el('span', '', label))
  parent.appendChild(wrap)
}

function radio(
  parent: HTMLElement, name: string, label: string, checked: boolean, onPick: () => void,
): void {
  const wrap = el('label', 'opt-check')
  const b = el('input')
  b.type = 'radio'
  b.name = name
  b.checked = checked
  b.addEventListener('change', () => { if (b.checked) onPick() })
  wrap.append(b, el('span', '', label))
  parent.appendChild(wrap)
}

function select<T extends string>(
  parent: HTMLElement, title: string, options: [T, string][], value: T, onPick: (v: T) => void,
): void {
  const sel = el('select', 'dlg-input brn-select')
  sel.title = title
  for (const [v, label] of options) {
    const o = el('option', '', label)
    o.value = v
    sel.appendChild(o)
  }
  sel.value = value
  sel.addEventListener('change', () => onPick(sel.value as T))
  parent.appendChild(sel)
}
