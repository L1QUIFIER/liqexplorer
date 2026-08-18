// "Save this PDF as pictures".
//
// The dialog exists because the answer is never just a format. Exporting a PDF
// to an image has three settings that decide whether the result is any use, and
// every one of them is invisible until it is wrong:
//
//   * RESOLUTION. The same page at 96 and at 600 dpi differ by forty times the
//     pixels. Neither is right in general — one is for a screen, one is for a
//     printer — so the choice is offered with the pixel size spelled out rather
//     than buried behind a "quality" word.
//   * WHICH PAGES. A 400-page document exported page-by-page into the folder you
//     were looking at is a mess nobody asked for.
//   * BACKGROUND. A PDF page has no background, so PNG output is transparent
//     unless something fills it — which reads as a blank page in half the places
//     you would open it.
//
// The format list comes from main and is CAPABILITY-PROBED, so a format this
// machine cannot really write never appears. Vector formats hide the resolution
// control entirely, because for them it means nothing.
import { app, liq } from '../core/app'
import { openModal, el, closeX } from './dialogs'
import { toast } from '../views/binstore'
import {
  PDF_DPI_PRESETS, PDF_EXPORT_PROGRESS, estimatePixels,
  type PdfExportFormat, type PdfExportProgress,
} from '../../shared/pdfexport'

export function mountPdfExport(): void {
  app.on('show-pdf-export', (req: { path: string; page?: number }) => { void show(req) })
}

async function show(req: { path: string; page?: number }): Promise<void> {
  const src = req?.path
  if (!src?.toLowerCase().endsWith('.pdf')) return

  const [formats, pages] = await Promise.all([
    liq.invoke('pdfExportFormats').catch(() => []) as Promise<PdfExportFormat[]>,
    liq.invoke('pdfPageCount', src).catch(() => 0) as Promise<number>,
  ])
  if (!formats.length) {
    toast({ text: 'No image formats are available on this computer.', bad: true })
    return
  }
  if (!pages) { toast({ text: 'That PDF could not be read.', bad: true }); return }

  const name = src.split('/').pop() ?? 'document.pdf'
  const dir = src.slice(0, src.lastIndexOf('/')) || '/'
  const modal = openModal({ width: 520, className: 'dlg-pdfexport' })

  const title = el('div', 'dlg-title')
  title.append(el('span', 'dlg-title-text', 'Save as pictures'), closeX(() => modal.close()))
  const body = el('div', 'dlg-body')

  body.appendChild(el('div', 'dlg-msg',
    `${name} — ${pages} ${pages === 1 ? 'page' : 'pages'}`))

  // ---- format ----
  const fmtRow = el('div', 'pe-row')
  fmtRow.appendChild(el('label', 'pe-label', 'Format'))
  const fmtSel = document.createElement('select')
  fmtSel.className = 'dlg-input pe-select'
  for (const f of formats) {
    const o = document.createElement('option')
    o.value = f.id
    o.textContent = f.label
    fmtSel.appendChild(o)
  }
  fmtSel.value = formats.some(f => f.id === 'png') ? 'png' : formats[0].id
  fmtRow.appendChild(fmtSel)
  body.appendChild(fmtRow)

  // ---- resolution ----
  const dpiRow = el('div', 'pe-row')
  dpiRow.appendChild(el('label', 'pe-label', 'Resolution'))
  const dpiSel = document.createElement('select')
  dpiSel.className = 'dlg-input pe-select'
  for (const p of PDF_DPI_PRESETS) {
    const o = document.createElement('option')
    o.value = String(p.dpi)
    // the pixel size is the fact people actually need; the prose is a hint
    o.textContent = `${p.label} · ${p.dpi} dpi · ${estimatePixels(p.dpi)} px · ${p.note}`
    dpiSel.appendChild(o)
  }
  dpiSel.value = '150'
  dpiRow.appendChild(dpiSel)
  body.appendChild(dpiRow)

  // ---- pages ----
  const pgRow = el('div', 'pe-row')
  pgRow.appendChild(el('label', 'pe-label', 'Pages'))
  const pgWrap = el('div', 'pe-pages')
  const allRadio = radio('pe-pages', 'Every page', true)
  const oneRadio = radio('pe-pages', req.page ? `This page (${req.page})` : 'First page only', false)
  const rangeRadio = radio('pe-pages', 'Pages', false)
  const fromIn = numberInput(1, pages, req.page ?? 1)
  const toIn = numberInput(1, pages, pages)
  const rangeLine = el('div', 'pe-range')
  rangeLine.append(rangeRadio.label, fromIn, el('span', '', 'to'), toIn)
  pgWrap.append(allRadio.label, oneRadio.label, rangeLine)
  pgRow.appendChild(pgWrap)
  body.appendChild(pgRow)

  // ---- options ----
  const optRow = el('div', 'pe-row')
  optRow.appendChild(el('label', 'pe-label', 'Options'))
  const opts = el('div', 'pe-opts')
  const transp = check('Keep the page background transparent', false)
  const combine = check('Join every page into one tall picture', false)
  opts.append(transp.label, combine.label)
  optRow.appendChild(opts)
  body.appendChild(optRow)

  const note = el('div', 'pe-note')
  body.appendChild(note)

  const bar = el('div', 'pe-bar')
  const barFill = el('div', 'pe-bar-fill')
  bar.appendChild(barFill)
  bar.hidden = true
  body.appendChild(bar)

  const buttons = el('div', 'dlg-buttons')
  const cancel = el('button', 'btn', 'Cancel')
  const go = el('button', 'btn btn-primary', 'Save pictures')
  buttons.append(cancel, go)

  modal.dlg.append(title, body, buttons)

  /** vector formats have no resolution and cannot be joined */
  function syncEnabled(): void {
    const f = formats.find(x => x.id === fmtSel.value)
    const vector = !!f?.vector
    dpiSel.disabled = vector
    dpiRow.classList.toggle('is-off', vector)
    combine.input.disabled = vector
    combine.label.classList.toggle('is-off', vector)
    transp.input.disabled = vector
    transp.label.classList.toggle('is-off', vector)
    const n = allRadio.input.checked ? pages
      : oneRadio.input.checked ? 1
        : Math.max(0, Number(toIn.value) - Number(fromIn.value) + 1)
    note.textContent = vector
      ? `${n} ${n === 1 ? 'file' : 'files'} — vector output stays sharp at any size, so resolution does not apply.`
      : combine.input.checked
        ? `One picture, ${n} ${n === 1 ? 'page' : 'pages'} tall.`
        : `${n} ${n === 1 ? 'picture' : 'pictures'}, written beside the PDF.`
  }
  fmtSel.addEventListener('change', syncEnabled)
  for (const r of [allRadio, oneRadio, rangeRadio]) r.input.addEventListener('change', syncEnabled)
  for (const i of [fromIn, toIn]) i.addEventListener('input', syncEnabled)
  combine.input.addEventListener('change', syncEnabled)
  syncEnabled()

  let runId = 0
  let off: (() => void) | null = null
  const finish = (): void => { off?.(); off = null }

  cancel.addEventListener('click', () => {
    if (runId) void liq.invoke('pdfExportCancel', runId).catch(() => { /* already gone */ })
    finish()
    modal.close()
  })

  go.addEventListener('click', () => {
    const f = formats.find(x => x.id === fmtSel.value)
    if (!f) return
    const range = allRadio.input.checked ? {}
      : oneRadio.input.checked ? { from: req.page ?? 1, to: req.page ?? 1 }
        : { from: Number(fromIn.value), to: Number(toIn.value) }

    go.disabled = true
    fmtSel.disabled = dpiSel.disabled = true
    bar.hidden = false
    cancel.textContent = 'Stop'

    off = liq.on(PDF_EXPORT_PROGRESS, (raw: unknown) => {
      const p = raw as PdfExportProgress
      if (runId && p.runId !== runId) return
      const pct = p.total > 0 ? Math.round((p.done / p.total) * 100) : 0
      barFill.style.width = `${pct}%`
      note.textContent = p.status === 'running'
        ? `${p.current || 'Working…'} — ${p.done} of ${p.total}`
        : note.textContent
      if (p.status === 'done') {
        finish()
        toast({ text: `Saved ${p.written} ${p.written === 1 ? 'picture' : 'pictures'}`, sub: dir })
        // land the user on the result rather than describing it
        if (p.outputs.length) app.activeTab?.setSelection(new Set(p.outputs.slice(0, 200)))
        modal.close()
      } else if (p.status === 'error') {
        finish()
        go.disabled = false
        fmtSel.disabled = dpiSel.disabled = false
        cancel.textContent = 'Cancel'
        bar.hidden = true
        note.textContent = p.error ?? 'That did not work.'
        note.classList.add('is-error')
      } else if (p.status === 'cancelled') {
        finish()
        modal.close()
      }
    })

    void liq.invoke('pdfExport', {
      src, dest: dir, format: f.id,
      dpi: Number(dpiSel.value) || 150,
      transparent: transp.input.checked && !f.vector,
      combine: combine.input.checked && !f.vector,
      quality: f.lossy ? 90 : undefined,
      ...range,
    }).then((id: unknown) => { runId = Number(id) || 0 })
      .catch((e: Error) => {
        finish()
        note.textContent = String(e?.message ?? e)
        note.classList.add('is-error')
        go.disabled = false
      })
  })
}

// ------------------------------------------------------------------ widgets

function radio(name: string, text: string, checked: boolean): { label: HTMLLabelElement; input: HTMLInputElement } {
  const label = el('label', 'pe-choice')
  const input = document.createElement('input')
  input.type = 'radio'
  input.name = name
  input.checked = checked
  label.append(input, el('span', '', text))
  return { label, input }
}

function check(text: string, checked: boolean): { label: HTMLLabelElement; input: HTMLInputElement } {
  const label = el('label', 'pe-choice')
  const input = document.createElement('input')
  input.type = 'checkbox'
  input.checked = checked
  label.append(input, el('span', '', text))
  return { label, input }
}

function numberInput(min: number, max: number, value: number): HTMLInputElement {
  const i = document.createElement('input')
  i.type = 'number'
  i.className = 'dlg-input pe-num'
  i.min = String(min)
  i.max = String(max)
  i.value = String(value)
  return i
}
