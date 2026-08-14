// Open With chooser — the Win11 'How do you want to open this .ext file?'
// dialog (research-properties-drives.md §6/§7). Suggested apps first, 'More
// apps' expands to every registered application; 'Always' persists the default.
import type { AppCandidate, FileEntry } from '../../shared/types'
import { app, liq } from '../core/app'
import { openModal, el, iconImg, closeX } from './dialogs'

/** payload for app.emit('show-openwith', ...): a FileEntry or a lean subset */
export interface OpenWithRequest {
  path: string
  name?: string
  ext?: string
  mime?: string
}

export function mountOpenWith(): void {
  app.on('show-openwith', (entry: OpenWithRequest) => { void show(entry) })
}

async function show(entry: OpenWithRequest): Promise<void> {
  if (!entry?.path) return
  const name = entry.name ?? entry.path.split('/').filter(Boolean).pop() ?? entry.path
  const ext = entry.ext ?? (name.includes('.') && !name.startsWith('.') ? name.split('.').pop()!.toLowerCase() : '')
  let mime = entry.mime
  if (!mime) {
    try {
      const st: (FileEntry | null)[] = await liq.statEntries([entry.path])
      mime = st?.[0]?.mime
    } catch { /* fall through */ }
    mime ||= 'application/octet-stream'
  }

  let suggested: AppCandidate[] = []
  try { suggested = await liq.listAppsFor(mime) ?? [] } catch { suggested = [] }

  let selectedId: string | null = null
  let moreLoaded = false

  const modal = openModal({
    width: 400,
    className: 'dlg-openwith',
    onEnter: () => confirm(),
  })

  const fileLabel = ext ? `.${ext} file` : (mime === 'inode/directory' ? 'folder' : 'file')

  const titleRow = el('div', 'dlg-title')
  titleRow.appendChild(el('span', 'dlg-title-text', 'Open with'))
  titleRow.appendChild(closeX(() => modal.close()))

  const body = el('div', 'dlg-body')
  body.appendChild(el('div', 'ow-heading', `How do you want to open this ${fileLabel}?`))

  const list = el('div', 'ow-list')
  list.setAttribute('role', 'listbox')
  body.appendChild(list)

  const okBtn = el('button', 'btn btn-primary', 'OK')
  okBtn.disabled = true

  const addRowFor = (a: AppCandidate, before?: HTMLElement): void => {
    const row = el('button', 'ow-row')
    row.setAttribute('role', 'option')
    row.dataset.appId = a.id
    row.appendChild(iconImg(a.icons, 24, 'ow-icon'))
    const meta = el('div', 'ow-meta')
    meta.appendChild(el('div', 'ow-name', a.name))
    if (a.isDefault) meta.appendChild(el('div', 'ow-sub', 'Current default'))
    row.appendChild(meta)
    row.addEventListener('click', () => select(a.id, row))
    row.addEventListener('dblclick', () => { select(a.id, row); confirm() })
    if (before) list.insertBefore(row, before)
    else list.appendChild(row)
  }

  const select = (id: string, row: HTMLElement): void => {
    selectedId = id
    okBtn.disabled = false
    for (const r of list.querySelectorAll('.ow-row.sel')) r.classList.remove('sel')
    row.classList.add('sel')
  }

  if (suggested.length) {
    for (const a of suggested) addRowFor(a)
  } else {
    list.appendChild(el('div', 'ow-empty', 'No suggested apps for this file type.'))
  }

  const moreRow = el('button', 'ow-more')
  moreRow.appendChild(el('span', '', 'More apps'))
  moreRow.appendChild(el('span', 'ow-more-chev', '⌄'))
  moreRow.addEventListener('click', async () => {
    if (moreLoaded) return
    moreLoaded = true
    moreRow.remove()
    let all: AppCandidate[] = []
    try { all = await liq.listAllApps() ?? [] } catch { all = [] }
    if (modal.closed) return
    const have = new Set(suggested.map(a => a.id))
    for (const a of all) {
      if (!have.has(a.id)) addRowFor(a)
    }
  })
  list.appendChild(moreRow)

  const alwaysRow = el('label', 'dlg-check')
  const alwaysChk = el('input')
  alwaysChk.type = 'checkbox'
  alwaysRow.append(alwaysChk,
    el('span', '', ext ? `Always use this app to open .${ext} files` : 'Always use this app to open files of this type'))
  body.appendChild(alwaysRow)

  const confirm = async (): Promise<void> => {
    if (!selectedId) return
    const appId = selectedId
    modal.close()
    try {
      if (alwaysChk.checked) await liq.setDefaultApp(mime, appId)
      await liq.openWith(entry.path, appId)
    } catch (e) {
      app.emit('show-confirm', {
        title: 'Open with',
        message: `Could not open the file: ${String((e as Error)?.message ?? e)}`,
        okLabel: 'OK', cancelLabel: '',
      })
    }
  }

  okBtn.addEventListener('click', confirm)
  const cancelBtn = el('button', 'btn', 'Cancel')
  cancelBtn.addEventListener('click', () => modal.close())
  const buttons = el('div', 'dlg-buttons')
  buttons.append(okBtn, cancelBtn)

  // preselect the current default so Enter/OK does the obvious thing
  const def = suggested.find(a => a.isDefault) ?? suggested[0]
  if (def) {
    const row = list.querySelector<HTMLElement>(`.ow-row[data-app-id="${CSS.escape(def.id)}"]`)
    if (row) select(def.id, row)
  }

  modal.dlg.append(titleRow, body, buttons)
}
