// Printing vocabulary, shared by main/platform/printing.ts and the bin that
// uses it. Here rather than in main/ so the renderer does not reach across the
// boundary for a type (the rule shared/nemo.ts and shared/tools.ts follow).

export interface Printer {
  name: string
  /** what lpstat said about it, e.g. "is idle. enabled since …" */
  status: string
  isDefault: boolean
  /** false when the queue is disabled — still listed, because a disabled
   *  printer is a thing to fix rather than a thing to hide */
  ready: boolean
}

export interface PrintResult {
  ok: boolean
  /** how many files CUPS accepted */
  queued: number
  failed: { path: string; error: string }[]
  error?: string
}

/** Which of a drop CUPS can render itself, and which need an application. */
export interface PrintableCheck {
  ok: string[]
  needsApp: string[]
  unknown: string[]
}
