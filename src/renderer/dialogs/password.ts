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

interface PromptSpec {
  archiveName: string
  /** action word for the message ("extract it" / "test it") */
  verb: string
  /** >1 shows Explorer's "that password did not work" line */
  attempt: number
  /** omit to hide the "use for the other archives" checkbox */
  applyAllLabel?: string
  /** password === null means "skip / cancel" */
  resolve(password: string | null, applyToAll: boolean): void
}

function buildPrompt(spec: PromptSpec): void {
  let resolved = false
  const send = (password: string | null, applyToAll: boolean): void => {
    if (resolved) return
    resolved = true
    modal.close()
    spec.resolve(password, applyToAll)
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
    `"${midEllipsize(spec.archiveName)}" is encrypted. Enter its password to ${spec.verb}.`))

  const field = el('input', 'dlg-input pw-input')
  field.type = 'password'
  field.autocomplete = 'off'
  field.spellcheck = false
  field.setAttribute('aria-label', 'Password')
  body.appendChild(field)

  // only shown after a wrong password, exactly like Explorer's retry
  if (spec.attempt > 1) {
    body.appendChild(el('div', 'dlg-error', 'That password did not work. Try again.'))
  }

  const allBox = el('input')
  allBox.type = 'checkbox'
  if (spec.applyAllLabel) {
    const allRow = el('label', 'dlg-check')
    allRow.append(allBox, el('span', undefined, spec.applyAllLabel))
    body.appendChild(allRow)
  }

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
  // AFTER openModal's own requestAnimationFrame, which focuses .btn-primary
  // (the Unlock button) and would otherwise steal focus a frame later —
  // leaving the typed password to fall through to the global shortcut map,
  // where Delete/Backspace/F2 act on the file view behind the modal.
  requestAnimationFrame(() => { if (!modal.closed) field.focus() })
}

function buildDialog(r: PasswordRequest): void {
  buildPrompt({
    archiveName: r.archiveName,
    verb: 'extract it',
    attempt: r.attempt,
    applyAllLabel: 'Use this password for the other archives',
    resolve: (password, applyToAll) => {
      answered.add(keyOf(r))
      if (answered.size > 500) answered.clear()
      void liq.invoke('resolvePassword', {
        opId: r.opId, reqId: r.reqId, password, applyToAll,
      })
      showNext()
    },
  })
}

/** One-off prompt outside the op queue (e.g. "Test archive" on an encrypted
 *  file). Resolves to null when the user skips or dismisses. */
export function askArchivePassword(archiveName: string, attempt = 1): Promise<string | null> {
  return new Promise(resolve => {
    buildPrompt({ archiveName, verb: 'test it', attempt, resolve: pw => resolve(pw) })
  })
}
