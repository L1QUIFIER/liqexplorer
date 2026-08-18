// File-picker mode: the contract between the XDG portal backend
// (helpers/filechooser-portal.py), the main process (main/pick.ts) and the
// picker bar in the renderer (renderer/chrome/pickbar.ts).
//
// WHY THIS EXISTS. On Linux an application does not draw its own file dialog:
// it asks the desktop for one over D-Bus (org.freedesktop.portal.FileChooser),
// and xdg-desktop-portal hands the request to whichever backend implements
// org.freedesktop.impl.portal.FileChooser. Out of the box that is
// xdg-desktop-portal-gtk, whose dialog has no columns, no real search, none of
// the places this file manager knows about, and nothing that can be configured.
// Registering LiqExplorer as that backend replaces it EVERYWHERE at once —
// Chrome, Electron apps, Firefox, flatpaks — because they all ask the same
// question of the same bus name.
//
// The request shape below is deliberately a near-copy of the portal's own
// options dictionary, so the Python side is a translation and not a design.

/** What the calling application asked for. */
export type PickMode =
  | 'open'    // one or more existing files (portal: OpenFile)
  | 'folder'  // one or more existing directories (portal: OpenFile + directory=true)
  | 'save'    // a destination path, which may not exist yet (portal: SaveFile)

/**
 * One entry of the caller's filter dropdown.
 *
 * The portal gives each rule a type: 0 is a shell glob matched against the
 * name, 1 is a MIME type matched against the file's type (and `image/*` is
 * legal there). A filter matches when ANY of its rules do.
 */
export interface PickFilter {
  name: string
  globs: string[]
  mimes: string[]
}

export interface PickRequest {
  mode: PickMode
  /** dialog title from the caller, e.g. "Open Files" */
  title: string
  /** caller's label for the accept button ("Open", "Upload", "Select") */
  acceptLabel?: string
  multiple?: boolean
  /** where to start; ignored when it does not exist */
  currentFolder?: string
  /** save mode: the filename to pre-fill */
  currentName?: string
  /** save mode: an existing file being overwritten (implies folder + name) */
  currentFile?: string
  filters?: PickFilter[]
  /** index into `filters` that starts selected */
  currentFilter?: number
  /**
   * X11 window id of the caller's window, as the portal spells it
   * ("x11:0x3400007"), or '' when the caller did not say. Used only to set
   * WM_TRANSIENT_FOR so the window manager stacks the picker over its parent.
   */
  parentWindow?: string
  /** keep the picker above other windows (portal `modal`, default true) */
  modal?: boolean
}

/** What the picker sends back. `ok: false` means the user cancelled. */
export interface PickResult {
  ok: boolean
  paths: string[]
  /** index of the filter that was active when the user accepted */
  filterIndex?: number
}

/**
 * Does this entry pass the filter?
 *
 * Both halves are matched because callers disagree about which they use:
 * Chromium turns `accept=".png,.jpg"` into globs, while GTK applications
 * almost always send MIME types. A filter with neither matches everything,
 * which is what "All Files" arrives as.
 */
export function filterMatches(
  filter: PickFilter | null | undefined,
  name: string,
  mime: string | undefined,
): boolean {
  if (!filter) return true
  if (!filter.globs.length && !filter.mimes.length) return true
  for (const g of filter.globs) if (globToRe(g).test(name)) return true
  if (mime) {
    for (const m of filter.mimes) {
      if (m === mime) return true
      // `image/*` — the only wildcard form the portal spec allows
      if (m.endsWith('/*') && mime.startsWith(m.slice(0, -1))) return true
    }
  }
  return false
}

const reCache = new Map<string, RegExp>()

/**
 * Shell glob -> anchored, case-insensitive RegExp.
 *
 * Case-insensitive on purpose: a caller asking for `*.jpg` means the photo, and
 * cameras have been writing `.JPG` for thirty years. Character classes are kept
 * ([0-9] is common in `IMG_[0-9]*.jpg`); everything else regex-special is
 * escaped, so a filter containing `.` or `+` cannot become a wildcard.
 */
function globToRe(glob: string): RegExp {
  const hit = reCache.get(glob)
  if (hit) return hit
  let out = ''
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]
    if (c === '*') out += '.*'
    else if (c === '?') out += '.'
    else if (c === '[') {
      const end = glob.indexOf(']', i + 1)
      if (end < 0) { out += '\\[' } else { out += glob.slice(i, end + 1); i = end }
    } else out += c.replace(/[.+^${}()|\\]/g, '\\$&')
  }
  const re = new RegExp(`^${out}$`, 'i')
  reCache.set(glob, re)
  return re
}
