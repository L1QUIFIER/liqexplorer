// Which paths are Favorites, for the file list to mark them.
//
// Favourites already existed as a Home section and a right-click verb, but a
// file in a folder listing looked exactly like any other — so the only way to
// know something was pinned was to leave the folder and go and look at Home.
// Ratings solved the same problem years earlier in this app with a corner badge
// (views/ratings.ts), and this follows that shape deliberately: same badge
// position, same repaint-on-broadcast rule, so the two marks can sit on one
// tile without arguing.
//
// Main owns the store. This is a read-through cache kept honest by the
// favoritesChanged broadcast — no renderer ever decides on its own that
// something is a favourite, which is what keeps two windows in agreement.
import { PUSH } from '../../shared/ipc'
import type { FavoriteEntry } from '../../shared/types'
import { app, liq } from '../core/app'

let favs = new Set<string>()
let primed = false

export function isFavorite(path: string): boolean {
  return favs.has(path)
}

function adopt(list: FavoriteEntry[]): void {
  const next = new Set((list ?? []).map(f => f.path).filter(p => typeof p === 'string'))
  // nothing to repaint if the set is unchanged — this broadcast also fires for
  // reorders and renames of entries in other folders
  const same = next.size === favs.size && [...next].every(p => favs.has(p))
  favs = next
  if (same) return
  // Every open tab repaints: a file pinned from Home has to gain its mark in a
  // listing that is already on screen behind the dialog. A plain repaint is
  // enough (unlike ratings, no sort key or filter depends on this).
  for (const t of app.allTabs()) app.emit('tab-listing', t)
}

export function mountFavoriteMarks(): void {
  if (primed) return
  primed = true
  void liq.invoke('listFavorites').then((l: FavoriteEntry[]) => adopt(l)).catch(() => { /* none yet */ })
  liq.on(PUSH.favoritesChanged, (l: FavoriteEntry[]) => adopt(l))
}
