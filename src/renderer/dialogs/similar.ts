// "Find repeated pictures" — the same picture saved more than once on THIS computer.
//
// It used to render through the generic text report: a name and a byte count per row, no picture,
// no progress, no actions. For a tool whose entire question is "which of these two is the one I
// want to keep", that is unusable — you cannot answer it from a filename, and the thing being
// compared was never shown. Worse, the scan ran invisibly for minutes and then a dialog appeared,
// which is indistinguishable from the app having hung.
//
// So this dialog is built around three things the report could not do:
//
//   * It opens IMMEDIATELY, with a live phase and count and a Stop button. The work is visible.
//   * Every file is a THUMBNAIL with its dimensions. The keeper is marked and explained.
//   * The copies can actually be dealt with — moved to the Recycle Bin through the ops engine, so
//     it lands on the undo stack like every other delete in this app.
//
// Nothing is ticked by default. A de-duplicator that pre-selects files for deletion is one
// mis-click from throwing away originals, and "biggest is the keeper" is a heuristic, not a fact.
import { app, liq } from '../core/app'
import { openModal, el, closeX } from './dialogs'
import { toast } from '../views/binstore'
import { formatSize } from '../../shared/sort'
import { PUSH } from '../../shared/ipc'
import { PHASE_TEXT, type SimilarFile, type SimilarProgress, type SimilarResult } from '../../shared/similar'

let open = false

/** detail for app.emit('show-similar', root | { root, paths }) */
export type SimilarRequest = string | { root?: string; paths?: string[] } | undefined

export function mountSimilar(): void {
  app.on('show-similar', (req: SimilarRequest) => { void openSimilar(req) })
}

export async function openSimilar(req: SimilarRequest): Promise<void> {
  if (open) return
  const root = typeof req === 'string' ? req : req?.root ?? app.activeTab?.path
  const roots = typeof req === 'object' && req?.paths?.length ? req.paths : undefined
  if (!root?.startsWith('/')) return
  open = true

  const modal = openModal({ width: 940, className: 'dlg-similar', onDismiss: () => close() })
  let scanning = true
  let busy = false
  const close = (): void => {
    if (busy) return
    if (scanning) void liq.invoke('cancelSimilar')
    offProgress()
    open = false
    modal.close()
  }

  const head = el('div', 'dlg-title')
  head.append(el('span', 'dlg-title-text', 'Repeated pictures'), closeX(() => close()))
  const status = el('div', 'sim-status')
  const bar = el('div', 'sim-bar')
  const fill = el('div', 'sim-bar-fill')
  bar.append(fill)
  const body = el('div', 'dlg-body sim-body')
  const foot = el('div', 'dlg-buttons')

  const btnTrash = el('button', 'btn btn-danger', 'Move 0 to Recycle Bin')
  const btnPick = el('button', 'btn btn-small', 'Tick every copy but the keeper')
  const btnUpgrade = el('button', 'btn btn-small', 'Look for better versions of the keepers')
  const btnStop = el('button', 'btn', 'Stop')
  const btnClose = el('button', 'btn', 'Close')
  foot.append(btnTrash, btnPick, btnUpgrade, btnStop, el('div', 'dlg-buttons-spacer'), btnClose)
  btnTrash.disabled = true
  btnPick.hidden = true
  btnUpgrade.hidden = true
  modal.dlg.append(head, status, bar, body, foot)

  btnClose.addEventListener('click', () => close())
  btnStop.addEventListener('click', () => { void liq.invoke('cancelSimilar'); btnStop.disabled = true })

  status.textContent = 'Starting…'
  body.append(el('div', 'sim-empty', 'Looking through the folder. This spawns one ImageMagick '
    + 'process per picture, so a big library takes a while — you can stop it at any point.'))

  // ------------------------------------------------------------------ progress

  const onProgress = (p: SimilarProgress): void => {
    if (!scanning) return
    const label = PHASE_TEXT[p.phase] ?? p.phase
    status.textContent = p.total
      ? `${label} — ${p.done} of ${p.total}`
      : `${label}${p.done ? ` — ${p.done} so far` : '…'}`
    const pct = p.total ? Math.min(100, Math.round((p.done / p.total) * 100)) : 0
    fill.style.width = pct + '%'
    bar.classList.toggle('indeterminate', !p.total)
  }
  const offProgress = liq.on(PUSH.similarProgress, onProgress)

  // ------------------------------------------------------------------ the scan

  const res = await liq.invoke('findSimilar', root, 10, roots).catch(
    (e: Error) => ({ ok: false, error: String(e?.message ?? e) } as SimilarResult)) as SimilarResult
  scanning = false
  offProgress()
  bar.hidden = true
  btnStop.disabled = true
  btnStop.hidden = true
  if (modal.closed) return

  if (!res.ok) {
    status.className = 'sim-status bad'
    status.textContent = res.error ?? 'That could not be scanned.'
    body.replaceChildren()
    return
  }

  const copies = res.groups.reduce((n, g) => n + g.files.length - 1, 0)
  status.className = 'sim-status'
  // A stopped run must never read as a clean "nothing found" — that is the same lie as a batch
  // reporting success over a queue it never consumed.
  const scope = res.cancelled
    ? `Stopped after ${res.scanned} ${res.scanned === 1 ? 'picture' : 'pictures'}`
    : `${res.scanned} pictures checked`
  status.textContent = res.groups.length
    ? `${scope} — ${res.groups.length} ${res.groups.length === 1 ? 'set' : 'sets'} of `
      + `repeats, ${copies} ${copies === 1 ? 'copy' : 'copies'} that could go.`
      + (res.cancelled ? ' The rest of the folder was not looked at.' : '')
      + (res.truncated ? ` Stopped at the ${res.scanned}-picture limit.` : '')
    : res.cancelled
      ? `${scope} — no repeats among those. The rest of the folder was not looked at.`
      : `${res.scanned} pictures checked — no repeats found.`

  body.replaceChildren()
  if (!res.groups.length) {
    body.append(el('div', 'sim-empty', res.cancelled
      ? 'Nothing repeated turned up in the part that ran. Run it again without stopping it to cover '
        + 'the whole folder.'
      : 'Every picture here is different from every other, at least as far as a perceptual '
        + 'fingerprint can tell.'))
    return
  }

  btnPick.hidden = false
  btnUpgrade.hidden = false

  /** every tile, so the footer can count and act on the ticked ones */
  const tiles: { file: SimilarFile; node: HTMLElement; cb: HTMLInputElement; keeper: boolean }[] = []

  for (const g of res.groups) {
    const keeper = g.files[0]
    const sec = el('div', 'sim-group')
    const gh = el('div', 'sim-group-head')
    gh.append(
      el('span', 'sim-group-title', `${g.files.length} copies of the same picture`),
      el('span', 'sim-group-sub', keeper.pixels
        ? `keeping the ${keeper.width} × ${keeper.height} copy`
        : 'keeping the largest file'),
    )
    sec.append(gh)

    const grid = el('div', 'sim-grid')
    for (const f of g.files) {
      const isKeeper = f === keeper
      const tile = el('div', 'sim-tile' + (isKeeper ? ' keeper' : ''))

      const img = el('img', 'sim-thumb')
      img.src = `liqthumb://?path=${encodeURIComponent(f.path)}&size=large`
      img.alt = ''
      img.title = f.path
      // the picture itself is the thing being judged, so clicking it opens it full size
      img.addEventListener('dblclick', () => { void liq.invoke('openPath', f.path) })

      const cb = el('input', 'sim-check') as HTMLInputElement
      cb.type = 'checkbox'
      cb.title = isKeeper ? 'This is the copy being kept — tick it only if you mean it' : 'Move this copy to the Recycle Bin'
      cb.addEventListener('change', () => {
        tile.classList.toggle('ticked', cb.checked)
        refresh()
      })

      const name = el('div', 'sim-name', f.name)
      name.title = f.path
      const dim = el('div', 'sim-dim', f.pixels
        ? `${f.width} × ${f.height} · ${formatSize(f.size)}`
        : `${formatSize(f.size)} · size unknown`)
      // "biggest" was the old word and it meant bytes. It means pixels now, and saying which is
      // the difference between trusting this tool and second-guessing it on every group.
      const tag = el('div', 'sim-tag', isKeeper
        ? (f.pixels ? 'highest resolution — keeping' : 'largest file — keeping')
        : (f.distance === 0
          ? 'looks identical'
          : `${f.distance} bit${f.distance === 1 ? '' : 's'} different`))

      const show = el('button', 'btn btn-link sim-show', 'Show in folder')
      show.addEventListener('click', () => {
        close()
        const dir = f.path.slice(0, f.path.lastIndexOf('/')) || '/'
        void app.activeTab?.navigate(dir).then(() => app.activeTab?.setSelection(new Set([f.path])))
      })

      tile.append(cb, img, name, dim, tag, show)
      grid.append(tile)
      tiles.push({ file: f, node: tile, cb, keeper: isKeeper })
    }
    sec.append(grid)
    body.append(sec)
  }

  // ------------------------------------------------------------------ actions

  function refresh(): void {
    const n = tiles.filter(t => t.cb.checked).length
    btnTrash.textContent = `Move ${n} to Recycle Bin`
    btnTrash.disabled = n === 0 || busy
    // ticking a keeper is allowed, but it should never be silent
    const keepers = tiles.filter(t => t.cb.checked && t.keeper).length
    btnTrash.classList.toggle('warn', keepers > 0)
    btnTrash.title = keepers
      ? `${keepers} of these is the copy this tool would keep — check before you do it.`
      : ''
  }

  btnPick.addEventListener('click', () => {
    const turnOn = tiles.some(t => !t.keeper && !t.cb.checked)
    for (const t of tiles) {
      if (t.keeper) continue
      t.cb.checked = turnOn
      t.node.classList.toggle('ticked', turnOn)
    }
    refresh()
  })

  btnUpgrade.addEventListener('click', () => {
    // The natural next question: these are the copies I am keeping — is there a BETTER one out
    // there? Same fingerprint engine, different corpus.
    const keepers = res.groups.map(g => g.files[0].path)
    close()
    app.emit(keepers.length > 1 ? 'show-better-batch' : 'show-better-image', keepers)
  })

  btnTrash.addEventListener('click', () => {
    const paths = tiles.filter(t => t.cb.checked).map(t => t.file.path)
    if (!paths.length) return
    busy = true
    btnTrash.disabled = true
    void liq.startOp({ kind: 'trash', sources: paths }).then(() => {
      busy = false
      toast({ text: `Moved ${paths.length} ${paths.length === 1 ? 'picture' : 'pictures'} to the Recycle Bin — Ctrl+Z puts them back` })
      for (const t of tiles.filter(x => x.cb.checked)) {
        t.node.classList.add('gone')
        t.cb.checked = false
        t.cb.disabled = true
      }
      refresh()
    }).catch((e: Error) => {
      busy = false
      refresh()
      toast({ text: String(e?.message ?? e), bad: true })
    })
  })

  refresh()
}
