// "Find a better version of this picture" — the front of the imagelab engine.
//
// The shape of this dialog follows one rule: NOTHING is replaced without the user seeing both
// pictures first. The engine can tell that a candidate is the same picture and bigger, but it
// cannot tell that it is the same *crop*, the same colour grade, or free of a watermark — and those
// are exactly the ways a "better" copy turns out worse. So the side-by-side is not decoration, it
// is the check the machine cannot do.
//
// And nothing here deletes: "Save this copy" writes the new picture beside the original. Swapping
// the two is the app's ordinary trash + rename, already on the undo stack.
import { app, liq } from '../core/app'
import { openModal, el, closeX, midEllipsize } from './dialogs'
import { toast } from '../views/binstore'
import { formatSize } from '../../shared/sort'
import {
  VERDICT_TEXT, ORIGIN_TEXT, aspectWarning,
  type Candidate, type ImagePreviewWire,
} from '../../shared/imagelab'

interface BetterResultWire {
  ok: boolean
  current: { path: string; name: string; ext: string; bytes: number; width: number; height: number; area: number }
  best: Candidate | null
  tried: Candidate[]
  searchUrl?: string
  captcha?: boolean
  error?: string
}

interface InspectWire {
  path: string; name: string; ext: string; bytes: number
  width: number; height: number; area: number
  worth: { worth: boolean; why: string }
  origin: { url: string; page: string }
  error?: string
}

let open = false

/** Opened with app.emit('show-better-image', [paths]). */
export function mountBetterImage(): void {
  app.on('show-better-image', (paths: string[]) => openBetterImage(paths ?? []))
}

export function openBetterImage(paths: string[]): void {
  if (open || !paths.length) return
  open = true

  const modal = openModal({ width: 860, className: 'dlg-better', onDismiss: () => close() })
  let busy = false
  const close = (): void => {
    if (busy) return                       // never vanish mid-download
    open = false
    modal.close()
  }

  const queue = paths.slice()
  let index = 0

  const head = el('div', 'dlg-title')
  head.append(el('span', 'dlg-title-text', 'Find a better version'), closeX(() => close()))
  const sub = el('div', 'better-sub')
  const body = el('div', 'dlg-body better-body')
  const foot = el('div', 'dlg-buttons')
  modal.dlg.append(head, sub, body, foot)

  // The save action lives in the FOOTER, not next to the pictures. Measured on the first build:
  // with the comparison scrolled into a body panel, "Save this copy" sat below the fold and the
  // only visible primary button was "Search the web" — the search that had already run.
  const btnSave = el('button', 'btn btn-primary', 'Save this copy')
  const btnSearch = el('button', 'btn btn-primary', 'Search the web')
  const btnSkip = el('button', 'btn', 'Next picture')
  const btnClose = el('button', 'btn', 'Close')
  foot.append(btnSave, btnSearch, btnSkip, el('div', 'dlg-buttons-spacer'), btnClose)
  btnSave.hidden = true
  btnClose.addEventListener('click', () => close())
  btnSkip.addEventListener('click', () => { index++; void showCurrent() })

  /** the candidate the footer's Save button would write, or null when there is nothing to save */
  let pending: { file: string; best: Candidate } | null = null
  btnSave.addEventListener('click', () => { if (pending) void doSave(pending.file, pending.best) })

  void showCurrent()

  // ------------------------------------------------------------ one picture

  async function showCurrent(): Promise<void> {
    if (index >= queue.length) {
      sub.textContent = queue.length > 1 ? 'That was the last picture.' : ''
      body.replaceChildren(el('div', 'better-empty', 'Nothing left to look at.'))
      btnSearch.disabled = true
      btnSkip.disabled = true
      btnSave.hidden = true
      return
    }
    const file = queue[index]
    pending = null
    btnSave.hidden = true
    btnSave.disabled = false
    btnSave.textContent = 'Save this copy'
    btnSearch.hidden = false
    btnSkip.disabled = index >= queue.length - 1
    btnSearch.disabled = false
    sub.textContent = queue.length > 1 ? `Picture ${index + 1} of ${queue.length}` : ''
    body.replaceChildren(el('div', 'better-empty', 'Reading the picture…'))

    const facts = await liq.invoke('imageInspect', file).catch(
      (e: Error) => ({ error: String(e?.message ?? e) })) as InspectWire

    const card = el('div', 'better-current')
    const shot = el('img', 'better-shot')
    shot.src = `liqthumb://?path=${encodeURIComponent(file)}&size=large`
    shot.alt = ''
    const facts2 = el('div', 'better-facts')
    facts2.append(
      el('div', 'better-name', facts.name ?? midEllipsize(file)),
      el('div', 'better-dim', facts.width
        ? `${facts.width} × ${facts.height} · ${facts.ext.toUpperCase()} · ${formatSize(facts.bytes)}`
        : (facts.error ?? 'This picture could not be measured.')),
      el('div', 'better-why' + (facts.worth?.worth ? ' good' : ''), facts.worth?.why ?? ''),
    )
    card.append(shot, facts2)
    body.replaceChildren(card)

    // The engine reads the file's own xattr for a source address. Nothing on Linux writes one, so
    // in practice this is always the search — but when a URL IS there, it is free and instant, so
    // it is still tried first and the button says which one it is about to do.
    const hasOrigin = Boolean(facts.origin?.url || facts.origin?.page)
    btnSearch.textContent = hasOrigin ? 'Look for a bigger copy' : 'Search the web'

    btnSearch.onclick = () => { void run(file, card) }
  }

  // ------------------------------------------------------------ the search

  async function run(file: string, card: HTMLElement): Promise<void> {
    busy = true
    btnSearch.disabled = true
    btnSearch.textContent = 'Searching…'
    btnSkip.disabled = true
    const status = el('div', 'better-status', 'Uploading the picture and reading the results — this takes a few seconds.')
    body.replaceChildren(card, status)

    const res = await liq.invoke('imageFindBetter', file, undefined, undefined, true).catch(
      (e: Error) => ({ ok: false, error: String(e?.message ?? e), tried: [], best: null })) as BetterResultWire

    busy = false
    btnSkip.disabled = index >= queue.length - 1
    btnSearch.disabled = false
    btnSearch.textContent = 'Search again'
    btnSearch.classList.remove('btn-primary')
    btnSearch.classList.add('btn')

    if (res.captcha) {
      status.className = 'better-status bad'
      status.textContent = 'The search engine is asking for a captcha, so it stopped rather than '
        + 'keep asking. Waiting a few minutes is usually what fixes this.'
      const forget = el('button', 'btn btn-small', 'Forget the search cookies')
      forget.title = 'Clears the cookies this feature has collected. It touches nothing you browse '
        + 'with — and it only helps if the block is being held by a cookie rather than by your '
        + 'network address, which is the more common cause.'
      forget.addEventListener('click', () => {
        void liq.invoke('imagelabForget').then(() => toast({ text: 'Search cookies cleared.' }))
      })
      status.after(forget)
      return
    }
    if (!res.best) {
      status.className = 'better-status'
      status.textContent = res.tried?.length
        ? `Looked at ${res.tried.length} ${res.tried.length === 1 ? 'copy' : 'copies'} — none was both the same picture and bigger.`
        : (res.error ?? 'Nothing was found.')
      if (res.tried?.length) status.after(triedList(res.tried))
      return
    }

    status.remove()
    body.replaceChildren(card, await comparison(file, res))
  }

  // --------------------------------------------------- side by side + save

  async function comparison(file: string, res: BetterResultWire): Promise<HTMLElement> {
    const best = res.best!
    const wrap = el('div', 'better-found')
    const gain = (best.width * best.height) / Math.max(1, res.current.area)
    wrap.append(el('div', 'better-head', `Found a copy ${gain.toFixed(1)}× the area — check it is the picture you want.`))
    const shape = aspectWarning(res.current.width, res.current.height, best.width, best.height)
    if (shape) wrap.append(el('div', 'better-warn', shape[0].toUpperCase() + shape.slice(1) + '.'))

    const pair = el('div', 'better-pair')
    const right = el('div', 'better-side')
    right.append(el('div', 'better-side-label', 'The copy that was found'))
    const img = el('img', 'better-shot big')
    img.alt = ''
    right.append(img, el('div', 'better-dim',
      `${best.width} × ${best.height} · ${formatSize(best.bytes)} · ${ORIGIN_TEXT[best.origin]}`))

    const left = el('div', 'better-side')
    left.append(el('div', 'better-side-label', 'What you have now'))
    const mine = el('img', 'better-shot big')
    mine.src = `liqthumb://?path=${encodeURIComponent(file)}&size=x-large`
    mine.alt = ''
    left.append(mine, el('div', 'better-dim',
      `${res.current.width} × ${res.current.height} · ${formatSize(res.current.bytes)}`))

    pair.append(left, right)
    wrap.append(pair)

    // remote bytes never reach the renderer directly — CSP forbids it, so main hands back a data:
    const prev = await liq.invoke('imagePreview', best.url).catch(() => null) as ImagePreviewWire | null
    if (prev?.ok && prev.dataUrl) img.src = prev.dataUrl
    else right.append(el('div', 'better-dim bad', 'That copy could not be shown, only measured.'))

    pending = { file, best }
    btnSave.hidden = false
    wrap.append(el('div', 'better-note',
      'Saving puts the new picture next to this one as "(better)". Nothing is deleted — once you '
      + 'have compared them, delete the one you do not want.'))
    if (res.tried.length > 1) wrap.append(triedList(res.tried))
    return wrap
  }

  async function doSave(file: string, best: Candidate): Promise<void> {
    busy = true
    const btn = btnSave
    btn.disabled = true
    btn.textContent = 'Saving…'
    const r = await liq.invoke('imageSaveBetter', file, best).catch(
      (e: Error) => ({ ok: false, error: String(e?.message ?? e) })) as { ok: boolean; file?: string; error?: string }
    busy = false
    if (!r.ok) {
      btn.disabled = false
      btn.textContent = 'Save this copy'
      toast({ text: r.error ?? 'That copy could not be saved.', bad: true })
      return
    }
    btn.textContent = 'Saved'
    toast({ text: `Saved as ${r.file?.split('/').pop()}` })
  }

  /** the full list, collapsed — useful when the answer is "no" and you want to know what was looked at */
  function triedList(tried: Candidate[]): HTMLElement {
    const d = el('details', 'better-tried')
    d.append(el('summary', '', `Everything that was looked at (${tried.length})`))
    for (const c of tried) {
      const row = el('div', 'better-tried-row')
      row.append(
        el('span', 'better-tried-verdict ' + c.verdict, VERDICT_TEXT[c.verdict] ?? c.verdict),
        el('span', 'better-tried-dim', c.width ? `${c.width}×${c.height}` : '—'),
        el('span', 'better-tried-url', midEllipsize(c.url, 60)),
      )
      row.title = c.why || c.url
      d.append(row)
    }
    return d
  }
}
