// Painting the app in the desktop's accent colour.
//
// main/platform/accent.ts finds ONE colour. This turns it into the handful the
// interface actually uses, because an accent is never used raw: a selected row
// is a pale wash of it, the same row hovered is slightly stronger, a primary
// button is the solid colour, and the text on that button is whichever of black
// or white can be read against it.
//
// Deriving those rather than shipping a table is what makes an arbitrary accent
// work. A user on Mint-Y-Dark-Aqua, Adwaita, or a hand-written theme gets a
// consistent interface without anyone having authored a palette for their
// particular blue.
//
// CONTRAST IS COMPUTED, NOT ASSUMED. White text on a yellow accent is
// unreadable, and yellow accents exist (GNOME ships one). The label colour is
// chosen by relative luminance, so a pale accent gets dark text automatically.
import { liq } from './app'

export interface AccentApplied {
  color: string
  source: string
  detail: string
}

interface Rgb { r: number; g: number; b: number }

function parse(hex: string): Rgb | null {
  const m = /^#([0-9a-f]{6})$/i.exec(hex.trim())
  if (!m) return null
  const n = parseInt(m[1], 16)
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 }
}

const clamp = (n: number): number => Math.max(0, Math.min(255, Math.round(n)))
const hex = (c: Rgb): string =>
  `#${[c.r, c.g, c.b].map(n => clamp(n).toString(16).padStart(2, '0')).join('')}`

/** blend towards white (t>0) or black (t<0) */
function shade(c: Rgb, t: number): Rgb {
  const to = t >= 0 ? 255 : 0
  const k = Math.abs(t)
  return { r: c.r + (to - c.r) * k, g: c.g + (to - c.g) * k, b: c.b + (to - c.b) * k }
}

/** WCAG relative luminance, for deciding what text can be read on this colour */
function luminance(c: Rgb): number {
  const f = (v: number): number => {
    const s = v / 255
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4)
  }
  return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b)
}

const VARS = [
  '--accent', '--accent-light', '--accent-selection', '--text-on-accent',
  '--bg-selected', '--bg-selected-hover', '--bg-selected-press',
] as const

/** put every derived variable back so the app returns to its own palette */
export function clearAccent(): void {
  const s = document.documentElement.style
  for (const v of VARS) s.removeProperty(v)
}

/**
 * Apply `color` as the accent, deriving the shades the interface needs.
 *
 * The selection washes differ between light and dark: on a light background a
 * selected row is the accent mixed heavily towards white, on a dark one it is
 * mixed towards black. Using one set for both gives either an invisible
 * selection or a glaring one.
 */
export function applyAccent(color: string, dark: boolean): boolean {
  const c = parse(color)
  if (!c) return false
  const s = document.documentElement.style
  s.setProperty('--accent', hex(c))
  // the lighter partner used for focus rings and hovered accents
  s.setProperty('--accent-light', hex(shade(c, dark ? 0.18 : 0.12)))
  s.setProperty('--accent-selection', hex(c))
  // readable label on a solid accent — computed, because a yellow accent needs
  // black text and a navy one needs white
  s.setProperty('--text-on-accent', luminance(c) > 0.45 ? '#101010' : '#ffffff')

  if (dark) {
    s.setProperty('--bg-selected', hex(shade(c, -0.62)))
    s.setProperty('--bg-selected-hover', hex(shade(c, -0.55)))
    s.setProperty('--bg-selected-press', hex(shade(c, -0.48)))
  } else {
    s.setProperty('--bg-selected', hex(shade(c, 0.78)))
    s.setProperty('--bg-selected-hover', hex(shade(c, 0.68)))
    s.setProperty('--bg-selected-press', hex(shade(c, 0.6)))
  }
  return true
}

/**
 * Read the setting and paint accordingly.
 *
 * Called at startup and whenever the theme flips, because a theme change is
 * usually an accent change too — Mint's light and dark variants are different
 * theme directories with their own colours.
 */
export async function refreshAccent(settings: {
  accentSource?: string
  accentColor?: string
}): Promise<AccentApplied | null> {
  const dark = document.documentElement.dataset.theme === 'dark'
  const mode = settings.accentSource ?? 'system'

  if (mode === 'app') { clearAccent(); return null }
  if (mode === 'custom') {
    const ok = applyAccent(settings.accentColor ?? '', dark)
    if (!ok) clearAccent()
    return ok ? { color: settings.accentColor ?? '', source: 'custom', detail: '' } : null
  }

  const info = await liq.invoke('systemAccent', dark).catch(() => null) as AccentApplied | null
  if (!info?.color || !applyAccent(info.color, dark)) { clearAccent(); return null }
  return info
}
