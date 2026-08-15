// What a file turns out to be when the name is no help, and what to do about it.
//
// Shared because the renderer shows the answer and main works it out; reaching
// into src/main from src/renderer for a type would make the boundary a
// suggestion rather than a rule (the same fix as shared/nemo.ts).

export interface Identified {
  /** what the bytes indicate, '' when nothing did */
  mime: string
  /** one sentence a person can read */
  why: string
  suggestions: { id: 'view' | 'text' | 'openwith' | 'rename' | 'properties'; label: string }[]
}
