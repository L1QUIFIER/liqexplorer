// What the inspector's Details tab shows, and the contract for fetching it.
//
// In its own file rather than shared/types.ts: this is additive, and types.ts is
// the one file every parallel piece of work has to touch.
//
// Main formats the rows. The renderer paints label/value pairs and never learns
// ffprobe's or pdfinfo's field names — so a change of tool is one file, and the
// Details tab needs no knowledge of how any of it was obtained.

/** one row in the Details list */
export interface FactRow {
  label: string
  value: string
  /** section heading this row belongs under; rows with no group come first */
  group?: string
  /** render in a monospace, wrap-anywhere style (paths, hashes) */
  mono?: boolean
}

export type FactsKind = 'image' | 'av' | 'pdf' | 'archive' | 'none'

export interface FileFacts {
  path: string
  /** the mtime/size this was read at; a mismatch means it is stale */
  mtime: number
  size: number
  kind: FactsKind
  rows: FactRow[]
  /** set when the probe failed or timed out — the pane says so rather than
   *  showing an empty section that looks like a file with no properties */
  error?: string
}

/** how long the renderer waits before showing "—" for a tier it asked for */
export const FACTS_UI_TIMEOUT_MS = 2500
