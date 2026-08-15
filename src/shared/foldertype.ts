// Smart view — pick a view mode from what a folder actually contains.
//
// Windows calls this folder templates: Explorer guesses General / Documents /
// Pictures / Music / Videos and applies that template's layout. It guesses from
// the folder's *name* as much as its contents and is famously wrong (the
// "why is my folder suddenly in Music view" problem), so this classifies by
// CONTENT only, and never overrides a folder the user has set by hand.
//
// Deliberate rules, learned from that failure mode:
//  - Folders are ignored in the vote. A photo folder with 30 pictures and 3
//    subfolders is still a photo folder.
//  - A clear majority is required (default 60%), otherwise the folder is
//    'mixed' and keeps the default view. Explorer flip-flopping on a 51/49
//    split is worse than doing nothing.
//  - Tiny folders (< 4 files) are left alone: one screenshot in a folder is not
//    a picture library.
import type { FileEntry, ViewMode } from './types'

export type FolderKind =
  | 'images' | 'video' | 'audio' | 'documents' | 'code' | 'archives' | 'mixed'

export interface SmartViewRule {
  /** view mode to switch to */
  mode: ViewMode
  /** open the preview pane for this kind (documents/video benefit most) */
  preview?: boolean
}

export type SmartViewRules = Record<FolderKind, SmartViewRule>

/** Sensible starting point; every entry is user-editable in Options. */
export const DEFAULT_SMART_RULES: SmartViewRules = {
  images: { mode: 'large' },
  video: { mode: 'large', preview: true },
  audio: { mode: 'tiles' },
  documents: { mode: 'details', preview: true },
  code: { mode: 'details' },
  archives: { mode: 'details' },
  mixed: { mode: 'details' },
}

const DOC_RE = /^(application\/(pdf|epub|rtf|msword|vnd\.(openxmlformats|oasis|ms-)|x-abiword)|text\/(rtf|markdown))/
const CODE_RE = /^(text\/(x-|javascript|css|html|xml|csv|plain)|application\/(json|xml|x-shellscript|javascript|toml|yaml|x-yaml|x-perl|x-python))/
const ARCHIVE_RE = /^application\/(zip|x-7z|x-rar|x-tar|gzip|x-bzip|x-xz|x-zstd|vnd\.rar|x-compressed)/

function categorize(e: FileEntry): FolderKind | null {
  const m = e.mime || ''
  if (m.startsWith('image/')) return 'images'
  if (m.startsWith('video/')) return 'video'
  if (m.startsWith('audio/')) return 'audio'
  if (DOC_RE.test(m)) return 'documents'
  if (ARCHIVE_RE.test(m)) return 'archives'
  if (CODE_RE.test(m)) return 'code'
  return null
}

export interface FolderVerdict {
  kind: FolderKind
  /** share of counted files that voted for `kind`, 0..1 */
  share: number
  counted: number
}

/**
 * Classify a listing. `threshold` is the share of files one category must
 * reach (0..1) before it wins; below it the folder is 'mixed'.
 */
export function classifyFolder(entries: FileEntry[], threshold = 0.6): FolderVerdict {
  const counts = new Map<FolderKind, number>()
  let counted = 0
  for (const e of entries) {
    if (e.isDir) continue                    // subfolders never vote
    const k = categorize(e)
    counted++
    if (!k) continue                         // unknown types dilute, as they should
    counts.set(k, (counts.get(k) ?? 0) + 1)
  }
  if (counted < 4) return { kind: 'mixed', share: 0, counted }

  let best: FolderKind = 'mixed'
  let bestN = 0
  for (const [k, n] of counts) if (n > bestN) { best = k; bestN = n }
  const share = bestN / counted

  // images and video read as one "media" folder when neither alone is a
  // majority — a camera dump of photos AND clips still wants big thumbnails
  if (share < threshold) {
    const media = (counts.get('images') ?? 0) + (counts.get('video') ?? 0)
    if (media / counted >= threshold) {
      const kind = (counts.get('video') ?? 0) > (counts.get('images') ?? 0) ? 'video' : 'images'
      return { kind, share: media / counted, counted }
    }
    return { kind: 'mixed', share, counted }
  }
  return { kind: best, share, counted }
}
