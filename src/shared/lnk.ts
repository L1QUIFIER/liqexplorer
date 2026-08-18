// Windows shortcut vocabulary, shared by fs/lnk.ts and the renderer.

export interface LnkTarget {
  ok: boolean
  /** the .lnk itself */
  lnk: string
  /** where it points ON THIS MACHINE; '' when it could not be resolved */
  target: string
  /** the Windows path it names, always set when the file parsed */
  winTarget: string
  isDir: boolean
  /** which rule found it, for the "why did that work" question */
  how?: 'relative' | 'unc' | 'mapping'
  error?: string
}
