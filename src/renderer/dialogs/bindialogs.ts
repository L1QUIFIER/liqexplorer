// DROP BINS — the two dialogs the feature owns: bulk image conversion
// (options -> live progress -> result) and the checksum sheet.
//
// Both drive main-process modules that self-register their IPC
// (main/ops/convert.ts, main/ops/checksums.ts), so nothing in the core IPC
// contract had to change.
import { app, liq } from '../core/app'
import { openModal, el, closeX, midEllipsize } from './dialogs'
import {
  CHECKSUM_PROGRESS, CONVERT_PROGRESS, TARGET_ASK, TARGET_CWD,
  type BinConfig, type ChecksumAlgo, type ChecksumProgress, type ChecksumResult,
  type ConvertFormat, type ConvertProgress,
} from '../../shared/bins'
import { bins, currentFolder, patchBins, toast } from '../views/binstore'

// ------------------------------------------------------------------- convert

const MAX_DIMS: { v: number; label: string }[] = [
  { v: 0, label: 'Original size' },
  { v: 800, label: '800 px' },
  { v: 1280, label: '1280 px' },
  { v: 1600, label: '1600 px' },
  { v: 1920, label: '1920 px' },
  { v: 2560, label: '2560 px' },
  { v: 4096, label: '4096 px' },
]

let formatsCache: ConvertFormat[] | null = null
async function formats(): Promise<ConvertFormat[]> {
  if (!formatsCache) formatsCache = await liq.invoke('convertFormats').catch(() => []) as ConvertFormat[]
  return formatsCache
}

function field(parent: HTMLElement, label: string): HTMLDivElement {
  const row = el('div', 'db-field')
  row.appendChild(el('label', undefined, label))
  parent.appendChild(row)
  return row
}

/**
 * The destination is edited IN this dialog rather than through a folder picker
 * fired before it: the bin usually knows where it wants to write, and making
 * the user answer a native picker and then a settings sheet for one drop is a
 * worse trade than one sheet with a Browse button.
 */
export async function openConvertDialog(
  sources: string[], bin: BinConfig, onStarted?: () => void,
): Promise<void> {
  const avail = await formats()
  const cur = bin.convert ?? { format: 'jpg', maxDim: 0, quality: 88 }

  // Closing the sheet (Esc, ✕ or Cancel) must also stop a run started from it:
  // there is no other UI for a conversion, so leaving one alive would keep
  // writing files with nothing on screen to say so.
  let cleanup: (() => void) | null = null
  const dismiss = (): void => { cleanup?.(); cleanup = null; modal.close() }
  const modal = openModal({ width: 460, className: 'dlg-convert', onDismiss: () => dismiss() })
  const titleRow = el('div', 'dlg-title')
  titleRow.appendChild(el('span', 'dlg-title-text', 'Convert images'))
  titleRow.appendChild(closeX(dismiss))
  const body = el('div', 'dlg-body')
  const buttons = el('div', 'dlg-buttons')
  modal.dlg.append(titleRow, body, buttons)

  if (!avail.length) {
    // main probed every candidate encoder and none of them actually produced
    // the format they claimed — say so instead of failing per file later
    body.appendChild(el('div', 'dlg-msg',
      'No working image encoder was found. Install ImageMagick (and ffmpeg for AVIF) and reopen this dialog.'))
    const close = el('button', 'btn btn-primary', 'Close')
    close.addEventListener('click', () => modal.close())
    buttons.appendChild(close)
    return
  }

  const form = el('div', 'db-cfg-edit')
  body.appendChild(el('div', 'dlg-msg', `${sources.length === 1 ? '1 item' : `${sources.length} items`} — folders are searched for images.`))
  body.appendChild(form)

  const fmtSel = el('select', 'opt-select') as HTMLSelectElement
  for (const f of avail) {
    const o = document.createElement('option')
    o.value = f.id
    o.textContent = f.label
    fmtSel.appendChild(o)
  }
  fmtSel.value = avail.some(f => f.id === cur.format) ? cur.format : avail[0].id
  field(form, 'Convert to').appendChild(fmtSel)

  const dimSel = el('select', 'opt-select') as HTMLSelectElement
  for (const d of MAX_DIMS) {
    const o = document.createElement('option')
    o.value = String(d.v)
    o.textContent = d.label
    dimSel.appendChild(o)
  }
  dimSel.value = String(MAX_DIMS.some(d => d.v === (cur.maxDim ?? 0)) ? (cur.maxDim ?? 0) : 0)
  field(form, 'Longest edge').appendChild(dimSel)

  const qRow = field(form, 'Quality')
  const qNum = el('input', 'opt-input') as HTMLInputElement
  qNum.type = 'number'
  qNum.min = '1'
  qNum.max = '100'
  qNum.value = String(cur.quality ?? 88)
  qRow.appendChild(qNum)
  const syncQuality = (): void => {
    const f = avail.find(x => x.id === fmtSel.value)
    qRow.hidden = !f?.lossy
  }
  fmtSel.addEventListener('change', syncQuality)
  syncQuality()

  const destRow = field(form, 'Save to')
  const destInput = el('input', 'opt-input') as HTMLInputElement
  destInput.type = 'text'
  destInput.spellcheck = false
  const t = bin.target ?? TARGET_ASK
  destInput.value = (t === TARGET_CWD || t === TARGET_ASK || !t)
    ? (currentFolder() ?? app.homePath ?? '')
    : t
  const browse = el('button', 'btn btn-small', 'Browse…')
  browse.addEventListener('click', () => {
    void (async () => {
      const p = await liq.invoke('pickFolder', destInput.value || app.homePath).catch(() => null) as string | null
      if (p) destInput.value = p
    })()
  })
  destRow.append(destInput, browse)

  const stripLabel = el('label', 'dlg-check')
  const strip = el('input') as HTMLInputElement
  strip.type = 'checkbox'
  strip.checked = cur.strip === true
  stripLabel.append(strip, document.createTextNode(' Remove EXIF / colour profile'))
  form.appendChild(stripLabel)

  const rememberLabel = el('label', 'dlg-check')
  const remember = el('input') as HTMLInputElement
  remember.type = 'checkbox'
  remember.checked = true
  rememberLabel.append(remember, document.createTextNode(' Remember these settings for this bin'))
  form.appendChild(rememberLabel)

  form.appendChild(el('div', 'opt-note',
    'Originals are never modified and an existing name is never overwritten — a clash becomes "name (2)". '
    + 'Only the first frame of an animation is converted.'))

  const start = el('button', 'btn btn-primary', 'Convert')
  const cancel = el('button', 'btn', 'Cancel')
  cancel.addEventListener('click', dismiss)
  buttons.append(start, cancel)

  start.addEventListener('click', () => {
    const dest = destInput.value.trim()
    if (!dest.startsWith('/')) { destInput.classList.add('bad'); destInput.focus(); return }
    const opts = {
      format: fmtSel.value,
      maxDim: Number(dimSel.value) || 0,
      quality: Math.max(1, Math.min(100, Number(qNum.value) || 88)),
      strip: strip.checked,
    }
    if (remember.checked) {
      patchBins({
        bins: bins().bins.map(b => b.id === bin.id ? { ...b, convert: opts, target: dest } : b),
      })
    }
    onStarted?.()
    cleanup = runConvert(modal, body, buttons, sources, dest, opts)
  })
}

/** Returns the teardown the dialog must run if it is dismissed mid-flight. */
function runConvert(
  modal: { dlg: HTMLDivElement; close: () => void; readonly closed: boolean },
  body: HTMLElement, buttons: HTMLElement,
  sources: string[], dest: string,
  opts: { format: string; maxDim: number; quality: number; strip: boolean },
): () => void {
  body.innerHTML = ''
  buttons.innerHTML = ''
  const line = el('div', 'dlg-msg', 'Preparing…')
  const bar = el('div', 'db-prog')
  const fill = el('div', 'db-prog-fill')
  fill.style.width = '0%'
  bar.appendChild(fill)
  const detail = el('div', 'opt-note', '')
  body.append(line, bar, detail)

  const stop = el('button', 'btn', 'Cancel')
  buttons.appendChild(stop)

  let runId = 0
  let finished = false
  let abandoned = false
  stop.addEventListener('click', () => {
    if (finished) { modal.close(); return }
    if (runId) void liq.invoke('convertCancel', runId)
  })

  const off = liq.on(CONVERT_PROGRESS, (p: ConvertProgress) => {
    if (!runId || p.runId !== runId || modal.closed) return
    if (p.status === 'running') {
      line.textContent = `Converting ${p.done} of ${p.total}…`
      fill.style.width = p.total ? `${Math.round((p.done / p.total) * 100)}%` : '0%'
      detail.textContent = p.current ? midEllipsize(p.current, 52) : ''
      return
    }
    finished = true
    off()
    fill.style.width = '100%'
    stop.textContent = 'Close'
    const failed = p.failures.length
    if (p.status === 'error') {
      line.textContent = p.error ?? 'Conversion failed.'
      detail.textContent = ''
      return
    }
    const n = p.written
    line.textContent = p.status === 'cancelled'
      ? `Cancelled — ${n} file${n === 1 ? '' : 's'} written.`
      : `Converted ${n} file${n === 1 ? '' : 's'} to .${opts.format}.`
    detail.textContent = failed
      ? `${failed} skipped: ` + p.failures.slice(0, 3).map(f => `${f.path.split('/').pop()} (${f.error})`).join(', ')
      : dest
    const show = el('button', 'btn btn-primary', 'Open folder')
    show.addEventListener('click', () => { modal.close(); void app.activeTab?.navigate(dest) })
    buttons.prepend(show)
  })

  void (async () => {
    try {
      runId = await liq.invoke('convertImages', {
        sources, dest, format: opts.format, maxDim: opts.maxDim,
        quality: opts.quality, strip: opts.strip,
      }) as number
      if (abandoned) void liq.invoke('convertCancel', runId)   // dismissed during the round trip
    } catch (e) {
      finished = true
      off()
      line.textContent = String((e as Error)?.message ?? e)
      stop.textContent = 'Close'
    }
  })()

  return () => {
    abandoned = true
    off()
    if (runId && !finished) void liq.invoke('convertCancel', runId)
  }
}

// ----------------------------------------------------------------- checksums

const ALGO_FILE: Record<ChecksumAlgo, string> = {
  md5: 'MD5SUMS', sha1: 'SHA1SUMS', sha256: 'SHA256SUMS',
}

let nextChecksumRun = 1

/**
 * Both outputs are offered, deliberately. Copy is what you want for one file
 * (paste the hash into whatever is asking for it); the saved file is what you
 * want for many, because the lines are byte-identical to coreutils' own format
 * and `sha256sum -c SHA256SUMS` in that folder verifies the whole set. Writing
 * that file unasked would litter the user's folders, so it is a button.
 */
export async function runChecksums(paths: string[], algo: ChecksumAlgo): Promise<void> {
  const runId = nextChecksumRun++
  let running = true
  // Esc and ✕ both have to stop the hashing, not just hide it
  const dismiss = (): void => {
    if (running) void liq.invoke('checksumsCancel', runId)
    modal.close()
  }
  const modal = openModal({ width: 560, className: 'dlg-checksums', onDismiss: () => dismiss() })
  const titleRow = el('div', 'dlg-title')
  titleRow.appendChild(el('span', 'dlg-title-text', `${algo.toUpperCase()} checksums`))
  titleRow.appendChild(closeX(dismiss))
  const body = el('div', 'dlg-body')
  const buttons = el('div', 'dlg-buttons')
  modal.dlg.append(titleRow, body, buttons)

  const line = el('div', 'dlg-msg', 'Hashing…')
  const bar = el('div', 'db-prog')
  const fill = el('div', 'db-prog-fill')
  fill.style.width = '0%'
  bar.appendChild(fill)
  body.append(line, bar)

  const off = liq.on(CHECKSUM_PROGRESS, (p: ChecksumProgress) => {
    if (p.runId !== runId || modal.closed) return
    line.textContent = `Hashing ${p.done} of ${p.total}…`
    fill.style.width = p.total ? `${Math.round((p.done / p.total) * 100)}%` : '0%'
  })

  let res: ChecksumResult
  try {
    res = await liq.invoke('checksumsRun', { runId, paths, algo }) as ChecksumResult
  } catch (e) {
    running = false
    off()
    if (!modal.closed) line.textContent = String((e as Error)?.message ?? e)
    return
  }
  running = false
  off()
  if (modal.closed) return

  body.innerHTML = ''
  if (!res.lines.length) {
    body.appendChild(el('div', 'dlg-msg', res.error ?? 'Nothing to hash.'))
  } else {
    body.appendChild(el('div', 'dlg-msg',
      `${res.lines.length} file${res.lines.length === 1 ? '' : 's'} in ${midEllipsize(res.root, 56)}`
      + (res.skipped.length ? ` — ${res.skipped.length} skipped` : '')))
    const out = el('textarea', 'db-out') as HTMLTextAreaElement
    out.readOnly = true
    out.spellcheck = false
    out.value = res.lines.join('\n')
    body.appendChild(out)
    body.appendChild(el('div', 'opt-note',
      `Saved as ${ALGO_FILE[algo]} in that folder, this verifies with \`${algo}sum -c ${ALGO_FILE[algo]}\`.`))
  }

  if (res.lines.length) {
    const copy = el('button', 'btn btn-primary', 'Copy')
    copy.addEventListener('click', () => {
      void liq.copyTextToClipboard(res.lines.join('\n'))
      copy.textContent = 'Copied'
    })
    const save = el('button', 'btn', `Save ${ALGO_FILE[algo]}`)
    save.addEventListener('click', () => {
      void (async () => {
        const r = await liq.invoke('checksumsSave', {
          dir: res.root, name: ALGO_FILE[algo], text: res.lines.join('\n') + '\n',
        }).catch((e: Error) => ({ ok: false, error: String(e?.message ?? e) })) as { ok: boolean; path?: string; error?: string }
        modal.close()
        toast(r.ok
          ? { text: `Wrote ${r.path?.split('/').pop()}`, sub: res.root }
          : { text: r.error ?? 'Could not write the file.', bad: true })
      })()
    })
    buttons.append(copy, save)
  }
  const close = el('button', 'btn', 'Close')
  close.addEventListener('click', () => modal.close())
  buttons.appendChild(close)
}
