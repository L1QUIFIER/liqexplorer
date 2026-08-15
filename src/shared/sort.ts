// Natural sorting + grouping shared by renderer and main.
// Explorer semantics: case-insensitive, digit runs compared numerically.
import type { FileEntry, FolderViewState, SortKey } from './types'
import { ratingBucket } from './ratings'

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base', usage: 'sort' })

export function naturalCompare(a: string, b: string): number {
  return collator.compare(a, b) || (a < b ? -1 : a > b ? 1 : 0)
}

// ---- canonical sort/group key list (Sort by, Group by, and the details
// column chooser all render from this, so the three can never diverge) ----

export interface SortKeyInfo { key: SortKey; label: string }

const GENERAL_SORT_KEYS: SortKeyInfo[] = [
  { key: 'name', label: 'Name' },
  { key: 'mtime', label: 'Date modified' },
  { key: 'ctime', label: 'Date created' },
  { key: 'atime', label: 'Date accessed' },
  { key: 'type', label: 'Type' },
  { key: 'size', label: 'Size' },
  { key: 'ext', label: 'File extension' },
  { key: 'rating', label: 'Rating' },
]

const TRASH_SORT_KEYS: SortKeyInfo[] = [
  { key: 'name', label: 'Name' },
  { key: 'origPath', label: 'Original location' },
  { key: 'deletedAt', label: 'Date deleted' },
  { key: 'type', label: 'Type' },
  { key: 'size', label: 'Size' },
]

/** Explorer's key list is folder-template dependent; ours varies by location. */
export function sortKeysFor(path: string): SortKeyInfo[] {
  return path === 'trash://' ? TRASH_SORT_KEYS : GENERAL_SORT_KEYS
}

export function typeLabelFor(e: FileEntry): string {
  if (e.isDir) return 'File folder'
  // shared-mime-info name ("PNG image"); Explorer-style fallback when the type
  // has no description (unregistered extensions)
  if (e.typeLabel) return e.typeLabel
  if (!e.ext) return 'File'
  return e.ext.toUpperCase() + ' File'
}

function keyValue(e: FileEntry, key: SortKey): string | number {
  switch (key) {
    case 'name': return e.name
    case 'mtime': return e.mtime
    case 'ctime': return e.btime ?? e.ctime
    case 'atime': return e.atime ?? e.mtime
    case 'size': return e.isDir ? -1 : e.size
    case 'type': return typeLabelFor(e)
    case 'ext': return e.ext
    case 'origPath': return e.trashOrigPath ?? ''
    case 'deletedAt': return e.trashDeletedAt ?? 0
    // folders sort below unrated files, as they do for 'size' — otherwise a
    // folder lands in the middle of the unrated run and splits the "Unrated"
    // group in two when grouping by rating
    case 'rating': return e.isDir ? -1 : e.rating ?? 0
    default: return e.name
  }
}

export function sortEntries(entries: FileEntry[], vs: FolderViewState, foldersFirst: boolean): FileEntry[] {
  const dir = vs.sortDir === 'asc' ? 1 : -1
  const key = vs.sortKey
  // The rating filter rides here rather than in the caller because this is the
  // one function every listing passes through on its way to Tab.rows, so the
  // item count, Select all, the master checkbox and the status bar all agree
  // about what is on screen without any of them knowing the filter exists.
  // Folders are never hidden by it — a filtered folder you cannot open is a
  // trap, and folders cannot be rated.
  const min = vs.minRating ?? 0
  const src = min > 0 ? entries.filter(e => e.isDir || (e.rating ?? 0) >= min) : entries
  const sorted = [...src].sort((a, b) => {
    if (foldersFirst && a.isDir !== b.isDir) return a.isDir ? -1 : 1
    const va = keyValue(a, key), vb = keyValue(b, key)
    let c: number
    if (typeof va === 'string' && typeof vb === 'string') c = naturalCompare(va, vb)
    else c = (va as number) < (vb as number) ? -1 : (va as number) > (vb as number) ? 1 : 0
    if (c === 0 && key !== 'name') c = naturalCompare(a.name, b.name)
    return c * dir
  })
  return sorted
}

// ---- grouping (Explorer buckets) ----

export interface Group { label: string; start: number; count: number }

const DAY = 86400000
export function dateBucket(ms: number, now = Date.now()): string {
  const d = new Date(ms), n = new Date(now)
  const startOfDay = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime()
  const today = startOfDay(n)
  if (ms >= today) return 'Today'
  if (ms >= today - DAY) return 'Yesterday'
  const dow = (n.getDay() + 6) % 7 // Monday=0
  const weekStart = today - dow * DAY
  if (ms >= weekStart) return 'Earlier this week'
  if (ms >= weekStart - 7 * DAY) return 'Last week'
  const monthStart = new Date(n.getFullYear(), n.getMonth(), 1).getTime()
  if (ms >= monthStart) return 'Earlier this month'
  const lastMonthStart = new Date(n.getFullYear(), n.getMonth() - 1, 1).getTime()
  if (ms >= lastMonthStart) return 'Last month'
  const yearStart = new Date(n.getFullYear(), 0, 1).getTime()
  if (ms >= yearStart) return 'Earlier this year'
  return 'A long time ago'
}

export function sizeBucket(size: number): string {
  if (size <= 0) return 'Empty (0 KB)'
  if (size <= 16 * 1024) return 'Tiny (0 - 16 KB)'
  if (size <= 1024 * 1024) return 'Small (16 KB - 1 MB)'
  if (size <= 128 * 1024 * 1024) return 'Medium (1 - 128 MB)'
  if (size <= 1024 * 1024 * 1024) return 'Large (128 MB - 1 GB)'
  if (size <= 4096 * 1024 * 1024) return 'Huge (1 - 4 GB)'
  return 'Gigantic (>4 GB)'
}

export function nameBucket(name: string): string {
  // strip diacritics so buckets agree with the sensitivity:'base' collator
  // ('éclair' sorts with 'e', so it must bucket as 'E', not 'Other')
  const c = name.normalize('NFD').replace(/\p{M}/gu, '')[0]?.toUpperCase() ?? ''
  if (c >= '0' && c <= '9') return '0 - 9'
  if (c >= 'A' && c <= 'H') return 'A - H'
  if (c >= 'I' && c <= 'P') return 'I - P'
  if (c >= 'Q' && c <= 'Z') return 'Q - Z'
  return 'Other'
}

export function groupLabelFor(e: FileEntry, vs: FolderViewState): string {
  switch (vs.groupKey) {
    case 'none': return ''
    case 'name': return nameBucket(e.name)
    case 'mtime': case 'ctime': case 'atime':
      return dateBucket(keyValue(e, vs.groupKey) as number)
    case 'size': return e.isDir ? 'Folders' : sizeBucket(e.size)
    case 'type': return typeLabelFor(e)
    case 'ext': return e.ext ? e.ext.toUpperCase() : 'None'
    case 'rating': return e.isDir ? 'Folders' : ratingBucket(e.rating ?? 0)
    default: return ''
  }
}

/** entries must already be sorted with group keys adjacent (sort by groupKey first when grouping) */
export function computeGroups(entries: FileEntry[], vs: FolderViewState): Group[] {
  // computer:// carries its own sections and is grouped whatever the view state
  // says, the way Explorer's This PC always shows Folders / Devices and drives
  // / Network locations. The rows arrive already in section order.
  if (entries.some(e => e.section)) {
    const out: Group[] = []
    let cur: Group | null = null
    entries.forEach((e, i) => {
      const label = e.section ?? ''
      if (!cur || cur.label !== label) { cur = { label, start: i, count: 1 }; out.push(cur) }
      else cur.count++
    })
    return out
  }
  if (vs.groupKey === 'none') return []
  const groups: Group[] = []
  let cur: Group | null = null
  entries.forEach((e, i) => {
    const label = groupLabelFor(e, vs)
    if (!cur || cur.label !== label) { cur = { label, start: i, count: 1 }; groups.push(cur) }
    else cur.count++
  })
  return groups
}

export function formatSize(bytes: number): string {
  if (bytes < 0) return ''
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let v = bytes
  for (const u of units) {
    v /= 1024
    if (v < 1024) return `${v >= 100 ? Math.round(v) : v.toFixed(v >= 10 ? 1 : 2)} ${u}`
  }
  return `${v.toFixed(1)} PB`
}

export function formatDate(ms: number): string {
  const d = new Date(ms)
  const dd = String(d.getDate()).padStart(2, '0')
  const mm = String(d.getMonth() + 1).padStart(2, '0')
  let h = d.getHours()
  const ampm = h >= 12 ? 'PM' : 'AM'
  h = h % 12 || 12
  return `${mm}/${dd}/${d.getFullYear()} ${h}:${String(d.getMinutes()).padStart(2, '0')} ${ampm}`
}
