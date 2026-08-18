// The batch plan table — "find better versions of these 40 pictures, then let me look at it".
//
// This is a PLAN, not a sweep. The scan writes nothing; it produces a list of what could be
// replaced, and the replacing happens only for rows the user ticks. That is the difference the design
// asked for ("or even a batch finder where I can select multiple images then plan it like that")
// and it is also the only honest way to do it: the engine can prove a candidate is the same picture
// and bigger, but not that it is the same crop, grade, or free of a watermark.
//
// So every row can be opened into the same side-by-side the single-picture dialog uses, and rows
// start UNTICKED. Ticking is the approval.
import { app, liq } from '../core/app'
import { openModal, el, closeX } from './dialogs'
import { toast } from '../views/binstore'
import { formatSize } from '../../shared/sort'
import { PUSH } from '../../shared/ipc'
import {
  STOP_TEXT, ORIGIN_TEXT, aspectWarning,
  type BatchProgress, type BatchRow, type BatchStop, type Candidate, type ImagePreviewWire,
} from '../../shared/imagelab'

let open = false

export function mountBetterBatch(): void {
  app.on('show-better-batch', (paths: string[]) => openBetterBatch(paths ?? []))
}

export function openBetterBatch(paths: string[]): void {
  if (open || !paths.length) return
  open = true

  const modal = openModal({ width: 1000, className: 'dlg-batch', onDismiss: () => close() })
  let scanning = false
  let applying = false
  const close = (): void => {
    if (applying) return                     // never vanish mid-write
    if (scanning) { void liq.invoke('imageBatchCancel') }
    off()
    open = false
    modal.close()
  }

  const head = el('div', 'dlg-title')
  head.append(el('span', 'dlg-title-text', `Find better versions — ${paths.length} pictures`), closeX(() => close()))
  const status = el('div', 'batch-status')
  const list = el('div', 'dlg-body batch-list')
  const foot = el('div', 'dlg-buttons')

  const btnSave = el('button', 'btn btn-primary', 'Save 0 copies')
  const btnStop = el('button', 'btn', 'Stop')
  const btnAll = el('button', 'btn btn-small', 'Tick all')
  const btnClose = el('button', 'btn', 'Close')
  foot.append(btnSave, btnAll, btnStop, el('div', 'dlg-buttons-spacer'), btnClose)
  btnSave.disabled = true
  modal.dlg.append(head, status, list, foot)
  btnClose.addEventListener('click', () => close())
  btnStop.addEventListener('click', () => { void liq.invoke('imageBatchCancel'); btnStop.disabled = true })

  /** the plan, keyed by file so a progress message can find its row */
  interface Entry { row: BatchRow; node: HTMLElement; chosen: boolean; pane?: HTMLElement }
  const rows = new Map<string, Entry>()

  btnAll.addEventListener('click', () => {
    const found = [...rows.values()].filter(r => r.row.state === 'found')
    const turnOn = found.some(r => !r.chosen)
    for (const r of found) {
      r.chosen = turnOn
      const cb = r.node.querySelector<HTMLInputElement>('.batch-check')
      if (cb) cb.checked = turnOn
      r.node.classList.toggle('chosen', turnOn)
    }
    refreshSave()
  })

  btnSave.addEventListener('click', () => { void apply() })

  // ------------------------------------------------------------------ live progress

  const onProgress = (p: BatchProgress): void => {
    if (p.rows) for (const r of p.rows) upsert(r)
    if (p.row) upsert(p.row)
    if (p.finished) {
      scanning = false
      btnStop.disabled = true
      finish(p)
    } else {
      const found = [...rows.values()].filter(r => r.row.state === 'found').length
      status.textContent = `Checked ${p.done} of ${p.total} — ${found} better ${found === 1 ? 'copy' : 'copies'} found so far.`
    }
  }
  // liq.on RETURNS the unsubscribe — there is no liq.off. Getting that wrong leaks a listener per
  // reopen, and the stale ones keep painting rows into a dialog that is no longer on screen.
  const off = liq.on(PUSH.imageBatch, onProgress)

  function finish(p: BatchProgress): void {
    const found = [...rows.values()].filter(r => r.row.state === 'found')
    // "Sort by biggest gain so the worthwhile ones float up" — done once, at the end, rather than
    // shuffling the list under the user while they are watching it fill in.
    const sorted = [...rows.values()].sort((a, b) => {
      if (a.row.state === 'found' && b.row.state !== 'found') return -1
      if (b.row.state === 'found' && a.row.state !== 'found') return 1
      return b.row.gain - a.row.gain
    })
    // the pane rides with its row — appending only the rows would leave an open comparison
    // stranded next to whatever happened to be there before
    for (const r of sorted) { list.append(r.node); if (r.pane) list.append(r.pane) }

    if (p.stopped) {
      status.className = 'batch-status bad'
      const checked = `${p.done} of ${p.total} checked`
      status.textContent = `${STOP_TEXT[p.stopped as BatchStop]} ${checked}, `
        + `${found.length} with a better copy.`
    } else {
      status.className = 'batch-status'
      status.textContent = found.length
        ? `${found.length} of ${p.total} ${found.length === 1 ? 'picture has' : 'pictures have'} a better copy available. `
          + 'Tick the ones to save — nothing is written until you do.'
        : `Checked all ${p.total} — none had a copy that was both the same picture and bigger.`
    }
    refreshSave()
  }

  // ------------------------------------------------------------------ one row

  function upsert(row: BatchRow): void {
    const existing = rows.get(row.file)
    if (existing) {
      existing.row = row
      paint(existing)
      return
    }
    const node = el('div', 'batch-row')
    const entry: Entry = { row, node, chosen: false }
    rows.set(row.file, entry)
    list.append(node)
    paint(entry)
  }

  function paint(entry: Entry): void {
    const { row, node } = entry
    node.replaceChildren()
    node.className = 'batch-row state-' + row.state + (entry.chosen ? ' chosen' : '')

    const cb = el('input', 'batch-check') as HTMLInputElement
    cb.type = 'checkbox'
    cb.checked = entry.chosen
    cb.disabled = row.state !== 'found'
    cb.addEventListener('change', () => {
      entry.chosen = cb.checked
      node.classList.toggle('chosen', cb.checked)
      refreshSave()
    })

    const thumb = el('img', 'batch-thumb')
    thumb.src = `liqthumb://?path=${encodeURIComponent(row.file)}&size=normal`
    thumb.alt = ''

    const mid = el('div', 'batch-mid')
    mid.append(el('div', 'batch-name', row.name))
    mid.append(el('div', 'batch-now', row.width
      ? `${row.width} × ${row.height} · ${row.ext.toUpperCase()} · ${formatSize(row.bytes)}`
      : 'could not be measured'))

    const right = el('div', 'batch-right')
    if (row.state === 'found' && row.best) {
      right.append(el('div', 'batch-gain', `${row.gain.toFixed(1)}× bigger`))
      right.append(el('div', 'batch-cand',
        `${row.best.width} × ${row.best.height} · ${formatSize(row.best.bytes)}`))
      const shape = aspectWarning(row.width, row.height, row.best.width, row.best.height)
      if (shape) right.append(el('div', 'batch-warn', shape))
      const look = el('button', 'btn btn-small', 'Compare')
      look.addEventListener('click', () => { void expand(entry, look) })
      right.append(look)
    } else {
      right.append(el('div', 'batch-state', stateText(row)))
    }

    node.append(cb, thumb, mid, right)
  }

  function stateText(row: BatchRow): string {
    switch (row.state) {
      case 'waiting': return 'waiting'
      case 'looking': return 'looking…'
      case 'nothing': return row.looked ? `nothing better in ${row.looked} looked at` : (row.error ?? 'nothing found')
      case 'error': return row.error ?? 'could not be read'
      case 'stopped': return 'not checked — the run stopped'
      default: return ''
    }
  }

  /** the side-by-side, inline under the row — the check the machine cannot do */
  async function expand(entry: Entry, btn: HTMLButtonElement): Promise<void> {
    if (entry.pane) { entry.pane.remove(); entry.pane = undefined; btn.textContent = 'Compare'; return }
    btn.textContent = 'Hide'
    const best = entry.row.best!
    const pane = el('div', 'batch-compare')

    const mk = (label: string, sub: string): { box: HTMLElement; img: HTMLImageElement } => {
      const box = el('div', 'better-side')
      box.append(el('div', 'better-side-label', label))
      const img = el('img', 'better-shot big')
      img.alt = ''
      box.append(img, el('div', 'better-dim', sub))
      return { box, img }
    }
    const mine = mk('What you have now', `${entry.row.width} × ${entry.row.height} · ${formatSize(entry.row.bytes)}`)
    mine.img.src = `liqthumb://?path=${encodeURIComponent(entry.row.file)}&size=x-large`
    const found = mk('The copy that was found',
      `${best.width} × ${best.height} · ${formatSize(best.bytes)} · ${ORIGIN_TEXT[best.origin]}`)
    const shape = aspectWarning(entry.row.width, entry.row.height, best.width, best.height)
    if (shape) found.box.append(el('div', 'better-warn', shape[0].toUpperCase() + shape.slice(1) + '.'))

    const pair = el('div', 'better-pair')
    pair.append(mine.box, found.box)
    pane.append(pair)
    entry.node.after(pane)
    entry.pane = pane

    // remote bytes never reach the renderer directly — main hands back a data: URL
    const prev = await liq.invoke('imagePreview', best.url).catch(() => null) as ImagePreviewWire | null
    if (prev?.ok && prev.dataUrl) found.img.src = prev.dataUrl
    else found.box.append(el('div', 'better-dim bad', 'That copy could not be shown, only measured.'))
  }

  function refreshSave(): void {
    const n = [...rows.values()].filter(r => r.chosen).length
    btnSave.textContent = n === 1 ? 'Save 1 copy' : `Save ${n} copies`
    btnSave.disabled = n === 0 || scanning || applying
    btnAll.disabled = ![...rows.values()].some(r => r.row.state === 'found')
  }

  // ------------------------------------------------------------------ applying

  async function apply(): Promise<void> {
    const chosen = [...rows.values()].filter(r => r.chosen && r.row.best)
    if (!chosen.length) return
    applying = true
    btnSave.disabled = true
    btnSave.textContent = 'Saving…'
    status.className = 'batch-status'
    status.textContent = `Saving ${chosen.length} ${chosen.length === 1 ? 'copy' : 'copies'}…`

    const res = await liq.invoke('imageBatchApply',
      chosen.map(r => ({ file: r.row.file, best: r.row.best as Candidate }))).catch(
      (e: Error) => ({ saved: [], failed: [{ file: '', error: String(e?.message ?? e) }] })
    ) as { saved: { file: string; saved: string }[]; failed: { file: string; error: string }[] }

    applying = false
    btnSave.textContent = 'Saved'
    const n = res.saved.length
    status.textContent = res.failed.length
      ? `Saved ${n}, and ${res.failed.length} could not be saved (${res.failed[0].error}).`
      : `Saved ${n} ${n === 1 ? 'copy' : 'copies'} beside the originals. Nothing was deleted.`
    toast({ text: `Saved ${n} better ${n === 1 ? 'copy' : 'copies'}`, bad: res.failed.length > 0 })
    for (const r of res.saved) rows.get(r.file)?.node.classList.add('saved')
  }

  // ------------------------------------------------------------------ go

  status.textContent = `Checking ${paths.length} pictures — this is paced on purpose, so it takes a while.`
  scanning = true
  void liq.invoke('imageBatchScan', paths).then((r: unknown) => {
    const res = r as { busy?: boolean }
    if (res?.busy) {
      scanning = false
      status.className = 'batch-status bad'
      status.textContent = 'Another batch is already running. Let that one finish first.'
      btnStop.disabled = true
    }
  })
}
