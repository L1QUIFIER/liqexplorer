// The one place that asks the user for an archive password. Mirrors the
// engine's askConflict contract exactly:
//   * op status flips to 'password' while we wait (and back to 'running' after)
//   * PUSH.opPassword carries a PasswordRequest to the originating window only
//   * the request is re-sent every 3s so a reloaded renderer recovers
//   * a destroyed originating window auto-resolves to "skip this archive"
//   * cancelling the op resolves any pending prompt immediately
//
// The renderer answers on the 'resolvePassword' invoke channel, registered here
// rather than in main/ipc.ts so the whole feature lives in one place.
//
// A password never leaves this module except as a return value: it is not
// logged, not written to OpProgress.currentFile, and not included in errors.
import { ipcMain, type WebContents } from 'electron'
import { CH, PUSH } from '../../../shared/ipc'
import type { OpStatus, PasswordRequest, PasswordResolution } from '../../../shared/types'
import { broadcast } from '../../windows'

export interface PromptCtx {
  opId: number
  /** originating window; null = internal replay, broadcast like askConflict does */
  sender: WebContents | null
  setStatus(s: OpStatus): void
  isCancelled(): boolean
}

interface Pending {
  reqId: number
  resolve: (r: PasswordResolution) => void
}

const RESEND_MS = 3000

const pending = new Map<number, Pending>()
let nextReqId = 1

ipcMain.handle(CH('resolvePassword'), (_e, res: PasswordResolution) => {
  const p = res && pending.get(res.opId)
  if (p && p.reqId === res.reqId) p.resolve(res)
})

/** Engine hook: cancelling an op must not leave the queue blocked on a prompt. */
export function cancelPasswordPrompt(opId: number): void {
  const p = pending.get(opId)
  if (p) p.resolve({ opId, reqId: p.reqId, password: null, applyToAll: false })
}

/**
 * Ask for the password to one archive. Resolves with password === null when the
 * user skips (or the window went away); the caller records that as a failure.
 */
export async function askPassword(
  ctx: PromptCtx, archivePath: string, archiveName: string, attempt: number,
): Promise<PasswordResolution> {
  const reqId = nextReqId++
  const req: PasswordRequest = { opId: ctx.opId, reqId, archivePath, archiveName, attempt }

  const send = (): void => {
    if (ctx.sender && !ctx.sender.isDestroyed()) ctx.sender.send(PUSH.opPassword, req)
    else if (!ctx.sender) broadcast(PUSH.opPassword, req)
  }

  ctx.setStatus('password')
  send()
  const resend = setInterval(() => {
    if (ctx.sender?.isDestroyed()) {
      // nobody left to answer — skip this archive rather than hang the queue
      pending.get(ctx.opId)?.resolve({ opId: ctx.opId, reqId, password: null, applyToAll: true })
      return
    }
    send()
  }, RESEND_MS)

  const res = await new Promise<PasswordResolution>(resolve => {
    pending.set(ctx.opId, { reqId, resolve })
  })
  clearInterval(resend)
  pending.delete(ctx.opId)
  if (!ctx.isCancelled()) ctx.setStatus('running')
  return res
}
