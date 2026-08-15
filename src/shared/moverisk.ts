// Safe mode — catch the move that was probably an accident.
//
// The everyday confirmations (confirmDrop / confirmMove) are off by default
// because asking every time trains people to click through. This asks only when
// something about the operation is genuinely unusual, so the prompt still means
// something when it appears:
//
//   - a system location is involved (/etc, /usr, /boot … — moving out of one is
//     almost never intended, and moving INTO one rarely ends well)
//   - a whole drive or mount point is being moved
//   - a large number of items at once (a stray drag over a folder tree)
//   - a hidden config directory (~/.config, ~/.ssh …) is being moved
//
// It deliberately does NOT fire on ordinary moves between ordinary folders.

const SYSTEM_PREFIXES = [
  '/bin', '/boot', '/dev', '/etc', '/lib', '/lib32', '/lib64', '/libx32',
  '/opt', '/proc', '/root', '/run', '/sbin', '/srv', '/sys', '/usr', '/var',
]

export interface MoveRiskOpts {
  /** absolute mount points, longest first (liq.invoke('mountPoints')) */
  mountPoints?: string[]
  /** how many items the operation covers */
  count?: number
  /** warn above this many items (0 disables the count rule) */
  bulkThreshold?: number
  home?: string
}

export interface MoveRisk {
  risky: boolean
  /** short sentence naming WHY, shown in the confirmation */
  reason?: string
}

function underAny(p: string, prefixes: string[]): string | null {
  for (const pre of prefixes) {
    if (p === pre || p.startsWith(pre.endsWith('/') ? pre : pre + '/')) return pre
  }
  return null
}

/** Assess a move/copy for the "this was probably a mistake" cases. */
export function assessMove(
  sources: string[], dest: string, opts: MoveRiskOpts = {},
): MoveRisk {
  const { mountPoints = [], count = sources.length, bulkThreshold = 100, home = '' } = opts

  for (const s of sources) {
    const sys = underAny(s, SYSTEM_PREFIXES)
    if (sys) return { risky: true, reason: `"${s}" is inside the system folder ${sys}.` }
    if (mountPoints.includes(s.replace(/\/+$/, ''))) {
      return { risky: true, reason: `"${s}" is a drive, not an ordinary folder.` }
    }
    if (s === home) return { risky: true, reason: 'That is your home folder.' }
    if (home && s.startsWith(home + '/.')) {
      const seg = s.slice(home.length + 1).split('/')[0]
      // may be a file (.bashrc) or a directory (.config) — word it for both
      return { risky: true, reason: `"${seg}" is hidden app settings — something may depend on it.` }
    }
  }

  const destSys = underAny(dest, SYSTEM_PREFIXES)
  if (destSys) return { risky: true, reason: `The destination is inside the system folder ${destSys}.` }

  if (bulkThreshold > 0 && count >= bulkThreshold) {
    return { risky: true, reason: `This affects ${count} items at once.` }
  }
  return { risky: false }
}
