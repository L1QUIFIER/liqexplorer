// Star ratings — the vocabulary shared by main and renderer.
//
// Scale is 0..5 to match XMP's xmp:Rating, which is what Windows Explorer,
// digiKam, Lightroom and darktable all write. KDE/Baloo uses 0..10 instead;
// that is normalised on the way in (see platform/ratingmeta.ts), never stored.

export const RATING_MAX = 5

/** push channel: { changes: Record<path, rating> }. Declared here rather than in
 *  shared/ipc.ts PUSH so the whole feature stays deletable as a unit. */
export const RATINGS_CHANGED = 'liqpush:ratings-changed'

export interface RatingsChanged {
  /** path -> rating; 0 means "cleared" (the store drops it) */
  changes: Record<string, number>
}

/** 0..5 integer, or 0 for anything unusable. XMP uses -1 for "rejected", which
 *  has no star representation here and collapses to unrated. */
export function clampRating(v: unknown): number {
  const n = Math.round(Number(v))
  if (!Number.isFinite(n) || n <= 0) return 0
  return n > RATING_MAX ? RATING_MAX : n
}

export function ratingLabel(r: number): string {
  if (!r) return 'Unrated'
  return r === 1 ? '1 star' : `${r} stars`
}

/** Group-by bucket. Descending-friendly wording so the buckets read as a ladder. */
export function ratingBucket(r: number): string {
  return r ? ratingLabel(r) : 'Unrated'
}
