// Vocabulary for the small tools (ops/toolbox.ts) and the menu that runs them.

export interface ToolboxResult {
  ok: boolean
  /** what was produced (or, for a test, what passed) */
  done: string[]
  failed: { path: string; error: string }[]
  error?: string
}

export interface CleanupResult {
  ok: boolean
  root: string
  /** reported, never deleted: "empty" is a judgement the user has to make */
  emptyDirs: string[]
  brokenLinks: string[]
  error?: string
}
