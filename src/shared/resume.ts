// Where you were up to in a video, and — more importantly — when NOT to remember.
//
// A resume position is only ever a convenience, so the failure modes matter more
// than the feature. Two of them are bad enough to be worth rules of their own:
//
//   * Remembering a few seconds in. You open a clip, watch six seconds, close
//     it. Reopening should start at the beginning, not six seconds in, because
//     at that point "resume" is indistinguishable from a broken player.
//   * Remembering the very end. You watch something through to the credits.
//     Reopening lands you on the last frame with nothing to play, which is the
//     single most annoying thing a resume feature can do.
//
// Both are handled by discarding, not by storing-and-ignoring, so a stale entry
// can never resurface if the thresholds are ever retuned.

/** below this, the user has barely started and resuming would be noise */
export const RESUME_MIN_SECONDS = 5
/** this close to the end counts as finished, however it was reached */
export const RESUME_END_PAD_SECONDS = 10
/** shorter than this and there is nothing meaningful to resume into */
export const RESUME_MIN_DURATION = 30

export interface ResumeDecision {
  /** store `seconds`, or (when false) forget any position we already had */
  store: boolean
  seconds: number
}

/**
 * Should `time` be remembered for a media file of length `duration`?
 *
 * Returns store:false for "no" AND for "finished" — both mean the stored entry
 * should go away, and collapsing them keeps callers from having to distinguish
 * "never had one" from "watched it to the end".
 */
export function resumeDecision(time: number, duration: number): ResumeDecision {
  const t = Number(time)
  const d = Number(duration)
  if (!Number.isFinite(t) || !Number.isFinite(d)) return { store: false, seconds: 0 }
  if (d < RESUME_MIN_DURATION) return { store: false, seconds: 0 }
  if (t < RESUME_MIN_SECONDS) return { store: false, seconds: 0 }
  if (t >= d - RESUME_END_PAD_SECONDS) return { store: false, seconds: 0 }
  return { store: true, seconds: Math.floor(t) }
}

/**
 * Is a stored position still worth using?
 *
 * Checked again on the way OUT because the duration we have now is the real one
 * from the decoder, while the one at write time could have come from a partial
 * or still-loading file. A position past the end of the file it names is
 * discarded rather than clamped — landing on the final frame is exactly the
 * behaviour the end-pad rule exists to prevent.
 */
export function usableResume(seconds: number, duration: number): number {
  const s = Number(seconds)
  const d = Number(duration)
  if (!Number.isFinite(s) || s < RESUME_MIN_SECONDS) return 0
  if (!Number.isFinite(d) || d <= 0) return 0
  if (s >= d - RESUME_END_PAD_SECONDS) return 0
  return Math.floor(s)
}
