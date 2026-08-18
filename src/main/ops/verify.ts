// Checking a checksum file, which is the other half of writing one.
//
// The app could WRITE SHA256SUMS and never read one back, so the feature
// stopped at the point it becomes useful: a checksum you never verify has told
// you nothing. This re-hashes what the file names and reports four outcomes,
// which are genuinely different problems and must not be merged:
//
//   ok        the bytes still match
//   changed   the file is there and the hash differs — corruption, or an edit
//   missing   the file named in the list is gone
//   extra     a file in the folder that the list does not mention
//
// `extra` is the one people forget and the reason this is not just
// `sha256sum -c`: on a media library the interesting question is usually "what
// has appeared since I last checked", and a verifier that only walks the list
// cannot see it.
//
// The hashing is delegated to the system tools (sha256sum and friends), the
// same ones ops/checksums.ts writes with, so a file written by one is read by
// the other with no chance of the two disagreeing about format.
import { ipcMain } from 'electron'
import { spawn } from 'node:child_process'
import * as fsp from 'node:fs/promises'
import * as path from 'node:path'
import { CH } from '../../shared/ipc'
import type { VerifyResult } from '../../shared/verify'

/** the checksum files worth recognising, and the tool that reads each */
const KNOWN: Record<string, string> = {
  SHA256SUMS: 'sha256sum',
  SHA1SUMS: 'sha1sum',
  MD5SUMS: 'md5sum',
}

/** which tool for a given file name, or '' when it is not a checksum file */
function toolFor(name: string): string {
  const base = name.replace(/\s*\(\d+\)$/, '')          // "SHA256SUMS (2)"
  for (const [k, bin] of Object.entries(KNOWN)) if (base.toUpperCase().startsWith(k)) return bin
  return ''
}

interface Line { hash: string; rel: string }

/** parse `<hash>  <name>` lines; the two-space separator is the coreutils format */
function parseSums(text: string): Line[] {
  const out: Line[] = []
  for (const raw of text.split('\n')) {
    const m = /^([0-9a-fA-F]{32,128})\s[\s*](.+)$/.exec(raw)
    if (m) out.push({ hash: m[1].toLowerCase(), rel: m[2] })
  }
  return out
}

function run(bin: string, args: string[], cwd: string, ms = 10 * 60_000): Promise<{ code: number; out: string }> {
  return new Promise(resolve => {
    let done = false
    const finish = (code: number, out: string): void => { if (!done) { done = true; resolve({ code, out }) } }
    try {
      const c = spawn(bin, args, { cwd, stdio: ['ignore', 'pipe', 'ignore'] })
      let out = ''
      c.stdout.on('data', d => { out += String(d) })
      const t = setTimeout(() => { try { c.kill('SIGKILL') } catch { /* gone */ } finish(-1, out) }, ms)
      c.on('error', () => { clearTimeout(t); finish(-1, '') })
      c.on('close', code => { clearTimeout(t); finish(code ?? -1, out) })
    } catch { finish(-1, '') }
  })
}

export async function verifyChecksums(file: string): Promise<VerifyResult> {
  const empty: VerifyResult = { ok: false, file, algo: '', ok_: [], changed: [], missing: [], extra: [], checked: 0 }
  if (!file || !file.startsWith('/')) return { ...empty, error: 'Not a file on this computer.' }
  const name = path.basename(file)
  const bin = toolFor(name)
  if (!bin) {
    return { ...empty, error: `"${name}" is not a checksum file (expected SHA256SUMS, SHA1SUMS or MD5SUMS).` }
  }
  const root = path.dirname(file)

  let text = ''
  try { text = await fsp.readFile(file, 'utf8') } catch (e) {
    return { ...empty, error: String((e as Error)?.message ?? e) }
  }
  const lines = parseSums(text)
  if (!lines.length) return { ...empty, algo: bin, error: 'That file contains no checksums this understands.' }

  // `-c` reports OK / FAILED / "No such file" per line, which is exactly the
  // three-way split wanted; --quiet would hide the OK lines and the count with them
  const r = await run(bin, ['-c', '--', name], root)
  const okList: string[] = []
  const changed: string[] = []
  const missing: string[] = []
  for (const raw of r.out.split('\n')) {
    const m = /^(.*): (OK|FAILED|FAILED open or read)\s*$/.exec(raw.trim())
    if (!m) continue
    if (m[2] === 'OK') okList.push(m[1])
    else if (m[2] === 'FAILED') changed.push(m[1])
    else missing.push(m[1])
  }

  // anything in the folder the list does not mention. Not recursive: the list
  // itself is not, so a recursive answer would report every file in every
  // subfolder as "extra" and drown the real ones.
  const listed = new Set(lines.map(l => l.rel))
  listed.add(name)
  const extra: string[] = []
  for (const e of await fsp.readdir(root, { withFileTypes: true }).catch(() => [])) {
    if (!e.isFile()) continue
    if (!listed.has(e.name)) extra.push(e.name)
  }

  return {
    ok: true, file, algo: bin,
    ok_: okList, changed, missing, extra,
    checked: lines.length,
  }
}

ipcMain.handle(CH('verifyChecksums'), (_e, file: string) => verifyChecksums(file))
