// The "Extract All" wizard.
//
// Explorer's version asks two things — where, and whether to open it afterwards
// — and this asks a third that the Windows one is regularly wished into
// existence: delete the archive once it is safely unpacked.
//
// Everything here is expressed in terms the app already has, which is why there
// is no main-side counterpart:
//
//   * the wrapper-folder choice is just extract mode 'named' vs 'to', a
//     distinction ops/archive.ts already implements in chooseTarget()
//   * deleting the archive is an ordinary trash op, so it lands in the undo
//     stack and the activity history exactly as a manual delete would — a
//     bespoke "delete after extract" path would have had neither
//   * showing the results is a navigation
//
// The last two happen only after the extract op reports 'done', and are skipped
// on cancel or failure: an archive whose extraction failed is the one archive
// you least want deleted.
import { app, liq } from '../core/app'
import type { OpProgress } from '../../shared/types'
import { openModal, el } from './dialogs'
import { archiveStem } from '../../shared/archive'

const PREF_KEY = 'extract-opts'

interface ExtractPrefs {
  intoFolder: boolean
  showWhenDone: boolean
  deleteArchive: boolean
}

function loadPrefs(): ExtractPrefs {
  const fallback: ExtractPrefs = { intoFolder: true, showWhenDone: true, deleteArchive: false }
  try {
    const raw = JSON.parse(localStorage.getItem(PREF_KEY) ?? '{}') as Partial<ExtractPrefs>
    return {
      intoFolder: raw.intoFolder !== false,
      showWhenDone: raw.showWhenDone !== false,
      // deliberately NOT remembered as on unless explicitly set: a destructive
      // option that quietly persists is how archives disappear by surprise
      deleteArchive: raw.deleteArchive === true,
    }
  } catch { return fallback }
}

function savePrefs(p: ExtractPrefs): void {
  try { localStorage.setItem(PREF_KEY, JSON.stringify(p)) } catch { /* private mode */ }
}

/** resolve once the op reaches a terminal state; true only for a clean finish */
function awaitOp(opId: number): Promise<boolean> {
  return new Promise(resolve => {
    const off = liq.on('liqpush:op-progress', (payload: unknown) => {
      const p = payload as OpProgress
      if (p.opId !== opId) return
      if (p.status === 'done') { off(); resolve(!p.failures?.length) }
      else if (p.status === 'cancelled' || p.status === 'error') { off(); resolve(false) }
    })
  })
}

export interface ExtractRequest {
  /** archives to unpack */
  archives: string[]
  /** where the picker should start */
  suggestedDest: string
  /** shown in the heading */
  title: string
}

/**
 * Ask, then extract. Resolves when the dialog is dismissed — the extraction
 * itself carries on in the background like every other op.
 */
export async function extractWizard(req: ExtractRequest): Promise<void> {
  if (!req.archives.length) return
  const prefs = loadPrefs()
  let dest = req.suggestedDest

  const modal = openModal({ width: 500, className: 'dlg-extract' })
  const body = el('div', 'ex-body')
  const heading = el('div', 'ex-head', req.archives.length === 1
    ? `Extract ${req.archives[0].slice(req.archives[0].lastIndexOf('/') + 1)}`
    : `Extract ${req.archives.length} archives`)

  const destRow = el('div', 'ex-destrow')
  const destLabel = el('div', 'ex-label', 'Files will be extracted to')
  const destPath = el('div', 'ex-dest', dest)
  destPath.title = dest
  const browse = el('button', 'btn', 'Browse…')
  browse.addEventListener('click', () => {
    void liq.invoke('pickFolder', dest).then((picked: string | null) => {
      if (!picked) return
      dest = picked
      destPath.textContent = dest
      destPath.title = dest
    })
  })
  destRow.append(destPath, browse)

  const check = (label: string, on: boolean, hint?: string): { row: HTMLElement; input: HTMLInputElement } => {
    const row = el('label', 'ex-check')
    const input = document.createElement('input')
    input.type = 'checkbox'
    input.checked = on
    row.append(input, el('span', '', label))
    if (hint) row.appendChild(el('div', 'ex-hint', hint))
    return { row, input }
  }

  const intoFolder = check('Put the files in a folder named after the archive', prefs.intoFolder,
    'Off, the contents go straight into the folder above.')
  const showWhenDone = check('Show the extracted files when finished', prefs.showWhenDone)
  const deleteArchive = check('Delete the archive afterwards', prefs.deleteArchive,
    'Only if it unpacks with no errors. It goes to the recycle bin, so it can be undone.')

  body.append(heading, destLabel, destRow, intoFolder.row, showWhenDone.row, deleteArchive.row)

  const buttons = el('div', 'dlg-buttons')
  const cancel = el('button', 'btn', 'Cancel')
  const go = el('button', 'btn primary', 'Extract')
  cancel.addEventListener('click', () => modal.close())
  go.addEventListener('click', () => {
    const chosen: ExtractPrefs = {
      intoFolder: intoFolder.input.checked,
      showWhenDone: showWhenDone.input.checked,
      deleteArchive: deleteArchive.input.checked,
    }
    savePrefs(chosen)
    modal.close()
    void run(req.archives, dest, chosen)
  })
  buttons.append(cancel, go)
  modal.dlg.append(body, buttons)
  go.focus()
}

async function run(archives: string[], dest: string, opts: ExtractPrefs): Promise<void> {
  const opId = await liq.invoke('extractArchives', {
    archives, dest,
    // 'named' makes chooseTarget() put each archive in its own <stem>/ folder;
    // 'to' drops the contents straight into dest
    mode: opts.intoFolder ? 'named' : 'to',
  }) as number

  if (!opts.showWhenDone && !opts.deleteArchive) return
  const clean = await awaitOp(opId)
  // a failed or cancelled extraction must not delete the source, and there is
  // nothing worth showing
  if (!clean) return

  if (opts.deleteArchive) {
    // through the op engine, so it is undoable and appears in the history
    await liq.startOp({ kind: 'trash', sources: archives }).catch(() => {})
  }
  if (opts.showWhenDone) {
    const target = opts.intoFolder && archives.length === 1
      ? `${dest}/${archiveStem(archives[0].slice(archives[0].lastIndexOf('/') + 1))}`
      : dest
    await app.activeTab.navigate(target).catch(() => {})
  }
}
