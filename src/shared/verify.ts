// Checksum verification vocabulary, shared by ops/verify.ts and its dialog.

export interface VerifyResult {
  ok: boolean
  file: string
  /** the tool that read it: sha256sum / sha1sum / md5sum */
  algo: string
  /** files whose bytes still match (named ok_ because `ok` is the call status) */
  ok_: string[]
  /** present, but the hash differs — corruption or an edit */
  changed: string[]
  /** named in the list and no longer on disk */
  missing: string[]
  /** in the folder but absent from the list — what has appeared since */
  extra: string[]
  /** lines the checksum file contained */
  checked: number
  error?: string
}
