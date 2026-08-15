// What "reopen where I left off" actually has to remember.
//
// Paths only — no listings, no selections. Restoring a selection would mean
// re-reading every folder at startup just to prove the files still exist, and a
// stale selection is worse than none.

export interface SessionTab {
  path: string
  /** pinned tabs come back even when the app is set to open on Home */
  pinned?: boolean
  /** the second pane's folder, when this tab was split */
  secondary?: string
  splitDir?: 'h' | 'v'
  splitRatio?: number
  /** which pane had focus (0 = left/top) */
  activePane?: 0 | 1
}

export interface SessionState {
  tabs: SessionTab[]
  /** index into tabs of the one that was in front */
  active: number
}

export const EMPTY_SESSION: SessionState = { tabs: [], active: 0 }

/** Drop anything we should not or cannot reopen. */
export function sanitizeSession(s: unknown): SessionState {
  const raw = s as Partial<SessionState> | null
  if (!raw || !Array.isArray(raw.tabs)) return { ...EMPTY_SESSION }
  const tabs: SessionTab[] = []
  for (const t of raw.tabs) {
    if (!t || typeof t.path !== 'string' || !t.path) continue
    // search:// results and archive:// members are derived views whose source
    // may be gone; reopening them would show an error page on launch
    if (t.path.startsWith('search://') || t.path.startsWith('archive://')) continue
    if (tabs.length >= 50) break              // a runaway session file
    tabs.push({
      path: t.path,
      pinned: !!t.pinned,
      secondary: typeof t.secondary === 'string' ? t.secondary : undefined,
      splitDir: t.splitDir === 'v' ? 'v' : t.splitDir === 'h' ? 'h' : undefined,
      splitRatio: typeof t.splitRatio === 'number' && t.splitRatio > 0 && t.splitRatio < 1
        ? t.splitRatio : undefined,
      activePane: t.activePane === 1 ? 1 : 0,
    })
  }
  const active = Number.isInteger(raw.active) && raw.active! >= 0 && raw.active! < tabs.length
    ? raw.active! : 0
  return { tabs, active }
}

/** Just the pinned tabs — what to restore when "open to" is not "last session". */
export function pinnedOnly(s: SessionState): SessionState {
  const tabs = s.tabs.filter(t => t.pinned)
  return { tabs, active: 0 }
}
