// Properties dialog — Win11 General tab replica with Linux extras
// (research-properties-drives.md §1). Dir sizes stream live over
// PUSH.propsSize; drives get the capacity bar + used/free/total rows.
import type { AppCandidate, DriveDetail, PropertiesData } from '../../shared/types'
import { PUSH } from '../../shared/ipc'
import { app, liq } from '../core/app'
import { formatSize, formatDate } from '../../shared/sort'
import { openModal, el, iconImg, closeX, dualSize } from './dialogs'

interface PropsSizeMsg {
  reqId: number
  size: number
  sizeOnDisk: number
  files: number
  dirs: number
  done: boolean
}

export function mountProperties(): void {
  app.on('show-properties', (paths: string[]) => { void show(paths) })
}

async function show(paths: string[]): Promise<void> {
  if (!paths?.length) return
  let data: PropertiesData
  try {
    data = await liq.getProperties(paths)
  } catch (e) {
    app.emit('show-confirm', {
      title: 'Properties',
      message: `Could not read properties: ${String((e as Error)?.message ?? e)}`,
      okLabel: 'OK', cancelLabel: '',
    })
    return
  }

  const multi = paths.length > 1
  const isDrive = !!data.capacity
  const ext = !data.isDir && data.name.includes('.') ? data.name.split('.').pop()!.toLowerCase() : ''

  let offSize: (() => void) | null = null
  const modal = openModal({
    width: 380,
    className: 'dlg-props',
    onDismiss: () => close(),
    onEnter: () => close(),
  })
  const close = (): void => {
    offSize?.()
    offSize = null
    modal.close()
  }

  // -- title + single General tab
  const titleRow = el('div', 'dlg-title')
  titleRow.appendChild(el('span', 'dlg-title-text',
    multi ? 'Multiple Items' : `${data.name} Properties`))
  titleRow.appendChild(closeX(close))

  const tabs = el('div', 'dlg-tabs')
  tabs.appendChild(el('button', 'dlg-tab active', 'General'))

  const body = el('div', 'dlg-body')
  const grid = el('div', 'props-grid')
  body.appendChild(grid)

  const addSep = (): void => { grid.appendChild(el('div', 'props-sep')) }
  const addRow = (label: string, value?: string): HTMLDivElement => {
    grid.appendChild(el('div', 'props-label', label))
    const v = el('div', 'props-value', value ?? '')
    grid.appendChild(v)
    return v
  }

  // -- icon + name row
  const nameRow = el('div', 'props-name-row')
  nameRow.appendChild(iconImg(data.icons, 32, 'props-icon'))
  const nameBox = el('input', 'props-name')
  nameBox.readOnly = true
  nameBox.title = 'Renaming from Properties comes in a later version'
  nameBox.value = multi ? `${paths.length} items` : data.name
  nameRow.appendChild(nameBox)
  grid.appendChild(nameRow)
  addSep()
  if (multi) {
    // real counts of the selection itself (files vs folders)
    liq.statEntries(paths).then((st: ({ isDir: boolean } | null)[]) => {
      const dirs = st.filter(s => s?.isDir).length
      const files = st.filter(s => s && !s.isDir).length
      if (!modal.closed) nameBox.value = countsLabel(files, dirs)
    }).catch(() => { /* keep placeholder */ })
  }

  // -- type / opens with
  if (isDrive) {
    addRow('Type:', data.typeLabel || 'Drive')
    const fsRow = addRow('File system:', '—')
    liq.getDriveDetails().then((dd: DriveDetail[]) => {
      const d = dd.find(x => x.mountPoint === paths[0])
      if (d && !modal.closed) fsRow.textContent = d.fsType + (d.isNetwork ? ' (network)' : '')
    }).catch(() => { /* leave dash */ })
  } else if (multi) {
    addRow('Type:', 'Multiple Types')
  } else if (data.isDir) {
    addRow('Type:', data.typeLabel || 'File folder')
  } else {
    addRow('Type of file:', `${data.typeLabel || 'File'}${ext ? ` (.${ext})` : ''}`)
    const openApp: AppCandidate | undefined =
      data.openWith?.find(a => a.isDefault) ?? data.openWith?.[0]
    const owVal = el('div', 'props-openwith')
    const appSpan = el('span', 'props-openwith-app')
    if (openApp) {
      appSpan.appendChild(iconImg(openApp.icons, 16))
      appSpan.appendChild(el('span', '', openApp.name))
    } else {
      appSpan.appendChild(el('span', '', 'Unknown application'))
    }
    const change = el('button', 'btn btn-small', 'Change...')
    change.addEventListener('click', () => {
      app.emit('show-openwith', { path: paths[0], name: data.name, ext, mime: data.mime })
    })
    owVal.append(appSpan, change)
    grid.appendChild(el('div', 'props-label', 'Opens with:'))
    grid.appendChild(owVal)
  }
  addSep()

  // -- location / sizes
  addRow('Location:', data.dir)
  let sizeRow: HTMLDivElement | null = null
  let diskRow: HTMLDivElement | null = null
  let containsRow: HTMLDivElement | null = null
  if (isDrive && data.capacity) {
    const { total, free } = data.capacity
    const used = Math.max(0, total - free)
    addRow('Used space:', dualSize(used, formatSize(used)))
    addRow('Free space:', dualSize(free, formatSize(free)))
    addRow('Capacity:', dualSize(total, formatSize(total)))
    const bar = el('div', 'cap-bar')
    const fill = el('div', 'cap-fill')
    const pct = total > 0 ? (used / total) * 100 : 0
    fill.style.width = pct.toFixed(1) + '%'
    if (total > 0 && free / total < 0.1) fill.classList.add('low')
    bar.appendChild(fill)
    grid.appendChild(bar)
    grid.appendChild(el('div', 'cap-legend',
      total > 0 ? `${formatSize(free)} free of ${formatSize(total)}` : ''))
  } else {
    const known = data.size >= 0
    sizeRow = addRow('Size:', known ? dualSize(data.size, formatSize(data.size)) : 'Calculating…')
    diskRow = addRow('Size on disk:', known ? dualSize(data.sizeOnDisk, formatSize(data.sizeOnDisk)) : 'Calculating…')
    if (data.isDir || multi) {
      containsRow = addRow('Contains:', data.itemCount
        ? countsLabel(data.itemCount.files, data.itemCount.dirs)
        : 'Calculating…')
    }
  }
  addSep()

  // -- timestamps
  addRow('Created:', formatDate(data.btime ?? data.ctime))
  addRow('Modified:', formatDate(data.mtime))
  addRow('Accessed:', formatDate(data.atime))
  addSep()

  // -- attributes + Linux extras
  const attrVal = el('div', 'props-attrs')
  const roTip = data.permsImmutable
    ? 'Permissions on this mount are controlled by the server'
    : 'Changing attributes comes in a later version'
  attrVal.appendChild(checkbox('Read-only', data.perms.readonly, roTip))
  attrVal.appendChild(checkbox('Hidden', data.name.startsWith('.'), 'Changing attributes comes in a later version'))
  grid.appendChild(el('div', 'props-label', 'Attributes:'))
  grid.appendChild(attrVal)
  if (!multi) {
    addRow('Owner:', data.owner)
    addRow('Group:', data.group)
    addRow('Permissions:', `${data.perms.text} (${data.perms.octal})${data.permsImmutable ? ' — fixed by mount' : ''}`)
    if (data.isSymlink && data.target) addRow('Link target:', data.target)
  }

  // -- buttons
  const buttons = el('div', 'dlg-buttons')
  const okBtn = el('button', 'btn btn-primary', 'OK')
  okBtn.addEventListener('click', close)
  const cancelBtn = el('button', 'btn', 'Cancel')
  cancelBtn.addEventListener('click', close)
  buttons.append(okBtn, cancelBtn)

  modal.dlg.append(titleRow, tabs, body, buttons)

  // -- live size scan for dirs / multi-selections (never for whole drives)
  if (!isDrive && (data.isDir || multi)) {
    try {
      const reqId: number = await liq.showProperties(paths)
      offSize = liq.on(PUSH.propsSize, (m: PropsSizeMsg) => {
        if (m.reqId !== reqId) return
        // unsubscribe BEFORE the closed early-return, or a listener registered
        // just after close() (which found offSize still null) leaks forever
        if (m.done || modal.closed) { offSize?.(); offSize = null }
        if (modal.closed) return
        if (sizeRow) sizeRow.textContent = dualSize(m.size, formatSize(m.size))
        if (diskRow) diskRow.textContent = dualSize(m.sizeOnDisk, formatSize(m.sizeOnDisk))
        if (containsRow) containsRow.textContent = countsLabel(m.files, m.dirs) + (m.done ? '' : '…')
      })
      // close() may have run during the await, missing the not-yet-set offSize
      if (modal.closed) { offSize?.(); offSize = null }
    } catch { /* scan unavailable — leave static values */ }
  }
}

function countsLabel(files: number, dirs: number): string {
  return `${files.toLocaleString('en-US')} Files, ${dirs.toLocaleString('en-US')} Folders`
}

function checkbox(label: string, checked: boolean, tip: string): HTMLLabelElement {
  const wrap = el('label', 'dlg-check dlg-check-disabled')
  const chk = el('input')
  chk.type = 'checkbox'
  chk.checked = checked
  chk.disabled = true
  wrap.title = tip
  wrap.append(chk, el('span', '', label))
  return wrap
}
