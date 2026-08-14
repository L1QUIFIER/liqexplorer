// Operations progress center — the Win11 copy-dialog replica, rendered as a
// bottom-right card stack in #ops-flyout. One card per live operation, each
// with header, green progress bar, pause/resume + cancel, and a 'More details'
// expansion carrying the signature live speed graph (research-file-ops.md §1).
import type { OpKind, OpProgress } from '../../shared/types'
import { app, liq } from '../core/app'
import { formatSize } from '../../shared/sort'
import { el, midEllipsize } from './dialogs'

// 'More details' persists for the session, globally across ops (EnthusiastMode).
let detailsExpanded = false

/** ops that finished with failures / errored: kept visible after app.ts drops
 *  them from app.ops, until the user hits Dismiss. */
const retained = new Map<number, OpProgress>()
/** per-op UI state that survives re-render */
const failListOpen = new Set<number>()

interface Card {
  root: HTMLDivElement
  title: HTMLDivElement
  pauseBtn: HTMLButtonElement
  cancelBtn: HTMLButtonElement
  bar: HTMLDivElement
  fill: HTMLDivElement
  percent: HTMLDivElement
  toggle: HTMLButtonElement
  details: HTMLDivElement
  fileLine: HTMLDivElement
  canvas: HTMLCanvasElement
  speedLine: HTMLDivElement
  itemsLine: HTMLDivElement
  etaLine: HTMLDivElement
  extra: HTMLDivElement
  status: OpProgress['status'] | ''
}

const cards = new Map<number, Card>()
let stackEl: HTMLDivElement | null = null

export function mountOps(): void {
  const host = document.getElementById('ops-flyout')
  if (!host) return
  stackEl = el('div', 'ops-stack')
  host.appendChild(stackEl)
  app.on('ops-changed', render)
  // seed: pick up operations already running (renderer reload mid-op)
  liq.getOps().then((ops: OpProgress[]) => {
    if (!ops?.length) return
    for (const p of ops) {
      if (!app.ops.some(o => o.opId === p.opId)) app.ops.push(p)
    }
    render()
  }).catch(() => { /* ok */ })
}

function render(): void {
  if (!stackEl) return
  // retain finished-with-failures and errored ops until dismissed
  for (const p of app.ops) {
    if ((p.status === 'done' && p.failures?.length) || p.status === 'error') {
      retained.set(p.opId, p)
    }
  }
  const live = app.ops
  const display: OpProgress[] = [...live]
  for (const [id, p] of retained) {
    if (!live.some(o => o.opId === id)) display.push(p)
  }
  const wanted = new Set(display.map(p => p.opId))
  for (const [id, card] of cards) {
    if (!wanted.has(id)) { card.root.remove(); cards.delete(id); failListOpen.delete(id) }
  }
  for (const p of display) {
    let card = cards.get(p.opId)
    if (!card) { card = buildCard(p); cards.set(p.opId, card); stackEl.appendChild(card.root) }
    updateCard(card, p)
  }
}

// -------------------------------------------------------------------- verbs

function verbing(kind: OpKind): string {
  switch (kind) {
    case 'copy': return 'Copying'
    case 'move': return 'Moving'
    case 'trash': return 'Recycling'
    case 'delete': return 'Deleting'
    case 'compress': return 'Compressing'
    case 'extract': return 'Extracting'
    case 'restoreTrash': return 'Restoring'
    case 'emptyTrash': return 'Emptying Recycle Bin'
    case 'rename': return 'Renaming'
    case 'symlink': return 'Linking'
    default: return 'Processing'
  }
}

function verbedPast(kind: OpKind): string {
  switch (kind) {
    case 'copy': return 'copied'
    case 'move': return 'moved'
    case 'trash': return 'recycled'
    case 'delete': return 'deleted'
    case 'compress': return 'compressed'
    case 'extract': return 'extracted'
    case 'restoreTrash': return 'restored'
    case 'emptyTrash': return 'deleted'
    case 'rename': return 'renamed'
    default: return 'processed'
  }
}

function baseName(p: string): string {
  const parts = p.replace(/\/+$/, '').split('/')
  return parts[parts.length - 1] || p
}
function dirLabel(p: string): string {
  const parts = p.replace(/\/+$/, '').split('/')
  parts.pop()
  return parts[parts.length - 1] || '/'
}

function headerText(p: OpProgress): string {
  // src/dest labels come along when the engine includes them (see contract
  // request); otherwise derive the source folder from the current file.
  const x = p as OpProgress & { srcLabel?: string; destLabel?: string; dest?: string; sources?: string[] }
  const n = p.itemsTotal > 0 ? p.itemsTotal : 0
  const items = n ? `${n} item${n === 1 ? '' : 's'}` : 'items'
  const src = x.srcLabel ?? (x.sources?.length ? dirLabel(x.sources[0]) : '')
  const srcFrom = src || (p.currentFile ? dirLabel(p.currentFile) : '')
  const dst = x.destLabel ?? (x.dest ? baseName(x.dest) : '')
  switch (p.kind) {
    case 'copy': case 'move': case 'extract':
      return `${verbing(p.kind)} ${items}${srcFrom ? ` from ${srcFrom}` : ''}${dst ? ` to ${dst}` : ''}`
    case 'trash': case 'delete':
      return `${verbing(p.kind)} ${items}${srcFrom ? ` from ${srcFrom}` : ''}`
    case 'emptyTrash':
      return 'Emptying the Recycle Bin'
    case 'compress':
      return `Compressing ${items}${dst ? ` to ${dst}` : ''}`
    default:
      return `${verbing(p.kind)} ${items}`
  }
}

// -------------------------------------------------------------------- card

const SVG_PAUSE = '<svg width="12" height="12" viewBox="0 0 12 12"><path d="M3 1.5v9M9 1.5v9" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>'
const SVG_PLAY = '<svg width="12" height="12" viewBox="0 0 12 12"><path d="M3 1.8v8.4L10 6z" fill="currentColor"/></svg>'
const SVG_CLOSE = '<svg width="12" height="12" viewBox="0 0 12 12"><path d="M2 2l8 8M10 2l-8 8" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>'
const SVG_WARN = '<svg width="14" height="14" viewBox="0 0 14 14"><path d="M7 1.2 13.2 12H.8Z" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/><path d="M7 5.2v3.2" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/><circle cx="7" cy="10.4" r=".8" fill="currentColor"/></svg>'

function buildCard(p: OpProgress): Card {
  const root = el('div', 'ops-card')
  const head = el('div', 'ops-head')
  const title = el('div', 'ops-title')
  const actions = el('div', 'ops-actions')
  const pauseBtn = el('button', 'ops-ibtn')
  pauseBtn.setAttribute('aria-label', 'Pause')
  pauseBtn.innerHTML = SVG_PAUSE
  const cancelBtn = el('button', 'ops-ibtn')
  cancelBtn.setAttribute('aria-label', 'Cancel')
  cancelBtn.innerHTML = SVG_CLOSE
  actions.append(pauseBtn, cancelBtn)
  head.append(title, actions)

  const bar = el('div', 'ops-bar')
  const fill = el('div', 'ops-bar-fill')
  bar.appendChild(fill)
  const percent = el('div', 'ops-percent')

  const toggle = el('button', 'ops-toggle')
  const details = el('div', 'ops-details')
  const fileLine = el('div', 'ops-file')
  const canvas = el('canvas', 'ops-graph')
  canvas.style.width = '260px'
  canvas.style.height = '60px'
  const speedLine = el('div', 'ops-stat')
  const itemsLine = el('div', 'ops-stat')
  const etaLine = el('div', 'ops-stat')
  details.append(fileLine, canvas, speedLine, itemsLine, etaLine)

  const extra = el('div', 'ops-extra')

  root.append(head, bar, percent, toggle, details, extra)

  const card: Card = {
    root, title, pauseBtn, cancelBtn, bar, fill, percent, toggle, details,
    fileLine, canvas, speedLine, itemsLine, etaLine, extra, status: '',
  }

  pauseBtn.addEventListener('click', () => {
    const cur = latest(p.opId)
    if (!cur) return
    if (cur.status === 'paused') liq.resumeOp(cur.opId)
    else liq.pauseOp(cur.opId)
  })
  cancelBtn.addEventListener('click', () => liq.cancelOp(p.opId))
  toggle.addEventListener('click', () => {
    detailsExpanded = !detailsExpanded
    render()
  })
  return card
}

function latest(opId: number): OpProgress | undefined {
  return app.ops.find(o => o.opId === opId) ?? retained.get(opId)
}

function fmtEta(sec: number): string {
  if (!isFinite(sec) || sec <= 0) return 'Calculating…'
  const s = Math.round(sec)
  if (s >= 3600) return `~${Math.floor(s / 3600)}:${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`
  return `~${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

function updateCard(c: Card, p: OpProgress): void {
  c.status = p.status
  c.title.textContent = headerText(p)
  c.title.title = c.title.textContent

  const running = p.status === 'queued' || p.status === 'enumerating' || p.status === 'running'
    || p.status === 'paused' || p.status === 'conflict'
  const indeterminate = (p.status === 'enumerating' || p.bytesTotal <= 0) && p.status !== 'done'
  const pct = p.bytesTotal > 0
    ? Math.min(100, Math.floor((p.bytesDone / p.bytesTotal) * 100))
    : (p.status === 'done' ? 100 : 0)

  // progress bar
  c.bar.classList.toggle('ind', indeterminate && running)
  c.bar.classList.toggle('paused', p.status === 'paused')
  if (!(indeterminate && running)) c.fill.style.width = (p.status === 'done' ? 100 : pct) + '%'

  // percent / status line
  if (p.status === 'enumerating') c.percent.textContent = 'Discovering items…'
  else if (p.status === 'queued') c.percent.textContent = 'Waiting…'
  else if (p.status === 'paused') c.percent.textContent = `Paused — ${pct}% complete`
  else if (p.status === 'conflict') c.percent.textContent = `${pct}% complete — action needed`
  else if (p.status === 'cancelled') c.percent.textContent = 'Cancelled'
  else if (p.status === 'error') c.percent.textContent = 'Error'
  else if (p.status === 'done') c.percent.textContent = p.failures?.length ? 'Done — with errors' : '100% complete'
  else c.percent.textContent = `${pct}% complete`

  // controls
  c.pauseBtn.hidden = !running || p.status === 'conflict'
  c.cancelBtn.hidden = !running
  c.pauseBtn.innerHTML = p.status === 'paused' ? SVG_PLAY : SVG_PAUSE
  c.pauseBtn.setAttribute('aria-label', p.status === 'paused' ? 'Resume' : 'Pause')

  // details expansion
  c.toggle.hidden = !running
  c.toggle.textContent = detailsExpanded ? 'Fewer details' : 'More details'
  const showDetails = detailsExpanded && running
  c.details.classList.toggle('open', showDetails)
  if (showDetails) {
    c.fileLine.textContent = p.currentFile ? `Name: ${midEllipsize(baseName(p.currentFile))}` : ''
    c.fileLine.title = p.currentFile
    c.speedLine.textContent = `Speed: ${formatSize(Math.max(0, p.speed))}/s`
    const itemsLeft = Math.max(0, p.itemsTotal - p.itemsDone)
    const bytesLeft = Math.max(0, p.bytesTotal - p.bytesDone)
    c.itemsLine.textContent = p.itemsTotal > 0
      ? `Items remaining: ${itemsLeft} (${formatSize(bytesLeft)})`
      : 'Items remaining: Calculating…'
    c.etaLine.textContent = `Time remaining: ${fmtEta(p.etaSec)}`
    drawGraph(c.canvas, p.speedHistory ?? [])
  }

  renderExtra(c, p)
}

// failures summary / error message / dismiss
function renderExtra(c: Card, p: OpProgress): void {
  c.extra.textContent = ''
  if (p.status === 'error') {
    c.root.classList.add('error')
    const msg = el('div', 'ops-error-msg', p.error || 'The operation failed.')
    const row = el('div', 'ops-extra-buttons')
    const dis = el('button', 'btn', 'Dismiss')
    dis.addEventListener('click', () => dismissOp(p.opId))
    row.appendChild(dis)
    c.extra.append(msg, row)
    return
  }
  c.root.classList.remove('error')

  if (p.status === 'done' && p.failures?.length) {
    const n = p.failures.length
    const warn = el('div', 'ops-warn')
    const sumRow = el('button', 'ops-warn-summary')
    sumRow.innerHTML = SVG_WARN
    sumRow.appendChild(el('span', '', ` ${n} item${n === 1 ? '' : 's'} couldn't be ${verbedPast(p.kind)}`))
    const chev = el('span', 'ops-warn-chev', failListOpen.has(p.opId) ? '⌃' : '⌄')
    sumRow.appendChild(chev)
    sumRow.addEventListener('click', () => {
      if (failListOpen.has(p.opId)) failListOpen.delete(p.opId)
      else failListOpen.add(p.opId)
      render()
    })
    warn.appendChild(sumRow)
    if (failListOpen.has(p.opId)) {
      const list = el('div', 'ops-fail-list')
      for (const f of p.failures) {
        const row = el('div', 'ops-fail-row')
        row.appendChild(el('div', 'ops-fail-path', f.path))
        row.appendChild(el('div', 'ops-fail-err', f.error))
        list.appendChild(row)
      }
      warn.appendChild(list)
    }
    const row = el('div', 'ops-extra-buttons')
    const dis = el('button', 'btn', 'Dismiss')
    dis.addEventListener('click', () => dismissOp(p.opId))
    row.appendChild(dis)
    c.extra.append(warn, row)
  }
}

function dismissOp(opId: number): void {
  retained.delete(opId)
  failListOpen.delete(opId)
  const i = app.ops.findIndex(o => o.opId === opId)
  if (i >= 0) {
    app.ops.splice(i, 1)
    app.emit('ops-changed', app.ops)
  } else {
    render()
  }
}

// ------------------------------------------------------------- speed graph

const GRAPH_W = 260
const GRAPH_H = 60

function drawGraph(canvas: HTMLCanvasElement, history: number[]): void {
  const dpr = window.devicePixelRatio || 1
  if (canvas.width !== Math.round(GRAPH_W * dpr)) {
    canvas.width = Math.round(GRAPH_W * dpr)
    canvas.height = Math.round(GRAPH_H * dpr)
  }
  const ctx = canvas.getContext('2d')
  if (!ctx) return
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx.clearRect(0, 0, GRAPH_W, GRAPH_H)
  const css = getComputedStyle(document.documentElement)
  const green = css.getPropertyValue('--progress-green').trim() || '#26a914'
  const gridCol = css.getPropertyValue('--divider').trim() || 'rgba(0,0,0,.08)'

  // faint horizontal gridlines like the Explorer graph
  ctx.strokeStyle = gridCol
  ctx.lineWidth = 1
  for (let i = 1; i < 4; i++) {
    const y = (GRAPH_H / 4) * i + 0.5
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(GRAPH_W, y); ctx.stroke()
  }

  const pts = history.length ? history : [0]
  const max = Math.max(...pts, 1)          // auto-scale
  const top = 6                            // headroom above the peak
  const yFor = (v: number): number => GRAPH_H - (Math.max(0, v) / max) * (GRAPH_H - top)
  const xFor = (i: number): number => pts.length > 1 ? (i / (pts.length - 1)) * GRAPH_W : GRAPH_W

  // filled area
  ctx.beginPath()
  ctx.moveTo(0, GRAPH_H)
  ctx.lineTo(0, yFor(pts[0]))
  for (let i = 1; i < pts.length; i++) ctx.lineTo(xFor(i), yFor(pts[i]))
  if (pts.length === 1) ctx.lineTo(GRAPH_W, yFor(pts[0]))
  ctx.lineTo(GRAPH_W, GRAPH_H)
  ctx.closePath()
  ctx.globalAlpha = 0.4
  ctx.fillStyle = green
  ctx.fill()
  ctx.globalAlpha = 1

  // line on top
  ctx.beginPath()
  ctx.moveTo(0, yFor(pts[0]))
  for (let i = 1; i < pts.length; i++) ctx.lineTo(xFor(i), yFor(pts[i]))
  if (pts.length === 1) ctx.lineTo(GRAPH_W, yFor(pts[0]))
  ctx.strokeStyle = green
  ctx.lineWidth = 1.5
  ctx.lineJoin = 'round'
  ctx.stroke()
}
