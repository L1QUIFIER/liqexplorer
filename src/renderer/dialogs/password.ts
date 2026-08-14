// Password prompt for encrypted archives. The engine only reaches this point
// after the backend has silently tried every candidate it can derive (filename
// markers, the archive's own word parts, the parent folder name, sibling
// readme/nfo files, a small common list), so being asked means it genuinely
// could not be guessed.
//
// Same shape as the conflict dialog: one modal at a time, later requests queue,
// and repeat pushes are ignored — main re-sends an unresolved request every few
// seconds so a reloaded renderer recovers.
import type { PasswordRequest } from '../../shared/types'
import { app, liq } from '../core/app'
import { openModal, el, closeX, midEllipsize } from './dialogs'

const queue: PasswordRequest[] = []
let showing: PasswordRequest | null = null
const answered = new Set<string>()

const keyOf = (r: { opId: number; reqId: number }): string => `${r.opId}:${r.reqId}`

export function mountPassword(): void {
  app.on('op-password', (r: PasswordRequest) => {
    if (answered.has(keyOf(r))) return
    if (showing && keyOf(showing) === keyOf(r)) return
    if (queue.some(q => keyOf(q) === keyOf(r))) return
    queue.push(r)
    if (!showing) showNext()
  })
}

function showNext(): void {
  const r = queue.shift()
  showing = r ?? null
  if (r) buildDialog(r)
}

function buildDialog(r: PasswordRequest): void {
  let resolved = false
  const send = (password: string | null, applyToAll: boolean): void => {
    if (resolved) return
    resolved = true
    answered.add(keyOf(r))
    if (answered.size > 500) answered.clear()
    void liq.invoke('resolvePassword', {
      opId: r.opId, reqId: r.reqId, password, applyToAll,
    })
    modal.close()
    showNext()
  }

  const modal = openModal({
    width: 420,
    className: 'dlg-password',
    onDismiss: () => send(null, false),          // Esc / X = skip this archive
    onEnter: () => submit(),
  })

  const titleRow = el('div', 'dlg-title')
  titleRow.appendChild(el('span', 'dlg-title-text', 'Password required'))
  titleRow.appendChild(closeX(() => send(null, false)))

  const body = el('div', 'dlg-body')
  body.appendChild(el('div', 'dlg-msg',
    `"${midEllipsize(r.archiveName)}" is encrypted. Enter its password to extract it.`))

  const field = el('input', 'dlg-input pw-input')
  field.type = 'password'
  field.autocomplete = 'off'
  field.spellcheck = false
  field.setAttribute('aria-label', 'Password')
  body.appendChild(field)

  // only shown after a wrong password, exactly like Explorer's retry
  if (r.attempt > 1) {
    body.appendChild(el('div', 'dlg-error', 'That password did not work. Try again.'))
  }

  const allRow = el('label', 'dlg-check')
  const allBox = el('input')
  allBox.type = 'checkbox'
  allRow.append(allBox, el('span', undefined, 'Use this password for the other archives'))
  body.appendChild(allRow)

  const buttons = el('div', 'dlg-buttons')
  const okBtn = el('button', 'btn btn-primary', 'Unlock')
  const skipBtn = el('button', 'btn', 'Skip')
  function submit(): void {
    const pw = field.value
    if (!pw) return                              // empty = nothing to try
    send(pw, allBox.checked)
  }
  okBtn.addEventListener('click', submit)
  skipBtn.addEventListener('click', () => send(null, allBox.checked))
  buttons.append(okBtn, skipBtn)

  modal.dlg.append(titleRow, body, buttons)
  field.focus()
}
