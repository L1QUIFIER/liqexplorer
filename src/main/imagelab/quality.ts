// Ported from projects/web/YandexLab/lib/quality.js — see imagelab/README.md.
//
// Is this copy good enough to stop the ladder walk at?
//
// A "pick the best image" walk goes through a result's copies largest-first and needs one decision
// per rung: take it, or keep looking. Getting that decision wrong is expensive in a way that is
// invisible afterwards — the file lands, the counter says "saved", and only the pixels show that a
// 257×126 removal notice was written in place of a 375×500 photo.
//
// Two different promises, judged differently:
//
// - The rung's own claim (`claimW/H`) is a statement about THAT file — the index saying this URL is
//   4000×3000. A file that arrives at a fraction of its own claim is a placeholder or a downscale,
//   and the slack is tight.
// - The item's advertised size (`advertisedW/H`) is what the search result said about the PICTURE
//   and what the caption shows the user. It is the only yardstick available for a rung with no
//   claim of its own — a CDN upgrade guess, or any copy queued before ladders were carried through
//   — and it is a weaker signal (the picture may simply not exist that large anywhere), so it is
//   judged leniently. Judging such a rung against NOTHING is the bug this exists to prevent: it
//   made the first URL that returned bytes win, whatever it contained.

/** A file must deliver at least this share of the size it claims for itself. */
export const CLAIM_SLACK = 0.5
/** …and at least this share of the size the search advertised, when that is all we have. */
export const ADVERTISED_SLACK = 0.25

export type RungVerdict = 'accept' | 'undersized' | 'unmeasurable'

export interface RungInput {
  /** what this rung says it is (0 when it says nothing) */
  claimW?: number
  claimH?: number
  /** what the search result said the picture is */
  advertisedW?: number
  advertisedH?: number
  /** what actually decoded (0 = could not be measured) */
  realW?: number
  realH?: number
}

export interface RungResult {
  verdict: RungVerdict
  realArea: number
  expectedArea: number
}

export function rungVerdict({
  claimW = 0, claimH = 0, advertisedW = 0, advertisedH = 0, realW = 0, realH = 0,
}: RungInput = {}): RungResult {
  const realArea = (realW || 0) * (realH || 0)

  // Never reject what you cannot measure — the same rule placeholder detection follows for WebP.
  // Accepting is a decision made in the open here, not an accident of a zero falling through a test.
  if (!realArea) return { verdict: 'unmeasurable', realArea: 0, expectedArea: 0 }

  const claimArea = (claimW || 0) * (claimH || 0)
  const advertisedArea = (advertisedW || 0) * (advertisedH || 0)
  const expectedArea = claimArea || advertisedArea
  if (!expectedArea) return { verdict: 'accept', realArea, expectedArea: 0 }

  const slack = claimArea ? CLAIM_SLACK : ADVERTISED_SLACK
  return {
    verdict: realArea >= expectedArea * slack ? 'accept' : 'undersized',
    realArea,
    expectedArea,
  }
}
