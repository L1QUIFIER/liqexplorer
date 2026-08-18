// Folder comparison vocabulary, shared by platform/compare.ts and its dialog.

export interface CompareRow {
  /** path relative to each side's root */
  rel: string
  /** 'differs' is the dangerous one: same name, different bytes */
  state: 'onlyA' | 'onlyB' | 'same' | 'differs'
  /** -1 when absent from that side */
  sizeA: number
  sizeB: number
  /** set when the verdict had to be assumed (a read timed out) */
  note?: string
}

export interface CompareResult {
  ok: boolean
  a: string
  b: string
  /** differences first; identical files last */
  rows: CompareRow[]
  onlyA: number
  onlyB: number
  same: number
  differs: number
  /** the run hit its cap; the answer covers only part of the tree */
  truncated?: boolean
  error?: string
}
