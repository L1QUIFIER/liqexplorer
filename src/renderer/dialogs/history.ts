// Activity history — "what did I actually do to these files?"
//
// Undo answers "put that back", but only while the app is open. This answers
// the question that comes an hour or a day later, when a folder is not where it
// was expected. Read-only by design: it lists what happened, and lets you jump
// to where the files ended up, but does not offer to reverse anything (a stale
// reversal of a week-old move would do more damage than it repairs).
import { app, liq } from '../core/app'
import { openModal, el, closeX } from './dialogs'
import { describeHistory, type HistoryEntry } from '../../shared/history'
import { formatDate } from '../../shared/sort'

const KIND_ICON: Record<string, string> = {
  copy: 'edit-copy,stock_copy', move: 'edit-cut,stock_cut',
  rename: 'edit-rename,text-editor', trash: 'user-trash',
  delete: 'edit-delete,user-trash-full', mkdir: 'folder-new',
  mkfile: 'document-new', symlink: 'emblem-symbolic-link,insert-link',
  restoreTrash: 'edit-undo', emptyTrash: 'user-trash',
  compress: 'package-x-generic', extract: 'archive-extract,package-x-generic',
}

export function mountHistory(): void {
  app.on('show-history', () => { void show() })
}

/** "2 minutes ago" / "Yesterday 14:02" — the absolute time is in the tooltip */
function relTime(ms: number): string {
  const secs = Math.max(0, (Date.now() - ms) / 1000)
  if (secs < 60) return 'Just now'
  if (secs < 3600) {
    const m = Math.round(secs / 60)
    return `${m} minute${m === 1 ? '' : 's'} ago`
  }
  if (secs < 86400) {
    const h = Math.round(secs / 3600)
    return `${h} hour${h === 1 ? '' : 's'} ago`
  }
  const d = Math.round(secs / 86400)
  if (d === 1) return 'Yesterday'
  if (d < 7) return `${d} days ago`
  return formatDate(ms)
}

/**
 * Abbreviate a path from the LEFT, so the part that identifies the file
 * survives: /home/user/Pictures/Trips/2024/a.jpg -> ~/…/Trips/2024/a.jpg.
 * CSS ellipsis truncates the wrong end for paths.
 */
function shortPath(p: string): string {
  if (!p) return ''
  const home = app.homePath
  let s = home && (p === home || p.startsWith(home + '/')) ? '~' + p.slice(home.length) : p
  const parts = s.split('/')
  if (parts.length > 5) s = [parts[0], '…', ...parts.slice(-3)].join('/')
  return s
}

/** the folder to open when a row is clicked: where the files ended up */
function landingFolder(e: HistoryEntry): string {
  if (e.dest) return e.dest
  const src = e.sources[0]
  if (!src) return ''
  const i = src.lastIndexOf('/')
  return i <= 0 ? '/' : src.slice(0, i)
}

async function show(): Promise<void> {
  const modal = openModal({ width: 560, className: 'dlg-history' })

  const title = el('div', 'dlg-title')
  title.appendChild(el('span', 'dlg-title-text', 'Activity history'))
  title.appendChild(closeX(modal.close))
  modal.dlg.appendChild(title)

  const body = el('div', 'dlg-body hist-body')
  modal.dlg.appendChild(body)

  const list = el('div', 'hist-list')
  list.setAttribute('role', 'list')
  body.appendChild(list)

  const foot = el('div', 'dlg-buttons hist-foot')
  const note = el('span', 'hist-note')
  foot.appendChild(note)

  const clearBtn = el('button', 'btn', 'Clear history')
  clearBtn.addEventListener('click', () => {
    app.emit('show-confirm', {
      title: 'Clear history',
      message: 'Delete the record of what this app did to your files? This does not change any files.',
      okLabel: 'Clear',
      danger: true,
      onOk: () => { void liq.invoke('clearHistory').then(() => { void load() }) },
    })
  })
  foot.appendChild(clearBtn)

  const okBtn = el('button', 'btn btn-primary', 'Close')
  okBtn.addEventListener('click', modal.close)
  foot.appendChild(okBtn)
  modal.dlg.appendChild(foot)

  async function load(): Promise<void> {
    list.innerHTML = ''
    let entries: HistoryEntry[] = []
    try { entries = await liq.invoke('listHistory', 300) as HistoryEntry[] } catch { /* none yet */ }

    if (!entries.length) {
      const empty = el('div', 'hist-empty')
      empty.appendChild(el('div', 'hist-empty-title',
        app.settings.historyEnabled ? 'Nothing recorded yet' : 'History is turned off'))
      empty.appendChild(el('div', 'hist-empty-sub', app.settings.historyEnabled
        ? 'Copies, moves, renames and deletes you make will be listed here.'
        : 'Turn it on in Options › General to start recording what you do to your files.'))
      list.appendChild(empty)
      note.textContent = ''
      clearBtn.disabled = true
      return
    }
    clearBtn.disabled = false
    note.textContent = `${entries.length} recent action${entries.length === 1 ? '' : 's'}`

    for (const e of entries) {
      const row = el('div', 'hist-row')
      row.setAttribute('role', 'listitem')
      if (e.status !== 'done') row.classList.add('bad')

      const img = document.createElement('img')
      img.className = 'hist-icon'
      img.width = 16
      img.height = 16
      img.draggable = false
      img.src = `liqicon://${KIND_ICON[e.kind] ?? 'document-properties'}?size=16`
      row.appendChild(img)

      const main = el('div', 'hist-main')
      main.appendChild(el('div', 'hist-what', describeHistory(e)))
      // the full paths matter when two folders share a name
      const detail = e.sources.slice(0, 2).join('\n')
        + (e.count > e.sources.length ? `\n… and ${e.count - e.sources.length} more` : '')
      const sub = el('div', 'hist-where', shortPath(e.sources[0] ?? ''))
      sub.title = detail + (e.dest ? `\n→ ${e.dest}` : '')
      main.appendChild(sub)
      row.appendChild(main)

      const when = el('div', 'hist-when', relTime(e.at))
      when.title = formatDate(e.at)
      row.appendChild(when)

      const dest = landingFolder(e)
      if (dest && !dest.includes('://')) {
        row.tabIndex = 0
        row.classList.add('clickable')
        row.title = `Open ${dest}`
        const go = (): void => { modal.close(); app.activeTab?.navigate(dest) }
        row.addEventListener('dblclick', go)
        row.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') go() })
      }
      list.appendChild(row)
    }
  }

  await load()
}
