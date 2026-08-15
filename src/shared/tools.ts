// The system-check vocabulary, shared by the probe in main and the panel that
// shows it. Here rather than in main/ so the renderer does not reach across
// the boundary for a type (same rule as shared/nemo.ts and shared/identify.ts).

export interface ToolStatus {
  key: string
  label: string
  /** what stops working without it, in the user's terms */
  needed: string
  /** false means the app is degraded but usable */
  optional: boolean
  present: boolean
  /** the command it resolved to — 'magick' vs 'convert' is worth seeing */
  found: string
  /** ready-to-paste install command for this distribution, '' when present */
  install: string
}

/**
 * The icon theme, which is a dependency like any other even though it is not a
 * program. A desktop with no usable icon theme renders a file list with no file
 * icons at all — the most visible failure this app has, and one that says
 * nothing about its cause unless something reports it.
 */
export interface IconStatus {
  /** the theme actually in use; '' when nothing usable was found */
  theme: string
  /** what the desktop asked for, which may not be installed */
  configured: string
  ok: boolean
  /** how many themes are installed, for "nothing is installed" vs "wrong one" */
  installedCount: number
  install: string
}

export interface ToolReport {
  distro: string
  /** e.g. "KDE", "X-Cinnamon" — why a given config source was believed */
  desktop: string
  packageManager: 'apt' | 'pacman' | 'dnf' | 'unknown'
  items: ToolStatus[]
  icons: IconStatus
}

/** Everything the startup check considers a problem worth interrupting for. */
export function reportProblems(r: ToolReport): { required: string[]; optional: string[]; icons: boolean } {
  return {
    required: r.items.filter(i => !i.present && !i.optional).map(i => i.label),
    optional: r.items.filter(i => !i.present && i.optional).map(i => i.label),
    icons: !r.icons.ok,
  }
}
