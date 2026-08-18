// The wire shapes for the "find a better version of this image" feature.
//
// These live in shared/ rather than in main/imagelab because the renderer must never import from
// main/, and the dialog needs exactly the shapes the IPC returns. main/imagelab imports them BACK
// from here so there is one definition rather than two that drift — the first draft of this file
// invented a verdict called 'unmeasurable' that quality.ts has never produced, which is precisely
// the failure a hand-kept copy invites.

/** why a candidate was accepted or thrown away */
export type CandidateVerdict =
  | 'better'
  | 'same-size'
  | 'smaller'
  | 'different-picture'
  | 'placeholder'
  | 'unreadable'

export interface Candidate {
  url: string
  /** where the URL came from, for the UI to explain itself */
  origin: 'given' | 'rewrite' | 'page' | 'search'
  width: number
  height: number
  bytes: number
  contentType: string
  /** '' when it could not be fingerprinted */
  fingerprint: string
  /** bits of difference from the local picture; 64 when not comparable */
  distance: number
  verdict: CandidateVerdict
  /** the one-line reason, ready to show */
  why: string
  /**
   * The request never left this machine.
   *
   * A real field rather than something read back out of `why`: the batch stop rule depends on this
   * distinction, and it must not be one reworded sentence away from silently never firing again.
   */
  transport?: boolean
  /** the raw network error ('net::ERR_PROXY_CONNECTION_FAILED'), for the outage detector to judge */
  errorCode?: string
}

/** how a verdict reads to a person */
export const VERDICT_TEXT: Record<CandidateVerdict, string> = {
  'better': 'bigger, and the same picture',
  'same-size': 'no bigger than what you have',
  'smaller': 'smaller than what you have',
  'different-picture': 'a different picture',
  'placeholder': 'a "picture removed" notice',
  'unreadable': 'could not be read',
}

/** where a candidate's address came from, in words */
export const ORIGIN_TEXT: Record<Candidate['origin'], string> = {
  'given': 'the address you gave',
  'rewrite': 'a guess at the full-size address',
  'page': 'the page it came from',
  'search': 'a reverse image search',
}

/**
 * Does the candidate have a noticeably different shape from what we have?
 *
 * dHash resamples to a fixed 9x8 grid, which means it compares CONTENT and is blind to aspect
 * ratio — a differently-cropped copy of the same picture squashes onto the same grid and passes the
 * same-picture test. Measured while testing the batch: a 250x293 portrait crop matched a 1200x800
 * landscape one at well inside the tolerance, and both are genuinely the same painting.
 *
 * So this is a WARNING, not a bar. Sometimes the wider copy is the one you want (the original,
 * uncropped); sometimes it is a banner version with the subject off-centre. Only the person
 * looking can tell, so this makes sure they are told to look.
 */
export function aspectWarning(w1: number, h1: number, w2: number, h2: number): string | null {
  if (!w1 || !h1 || !w2 || !h2) return null
  const a = w1 / h1
  const b = w2 / h2
  const off = Math.abs(Math.log(b / a))
  if (off < 0.08) return null                     // within ~8%: rounding and re-encodes
  const shape = (w: number, h: number): string => (w > h ? 'landscape' : w < h ? 'portrait' : 'square')
  const from = shape(w1, h1)
  const to = shape(w2, h2)
  return from === to
    ? 'a different shape — check the crop'
    : `${from} becomes ${to} — check the crop`
}

export interface ImagePreviewWire {
  ok: boolean
  /** a `data:` URL — the renderer's CSP allows no remote images, on purpose */
  dataUrl?: string
  width?: number
  height?: number
  error?: string
}

// ------------------------------------------------------------------- batch mode

/** where one picture has got to in a batch run */
export type BatchState =
  | 'waiting'    // queued, not looked at yet
  | 'looking'    // being searched right now
  | 'found'      // a better copy is available
  | 'nothing'    // searched, nothing cleared the bars
  | 'error'      // this one picture failed
  | 'stopped'    // the run stopped before reaching it

export interface BatchRow {
  file: string
  name: string
  ext: string
  bytes: number
  width: number
  height: number
  area: number
  state: BatchState
  best: Candidate | null
  /** candidate area ÷ current area; 0 when there is no candidate */
  gain: number
  /** how many addresses were looked at for this picture */
  looked: number
  error?: string
}

/** why a run ended early — every one of these means "do not keep consuming the queue" */
export type BatchStop = 'captcha' | 'transport' | 'cancelled'

export interface BatchProgress {
  runId: number
  done: number
  total: number
  /** the row that just changed */
  row?: BatchRow
  /**
   * The WHOLE plan. Sent twice: once before any work starts, so the list is visible and honest from
   * the first moment rather than trickling into an empty box, and once at the end, so rows the run
   * never reached can say so instead of sitting at "waiting" forever.
   */
  rows?: BatchRow[]
  finished?: boolean
  stopped?: BatchStop
  /** what to tell the user when a run stopped early */
  message?: string
}

export interface BatchApplyProgress {
  runId: number
  done: number
  total: number
  file?: string
  saved?: string
  error?: string
  finished?: boolean
}

export const STOP_TEXT: Record<BatchStop, string> = {
  captcha: 'The search engine started asking for a captcha, so the run stopped rather than paging '
    + 'further into the block. The pictures already checked are listed below.',
  transport: 'Nothing is leaving this machine — several requests in a row failed before reaching '
    + 'anywhere. The run stopped rather than marking the rest of the list bad for a reason that has '
    + 'nothing to do with those pictures.',
  cancelled: 'Stopped before the end of the list.',
}
