// Printing, via CUPS.
//
// `lp` is the interface, not a GUI print dialog: this app has no print dialog
// and building one would mean reimplementing page setup, duplex, ranges and
// media size — all of which CUPS already knows per printer. A drop bin that
// says "Print" should hand the file to the queue the way `lp` does and stop
// there; anything more belongs in the printer's own dialog.
//
// WHAT LP CAN AND CANNOT PRINT. CUPS filters PDF, PostScript, plain text and
// common images itself. It cannot print a .docx or a .odt — those need an
// application to render them, and lp would either fail or spray raw XML at the
// printer, which wastes a tray of paper to discover. Rather than let that
// happen, the caller is told which files CUPS will not take BEFORE anything is
// queued (printableCheck), and the ones that need an application are named.
import { ipcMain } from 'electron'
import { spawn } from 'node:child_process'
import * as path from 'node:path'
import { CH } from '../../shared/ipc'
import type { PrintableCheck, PrintResult, Printer } from '../../shared/printing'

function which(bin: string): boolean {
  const fs = require('node:fs') as typeof import('node:fs')
  for (const dir of (process.env.PATH || '/usr/bin:/bin').split(':')) {
    if (dir && fs.existsSync(path.join(dir, bin))) return true
  }
  return false
}

function run(bin: string, args: string[], ms = 20_000): Promise<{ code: number; out: string; err: string }> {
  return new Promise(resolve => {
    let done = false
    const finish = (code: number, out: string, err: string): void => {
      if (!done) { done = true; resolve({ code, out, err }) }
    }
    try {
      const c = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] })
      let out = ''
      let err = ''
      c.stdout.on('data', d => { out += String(d) })
      c.stderr.on('data', d => { err += String(d) })
      const t = setTimeout(() => { try { c.kill('SIGKILL') } catch { /* gone */ } finish(-1, out, 'timed out') }, ms)
      c.on('error', e => { clearTimeout(t); finish(-1, '', String(e)) })
      c.on('close', code => { clearTimeout(t); finish(code ?? -1, out, err) })
    } catch (e) { finish(-1, '', String(e)) }
  })
}

/**
 * The queues CUPS knows about, default first.
 *
 * `lpstat -p` lists them and `-d` names the default; both are parsed rather
 * than one call to `lpstat -a`, because the default is what a bin with no
 * printer configured will use and the UI should say which one that is.
 */
export async function listPrinters(): Promise<Printer[]> {
  if (!which('lpstat')) return []
  const [p, d] = await Promise.all([run('lpstat', ['-p'], 8000), run('lpstat', ['-d'], 8000)])
  const def = /:\s*(\S+)\s*$/m.exec(d.out)?.[1] ?? ''
  const out: Printer[] = []
  for (const line of p.out.split('\n')) {
    // "printer NAME is idle.  enabled since …"  /  "printer NAME disabled since …"
    const m = /^printer\s+(\S+)\s+(.*)$/.exec(line.trim())
    if (!m) continue
    out.push({
      name: m[1],
      status: m[2].replace(/\s+/g, ' ').trim().slice(0, 80),
      isDefault: m[1] === def,
      ready: !/disabled/i.test(m[2]),
    })
  }
  out.sort((a, b) => Number(b.isDefault) - Number(a.isDefault) || a.name.localeCompare(b.name))
  return out
}

/** extensions CUPS renders on its own */
const CUPS_OK = new Set([
  'pdf', 'ps', 'eps', 'txt', 'text', 'log', 'md', 'csv',
  'jpg', 'jpeg', 'png', 'gif', 'bmp', 'tif', 'tiff', 'webp',
])

/** things an application has to render first; printing them raw wastes paper */
const NEEDS_APP = new Set([
  'doc', 'docx', 'odt', 'rtf', 'xls', 'xlsx', 'ods', 'ppt', 'pptx', 'odp', 'html', 'htm', 'epub',
])

export function printableCheck(paths: string[]): PrintableCheck {
  const out: PrintableCheck = { ok: [], needsApp: [], unknown: [] }
  for (const p of paths) {
    const ext = path.extname(p).replace(/^\./, '').toLowerCase()
    if (CUPS_OK.has(ext)) out.ok.push(p)
    else if (NEEDS_APP.has(ext)) out.needsApp.push(p)
    else out.unknown.push(p)
  }
  return out
}

/**
 * Queue files for printing.
 *
 * One `lp` per file rather than one call with every file: lp accepts a list,
 * but a single failure then takes the whole batch with it and the message names
 * only the first problem. Per file, a bad one is reported by name and the rest
 * still print — which is the behaviour someone standing at a printer wants.
 */
export async function printFiles(paths: string[], printer?: string): Promise<PrintResult> {
  if (!which('lp')) {
    return { ok: false, queued: 0, failed: [], error: 'Printing needs CUPS (the `lp` command), which is not installed.' }
  }
  const files = paths.filter(p => typeof p === 'string' && p.startsWith('/'))
  if (!files.length) return { ok: false, queued: 0, failed: [], error: 'Nothing to print.' }

  // No printer on the bin means "the system default" — but CUPS does not always
  // have one (measured here: `lpstat -d` says "no system default destination"
  // while a perfectly good printer is idle). Without this, a Print bin left on
  // its defaults fails with "no default destination" on a machine that has
  // exactly one printer, which is not a choice anyone needs to be asked to make.
  let dest = printer
  if (!dest) {
    const ps = await listPrinters()
    if (!ps.length) {
      return { ok: false, queued: 0, failed: [], error: 'No printers are set up on this computer.' }
    }
    if (!ps.some(p => p.isDefault) && ps.length === 1) dest = ps[0].name
  }

  const failed: { path: string; error: string }[] = []
  let queued = 0
  for (const f of files) {
    const args = dest ? ['-d', dest, '--', f] : ['--', f]
    const r = await run('lp', args, 30_000)
    if (r.code === 0) queued++
    else failed.push({ path: f, error: (r.err || r.out).split('\n').find(Boolean) || 'lp refused it' })
  }
  return { ok: queued > 0, queued, failed }
}

ipcMain.handle(CH('listPrinters'), () => listPrinters())
ipcMain.handle(CH('printFiles'), (_e, paths: string[], printer?: string) => printFiles(paths ?? [], printer))
ipcMain.handle(CH('printableCheck'), (_e, paths: string[]) => printableCheck(paths ?? []))
