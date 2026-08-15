// Undo/redo for the Doc tab's text editor.
//
// WHY NOT THE TEXTAREA'S OWN UNDO. A <textarea> has a perfectly good native
// undo stack, and this file existed as one line of comment saying so. Two facts
// killed that:
//
//   1. Assigning `.value` CLEARS the native stack. The Doc pane assigns it on
//      every load and every time it restores stashed text, so selecting another
//      file and coming back left the editor with no undo at all — precisely the
//      moment a user is most likely to want it, because they have lost track of
//      what they changed.
//   2. A native stack cannot be seen. The request was for undo *options* the
//      user can find, in a pane that is often a 260px strip, which means
//      buttons that say what they will undo — and the native stack exposes
//      neither its depth nor its contents.
//
// WHY SPLICES AND NOT SNAPSHOTS. The Doc tab opens files up to 3MB. Two hundred
// whole-text snapshots of a 3MB file is 600MB of history for one editor. Every
// edit a textarea can produce is a single contiguous replacement, so each step
// is stored as one: an offset, the text removed, the text inserted. A keystroke
// costs a few bytes instead of the size of the file, and the reconstruction is
// exact rather than approximate — this is not a diff heuristic, it is the edit
// itself, recovered by trimming the common prefix and suffix.
//
// Coalescing exists because one undo per character is not undo, it is a
// typewriter in reverse. Runs of typing merge; a pause, a newline, a paste or a
// change of direction breaks the run, which is where a person's sense of "one
// thing I did" actually falls.

/** where the caret was; restored with the text so undo returns you to the spot */
export interface Caret { start: number; end: number }

interface Step {
  /** offset the replacement starts at */
  at: number
  removed: string
  inserted: string
  /** what kind of edit, for the button's tooltip */
  kind: EditKind
  before: Caret
  after: Caret
  /** for time-based coalescing */
  stamp: number
  /** a save was made with the text as it stands AFTER this step */
  savedAfter?: boolean
}

export type EditKind = 'type' | 'delete' | 'paste' | 'cut' | 'replace' | 'drop' | 'other'

/** consecutive typing merges while the gap stays under this */
const COALESCE_MS = 700
/** hard caps, so a long session cannot grow history without bound */
const MAX_STEPS = 400
const MAX_CHARS = 4_000_000

const KIND_LABEL: Record<EditKind, string> = {
  type: 'typing',
  delete: 'deleting',
  paste: 'paste',
  cut: 'cut',
  replace: 'replacement',
  drop: 'dragged text',
  other: 'change',
}

/** map the browser's inputType onto the coarser kinds shown to the user */
export function kindOf(inputType: string): EditKind {
  if (inputType.startsWith('delete')) return 'delete'
  if (inputType === 'insertFromPaste' || inputType === 'insertFromPasteAsQuotation') return 'paste'
  if (inputType === 'deleteByCut') return 'cut'
  if (inputType === 'insertFromDrop') return 'drop'
  if (inputType.startsWith('insert')) return 'type'
  return 'other'
}

/**
 * The edit between two strings, as one contiguous replacement.
 *
 * Trim the shared head, then the shared tail, and whatever is left in the
 * middle is exactly what changed. Correct for every operation a textarea can
 * perform, because all of them replace one range with one string.
 */
function spliceBetween(a: string, b: string): { at: number; removed: string; inserted: string } | null {
  if (a === b) return null
  const max = Math.min(a.length, b.length)
  let head = 0
  while (head < max && a.charCodeAt(head) === b.charCodeAt(head)) head++
  let tail = 0
  while (
    tail < max - head
    && a.charCodeAt(a.length - 1 - tail) === b.charCodeAt(b.length - 1 - tail)
  ) tail++
  return {
    at: head,
    removed: a.slice(head, a.length - tail),
    inserted: b.slice(head, b.length - tail),
  }
}

export class TextHistory {
  private steps: Step[] = []
  /** how many steps are currently applied; redo lives above this */
  private at = 0
  /** the step index the on-disk file corresponds to, or -1 when never saved */
  private savedAt = 0
  private chars = 0

  constructor(private readonly baseText: string) {}

  /** the text as first loaded, which is what a full revert goes back to */
  get base(): string { return this.baseText }

  canUndo(): boolean { return this.at > 0 }
  canRedo(): boolean { return this.at < this.steps.length }

  /** "typing" / "deleting" — for "Undo typing" on the button */
  undoLabel(): string { return this.at > 0 ? KIND_LABEL[this.steps[this.at - 1].kind] : '' }
  redoLabel(): string { return this.at < this.steps.length ? KIND_LABEL[this.steps[this.at].kind] : '' }

  /** is the text as it stands the same as what was last written to disk? */
  atSavedPoint(): boolean { return this.at === this.savedAt }

  /** called after a successful write: this point in the timeline is now on disk */
  markSaved(): void { this.savedAt = this.at }

  /**
   * Record an edit. `prev` is the text before it, `next` after; the caller owns
   * both because the textarea only ever reports the result.
   */
  record(prev: string, next: string, kind: EditKind, before: Caret, after: Caret): void {
    const sp = spliceBetween(prev, next)
    if (!sp) return

    // anything above the cursor is a branch nobody can reach any more
    if (this.at < this.steps.length) {
      for (const s of this.steps.slice(this.at)) this.chars -= s.removed.length + s.inserted.length
      this.steps.length = this.at
      // the saved point may have been on the discarded branch
      if (this.savedAt > this.at) this.savedAt = -1
    }

    const now = Date.now()
    const last = this.steps[this.at - 1]
    if (last && this.at !== this.savedAt && now - last.stamp < COALESCE_MS && this.mergeable(last, sp, kind)) {
      // extend the run rather than starting a new step
      if (kind === 'delete' && sp.at < last.at) {
        // backspace: the new deletion sits immediately before the last one
        last.removed = sp.removed + last.removed
        last.at = sp.at
      } else if (kind === 'delete') {
        last.removed += sp.removed          // forward delete at a fixed offset
      } else {
        last.inserted += sp.inserted
      }
      last.after = after
      last.stamp = now
      this.chars += sp.removed.length + sp.inserted.length
      this.trim()
      return
    }

    this.steps.push({ ...sp, kind, before, after, stamp: now })
    this.at = this.steps.length
    this.chars += sp.removed.length + sp.inserted.length
    this.trim()
  }

  /**
   * Should this edit join the previous one?
   *
   * Only for unbroken runs of the same kind in the same direction, and never
   * across a newline — pressing Enter is where people expect one undo to stop.
   */
  private mergeable(last: Step, sp: { at: number; removed: string; inserted: string }, kind: EditKind): boolean {
    if (kind !== last.kind) return false
    if (kind === 'type') {
      if (last.removed || sp.removed) return false
      if (sp.inserted.includes('\n') || last.inserted.endsWith('\n')) return false
      return sp.at === last.at + last.inserted.length
    }
    if (kind === 'delete') {
      if (last.inserted || sp.inserted) return false
      if (sp.removed.includes('\n')) return false
      // backspace runs leftwards, the Delete key eats forwards at one offset
      return sp.at + sp.removed.length === last.at || sp.at === last.at
    }
    return false      // a paste, a cut or a drop is always its own step
  }

  /** drop the oldest steps once either cap is exceeded */
  private trim(): void {
    while (this.steps.length > MAX_STEPS || this.chars > MAX_CHARS) {
      const gone = this.steps.shift()
      if (!gone) break
      this.chars -= gone.removed.length + gone.inserted.length
      this.at--
      if (this.savedAt >= 0) this.savedAt--
    }
    if (this.at < 0) this.at = 0
  }

  /** apply one step backwards; returns the new text and where the caret goes */
  undo(text: string): { text: string; caret: Caret } | null {
    if (!this.canUndo()) return null
    const s = this.steps[--this.at]
    return {
      text: text.slice(0, s.at) + s.removed + text.slice(s.at + s.inserted.length),
      caret: s.before,
    }
  }

  redo(text: string): { text: string; caret: Caret } | null {
    if (!this.canRedo()) return null
    const s = this.steps[this.at++]
    return {
      text: text.slice(0, s.at) + s.inserted + text.slice(s.at + s.removed.length),
      caret: s.after,
    }
  }

  /** how many steps deep the user currently is, for "3 changes" in the pane */
  depth(): number { return this.at }
}
