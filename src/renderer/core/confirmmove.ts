// One place where "should we ask before doing this?" is decided.
//
// Three surfaces move files — paste, drag & drop, and the dual-pane F5/F6
// transfer — and each previously had its own copy of the confirm logic. They
// now all call confirmTransfer(), so a setting change applies everywhere and
// safe mode cannot be bypassed just by using a different gesture.
import { app, liq } from './app'
import { allMounts } from './mounts'
import { assessMove } from '../../shared/moverisk'
import type { OpKind } from '../../shared/types'

const VERB: Record<string, string> = {
  copy: 'Copy', move: 'Move', symlink: 'Create shortcuts for',
}

function baseName(p: string): string {
  return p.replace(/\/+$/, '').split('/').pop() || p
}

export interface TransferReq {
  kind: OpKind
  sources: string[]
  dest: string
  /** the user's plain confirm setting for this gesture (confirmDrop/confirmMove) */
  always?: boolean
  /** run when confirmed (or when no confirmation was needed) */
  run: () => void
}

/**
 * Ask if the user's settings say to, or if safe mode judges this move unusual;
 * otherwise just run it. Safe mode only fires for move/symlink-style relocation
 * and for copies INTO system locations — copying a file out of /usr is harmless.
 */
export function confirmTransfer(req: TransferReq): void {
  const { kind, sources, dest, always, run } = req
  const s = app.settings
  const verb = VERB[kind] ?? 'Move'

  let reason = ''
  if (s.safeMode && (kind === 'move' || kind === 'copy' || kind === 'trash')) {
    // A copy leaves the originals where they are, so the source half of the
    // assessment is not a hazard for it — only writing INTO a system location is.
    const risk = assessMove(kind === 'copy' ? [] : sources, dest, {
      mountPoints: allMounts(),
      count: kind === 'copy' ? 0 : sources.length,
      bulkThreshold: s.safeModeBulk,
      home: app.homePath,
    })
    if (risk.risky) reason = risk.reason || ''
  }

  if (!reason && !always) { run(); return }

  const what = sources.length === 1 ? `"${baseName(sources[0])}"` : `${sources.length} items`
  const where = dest ? ` to "${baseName(dest)}"` : ''
  app.emit('show-confirm', {
    title: reason ? 'Check this move' : `${verb} items`,
    message: reason
      ? `${reason}\n\n${verb} ${what}${where}?`
      : `${verb} ${what}${where}?`,
    okLabel: verb,
    danger: !!reason,
    onOk: run,
  })
}

/** Convenience for the common "start an op once confirmed" case. */
export function transferWithConfirm(
  kind: OpKind, sources: string[], dest: string, always?: boolean,
): void {
  confirmTransfer({
    kind, sources, dest, always,
    run: () => { void liq.startOp({ kind, sources, dest }) },
  })
}
