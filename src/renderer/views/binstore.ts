// DROP BINS — shared renderer state: the bin configuration, the Stack, the
// toast host, and the two helpers every part of the feature needs (reading a
// drop, resolving a bin's destination folder).
//
// Kept separate from views/dropbins.ts purely to keep the import graph acyclic:
// the dock, the bin manager and the convert/checksum dialogs all need this, and
// the dock needs them.
import { app, liq } from '../core/app'
import {
  BINS_CHANGED, TARGET_ASK, TARGET_CWD, defaultBinsConfig,
  type BinConfig, type BinsConfig,
} from '../../shared/bins'

let cfg: BinsConfig = defaultBinsConfig()
let loaded = false
const listeners = new Set<() => void>()

export function bins(): BinsConfig { return cfg }
export function onBinsChanged(cb: () => void): () => void {
  listeners.add(cb)
  return () => listeners.delete(cb)
}
function fire(): void { for (const cb of [...listeners]) cb() }

/** Coalesce bursts (dragging five files in adds five stack entries) into one
 *  atomic write, and never let a failed write lose the in-memory state. */
let pending: Partial<BinsConfig> | null = null
let timer = 0

function flush(): void {
  const patch = pending
  pending = null
  timer = 0
  if (!patch) return
  void liq.invoke('binsSet', patch).catch(() => { /* keep the UI state anyway */ })
}

export function patchBins(patch: Partial<BinsConfig>): void {
  cfg = { ...cfg, ...patch }
  pending = { ...(pending ?? {}), ...patch }
  if (!timer) timer = window.setTimeout(flush, 250)
  fire()
}

export async function loadBins(): Promise<void> {
  if (loaded) return
  loaded = true
  try {
    const got = await liq.invoke('binsGet') as BinsConfig
    // `!pending`: the user can pin the tray or fill the Stack inside the few ms
    // this round trip takes, and the stored document must not undo that
    if (got && Array.isArray(got.bins) && !pending) { cfg = got; fire() }
    // a second window editing bins (or filling the Stack) must show up here
    liq.on(BINS_CHANGED, (next: BinsConfig) => {
      if (!next || !Array.isArray(next.bins)) return
      if (pending) return         // our own write is still in flight; ours wins
      cfg = next
      fire()
    })
  } catch { /* main not ready: defaults are already in place */ }
}

// ------------------------------------------------------------------ the Stack

/** Hard cap; also enforced in main/state/bins.ts. */
const STACK_CAP = 2000

export function addToStack(paths: string[]): number {
  const have = new Set(cfg.stack)
  const add = paths.filter(p => !have.has(p)).slice(0, Math.max(0, STACK_CAP - cfg.stack.length))
  if (!add.length) return 0
  patchBins({ stack: [...cfg.stack, ...add] })
  return add.length
}

export function removeFromStack(paths: string[]): void {
  const drop = new Set(paths)
  patchBins({ stack: cfg.stack.filter(p => !drop.has(p)) })
}

export function clearStack(): void { patchBins({ stack: [] }) }

// --------------------------------------------------------------- drop reading

/** Read a drop exactly the way views/dnd.ts does: our own JSON payload first,
 *  then real OS files through webUtils, then a text/uri-list. Virtual rows
 *  (trash://, archive://, computer://) are dropped — a bin has no way to act on
 *  something that is not a real file. */
export function readDropPaths(dt: DataTransfer | null): string[] {
  if (!dt) return []
  let out: string[] = []
  const raw = dt.getData('application/x-liq-paths')
  if (raw) {
    try { out = JSON.parse(raw) as string[] } catch { out = [] }
  } else if (dt.files && dt.files.length) {
    for (const f of Array.from(dt.files)) {
      try {
        const p = liq.pathForFile(f)
        if (p) out.push(p)
      } catch { /* not a filesystem file */ }
    }
  } else {
    for (const line of dt.getData('text/uri-list').split(/\r?\n/)) {
      const s = line.trim()
      if (!s || s.startsWith('#') || !s.startsWith('file://')) continue
      try { out.push(decodeURIComponent(new URL(s).pathname)) } catch { /* bad uri */ }
    }
  }
  return [...new Set(out.filter(p => typeof p === 'string' && p.startsWith('/') && !p.includes('://')))]
}

/** true when a dragover carries something a bin could accept */
export function dragHasPaths(dt: DataTransfer | null): boolean {
  if (!dt) return false
  const t = Array.from(dt.types)
  return t.includes('application/x-liq-paths') || t.includes('Files') || t.includes('text/uri-list')
}

// ------------------------------------------------------ destination resolving

/** The folder the active tab is showing, or null when it is a virtual page. */
export function currentFolder(): string | null {
  const p = app.activeTab?.path
  return p && !p.includes('://') ? p : null
}

/**
 * Resolve a bin's destination.
 *   TARGET_CWD  -> the folder on screen (falls back to asking on home://…)
 *   TARGET_ASK  -> always ask
 *   a real path -> used as-is, but re-asked if it has since been deleted, so a
 *                  bin pointed at an unmounted drive cannot silently create the
 *                  mount point and copy into the empty stub.
 */
export async function resolveTarget(bin: BinConfig, suggested?: string): Promise<string | null> {
  const t = bin.target ?? TARGET_ASK
  if (t === TARGET_CWD) {
    const cwd = currentFolder()
    if (cwd) return cwd
  } else if (t && t !== TARGET_ASK) {
    const ok = await liq.pathExists(t).catch(() => false)
    if (ok) return t
  }
  const start = suggested ?? currentFolder() ?? app.homePath ?? undefined
  const picked = await liq.invoke('pickFolder', start).catch(() => null) as string | null
  return picked || null
}

export function targetLabel(bin: BinConfig): string {
  const t = bin.target ?? TARGET_ASK
  if (t === TARGET_CWD) return 'This folder'
  if (!t || t === TARGET_ASK) return 'Ask each time'
  const home = app.homePath
  return home && t.startsWith(home + '/') ? '~' + t.slice(home.length) : t
}

// ------------------------------------------------------------------- toasts
//
// Bins run without opening a dialog, so the only feedback is a small card that
// says what happened and offers the one follow-up that matters (Undo for the
// favourites bin, which the file engine's undo stack does not cover; Show for
// anything that produced files).

export interface ToastAction { label: string; onClick: () => void }
export interface ToastOptions {
  text: string
  sub?: string
  actions?: ToastAction[]
  bad?: boolean
  /** ms before it fades; 0 keeps it until clicked */
  ttl?: number
}

let toastHost: HTMLElement | null = null
export function setToastHost(el: HTMLElement): void { toastHost = el }

export function toast(o: ToastOptions): void {
  if (!toastHost) return
  const card = document.createElement('div')
  card.className = 'db-toast' + (o.bad ? ' db-toast-bad' : '')
  const text = document.createElement('div')
  text.className = 'db-toast-text'
  text.textContent = o.text
  if (o.sub) {
    const sub = document.createElement('span')
    sub.className = 'db-toast-sub'
    sub.textContent = o.sub
    text.appendChild(sub)
  }
  card.appendChild(text)
  let dead = false
  const kill = (): void => {
    if (dead) return
    dead = true
    card.classList.add('db-toast-out')
    setTimeout(() => card.remove(), 200)
  }
  for (const a of o.actions ?? []) {
    const b = document.createElement('button')
    b.className = 'btn btn-small'
    b.textContent = a.label
    b.addEventListener('click', () => { kill(); a.onClick() })
    card.appendChild(b)
  }
  card.addEventListener('click', (e) => { if (e.target === card || e.target === text) kill() })
  toastHost.appendChild(card)
  // never let a runaway loop bury the tray
  while (toastHost.childElementCount > 4) toastHost.firstElementChild?.remove()
  const ttl = o.ttl ?? (o.actions?.length ? 8000 : 4500)
  if (ttl > 0) setTimeout(kill, ttl)
}

/** "3 items" / "\"photo.jpg\"" — the phrasing the rest of the app uses. */
export function describe(paths: string[]): string {
  return paths.length === 1 ? `"${paths[0].split('/').pop()}"` : `${paths.length} items`
}
