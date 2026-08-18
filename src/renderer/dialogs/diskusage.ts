// "What is using all the space?"
//
// Two lists, because there are two shapes the answer takes and they are not the
// same question: WHERE the space went (folders, ranked, with a bar) and WHAT is
// big (the largest individual files anywhere below). A folder view alone makes
// you drill five levels to find one film; a file list alone hides that a
// thousand small things add up to more.
//
// Clicking a folder rescans from there, so drilling down is the same operation
// rather than a second mode, and the breadcrumb walks back out.
import { app, liq } from '../core/app'
import { PUSH } from '../../shared/ipc'
import { formatSize } from '../../shared/sort'
import { USAGE_PUSH, type UsageProgress, type UsageResult, type UsageRow } from '../../shared/diskusage'
import { openModal, el, closeX } from './dialogs'

let open = false

export function mountDiskUsage(): void {
  app.on('show-diskusage', (root?: string) => { void show(root ?? app.activeTab?.path ?? '') })
}

async function show(startRoot: string): Promise<void> {
  if (open) return
  if (!startRoot.startsWith('/')) return
  open = true

  const modal = openModal({ width: 720, className: 'dlg-usage', onDismiss: () => close() })
  const close = (): void => { open = false; off?.(); modal.close() }

  const titleRow = el('div', 'dlg-title')
  const titleText = el('span', 'dlg-title-text', 'Disk usage')
  titleRow.append(titleText, closeX(close))
  const body = el('div', 'dlg-body usage-body')
  const buttons = el('div', 'dlg-buttons')
  modal.dlg.append(titleRow, body, buttons)

  const crumb = el('div', 'usage-crumb')
  const status = el('div', 'usage-status', 'Scanning…')
  const lists = el('div', 'usage-lists')
  body.append(crumb, status, lists)

  const closeBtn = el('button', 'btn btn-primary', 'Close')
  closeBtn.addEventListener('click', close)
  const stopBtn = el('button', 'btn', 'Stop')
  buttons.append(closeBtn, el('div', 'dlg-buttons-spacer'), stopBtn)

  let scanId = 0
  const off = liq.on(USAGE_PUSH, (p: UsageProgress) => {
    scanId = p.scanId
    if (p.done) return
    status.textContent = `${p.files.toLocaleString()} files · ${formatSize(p.bytes)} · ${p.dirs.toLocaleString()} folders`
      + (p.current ? ` — ${p.current}` : '')
  })
  stopBtn.addEventListener('click', () => { if (scanId) void liq.invoke('cancelUsage', scanId) })

  /** roots visited, so the breadcrumb can walk back out of a drill-down */
  const trail: string[] = []

  async function scan(root: string): Promise<void> {
    lists.textContent = ''
    status.textContent = 'Scanning…'
    titleText.textContent = 'Disk usage — ' + (root.split('/').pop() || root)
    paintCrumb(root)
    const r = await liq.invoke('scanUsage', root).catch(
      (e: Error) => ({ ok: false, error: String(e?.message ?? e) } as UsageResult)) as UsageResult
    if (!r.ok) { status.textContent = r.error ?? 'That could not be scanned.'; return }
    status.textContent = `${r.totalFiles.toLocaleString()} files · ${formatSize(r.totalBytes)}`
      + (r.cancelled ? ' (stopped early — partial)' : '')
      + (r.problems.length ? ` · ${r.problems.length} unreadable` : '')
    paint(r)
  }

  function paintCrumb(root: string): void {
    crumb.textContent = ''
    const parts = [...trail, root]
    parts.forEach((p, i) => {
      const b = el('button', 'usage-crumb-btn', p.split('/').pop() || p)
      b.title = p
      b.addEventListener('click', () => {
        trail.length = i
        void scan(p)
      })
      crumb.appendChild(b)
      if (i < parts.length - 1) crumb.appendChild(el('span', 'usage-crumb-sep', '›'))
    })
  }

  function rowEl(r: UsageRow, root: string): HTMLElement {
    const row = el('div', 'usage-row' + (r.isDir ? ' is-dir' : ''))
    const bar = el('div', 'usage-bar')
    // the bar is the point: a column of numbers makes you compare, a bar shows
    bar.style.width = `${Math.max(1, Math.round(r.share * 100))}%`
    const name = el('div', 'usage-name', r.name)
    name.title = r.path
    const size = el('div', 'usage-size', formatSize(r.bytes))
    const pct = el('div', 'usage-pct', `${Math.round(r.share * 100)}%`)
    const count = el('div', 'usage-count', r.isDir ? `${r.files.toLocaleString()} files` : '')
    row.append(bar, name, count, size, pct)

    if (r.isDir) {
      row.title = 'Scan inside this folder'
      row.addEventListener('click', () => { trail.push(root); void scan(r.path) })
    } else {
      row.title = 'Show this file'
      row.addEventListener('click', () => {
        close()
        const dir = r.path.slice(0, r.path.lastIndexOf('/')) || '/'
        void app.activeTab?.navigate(dir).then(() => app.activeTab?.setSelection(new Set([r.path])))
      })
    }
    return row
  }

  function paint(r: UsageResult): void {
    lists.textContent = ''
    const left = el('div', 'usage-col')
    left.appendChild(el('div', 'usage-h', 'Where it went'))
    if (!r.children.length) left.appendChild(el('div', 'opt-hint', 'Nothing here.'))
    for (const c of r.children) left.appendChild(rowEl(c, r.root))

    const right = el('div', 'usage-col')
    right.appendChild(el('div', 'usage-h', 'Biggest files'))
    if (!r.biggest.length) right.appendChild(el('div', 'opt-hint', 'No files.'))
    for (const b of r.biggest) right.appendChild(rowEl(b, r.root))

    lists.append(left, right)

    if (r.problems.length) {
      const p = el('div', 'opt-note', `Could not read: ${r.problems.slice(0, 3).join(' · ')}`
        + (r.problems.length > 3 ? ` and ${r.problems.length - 3} more` : ''))
      body.appendChild(p)
    }
  }

  await scan(startRoot)
}
