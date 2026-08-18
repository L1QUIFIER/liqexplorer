// Three tools that all produce the same shape of answer: a list of files sorted
// into buckets, where the interesting bucket is the bad one.
//
//   Verify checksums   ok / changed / missing / extra
//   Media health       plays / needs converting / cannot play
//   Compare folders    differs / only here / only there / same
//
// "Similar pictures" USED to render here too, and that was the mistake this comment now guards
// against: its answer is a set of pictures, and a text row cannot show a picture. It has its own
// dialog in similar.ts. A shared shell is right when the answer is a list of names; it is wrong the
// moment the thing being judged is visual.
//
// One dialog for all three, because writing three of them would produce three
// slightly different ideas of what a result list looks like, and the difference
// between "changed" and "differs" is not worth a second layout. Each bucket is
// collapsible and the problem buckets open first — a report whose bad news is
// below the fold gets closed before it is read.
import { app, liq } from '../core/app'
import { formatSize } from '../../shared/sort'
import type { VerifyResult } from '../../shared/verify'
import type { HealthResult } from '../../shared/mediahealth'
import type { CompareResult } from '../../shared/compare'
import type { CleanupResult } from '../../shared/toolbox'
import { openModal, el, closeX } from './dialogs'

interface Bucket {
  key: string
  label: string
  /** the ones worth opening by default */
  bad?: boolean
  rows: { text: string; sub?: string; path?: string }[]
}

let open = false

export function mountReports(): void {
  app.on('show-verify', (file?: string) => { void runVerify(file) })
  app.on('show-mediahealth', (root?: string) => { void runHealth(root) })
  app.on('show-compare', () => { void runCompare() })
  app.on('show-cleanup', (root?: string) => { void runCleanup(root) })
}

/** the shared shell: title, a status line, and collapsible buckets */
function report(title: string, status: string, buckets: Bucket[]): void {
  if (open) return
  open = true
  const modal = openModal({ width: 700, className: 'dlg-report', onDismiss: () => close() })
  const close = (): void => { open = false; modal.close() }

  const titleRow = el('div', 'dlg-title')
  titleRow.append(el('span', 'dlg-title-text', title), closeX(close))
  const body = el('div', 'dlg-body report-body')
  const buttons = el('div', 'dlg-buttons')
  const closeBtn = el('button', 'btn btn-primary', 'Close')
  closeBtn.addEventListener('click', close)
  buttons.appendChild(closeBtn)
  modal.dlg.append(titleRow, body, buttons)

  body.appendChild(el('div', 'report-status', status))

  for (const b of buckets) {
    const sec = el('div', 'report-sec' + (b.bad && b.rows.length ? ' is-bad' : ''))
    const head = el('button', 'report-head')
    head.type = 'button'
    head.append(
      el('span', 'report-chev', b.rows.length && (b.bad || buckets.length === 1) ? '▾' : '▸'),
      el('span', 'report-label', b.label),
      el('span', 'report-n', String(b.rows.length)),
    )
    const list = el('div', 'report-list')
    list.hidden = !(b.rows.length && (b.bad || buckets.length === 1))
    head.addEventListener('click', () => {
      list.hidden = !list.hidden
      ;(head.firstChild as HTMLElement).textContent = list.hidden ? '▸' : '▾'
    })
    for (const r of b.rows.slice(0, 500)) {
      const row = el('div', 'report-row')
      row.appendChild(el('span', 'report-name', r.text))
      if (r.sub) row.appendChild(el('span', 'report-sub', r.sub))
      if (r.path) {
        row.title = 'Show this file'
        row.classList.add('is-clickable')
        row.addEventListener('click', () => {
          close()
          const dir = r.path!.slice(0, r.path!.lastIndexOf('/')) || '/'
          void app.activeTab?.navigate(dir).then(() => app.activeTab?.setSelection(new Set([r.path!])))
        })
      }
      list.appendChild(row)
    }
    if (b.rows.length > 500) list.appendChild(el('div', 'opt-hint', `…and ${b.rows.length - 500} more`))
    sec.append(head, list)
    body.appendChild(sec)
  }
}

// ------------------------------------------------------------------ verify

async function runVerify(file?: string): Promise<void> {
  const target = file ?? [...(app.activeTab?.selection ?? [])][0]
  if (!target) return
  const r = await liq.invoke('verifyChecksums', target).catch(
    (e: Error) => ({ ok: false, error: String(e?.message ?? e) } as VerifyResult)) as VerifyResult
  if (!r.ok) { report('Verify checksums', r.error ?? 'That could not be checked.', []); return }
  const name = target.split('/').pop() ?? target
  report('Verify checksums',
    `${name} — ${r.checked} listed, ${r.ok_.length} unchanged`
    + (r.changed.length ? `, ${r.changed.length} CHANGED` : '')
    + (r.missing.length ? `, ${r.missing.length} missing` : ''),
    [
      { key: 'changed', label: 'Changed — the bytes no longer match', bad: true, rows: r.changed.map(t => ({ text: t })) },
      { key: 'missing', label: 'Missing — listed but not on disk', bad: true, rows: r.missing.map(t => ({ text: t })) },
      { key: 'extra', label: 'Not in the list — appeared since', rows: r.extra.map(t => ({ text: t })) },
      { key: 'ok', label: 'Unchanged', rows: r.ok_.map(t => ({ text: t })) },
    ])
}

// ------------------------------------------------------------- media health

async function runHealth(root?: string): Promise<void> {
  const target = root ?? app.activeTab?.path
  if (!target?.startsWith('/')) return
  const r = await liq.invoke('mediaHealth', target).catch(
    (e: Error) => ({ ok: false, error: String(e?.message ?? e) } as HealthResult)) as HealthResult
  if (!r.ok) { report('Media health', r.error ?? 'That could not be scanned.', []); return }
  const pick = (s: string) => r.rows.filter(x => x.state === s).map(x => ({
    text: x.name, sub: x.why || [x.video, x.audio].filter(Boolean).join(' / '), path: x.path,
  }))
  report('Media health',
    `${r.scanned} media files — ${r.plays} play, ${r.converts} need converting, ${r.fails} cannot be shown`
    + (r.truncated ? ' · stopped at the limit, so this covers only part of the tree' : ''),
    [
      { key: 'fails', label: 'Cannot be shown', bad: true, rows: pick('fails') },
      { key: 'converts', label: 'Converted on the fly (slower to start, seeking is a restart)', bad: true, rows: pick('converts') },
      { key: 'plays', label: 'Play as they are', rows: pick('plays') },
    ])
}

// ----------------------------------------------------------------- cleanup

async function runCleanup(root?: string): Promise<void> {
  const target = root ?? app.activeTab?.path
  if (!target?.startsWith('/')) return
  const r = await liq.invoke('findCleanup', target).catch(
    (e: Error) => ({ ok: false, error: String(e?.message ?? e) } as CleanupResult)) as CleanupResult
  if (!r.ok) { report('Empty folders & broken links', r.error ?? 'That could not be scanned.', []); return }
  const short = (p: string): string => (p.startsWith(target + '/') ? p.slice(target.length + 1) : p)
  report('Empty folders & broken links',
    `${r.emptyDirs.length} empty folders, ${r.brokenLinks.length} broken links — nothing has been deleted`,
    [
      {
        key: 'empty', label: 'Empty folders', bad: true,
        rows: r.emptyDirs.map(p => ({ text: short(p), path: p })),
      },
      {
        key: 'links', label: 'Links pointing at something that is gone', bad: true,
        rows: r.brokenLinks.map(p => ({ text: short(p), path: p })),
      },
    ])
}

// ----------------------------------------------------------------- compare

async function runCompare(): Promise<void> {
  const a = app.activeTab?.path
  if (!a?.startsWith('/')) return
  const picked = await liq.invoke('pickFolder', a).catch(() => null) as string | null
  if (!picked) return
  const r = await liq.invoke('compareFolders', a, picked).catch(
    (e: Error) => ({ ok: false, error: String(e?.message ?? e) } as CompareResult)) as CompareResult
  if (!r.ok) { report('Compare folders', r.error ?? 'Those could not be compared.', []); return }
  const size = (n: number): string => (n < 0 ? '—' : formatSize(n))
  const pick = (s: string) => r.rows.filter(x => x.state === s).map(x => ({
    text: x.rel,
    sub: x.state === 'differs' ? `${size(x.sizeA)} vs ${size(x.sizeB)}${x.note ? ` · ${x.note}` : ''}`
      : size(x.sizeA >= 0 ? x.sizeA : x.sizeB),
    path: x.state === 'onlyB' ? `${picked}/${x.rel}` : `${a}/${x.rel}`,
  }))
  report('Compare folders',
    `${a.split('/').pop()} ↔ ${picked.split('/').pop()} — `
    + `${r.differs} differ, ${r.onlyA} only here, ${r.onlyB} only there, ${r.same} identical`
    + (r.truncated ? ' · stopped at the limit, so this covers only part of the tree' : ''),
    [
      { key: 'differs', label: 'Same name, different content', bad: true, rows: pick('differs') },
      { key: 'onlyA', label: `Only in ${a.split('/').pop()}`, bad: true, rows: pick('onlyA') },
      { key: 'onlyB', label: `Only in ${picked.split('/').pop()}`, bad: true, rows: pick('onlyB') },
      { key: 'same', label: 'Identical', rows: pick('same') },
    ])
}
