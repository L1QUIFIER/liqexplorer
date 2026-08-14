// 'Replace or Skip Files' — the Win11 conflict dialog (research-file-ops.md §2).
// One modal at a time; further conflicts queue and show sequentially. Folder-
// over-folder swaps Replace for Merge (folders are never replaced, always merged).
import type { ConflictInfo, ConflictChoice, FileEntry } from '../../shared/types'
import { app, liq } from '../core/app'
import { formatSize, formatDate } from '../../shared/sort'
import { openModal, el, iconImg, closeX } from './dialogs'

const queue: ConflictInfo[] = []
let showing: ConflictInfo | null = null
/** 'opId:conflictId' keys already answered — main re-broadcasts unresolved
 * conflicts every few seconds, so duplicate pushes must be no-ops. */
const answered = new Set<string>()

const keyOf = (c: { opId: number; conflictId: number }): string => `${c.opId}:${c.conflictId}`

export function mountConflict(): void {
  app.on('op-conflict', (c: ConflictInfo) => {
    if (answered.has(keyOf(c))) return
    if (showing && keyOf(showing) === keyOf(c)) return
    if (queue.some(q => keyOf(q) === keyOf(c))) return
    queue.push(c)
    if (!showing) showNext()
  })
}

function showNext(): void {
  const c = queue.shift()
  showing = c ?? null
  if (!c) return
  buildDialog(c)
}

function baseName(p: string): string {
  const parts = p.replace(/\/+$/, '').split('/')
  return parts[parts.length - 1] || p
}

function buildDialog(c: ConflictInfo): void {
  const isMerge = c.source.isDir && c.dest.isDir
  const name = baseName(c.dest.path)
  const pending = queue.length + 1

  let resolved = false
  const resolve = (choice: ConflictChoice, applyToAll: boolean): void => {
    if (resolved) return
    resolved = true
    answered.add(keyOf(c))
    if (answered.size > 1000) answered.clear()  // keep the dedupe set bounded
    liq.resolveConflict({ opId: c.opId, conflictId: c.conflictId, choice, applyToAll })
    if (applyToAll) {
      // flush queued conflicts of the same op with the same answer — main may
      // have auto-resolved them already; duplicate resolutions are harmless.
      for (let i = queue.length - 1; i >= 0; i--) {
        if (queue[i].opId === c.opId) {
          const q = queue.splice(i, 1)[0]
          answered.add(keyOf(q))
          liq.resolveConflict({ opId: q.opId, conflictId: q.conflictId, choice, applyToAll: true })
        }
      }
    }
    modal.close()
    showNext()
  }

  const modal = openModal({
    width: 440,
    className: 'dlg-conflict',
    onDismiss: () => resolve('cancel', false),
    onEnter: () => resolve(isMerge ? 'merge' : 'replace', applyChk.checked),
  })

  const titleRow = el('div', 'dlg-title')
  titleRow.appendChild(el('span', 'dlg-title-text',
    `Replacing ${pending} item${pending === 1 ? '' : 's'}`))
  titleRow.appendChild(closeX(() => resolve('cancel', false)))

  const body = el('div', 'dlg-body')
  body.appendChild(el('div', 'cfl-message', isMerge
    ? `The destination already contains a folder named "${name}"`
    : `The destination already has a file named "${name}"`))
  if (isMerge) {
    body.appendChild(el('div', 'dlg-msg',
      'If any files have the same names, you will be asked if you want to replace those files.'))
  }

  const noun = isMerge ? 'Folder' : 'File'
  const destCard = infoCard(`${noun} in destination`, c.dest)
  const srcCard = infoCard(`${noun} being copied`, c.source)
  body.append(destCard.root, srcCard.root)

  // resolve real theme icons asynchronously — ConflictInfo only carries stats
  liq.statEntries([c.dest.path, c.source.path]).then((st: (FileEntry | null)[]) => {
    if (modal.closed) return
    if (st?.[0]?.icons?.length) destCard.setIcons(st[0].icons)
    if (st?.[1]?.icons?.length) srcCard.setIcons(st[1].icons)
  }).catch(() => { /* keep fallback icons */ })

  const applyRow = el('label', 'dlg-check')
  const applyChk = el('input')
  applyChk.type = 'checkbox'
  applyRow.append(applyChk, el('span', '', 'Do this for the next conflicts'))
  body.appendChild(applyRow)

  const buttons = el('div', 'dlg-buttons')
  const cancelLink = el('button', 'btn-link', 'Cancel')
  cancelLink.addEventListener('click', () => resolve('cancel', false))
  const spacer = el('div', 'dlg-buttons-spacer')

  const primary = el('button', 'btn btn-primary', isMerge ? 'Merge' : 'Replace')
  primary.addEventListener('click', () => resolve(isMerge ? 'merge' : 'replace', applyChk.checked))
  const skip = el('button', 'btn', 'Skip')
  skip.addEventListener('click', () => resolve('skip', applyChk.checked))
  const keep = el('button', 'btn', 'Keep both')
  keep.addEventListener('click', () => resolve('keepBoth', applyChk.checked))
  buttons.append(cancelLink, spacer, primary, skip, keep)

  modal.dlg.append(titleRow, body, buttons)
}

function infoCard(label: string, info: { path: string; size: number; mtime: number; isDir: boolean }):
  { root: HTMLDivElement; setIcons: (names: string[]) => void } {
  const root = el('div', 'cfl-block')
  root.appendChild(el('div', 'cfl-label', label))
  const card = el('div', 'cfl-card')
  let img = iconImg(info.isDir ? ['folder', 'inode-directory'] : ['text-x-generic', 'application-x-generic'], 32, 'cfl-icon')
  card.appendChild(img)
  const meta = el('div', 'cfl-meta')
  meta.appendChild(el('div', 'cfl-name', baseName(info.path)))
  if (!info.isDir && info.size >= 0) {
    meta.appendChild(el('div', 'cfl-sub', `Size: ${formatSize(info.size)}`))
  }
  meta.appendChild(el('div', 'cfl-sub', `Modified: ${formatDate(info.mtime)}`))
  card.appendChild(meta)
  root.appendChild(card)
  return {
    root,
    setIcons: (names) => {
      const next = iconImg(names, 32, 'cfl-icon')
      img.replaceWith(next)
      img = next
    },
  }
}
