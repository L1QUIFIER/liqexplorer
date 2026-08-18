// Media health vocabulary, shared by platform/mediahealth.ts and its dialog.

export interface HealthRow {
  path: string
  name: string
  /** plays natively / needs converting first / nothing can show it */
  state: 'plays' | 'converts' | 'fails'
  /** what stops it playing natively, in the user's terms */
  why: string
  video: string
  audio: string
  seconds: number
}

export interface HealthResult {
  ok: boolean
  root: string
  /** problems first — a report whose bad news is below the fold gets closed */
  rows: HealthRow[]
  plays: number
  converts: number
  fails: number
  scanned: number
  /** the run hit its cap; the answer covers only part of the tree */
  truncated?: boolean
  error?: string
}
