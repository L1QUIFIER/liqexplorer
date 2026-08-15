// DROP BINS — the bin manager. Add, remove, reorder, hide and configure bins.
//
// Everything it edits lives in one JSON document (BinsConfig) written by
// main/state/bins.ts to ~/.local/state/liqexplorer/dropbins.json, so this
// dialog never touches AppSettings and the feature adds nothing to the core
// settings contract.
import { liq } from '../core/app'
import { openModal, el, closeX } from './dialogs'
import {
  ACTION_LABELS, NEEDS_TARGET, TARGET_ASK, TARGET_CWD, defaultBins, newBinId,
  type ArchiveFormat, type BinAction, type BinConfig, type ChecksumAlgo,
} from '../../shared/bins'
import { bins, patchBins, targetLabel } from '../views/binstore'
import { binSubtitle } from '../views/binrun'

const ORDER: BinAction[] = [
  'stack', 'copy', 'move', 'symlink', 'compress', 'extract',
  'favorites', 'bulkRename', 'convert', 'checksums', 'trash',
]

function svgBtn(title: string, d: string): HTMLButtonElement {
  const b = el('button', 'db-ibtn')
  b.title = title
  b.setAttribute('aria-label', title)
  b.innerHTML = `<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor"
    stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`
  return b
}

const ICON = {
  up: '<path d="M8 12.5V3.5M4 7.5 8 3.5l4 4"/>',
  down: '<path d="M8 3.5v9M4 8.5 8 12.5l4-4"/>',
  edit: '<path d="M11.1 2.9a1.8 1.8 0 0 1 2.5 2.5l-7.3 7.3-3.3.8.8-3.3z"/>',
  del: '<path d="M2.8 4.3h10.4M6.3 4.3V3.2c0-.5.4-.9.9-.9h1.6c.5 0 .9.4.9.9v1.1M4.3 4.3l.6 8.2c0 .7.6 1.3 1.3 1.3h3.6c.7 0 1.3-.6 1.3-1.3l.6-8.2"/>',
}

export function openBinSettings(editId?: string): void {
  const modal = openModal({ width: 480, className: 'dlg-binsettings' })
  const titleRow = el('div', 'dlg-title')
  const titleText = el('span', 'dlg-title-text', 'Drop Bins')
  titleRow.append(titleText, closeX(() => modal.close()))
  const body = el('div', 'dlg-body')
  const buttons = el('div', 'dlg-buttons')
  modal.dlg.append(titleRow, body, buttons)

  const showList = (): void => {
    titleText.textContent = 'Drop Bins'
    body.innerHTML = ''
    buttons.innerHTML = ''
    const cfg = bins()

    const list = el('div', 'db-cfg-list')
    cfg.bins.forEach((bin, i) => {
      const row = el('div', 'db-cfg-row' + (bin.hidden ? ' db-off' : ''))
      const show = el('input') as HTMLInputElement
      show.type = 'checkbox'
      show.checked = !bin.hidden
      show.title = 'Show this bin in the tray'
      show.addEventListener('change', () => {
        update(bin.id, b => ({ ...b, hidden: !show.checked }))
        showList()
      })
      const name = el('div', 'db-cfg-name')
      name.appendChild(document.createTextNode(bin.label))
      const sub = el('span', 'db-cfg-sub', '  ' + binSubtitle(bin, targetLabel(bin)))
      name.appendChild(sub)

      const btns = el('div', 'db-cfg-btns')
      const up = svgBtn('Move up', ICON.up)
      up.disabled = i === 0
      up.addEventListener('click', () => { reorder(i, i - 1); showList() })
      const down = svgBtn('Move down', ICON.down)
      down.disabled = i === cfg.bins.length - 1
      down.addEventListener('click', () => { reorder(i, i + 1); showList() })
      const edit = svgBtn('Configure', ICON.edit)
      edit.addEventListener('click', () => showEditor(bin.id))
      const del = svgBtn('Remove', ICON.del)
      del.addEventListener('click', () => {
        patchBins({ bins: bins().bins.filter(b => b.id !== bin.id) })
        showList()
      })
      btns.append(up, down, edit, del)
      row.append(show, name, btns)
      list.appendChild(row)
    })
    body.appendChild(list)

    // add a bin
    const addRow = el('div', 'opt-row')
    const sel = el('select', 'opt-select') as HTMLSelectElement
    for (const a of ORDER) {
      const o = document.createElement('option')
      o.value = a
      o.textContent = ACTION_LABELS[a]
      sel.appendChild(o)
    }
    sel.value = 'copy'
    const add = el('button', 'btn btn-small', 'Add bin')
    add.addEventListener('click', () => {
      const action = sel.value as BinAction
      const bin: BinConfig = {
        id: newBinId(action),
        action,
        label: ACTION_LABELS[action],
        target: NEEDS_TARGET.has(action) ? TARGET_ASK : undefined,
        confirm: action === 'move' || action === 'trash',
        format: action === 'compress' ? 'zip' : undefined,
        extractMode: action === 'extract' ? 'to' : undefined,
        algo: action === 'checksums' ? 'sha256' : undefined,
        convert: action === 'convert' ? { format: 'jpg', maxDim: 0, quality: 88 } : undefined,
      }
      patchBins({ bins: [...bins().bins, bin] })
      showEditor(bin.id)
    })
    addRow.append(sel, add)
    body.appendChild(addRow)

    const clearLab = el('label', 'dlg-check')
    const clearCb = el('input') as HTMLInputElement
    clearCb.type = 'checkbox'
    clearCb.checked = cfg.clearStackAfterUse
    clearCb.addEventListener('change', () => patchBins({ clearStackAfterUse: clearCb.checked }))
    clearLab.append(clearCb, document.createTextNode(' Empty the Stack after using it'))
    body.appendChild(clearLab)

    body.appendChild(el('div', 'opt-note',
      'The tray opens by itself as soon as you start dragging anything, and closes again when you '
      + 'let go. Several bins of the same kind are fine — one "Copy to…" per folder you use often.'))

    const reset = el('button', 'btn', 'Reset to defaults')
    reset.addEventListener('click', () => { patchBins({ bins: defaultBins() }); showList() })
    const close = el('button', 'btn btn-primary', 'Close')
    close.addEventListener('click', () => modal.close())
    buttons.append(close, el('div', 'dlg-buttons-spacer'), reset)
  }

  const showEditor = (id: string): void => {
    const bin = bins().bins.find(b => b.id === id)
    if (!bin) { showList(); return }
    titleText.textContent = ACTION_LABELS[bin.action]
    body.innerHTML = ''
    buttons.innerHTML = ''
    const form = el('div', 'db-cfg-edit')
    body.appendChild(form)

    const row = (label: string): HTMLDivElement => {
      const r = el('div', 'db-field')
      r.appendChild(el('label', undefined, label))
      form.appendChild(r)
      return r
    }

    // label
    const labelInput = el('input', 'opt-input') as HTMLInputElement
    labelInput.type = 'text'
    labelInput.value = bin.label
    labelInput.addEventListener('input', () => update(id, b => ({ ...b, label: labelInput.value })))
    row('Name').appendChild(labelInput)

    // destination
    if (NEEDS_TARGET.has(bin.action) && !(bin.action === 'extract' && bin.extractMode !== 'to')) {
      const r = row('Save to')
      const mode = el('select', 'opt-select') as HTMLSelectElement
      for (const [v, t] of [[TARGET_ASK, 'Ask each time'], [TARGET_CWD, 'The folder I am in'], ['fixed', 'A folder…']]) {
        const o = document.createElement('option')
        o.value = v
        o.textContent = t
        mode.appendChild(o)
      }
      const cur = bin.target ?? TARGET_ASK
      mode.value = cur === TARGET_ASK || cur === TARGET_CWD ? cur : 'fixed'
      const pathInput = el('input', 'opt-input') as HTMLInputElement
      pathInput.type = 'text'
      pathInput.spellcheck = false
      pathInput.value = mode.value === 'fixed' ? cur : ''
      pathInput.hidden = mode.value !== 'fixed'
      const browse = el('button', 'btn btn-small', 'Browse…')
      browse.hidden = mode.value !== 'fixed'
      const sync = (): void => {
        pathInput.hidden = mode.value !== 'fixed'
        browse.hidden = mode.value !== 'fixed'
        update(id, b => ({ ...b, target: mode.value === 'fixed' ? pathInput.value : mode.value }))
      }
      mode.addEventListener('change', sync)
      pathInput.addEventListener('input', sync)
      browse.addEventListener('click', () => {
        void (async () => {
          const p = await liq.invoke('pickFolder', pathInput.value || undefined).catch(() => null) as string | null
          if (p) { pathInput.value = p; sync() }
        })()
      })
      r.append(mode, pathInput, browse)
    }

    // per-action options
    if (bin.action === 'compress') {
      const sel = el('select', 'opt-select') as HTMLSelectElement
      for (const f of ['zip', '7z', 'tar.gz'] as ArchiveFormat[]) {
        const o = document.createElement('option')
        o.value = f
        o.textContent = f
        sel.appendChild(o)
      }
      sel.value = bin.format ?? 'zip'
      sel.addEventListener('change', () => update(id, b => ({ ...b, format: sel.value as ArchiveFormat })))
      row('Archive format').appendChild(sel)
    }
    if (bin.action === 'extract') {
      const sel = el('select', 'opt-select') as HTMLSelectElement
      for (const [v, t] of [['to', 'Into one folder'], ['auto', 'Beside each archive'], ['named', 'Beside each, in <name>/']]) {
        const o = document.createElement('option')
        o.value = v
        o.textContent = t
        sel.appendChild(o)
      }
      sel.value = bin.extractMode ?? 'to'
      sel.addEventListener('change', () => {
        update(id, b => ({ ...b, extractMode: sel.value as 'auto' | 'named' | 'to' }))
        showEditor(id)     // the destination row appears/disappears with this
      })
      row('Where').appendChild(sel)
    }
    if (bin.action === 'checksums') {
      const sel = el('select', 'opt-select') as HTMLSelectElement
      for (const a of ['sha256', 'sha1', 'md5'] as ChecksumAlgo[]) {
        const o = document.createElement('option')
        o.value = a
        o.textContent = a.toUpperCase()
        sel.appendChild(o)
      }
      sel.value = bin.algo ?? 'sha256'
      sel.addEventListener('change', () => update(id, b => ({ ...b, algo: sel.value as ChecksumAlgo })))
      row('Algorithm').appendChild(sel)
    }
    if (bin.action === 'convert') {
      form.appendChild(el('div', 'opt-note',
        'Format, size and quality are chosen on the sheet that opens when you use this bin, and '
        + 'remembered here.'))
    }

    // confirm
    if (bin.action !== 'stack') {
      const lab = el('label', 'dlg-check')
      const cb = el('input') as HTMLInputElement
      cb.type = 'checkbox'
      cb.checked = bin.confirm === true
      cb.addEventListener('change', () => update(id, b => ({ ...b, confirm: cb.checked })))
      lab.append(cb, document.createTextNode(' Ask before running'))
      form.appendChild(lab)
    }

    const back = el('button', 'btn btn-primary', 'Done')
    back.addEventListener('click', showList)
    buttons.appendChild(back)
  }

  const update = (id: string, fn: (b: BinConfig) => BinConfig): void => {
    patchBins({ bins: bins().bins.map(b => b.id === id ? fn(b) : b) })
  }
  const reorder = (from: number, to: number): void => {
    const next = [...bins().bins]
    if (to < 0 || to >= next.length) return
    const [m] = next.splice(from, 1)
    next.splice(to, 0, m)
    patchBins({ bins: next })
  }

  if (editId) showEditor(editId); else showList()
}
