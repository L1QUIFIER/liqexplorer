// The vocabulary for Nemo actions, shared by the main-side loader
// (main/platform/nemoactions.ts) and the context menu that offers them.
//
// Here rather than in the main module because the renderer needs the shape to
// build its submenu, and reaching into src/main from src/renderer for a type
// would make the boundary a suggestion rather than a rule.

export interface NemoAction {
  /** absolute path of the .nemo_action file; also the id used to run it */
  id: string
  name: string
  comment: string
  /** freedesktop icon name, may be '' */
  icon: string
  /** raw Exec line, for the tooltip only — never executed as a string */
  exec: string
  selection: string
  extensions: string[]
  mimetypes: string[]
  separator: string
}

/**
 * An action as the Extensions manager sees it — including the ones that will
 * NEVER appear in a menu.
 *
 * The menu path drops an action whose dependencies are missing or whose
 * conditions cannot be verified, silently and for good reasons. That silence is
 * the problem the manager solves: "I installed an extension and nothing
 * happened" has an answer, and it is usually one missing binary.
 */
export interface ExtensionInfo {
  id: string
  name: string
  comment: string
  icon: string
  exec: string
  /** where it came from: the app's own folder, the user's Nemo folder, the system */
  source: 'liq' | 'user' | 'system'
  /** turned off by the user in the manager */
  enabled: boolean
  /** '' when it will appear; otherwise why it will not */
  blocked: '' | 'deps' | 'condition'
  /** binaries it names that are not on PATH */
  missing: string[]
  /** a command that FINDS the package providing `missing[0]` — not an install
   *  command, because a binary name does not imply a package name */
  install: string
  /** when it applies, in words, for the manager's second line */
  applies: string
}

/** What the renderer knows about the current selection, for filtering. */
export interface ActionQuery {
  /** absolute paths of the selection; empty for a background click */
  paths: string[]
  /** true per path, index-aligned with `paths` */
  dirs: boolean[]
  /** mime per path, index-aligned with `paths` */
  mimes: string[]
}
