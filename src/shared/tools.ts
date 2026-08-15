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

export interface ToolReport {
  distro: string
  packageManager: 'apt' | 'pacman' | 'dnf' | 'unknown'
  items: ToolStatus[]
}
