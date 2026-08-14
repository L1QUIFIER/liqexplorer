// Generic Win11 confirmation modal (permanent delete, Empty Recycle Bin...).
// Callers either emit app.emit('show-confirm', opts) or import showConfirm().
import { app } from '../core/app'
import { openModal, el } from './dialogs'

export interface ConfirmOptions {
  title: string
  message: string
  okLabel?: string
  /** empty string or null hides the cancel button (plain alert) */
  cancelLabel?: string | null
  /** danger -> red primary button (destructive verb) */
  danger?: boolean
  onOk?: () => void
  onCancel?: () => void
}

export function mountConfirm(): void {
  app.on('show-confirm', (opts: ConfirmOptions) => showConfirm(opts))
}

export function showConfirm(opts: ConfirmOptions): void {
  let decided = false
  const ok = (): void => {
    if (decided) return
    decided = true
    modal.close()
    opts.onOk?.()
  }
  const cancel = (): void => {
    if (decided) return
    decided = true
    modal.close()
    opts.onCancel?.()
  }

  const modal = openModal({
    width: 360,
    className: 'dlg-confirm',
    onDismiss: cancel,
    onEnter: ok,
  })

  const titleRow = el('div', 'dlg-title')
  titleRow.appendChild(el('span', 'dlg-title-text', opts.title))

  const body = el('div', 'dlg-body')
  body.appendChild(el('div', 'dlg-msg', opts.message))

  const buttons = el('div', 'dlg-buttons')
  const okBtn = el('button', 'btn btn-primary' + (opts.danger ? ' btn-danger' : ''), opts.okLabel ?? 'OK')
  okBtn.addEventListener('click', ok)
  buttons.appendChild(okBtn)
  if (opts.cancelLabel !== '' && opts.cancelLabel !== null) {
    const cancelBtn = el('button', 'btn', opts.cancelLabel ?? 'Cancel')
    cancelBtn.addEventListener('click', cancel)
    buttons.appendChild(cancelBtn)
  }

  modal.dlg.append(titleRow, body, buttons)
}
