// DROP BINS — what a bin actually does with the paths dropped on it.
//
// Nothing here reimplements a file operation. copy / move / symlink / trash /
// compress go through liq.startOp(), i.e. the same queued engine the rest of
// the app uses, so every one of them gets the progress card, the conflict
// dialog, the failure list and (where the engine records it) undo. Extract goes
// through the archive backend's 'extractArchives' exactly as core/actions.ts
// does; favourites and bulk rename are app events owned by other modules.
//
// Only image conversion and checksums are new work, and both live in the main
// process behind their own IPC (main/ops/convert.ts, main/ops/checksums.ts).
import { app, liq } from '../core/app'
import { isArchiveName } from '../../shared/archive'
import { TARGET_CWD, UNDOABLE, type BinConfig } from '../../shared/bins'
import {
  addToStack, bins, describe, removeFromStack, resolveTarget, toast,
} from './binstore'
import { openConvertDialog, runChecksums } from '../dialogs/bindialogs'

export interface RunOptions {
  /** the paths came out of the Stack, so a consuming action should empty it */
  fromStack?: boolean
}

function dirOf(p: string): string {
  const i = p.lastIndexOf('/')
  return i > 0 ? p.slice(0, i) : '/'
}

function confirmThen(title: string, message: string, okLabel: string, danger: boolean, run: () => void): void {
  app.emit('show-confirm', { title, message, okLabel, danger, onOk: run })
}

/** Undoable ops say so instead of offering a button: the op is queued, so at
 *  toast time it may not have run yet, and Ctrl+Z would pop whatever finished
 *  last — which is not necessarily this. */
function undoHint(bin: BinConfig): string | undefined {
  return UNDOABLE.has(bin.action) ? 'Ctrl+Z undoes this once it finishes.' : undefined
}

export async function runBin(bin: BinConfig, paths: string[], opts: RunOptions = {}): Promise<void> {
  const sources = paths.filter(p => p.startsWith('/') && !p.includes('://'))
  if (!sources.length) {
    toast({ text: 'Nothing usable was dropped.', sub: 'Items inside an archive or the Recycle Bin are not real files.', bad: true })
    return
  }
  // Move and Delete make the collected paths stop existing, so the Stack has to
  // let them go whatever the setting says; a Copy leaves them where they were,
  // and whether that empties the Stack is the user's call.
  const alwaysConsumes = bin.action === 'move' || bin.action === 'trash' || bin.action === 'bulkRename'
  const consumed = (): void => {
    if (opts.fromStack && (alwaysConsumes || bins().clearStackAfterUse)) removeFromStack(sources)
  }

  switch (bin.action) {
    case 'stack': {
      const n = addToStack(sources)
      toast(n
        ? { text: `Added ${n === sources.length ? describe(sources) : `${n} items`} to the Stack.` }
        : { text: 'Already in the Stack.' })
      return
    }

    case 'copy':
    case 'move':
    case 'symlink': {
      const dest = await resolveTarget(bin)
      if (!dest) return
      // same guards as views/dnd.ts: never drop a folder into itself or into
      // one of its own descendants, and never "move" something to where it is
      let list = sources.filter(s => dest !== s && !dest.startsWith(s + '/'))
      if (bin.action === 'move') list = list.filter(s => dirOf(s) !== dest)
      if (!list.length) {
        toast({ text: bin.action === 'move' ? 'Those items are already there.' : 'That destination is inside what you dropped.', bad: true })
        return
      }
      const verb = bin.action === 'move' ? 'Move' : bin.action === 'copy' ? 'Copy' : 'Create shortcuts for'
      const gerund = bin.action === 'move' ? 'Moving' : bin.action === 'copy' ? 'Copying' : 'Linking'
      const go = (): void => {
        void liq.startOp({ kind: bin.action, sources: list, dest })
        consumed()
        toast({ text: `${gerund} ${describe(list)}`, sub: dest, actions: [showAction(dest)] })
      }
      if (bin.confirm) {
        confirmThen(`${verb} items`, `${verb} ${describe(list)} to "${dest.split('/').pop() || dest}"?`, verb, false, go)
      } else { go() }
      return
    }

    case 'trash': {
      const go = (): void => {
        void liq.startOp({ kind: 'trash', sources })
        consumed()
        toast({ text: `Moved ${describe(sources)} to the Recycle Bin.`, sub: undoHint(bin) })
      }
      if (bin.confirm ?? app.settings.confirmTrash) {
        confirmThen('Delete', `Are you sure you want to move ${describe(sources)} to the Recycle Bin?`, 'Yes', true, go)
      } else { go() }
      return
    }

    case 'compress': {
      const dest = await resolveTarget(bin)
      if (!dest) return
      void liq.startOp({ kind: 'compress', sources, dest, format: bin.format ?? 'zip' })
      consumed()
      toast({ text: `Compressing ${describe(sources)} (${bin.format ?? 'zip'})`, sub: dest, actions: [showAction(dest)] })
      return
    }

    case 'extract': {
      const archives = sources.filter(p => isArchiveName(p.split('/').pop() ?? ''))
      if (!archives.length) {
        toast({ text: 'No archives in what you dropped.', bad: true })
        return
      }
      const mode = bin.extractMode ?? 'to'
      if (mode === 'to') {
        const dest = await resolveTarget(bin)
        if (!dest) return
        await liq.invoke('extractArchives', { archives, mode, dest })
        toast({ text: `Extracting ${describe(archives)}`, sub: dest, actions: [showAction(dest)] })
      } else {
        // 'auto'/'named' unpack BESIDE each archive — one call per source folder,
        // exactly as core/actions.ts does (a mixed selection must not all land
        // in the folder the first archive happened to live in).
        const byDir = new Map<string, string[]>()
        for (const a of archives) {
          const d = dirOf(a)
          const g = byDir.get(d)
          if (g) g.push(a); else byDir.set(d, [a])
        }
        for (const [d, list] of byDir) await liq.invoke('extractArchives', { archives: list, mode, dest: d })
        toast({ text: `Extracting ${describe(archives)}`, sub: 'beside each archive' })
      }
      consumed()
      return
    }

    case 'favorites': {
      app.emit('add-to-favorites', sources)
      consumed()
      toast({
        text: `Added ${describe(sources)} to Favorites.`,
        actions: [{ label: 'Undo', onClick: () => app.emit('remove-from-favorites', sources) }],
      })
      return
    }

    case 'bulkRename':
      // dialogs/bulkrename.ts owns the UI and the renames (each recorded on the
      // undo stack by main/ops/quick.ts)
      app.emit('show-bulk-rename', sources)
      consumed()
      return

    case 'convert':
      await openConvertDialog(sources, bin, consumed)
      return

    case 'checksums':
      await runChecksums(sources, bin.algo ?? 'sha256')
      return
  }
}

/** "Show" jumps the active tab to a folder an action just wrote into. */
function showAction(dest: string): { label: string; onClick: () => void } {
  return {
    label: 'Show',
    onClick: () => { void app.activeTab?.navigate(dest) },
  }
}

/** Human sub-label under a tile: where it will put things. */
export function binSubtitle(bin: BinConfig, target: string): string {
  switch (bin.action) {
    case 'stack': return 'Collect, then act on all of it'
    case 'favorites': return 'Quick access'
    case 'bulkRename': return 'Rename dialog'
    case 'checksums': return (bin.algo ?? 'sha256').toUpperCase()
    case 'trash': return 'Recoverable'
    case 'compress': return `${bin.format ?? 'zip'} → ${target}`
    case 'convert': return `${(bin.convert?.format ?? 'jpg').toUpperCase()} → ${target}`
    case 'extract': return bin.extractMode === 'to' ? target : 'beside each archive'
    default: return bin.target === TARGET_CWD ? 'This folder' : target
  }
}
