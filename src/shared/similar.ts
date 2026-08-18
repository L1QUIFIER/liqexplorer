// Near-duplicate image vocabulary, shared by platform/similar.ts and the dialog.

export interface SimilarFile {
  path: string
  name: string
  size: number
  /** differing bits from the group's keeper; 0 means visually identical */
  distance: number
  /** 0 when the dimensions could not be read */
  width: number
  height: number
  /**
   * width x height.
   *
   * This, not `size`, is what picks the copy worth keeping. Sorting by BYTES was the original
   * behaviour and it is wrong often enough to matter: a re-saved PNG is regularly larger on disk
   * and smaller in pixels than the JPEG beside it, so the tool would recommend throwing away the
   * higher-resolution file. Bytes only break ties now.
   */
  pixels: number
}

export interface SimilarGroup {
  /** the keeper first — most pixels, then most bytes — followed by the copies of it */
  files: SimilarFile[]
}

export interface SimilarResult {
  ok: boolean
  root: string
  groups: SimilarGroup[]
  /** images successfully hashed */
  scanned: number
  threshold: number
  /** the run hit its cap; the answer covers only part of the tree */
  truncated?: boolean
  /** the user stopped it */
  cancelled?: boolean
  error?: string
}

/**
 * What the scan is doing right now.
 *
 * Reported because this tool spawns one ImageMagick process per picture and then compares every
 * hash to every other, which on a real folder is minutes. Without it the whole thing happened
 * invisibly and a dialog appeared out of nowhere when it was over — indistinguishable from the app
 * having hung, and impossible to stop.
 */
export type SimilarPhase = 'listing' | 'measuring' | 'hashing' | 'comparing' | 'done'

export interface SimilarProgress {
  runId: number
  phase: SimilarPhase
  done: number
  total: number
  /** the picture being worked on, so the line visibly moves */
  current?: string
}

export const PHASE_TEXT: Record<SimilarPhase, string> = {
  listing: 'Finding pictures',
  measuring: 'Reading picture sizes',
  hashing: 'Fingerprinting pictures',
  comparing: 'Comparing every picture to every other',
  done: 'Done',
}

/** the keeper is the most pixels, then the most bytes — never bytes alone */
export function keeperFirst<T extends { pixels: number; size: number }>(a: T, b: T): number {
  return (b.pixels - a.pixels) || (b.size - a.size)
}
