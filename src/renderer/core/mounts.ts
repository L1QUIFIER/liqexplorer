// Cached mount table for the renderer. Two features need it — the default
// drag action (move within a volume, copy across) and safe mode's "you are
// moving a whole drive" check — so it lives in one place and refreshes when
// the places sidebar does (that is when a drive was plugged in or removed).
import { app, liq } from './app'

let mountPoints: string[] = []

function refresh(): void {
  void liq.invoke('mountPoints')
    .then((m: string[]) => { mountPoints = m })
    .catch(() => { /* keep the previous table rather than blanking it */ })
}
refresh()
app.on('places-changed', refresh)

export function allMounts(): string[] { return mountPoints }

/** true when p is itself a mount point — a drive, not an ordinary folder */
export function isMountPoint(p: string): boolean {
  return mountPoints.includes(p.replace(/\/+$/, ''))
}

/** longest-prefix mount point containing p ('' when the table is unavailable) */
export function volumeOf(p: string): string {
  let best = ''
  for (const m of mountPoints) {
    if ((p === m || p.startsWith(m === '/' ? '/' : m + '/')) && m.length > best.length) best = m
  }
  return best
}
