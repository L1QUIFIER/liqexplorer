// DROP BINS — the bin manager. Add, remove, reorder, hide and configure bins.
//
// Everything it edits lives in one JSON document (BinsConfig) written by
// main/state/bins.ts to ~/.local/state/liqexplorer/dropbins.json, so this
// dialog never touches AppSettings and the feature adds nothing to the core
// settings contract.
import { liq } from '../core/app'
import { openModal, el, closeX } from './dialogs'
import { paintBinIcon, binColorClass, primeBinIcons, bumpBinIconCache } from '../views/binicon'
import { binBuiltinSvg } from '../views/dropbins'
import {
  ACTION_LABELS, BIN_COLORS, NEEDS_TARGET, PATH_FORMAT_LABELS, TARGET_ASK, TARGET_CWD,
  defaultBins, newBinId,
  type ArchiveFormat, type BinAction, type BinConfig, type ChecksumAlgo, type PathFormat,
} from '../../shared/bins'
import { bins, patchBins, targetLabel } from '../views/binstore'
import { binSubtitle } from '../views/binrun'
import type { Printer } from '../../shared/printing'

const ORDER: BinAction[] = [
  'stack', 'copy', 'move', 'symlink', 'compress', 'extract',
  'favorites', 'bulkRename', 'convert', 'checksums',
  'openWith', 'copyPath', 'print', 'trash',
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
      // the tile's own icon, so the list reads the way the tray does — the
      // whole reason for custom icons is telling two bins of the same action
      // apart, which a text-only list cannot show
      const ico = el('span', 'db-cfg-ico' + binColorClass(bin))
      ico.appendChild(paintBinIcon(bin, binBuiltinSvg, 16))

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
      row.append(show, ico, name, btns)
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
        confirm: action === 'move' || action === 'trash' || action === 'print',
        format: action === 'compress' ? 'zip' : undefined,
        extractMode: action === 'extract' ? 'to' : undefined,
        algo: action === 'checksums' ? 'sha256' : undefined,
        convert: action === 'convert' ? { format: 'jpg', maxDim: 0, quality: 88 } : undefined,
        pathFormat: action === 'copyPath' ? 'plain' : undefined,
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

    // ---- icon + colour ----
    //
    // The point of bins is having SEVERAL of the same kind — one "Copy to…" per
    // folder you use often — and until now every one of them drew the same
    // shape in the same colour, so during a drag they were told apart only by
    // reading the subtitle. This is the part that makes them recognisable.
    {
      const r = row('Icon')
      const pick = el('div', 'db-iconpick')

      const preview = el('div', 'db-iconpick-prev')
      const drawPreview = (): void => {
        const b = bins().bins.find(x => x.id === id)
        if (!b) return
        preview.textContent = ''
        preview.className = 'db-iconpick-prev' + binColorClass(b)
        preview.appendChild(paintBinIcon(b, binBuiltinSvg, 20))
      }

      const kindSel = el('select', 'opt-select') as HTMLSelectElement
      for (const [v, t] of [['builtin', 'Built-in'], ['emoji', 'Emoji'], ['image', 'Picture…'], ['themed', 'System icon']]) {
        const o = document.createElement('option')
        o.value = v
        o.textContent = t
        kindSel.appendChild(o)
      }
      kindSel.value = bin.icon?.kind ?? 'builtin'

      const emojiWrap = el('div', 'db-iconpick-emoji')
      const emojiInput = el('input', 'opt-input db-iconpick-input') as HTMLInputElement
      emojiInput.type = 'text'
      emojiInput.maxLength = 4
      emojiInput.placeholder = '🙂'
      emojiInput.value = bin.icon?.kind === 'emoji' ? bin.icon.value : ''
      emojiInput.addEventListener('input', () => {
        update(id, b => ({ ...b, icon: { kind: 'emoji', value: emojiInput.value } }))
        drawPreview()
      })
      const quick = el('div', 'db-iconpick-quick')
      // a small, useful set rather than a full picker: these are the ones a
      // folder-shaped shortcut actually wants
      for (const e of ['📁', '📷', '🎬', '🎵', '📄', '⭐', '💼', '🧾', '🗜️', '🚀', '🧪', '🗑️']) {
        const b = el('button', 'db-iconpick-e', e)
        b.type = 'button'
        b.addEventListener('click', () => {
          emojiInput.value = e
          update(id, x => ({ ...x, icon: { kind: 'emoji', value: e } }))
          drawPreview()
        })
        quick.appendChild(b)
      }
      emojiWrap.append(emojiInput, quick)

      const imgBtn = el('button', 'btn btn-small', 'Choose picture…')
      imgBtn.addEventListener('click', () => {
        void (async () => {
          const picked = await liq.invoke('binIconPick').catch(() => []) as string[]
          if (!picked.length) return
          const r2 = await liq.invoke('binIconImport', picked[0], id)
            .catch((e: Error) => ({ ok: false, error: String(e?.message ?? e) })) as { ok: boolean; value?: string; error?: string }
          if (!r2.ok) { imgBtn.textContent = r2.error ?? 'That did not work'; return }
          bumpBinIconCache()
          update(id, b => ({ ...b, icon: { kind: 'image', value: r2.value! } }))
          imgBtn.textContent = 'Choose a different picture…'
          drawPreview()
        })()
      })

      const themedInput = el('input', 'opt-input') as HTMLInputElement
      themedInput.type = 'text'
      themedInput.spellcheck = false
      themedInput.placeholder = 'folder-pictures'
      themedInput.value = bin.icon?.kind === 'themed' ? bin.icon.value : ''
      themedInput.addEventListener('input', () => {
        update(id, b => ({ ...b, icon: { kind: 'themed', value: themedInput.value.trim() } }))
        drawPreview()
      })

      const syncKind = (): void => {
        const k = kindSel.value
        emojiWrap.hidden = k !== 'emoji'
        imgBtn.hidden = k !== 'image'
        themedInput.hidden = k !== 'themed'
        if (k === 'builtin') update(id, b => ({ ...b, icon: undefined }))
        else if (k === 'emoji') update(id, b => ({ ...b, icon: { kind: 'emoji', value: emojiInput.value } }))
        else if (k === 'themed') update(id, b => ({ ...b, icon: { kind: 'themed', value: themedInput.value.trim() } }))
        drawPreview()
      }
      kindSel.addEventListener('change', syncKind)

      pick.append(preview, kindSel, emojiWrap, imgBtn, themedInput)
      r.appendChild(pick)

      // colour
      const cr = row('Colour')
      const swatches = el('div', 'db-colours')
      for (const c of BIN_COLORS) {
        const b = el('button', 'db-colour db-c-' + c + (( bin.color ?? 'default') === c ? ' is-on' : ''))
        b.type = 'button'
        b.title = c === 'default' ? 'Theme colour' : c
        b.addEventListener('click', () => {
          update(id, x => ({ ...x, color: c === 'default' ? undefined : c }))
          for (const other of swatches.querySelectorAll('.db-colour')) other.classList.remove('is-on')
          b.classList.add('is-on')
          drawPreview()
        })
        swatches.appendChild(b)
      }
      cr.appendChild(swatches)

      syncKind()
      // syncKind() writes the icon for the current kind; draw once it has
      drawPreview()
    }

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

    if (bin.action === 'openWith') {
      const sel = el('select', 'opt-select') as HTMLSelectElement
      const ask = document.createElement('option')
      ask.value = ''
      ask.textContent = 'Ask each time'
      sel.appendChild(ask)
      sel.value = bin.appId ?? ''
      row('Application').appendChild(sel)
      form.appendChild(el('div', 'opt-note',
        'Everything dropped here is handed to the application in one go, so dropping twelve '
        + 'photos opens one window with twelve photos in it.'))
      // the app list is long and comes from disk; fetched once the row exists so
      // the dialog does not wait on it
      void liq.invoke('listAllApps').then((apps: { id: string; name: string }[]) => {
        for (const a of apps) {
          const o = document.createElement('option')
          o.value = a.id
          o.textContent = a.name
          sel.appendChild(o)
        }
        sel.value = bin.appId ?? ''
      }).catch(() => { /* leave it as "Ask each time" */ })
      sel.addEventListener('change', () => {
        const name = sel.options[sel.selectedIndex]?.textContent ?? ''
        update(id, b => ({
          ...b,
          appId: sel.value || undefined,
          appName: sel.value ? name : undefined,
        }))
      })
    }

    if (bin.action === 'copyPath') {
      const sel = el('select', 'opt-select') as HTMLSelectElement
      for (const f of Object.keys(PATH_FORMAT_LABELS) as PathFormat[]) {
        const o = document.createElement('option')
        o.value = f
        o.textContent = PATH_FORMAT_LABELS[f]
        sel.appendChild(o)
      }
      sel.value = bin.pathFormat ?? 'plain'
      sel.addEventListener('change', () => update(id, b => ({ ...b, pathFormat: sel.value as PathFormat })))
      row('Write as').appendChild(sel)
      form.appendChild(el('div', 'opt-note', 'One per line. Quoted is the form a terminal wants.'))
    }

    if (bin.action === 'print') {
      const sel = el('select', 'opt-select') as HTMLSelectElement
      const def = document.createElement('option')
      def.value = ''
      def.textContent = 'Default printer'
      sel.appendChild(def)
      sel.value = bin.printer ?? ''
      row('Printer').appendChild(sel)
      const note = el('div', 'opt-note', 'Looking for printers…')
      form.appendChild(note)
      void liq.invoke('listPrinters').then((ps: Printer[]) => {
        for (const p of ps) {
          const o = document.createElement('option')
          o.value = p.name
          o.textContent = p.name + (p.isDefault ? ' (default)' : '') + (p.ready ? '' : ' — disabled')
          sel.appendChild(o)
        }
        sel.value = bin.printer ?? ''
        note.textContent = ps.length
          ? 'PDFs, text and pictures go straight to the queue. Word and spreadsheet files need '
            + 'their own application, and are skipped rather than printed as raw markup.'
          : 'No printers are set up on this computer, so this bin has nothing to send to.'
      }).catch(() => { note.textContent = 'The printer list could not be read.' })
      sel.addEventListener('change', () => update(id, b => ({ ...b, printer: sel.value || undefined })))
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
