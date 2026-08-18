// Comparing two folders.
//
// The question this answers is "are these two copies the same, and if not
// where do they differ" — which on this machine is a real one: the code lives
// on a CIFS share with local mirrors that silently diverge, and VM shares sit
// on top of that again.
//
// Four outcomes, and the fourth is the one that matters:
//
//   onlyA / onlyB   present on one side
//   same            same name, same size, same bytes
//   differs         SAME NAME, DIFFERENT CONTENT — the dangerous one, because
//                   it is the case a listing cannot show you and the one that
//                   silently overwrites work
//
// SIZE FIRST, then hash. Two files of different sizes cannot have the same
// content, so the expensive comparison is only paid where it can change the
// answer — the same staged strategy platform/duplicates.ts uses, for the same
// reason: the alternative is hashing a hundred gigabytes to learn nothing.
import { ipcMain } from 'electron'
import * as crypto from 'node:crypto'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { CH } from '../../shared/ipc'
import type { CompareResult, CompareRow } from '../../shared/compare'
import { walkTree, withTimeout } from './treewalk'

/** hash a file with a deadline, so a dead mount cannot stall the comparison */
function hashFile(p: string): Promise<string> {
  return new Promise(resolve => {
    const h = crypto.createHash('sha256')
    const s = fs.createReadStream(p)
    s.on('data', c => h.update(c))
    s.on('end', () => resolve(h.digest('hex')))
    s.on('error', () => resolve(''))
  })
}

/** per side; two maps of every file is the memory this tool actually spends */
const MAX_PER_SIDE = 50_000

interface Side { rel: string; size: number }

async function listSide(root: string): Promise<Map<string, Side>> {
  const out = new Map<string, Side>()
  const base = root.endsWith('/') ? root.slice(0, -1) : root
  await walkTree([base], {
    onFile: (f) => {
      if (out.size >= MAX_PER_SIDE) return
      const rel = f.path.slice(base.length + 1)
      out.set(rel, { rel, size: f.stat.size })
    },
    maxDirs: 8000,
  })
  return out
}

export async function compareFolders(a: string, b: string): Promise<CompareResult> {
  const empty: CompareResult = { ok: false, a, b, rows: [], onlyA: 0, onlyB: 0, same: 0, differs: 0 }
  if (!a?.startsWith('/') || !b?.startsWith('/')) return { ...empty, error: 'Both sides must be folders on this computer.' }
  if (a === b) return { ...empty, error: 'Those are the same folder.' }

  const [left, right] = await Promise.all([listSide(a), listSide(b)])
  const rows: CompareRow[] = []

  for (const [rel, l] of left) {
    const r = right.get(rel)
    if (!r) { rows.push({ rel, state: 'onlyA', sizeA: l.size, sizeB: -1 }); continue }
    if (l.size !== r.size) { rows.push({ rel, state: 'differs', sizeA: l.size, sizeB: r.size }); continue }
    // same size: only now is it worth reading both
    const [ha, hb] = await Promise.all([
      withTimeout(hashFile(path.join(a, rel)), 60_000),
      withTimeout(hashFile(path.join(b, rel)), 60_000),
    ])
    const av = ha.value ?? ''
    const bv = hb.value ?? ''
    const unknown = ha.timedOut || hb.timedOut || !av || !bv
    rows.push({
      rel,
      state: unknown ? 'differs' : av === bv ? 'same' : 'differs',
      sizeA: l.size, sizeB: r.size,
      note: unknown ? 'could not be read on both sides' : undefined,
    })
  }
  for (const [rel, r] of right) {
    if (!left.has(rel)) rows.push({ rel, state: 'onlyB', sizeA: -1, sizeB: r.size })
  }

  // differences first, identical files last: the reason anyone opens this is to
  // find what is NOT the same
  const rank = { differs: 0, onlyA: 1, onlyB: 2, same: 3 } as const
  rows.sort((x, y) => rank[x.state] - rank[y.state] || x.rel.localeCompare(y.rel))

  return {
    ok: true, a, b, rows,
    onlyA: rows.filter(r => r.state === 'onlyA').length,
    onlyB: rows.filter(r => r.state === 'onlyB').length,
    same: rows.filter(r => r.state === 'same').length,
    differs: rows.filter(r => r.state === 'differs').length,
  }
}

ipcMain.handle(CH('compareFolders'), (_e, a: string, b: string) => compareFolders(a, b))
