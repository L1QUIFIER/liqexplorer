// Natural sorting + grouping shared by renderer and main.
// Explorer semantics: case-insensitive, digit runs compared numerically.
import type { FileEntry, FolderViewState, SortKey } from './types'

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base', usage: 'sort' })

export function naturalCompare(a: string, b: string): number {
  return collator.compare(a, b) || (a < b ? -1 : a > b ? 1 : 0)
}

export function typeLabelFor(e: FileEntry): string {
  if (e.isDir) return 'File folder'
  if (!e.ext) return 'File'
  return e.ext.toUpperCase() + ' File'
}

function keyValue(e: FileEntry, key: SortKey): string | number {
  switch (key) {
    case 'name': return e.name
    case 'mtime': return e.mtime
    case 'ctime': return e.btime ?? e.ctime
    case 'atime': return e.mtime
    case 'size': return e.isDir ? -1 : e.size
    case 'type': return typeLabelFor(e)
    case 'ext': return e.ext
    case 'origPath': return e.trashOrigPath ?? ''
    case 'deletedAt': return e.trashDeletedAt ?? 0
    default: return e.name
  }
}

export function sortEntries(entries: FileEntry[], vs: FolderViewState, foldersFirst: boolean): FileEntry[] {
  const dir = vs.sortDir === 'asc' ? 1 : -1
  const key = vs.sortKey
  const sorted = [...entries].sort((a, b) => {
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
    default: return ''
  }
}

/** entries must already be sorted with group keys adjacent (sort by groupKey first when grouping) */
export function computeGroups(entries: FileEntry[], vs: FolderViewState): Group[] {
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
