// 7-Zip archive backend — the only place that knows how to talk to the archive
// CLIs. Pure node (no electron imports) so it can be exercised head-less.
//
// Tools, measured on this machine (7-Zip 23.01, unrar 7.00, unar/lsar 1.10.1):
//   list    : `7z l -slt` for every format (structured key/value blocks),
//             `lsar -j` as the tolerant fallback for odd/legacy containers.
//   extract : unrar for .rar when present (best rar5 fidelity), else 7z,
//             else unar (very tolerant, and the last resort when 7z refuses).
//   create  : 7z for .zip/.7z; GNU tar piped through node zlib for .tar.gz
//             (real byte progress without giving up tar's metadata fidelity).
//
// TWO HARD RULES, both measured:
//  1. Every child is spawned with stdin IGNORED. `7z l` on a header-encrypted
//     archive prompts on the terminal and blocks forever otherwise.
//  2. A password switch is ALWAYS passed (`-p` with an empty value when we have
//     no password) for the same reason — `-p` turns the prompt into exit 2.
// Exit codes seen: 7z 0 ok / 2 fatal (also "wrong password") / 255 user break;
// unrar 0 ok / 11 wrong password.
//
// NOTE: passwords travel as argv, which is visible in `ps` to other local
// users. Every CLI-driven extractor has this property (7z has no usable stdin
// password channel); it is not something this module can fix.
import { spawn, type ChildProcess } from 'node:child_process'
import * as fsp from 'node:fs/promises'
import * as path from 'node:path'

// ---------------- types ----------------

export interface ArchiveEntry {
  /** in-archive path, '/' separated, no leading slash */
  path: string
  size: number
  packed: number
  /** epoch ms, 0 when unknown */
  mtime: number
  isDir: boolean
  encrypted: boolean
}

export interface ArchiveListing {
  ok: boolean
  entries: ArchiveEntry[]
  /** at least one member is encrypted */
  encrypted: boolean
  /** the listing itself needs a password (7z -mhe=on, rar -hp) */
  headerEncrypted: boolean
  /** container type as reported by 7z ('7z', 'zip', 'Rar5', 'tar', ...) */
  type: string
  /** volume count for a split set, 0 when not split */
  volumes: number
  /** total uncompressed bytes */
  totalSize: number
  /** bytes on disk (all volumes) */
  physicalSize: number
  error?: string
}

export type TestStatus = 'ok' | 'wrongPassword' | 'encrypted' | 'corrupt' | 'error'
export interface TestResult {
  status: TestStatus
  error?: string
}

export interface ChildSink {
  /** engine hook: the running child is exposed for SIGSTOP/SIGCONT/SIGTERM */
  onChild?: (c: ChildProcess | null) => void
}

export interface ListOpts extends ChildSink {
  password?: string
}

export interface ExtractOpts extends ChildSink {
  password?: string
  /** 0..100, monotonic per archive */
  onPercent?: (percent: number) => void
  /** extract only these members (archive:// open-on-demand); undefined = all */
  members?: string[]
}

export interface ExtractResult {
  ok: boolean
  wrongPassword?: boolean
  error?: string
  /** which binary actually did the work, for diagnostics */
  tool?: string
}

export interface CreateOpts extends ChildSink {
  onPercent?: (percent: number) => void
  /** bytes read out of tar, for the tar.gz path */
  onBytes?: (bytes: number) => void
}

export type ArchiveFormat = 'zip' | 'tar.gz' | '7z'

// ---------------- tool discovery ----------------

const toolCache = new Map<string, string | null>()

async function canExec(p: string): Promise<boolean> {
  try {
    const st = await fsp.stat(p)
    return st.isFile() && (st.mode & 0o111) !== 0
  } catch { return false }
}

async function findTool(names: string[]): Promise<string | null> {
  const key = names.join('|')
  const hit = toolCache.get(key)
  if (hit !== undefined) return hit
  const dirs = (process.env.PATH || '/usr/local/bin:/usr/bin:/bin').split(':').filter(Boolean)
  let found: string | null = null
  for (const n of names) {
    if (n.includes('/')) {
      if (await canExec(n)) { found = n; break }
      continue
    }
    for (const d of dirs) {
      const p = path.join(d, n)
      if (await canExec(p)) { found = p; break }
    }
    if (found) break
  }
  toolCache.set(key, found)
  return found
}

/** 7-Zip: `7z` (p7zip / 7-Zip 21+), `7zz` (upstream tarball), `7za` (reduced). */
export const sevenZip = (): Promise<string | null> => findTool(['7z', '7zz', '7za'])
export const unrarBin = (): Promise<string | null> => findTool(['unrar'])
export const unarBin = (): Promise<string | null> => findTool(['unar'])
export const lsarBin = (): Promise<string | null> => findTool(['lsar'])
export const tarBin = (): Promise<string | null> => findTool(['tar'])

/** Which backends are usable — surfaced in errors so the user knows what to install. */
export async function availability(): Promise<{ sevenZip: boolean; unrar: boolean; unar: boolean; tar: boolean }> {
  const [z, r, u, t] = await Promise.all([sevenZip(), unrarBin(), unarBin(), tarBin()])
  return { sevenZip: !!z, unrar: !!r, unar: !!u, tar: !!t }
}

// ---------------- process plumbing ----------------

interface RunResult { code: number; out: string; err: string; spawnFailed: boolean }

interface RunOpts extends ChildSink {
  onOut?: (chunk: string) => void
  /** cap on captured stdout; progress streams are noisy and we only keep a tail */
  capOut?: number
}

/**
 * Spawn with stdin IGNORED (rule 1). Never rejects — a missing binary comes
 * back as spawnFailed so callers can fall through to the next tool.
 */
function run(cmd: string, args: string[], opts: RunOpts = {}): Promise<RunResult> {
  return new Promise(resolve => {
    let child: ChildProcess
    try {
      child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (e) {
      resolve({ code: -1, out: '', err: describeSpawnError(cmd, e), spawnFailed: true })
      return
    }
    opts.onChild?.(child)
    const cap = opts.capOut ?? 1 << 20
    let out = ''
    let err = ''
    child.stdout?.setEncoding('utf8')
    child.stderr?.setEncoding('utf8')
    child.stdout?.on('data', (d: string) => {
      opts.onOut?.(d)
      if (out.length < cap) out += d
    })
    child.stderr?.on('data', (d: string) => { if (err.length < (1 << 18)) err += d })
    let settled = false
    const done = (r: RunResult): void => {
      if (settled) return
      settled = true
      opts.onChild?.(null)
      resolve(r)
    }
    child.on('error', e => done({ code: -1, out, err: describeSpawnError(cmd, e), spawnFailed: true }))
    child.on('close', code => done({ code: code ?? -1, out, err, spawnFailed: false }))
  })
}

function describeSpawnError(cmd: string, e: unknown): string {
  const code = (e as NodeJS.ErrnoException)?.code
  if (code === 'ENOENT') return `${path.basename(cmd)} is not installed`
  return `${path.basename(cmd)}: ${String((e as Error)?.message ?? e)}`
}

// Banner / progress / bookkeeping chatter that must never reach the user as an
// "error"; without this the real line ("Unexpected end of archive") is buried.
const NOISE_RE = new RegExp([
  '^7-Zip', '^Copyright', '^64-bit locale', '^UNRAR ', '^Scanning the drive',
  '^\\d+ files?[,)]', '^\\d+ folders?[,)]', '^Listing archive', '^Extracting archive',
  '^Extracting from', '^Open archive', '^Updating archive', '^Creating archive',
  '^Add new data to archive', '^ERRORS?:$', '^WARNINGS?:$', '^Errors?: \\d+$',
  '^Warnings?: \\d+$', '^Sub items Errors', '^Everything is Ok', '^All OK',
  '^Files: ', '^Folders: ', '^Size: ', '^Compressed: ', '^Archives: ', '^Archive: ',
  '^Path = ', '^Type = ', '^Physical Size', '^Details: ', '^-+$', '^=+$', '^\\d+%$',
].join('|'), 'i')

/** Last few meaningful lines of tool output — the user-facing error surface. */
export function toolError(r: { out: string; err: string; code: number }, fallback: string): string {
  const lines = (r.err + '\n' + r.out)
    .split(/[\r\n\b]+/)
    .map(l => l.trim())
    .filter(l => l.length > 0 && !NOISE_RE.test(l))
  const errs = lines.filter(l => /error|cannot|unsupported|unavailable|corrupt|damaged|unexpected|not implemented|checksum|crc failed|wrong password/i.test(l))
  const pick = (errs.length ? errs : lines).slice(-2).join(' ').replace(/\s+/g, ' ').slice(0, 300)
  return pick || `${fallback} (exit code ${r.code})`
}

/**
 * Percent reader for 7z `-bsp1` / unrar output. Both emit `\b`-separated
 * fragments like " 18%" and "100% 7 - name"; chunk boundaries can split a
 * number so a short tail is carried over.
 */
export function percentReader(onPercent: (p: number) => void): (chunk: string) => void {
  let tail = ''
  let last = -1
  return (chunk: string) => {
    const text = tail + chunk
    tail = text.slice(-8)
    let best = -1
    for (const m of text.matchAll(/(\d{1,3})%/g)) {
      const v = Number(m[1])
      if (v >= 0 && v <= 100) best = v
    }
    if (best >= 0 && best !== last) { last = best; onPercent(best) }
  }
}

// ---------------- listing ----------------

/** ALWAYS present so 7z can never fall back to its interactive prompt. */
const pFlag = (password?: string): string => `-p${password ?? ''}`

const ENCRYPTED_RE = /cannot open encrypted archive|wrong password|encrypted archive/i

function parseTimestamp(v: string): number {
  // 7z: '2026-08-13 20:32:38.7345694' (local time, optional fraction)
  const m = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})/.exec(v.trim())
  if (!m) return 0
  return new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]).getTime()
}

function splitKv(line: string): [string, string] | null {
  const i = line.indexOf(' = ')
  if (i <= 0) return null
  return [line.slice(0, i).trim(), line.slice(i + 3)]
}

/** Normalize an in-archive path: '/' separators, no './', no leading '/'. */
export function normalizeMember(p: string): string {
  return p.replace(/\\/g, '/').replace(/^\.\/+/, '').replace(/^\/+/, '').replace(/\/+$/, '')
}

function parseSlt(out: string): Omit<ArchiveListing, 'ok' | 'headerEncrypted' | 'error'> {
  const lines = out.split(/\r?\n/)
  let sep = -1
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].trim() === '----------') { sep = i; break }
  }
  const head = sep >= 0 ? lines.slice(0, sep) : lines
  const body = sep >= 0 ? lines.slice(sep + 1) : []

  let type = ''
  let volumes = 0
  let physicalSize = 0
  for (const l of head) {
    const kv = splitKv(l)
    if (!kv) continue
    if (kv[0] === 'Type' && kv[1].trim() && kv[1].trim() !== 'Split') type = kv[1].trim()
    else if (kv[0] === 'Volumes') volumes = Number(kv[1].trim()) || 0
    else if (kv[0] === 'Total Physical Size') physicalSize = Number(kv[1].trim()) || physicalSize
    else if (kv[0] === 'Physical Size' && !physicalSize) physicalSize = Number(kv[1].trim()) || 0
  }

  const entries: ArchiveEntry[] = []
  let cur: Record<string, string> | null = null
  const flush = (): void => {
    if (!cur || cur.Path === undefined) { cur = null; return }
    const raw = cur.Path
    const attrHead = (cur.Attributes ?? '').split(' ')[0] ?? ''
    const isDir = cur.Folder === '+' || attrHead.includes('D') || raw.endsWith('/')
    entries.push({
      path: normalizeMember(raw),
      size: Number(cur.Size) || 0,
      packed: Number(cur['Packed Size']) || 0,
      mtime: parseTimestamp(cur.Modified ?? ''),
      isDir,
      encrypted: (cur.Encrypted ?? '').trim() === '+',
    })
    cur = null
  }
  for (const l of body) {
    if (!l.trim()) { flush(); continue }
    const kv = splitKv(l)
    if (!kv) continue
    if (kv[0] === 'Path') { flush(); cur = {} }
    if (cur) cur[kv[0]] = kv[1]
  }
  flush()

  const totalSize = entries.reduce((n, e) => n + (e.isDir ? 0 : e.size), 0)
  return {
    entries: entries.filter(e => e.path.length > 0),
    encrypted: entries.some(e => e.encrypted),
    type,
    volumes,
    totalSize,
    physicalSize,
  }
}

interface LsarEntry {
  XADFileName?: string
  XADFileSize?: number
  XADCompressedSize?: number
  XADIsDirectory?: number
  XADIsEncrypted?: number
  XADLastModificationDate?: string
}

function parseLsar(out: string): Omit<ArchiveListing, 'ok' | 'headerEncrypted' | 'error'> | null {
  let doc: { lsarContents?: LsarEntry[]; lsarFormatName?: string }
  try { doc = JSON.parse(out) } catch { return null }
  if (!doc || !Array.isArray(doc.lsarContents)) return null
  const entries: ArchiveEntry[] = doc.lsarContents.map(e => ({
    path: normalizeMember(String(e.XADFileName ?? '')),
    size: Number(e.XADFileSize) || 0,
    packed: Number(e.XADCompressedSize) || 0,
    mtime: e.XADLastModificationDate ? (Date.parse(e.XADLastModificationDate.replace(' ', 'T')) || 0) : 0,
    isDir: Number(e.XADIsDirectory) === 1,
    encrypted: Number(e.XADIsEncrypted) === 1,
  })).filter(e => e.path.length > 0)
  return {
    entries,
    encrypted: entries.some(e => e.encrypted),
    type: String(doc.lsarFormatName ?? ''),
    volumes: 0,
    totalSize: entries.reduce((n, e) => n + (e.isDir ? 0 : e.size), 0),
    physicalSize: 0,
  }
}

const EMPTY_LISTING: ArchiveListing = {
  ok: false, entries: [], encrypted: false, headerEncrypted: false,
  type: '', volumes: 0, totalSize: 0, physicalSize: 0,
}

/**
 * Structured listing. `headerEncrypted` means we could not even read the table
 * of contents — the caller must supply a password and list again.
 */
export async function list(archivePath: string, opts: ListOpts = {}): Promise<ArchiveListing> {
  const sz = await sevenZip()
  let firstError = ''
  if (sz) {
    const r = await run(sz, ['l', '-slt', pFlag(opts.password), '--', archivePath], { onChild: opts.onChild })
    const text = r.out + '\n' + r.err
    if (r.code === 0 && !/^ERRORS?:/m.test(text)) {
      const parsed = parseSlt(r.out)
      if (!parsed.physicalSize) {
        parsed.physicalSize = await fsp.stat(archivePath).then(s => s.size, () => 0)
      }
      return { ...parsed, ok: true, headerEncrypted: false }
    }
    if (ENCRYPTED_RE.test(text)) {
      return {
        ...EMPTY_LISTING,
        headerEncrypted: true,
        encrypted: true,
        error: 'The archive is encrypted and needs a password.',
      }
    }
    if (!r.spawnFailed) firstError = toolError(r, `Could not read "${path.basename(archivePath)}"`)
  }

  // tolerant fallback: unar's lister copes with legacy/odd containers 7z rejects
  const ls = await lsarBin()
  if (ls) {
    const args = ['-j']
    if (opts.password) args.push('-p', opts.password)
    args.push(archivePath)
    const r = await run(ls, args, { onChild: opts.onChild })
    if (r.code === 0) {
      const parsed = parseLsar(r.out)
      if (parsed) {
        if (!parsed.physicalSize) {
          parsed.physicalSize = await fsp.stat(archivePath).then(s => s.size, () => 0)
        }
        return { ...parsed, ok: true, headerEncrypted: false }
      }
    }
    if (ENCRYPTED_RE.test(r.out + r.err)) {
      return { ...EMPTY_LISTING, headerEncrypted: true, encrypted: true, error: 'The archive is encrypted and needs a password.' }
    }
  }
  return {
    ...EMPTY_LISTING,
    error: firstError || (sz
      ? `Could not read "${path.basename(archivePath)}" — the format is not supported.`
      : '7-Zip (7z) is not installed.'),
  }
}

// ---------------- test ----------------

/**
 * Integrity / password check. `member` restricts the test to one file, which is
 * what makes silent password probing cheap on a multi-gigabyte archive.
 */
export async function test(archivePath: string, password?: string, opts: ListOpts & { member?: string } = {}): Promise<TestResult> {
  const isRar = /\.rar$|\.r\d\d$|\.part\d+\.rar$/i.test(archivePath)
  const ur = isRar && !startsWithDash(password) ? await unrarBin() : null
  if (ur) {
    const args = ['t', '-y', password ? `-p${password}` : '-p-']
    args.push(archivePath)
    if (opts.member) args.push(opts.member)
    const r = await run(ur, args, { onChild: opts.onChild })
    if (r.code === 0) return { status: 'ok' }
    if (r.code === 11) return { status: password === undefined ? 'encrypted' : 'wrongPassword' }
    if (!r.spawnFailed) {
      return { status: /crc|checksum|corrupt|damaged/i.test(r.out + r.err) ? 'corrupt' : 'error', error: toolError(r, 'The archive could not be tested') }
    }
  }
  const sz = await sevenZip()
  if (!sz) return { status: 'error', error: '7-Zip (7z) is not installed.' }
  const args = ['t', pFlag(password), '--', archivePath]
  if (opts.member) args.push(opts.member)
  const r = await run(sz, args, { onChild: opts.onChild })
  if (r.code === 0) return { status: 'ok' }
  const text = r.out + '\n' + r.err
  if (ENCRYPTED_RE.test(text)) {
    return { status: password === undefined ? 'encrypted' : 'wrongPassword' }
  }
  if (/data error|crc failed|unexpected end|is not supported archive|cannot open the file as/i.test(text)) {
    return { status: 'corrupt', error: toolError(r, 'The archive is damaged') }
  }
  return { status: 'error', error: toolError(r, 'The archive could not be tested') }
}

function startsWithDash(s?: string): boolean {
  return typeof s === 'string' && s.startsWith('-')
}

// ---------------- extraction ----------------

/**
 * Extract into destDir (which must already exist and, for the engine path, is a
 * private temp dir). Tool order: unrar for rar, then 7z, then unar as the
 * tolerant last resort.
 */
export async function extract(archivePath: string, destDir: string, opts: ExtractOpts = {}): Promise<ExtractResult> {
  const isRar = /\.rar$|\.r\d\d$/i.test(archivePath)
  const reader = opts.onPercent ? percentReader(opts.onPercent) : undefined

  if (isRar && !startsWithDash(opts.password)) {
    const ur = await unrarBin()
    if (ur) {
      // unrar wants a trailing slash on the destination or it treats it as a file
      const args = ['x', '-y', '-o+', opts.password ? `-p${opts.password}` : '-p-', archivePath]
      if (opts.members?.length) args.push(...opts.members)
      args.push(destDir.endsWith('/') ? destDir : destDir + '/')
      const r = await run(ur, args, { onChild: opts.onChild, onOut: reader, capOut: 8192 })
      if (r.code === 0) return { ok: true, tool: 'unrar' }
      if (r.code === 11) return { ok: false, wrongPassword: true, tool: 'unrar', error: 'The password is incorrect.' }
      if (!r.spawnFailed && r.code !== -1) {
        return { ok: false, tool: 'unrar', error: toolError(r, `Could not extract "${path.basename(archivePath)}"`) }
      }
    }
  }

  const sz = await sevenZip()
  let szError = ''
  if (sz) {
    const args = ['x', '-bsp1', '-bso0', '-bse2', '-y', '-aoa', `-o${destDir}`, pFlag(opts.password), '--', archivePath]
    if (opts.members?.length) args.push(...opts.members)
    const r = await run(sz, args, { onChild: opts.onChild, onOut: reader, capOut: 8192 })
    if (r.code === 0) return { ok: true, tool: '7z' }
    const text = r.out + '\n' + r.err
    if (ENCRYPTED_RE.test(text)) {
      return { ok: false, wrongPassword: true, tool: '7z', error: 'The password is incorrect.' }
    }
    if (r.code === 255) return { ok: false, tool: '7z', error: 'The operation was stopped.' }
    if (!r.spawnFailed) szError = toolError(r, `Could not extract "${path.basename(archivePath)}"`)
  }

  // last resort: unar is tolerant of odd/legacy containers that 7z rejects.
  // -D: never invent a containing directory — the single-root policy is ours.
  const un = await unarBin()
  if (un) {
    const args = ['-q', '-D', '-f', '-o', destDir]
    if (opts.password) args.push('-p', opts.password)
    args.push(archivePath)
    if (opts.members?.length) args.push(...opts.members)
    const r = await run(un, args, { onChild: opts.onChild, capOut: 8192 })
    if (r.code === 0) return { ok: true, tool: 'unar' }
    if (ENCRYPTED_RE.test(r.out + r.err)) {
      return { ok: false, wrongPassword: true, tool: 'unar', error: 'The password is incorrect.' }
    }
    if (!szError && !r.spawnFailed) szError = toolError(r, `Could not extract "${path.basename(archivePath)}"`)
  }
  return { ok: false, error: szError || '7-Zip (7z) is not installed.' }
}

// ---------------- creation ----------------

const FORMAT_EXT: Record<ArchiveFormat, string> = { zip: '.zip', 'tar.gz': '.tar.gz', '7z': '.7z' }
export const extensionFor = (f: ArchiveFormat): string => FORMAT_EXT[f] ?? '.zip'

/** Create `destArchive` from absolute `sources`. Overwrites nothing — the caller picks a free name. */
export async function create(
  destArchive: string, sources: string[], format: ArchiveFormat, opts: CreateOpts = {},
): Promise<{ ok: boolean; error?: string }> {
  if (!sources.length) return { ok: false, error: 'There is nothing to compress.' }
  if (format === 'tar.gz') return createTarGz(destArchive, sources, opts)

  const sz = await sevenZip()
  if (!sz) return { ok: false, error: '7-Zip (7z) is not installed.' }
  const type = format === 'zip' ? '-tzip' : '-t7z'
  // -snl stores symlinks as links instead of following them (matches our copy semantics)
  const args = ['a', type, '-bsp1', '-bso0', '-bse2', '-y', '-snl', '--', destArchive, ...sources]
  const reader = opts.onPercent ? percentReader(opts.onPercent) : undefined
  const r = await run(sz, args, { onChild: opts.onChild, onOut: reader, capOut: 8192 })
  if (r.code === 0) return { ok: true }
  return { ok: false, error: toolError(r, `Could not create "${path.basename(destArchive)}"`) }
}

/**
 * tar.gz via GNU tar piped through node's zlib. Keeping tar as the writer
 * preserves permissions/symlinks/hardlinks properly, and counting the bytes
 * leaving tar gives real progress (7z has no single-shot tar.gz command).
 */
async function createTarGz(destArchive: string, sources: string[], opts: CreateOpts): Promise<{ ok: boolean; error?: string }> {
  const tar = await tarBin()
  if (!tar) return { ok: false, error: 'tar is not installed.' }
  const zlib = await import('node:zlib')
  const fs = await import('node:fs')
  const { pipeline } = await import('node:stream/promises')

  // one -C per source directory keeps stored names relative (no absolute paths)
  const args = ['-c', '-f', '-']
  for (const s of sources) args.push('-C', path.dirname(s), path.basename(s))

  return new Promise(resolve => {
    let child: ChildProcess
    try {
      child = spawn(tar, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (e) {
      resolve({ ok: false, error: describeSpawnError(tar, e) })
      return
    }
    opts.onChild?.(child)
    let err = ''
    child.stderr?.setEncoding('utf8')
    child.stderr?.on('data', (d: string) => { if (err.length < 65536) err += d })
    let bytes = 0
    child.stdout?.on('data', (d: Buffer) => { bytes += d.length; opts.onBytes?.(bytes) })

    const gzip = zlib.createGzip({ level: 6 })
    const out = fs.createWriteStream(destArchive)
    let pipeErr: unknown = null
    const finish = (code: number | null): void => {
      opts.onChild?.(null)
      if (pipeErr) { resolve({ ok: false, error: String((pipeErr as Error)?.message ?? pipeErr) }); return }
      if (code === 0) { resolve({ ok: true }); return }
      const lines = err.split('\n').map(l => l.trim()).filter(Boolean).slice(-2).join(' ')
      resolve({ ok: false, error: lines || `Could not create "${path.basename(destArchive)}" (tar exited with code ${code})` })
    }
    pipeline(child.stdout!, gzip, out).catch(e => { pipeErr = e })
    child.on('error', e => { opts.onChild?.(null); resolve({ ok: false, error: describeSpawnError(tar, e) }) })
    child.on('close', code => {
      // let the gzip tail flush before reporting
      out.on('close', () => finish(code))
      if (out.destroyed || out.closed) finish(code)
    })
  })
}

// ---------------- layout policy / guards ----------------

/**
 * Containers that hold exactly one compressed stream. `foo.tar.gz` lists as a
 * single member "foo.tar", so extracting one of these needs a second pass or
 * the user is handed a .tar instead of their files (7z has no auto-recursion;
 * file-roller and unar both do this).
 */
export const SINGLE_STREAM_TYPES = new Set(
  ['gzip', 'bzip2', 'xz', 'lzma', 'lzma86', 'zstd', 'z', 'lz4', 'brotli', 'lzip'])

/** Unique first path segments — one entry means the archive has a single root. */
export function topLevelNames(entries: ArchiveEntry[]): string[] {
  const seen = new Set<string>()
  for (const e of entries) {
    const first = e.path.split('/')[0]
    if (first && first !== '.' && first !== '..') seen.add(first)
  }
  return [...seen]
}

/** Archive stem for the "<archive-stem>/" destination: drops .tar.gz / .part01.rar / .7z.001 wholesale. */
export function archiveStem(archivePath: string): string {
  let base = path.basename(archivePath)
  base = base.replace(/\.(\d{3,})$/, '')                       // foo.7z.001
  base = base.replace(/\.part\d+\.rar$/i, '')                  // foo.part01.rar
  base = base.replace(/\.r\d{2,}$/i, '')                       // foo.r00
  base = base.replace(/\.z\d{2,}$/i, '')                       // foo.z01
  base = base.replace(/\.(tar\.(gz|bz2|xz|zst|lz|lzma)|tgz|tbz2?|txz)$/i, '')
  const i = base.lastIndexOf('.')
  if (i > 0) base = base.slice(0, i)
  return base || path.basename(archivePath)
}

/** Members that would escape the destination (zip-slip). */
export function unsafeMembers(entries: ArchiveEntry[]): string[] {
  const bad: string[] = []
  for (const e of entries) {
    const p = e.path
    if (!p) continue
    if (p.startsWith('/') || /^[A-Za-z]:[\\/]/.test(p) || p.split('/').includes('..')) {
      bad.push(p)
      if (bad.length >= 5) break
    }
  }
  return bad
}

const GB = 1024 ** 3
const MB = 1024 ** 2
/** Absolute ceiling — anything past this is refused whatever the ratio. */
const MAX_EXPANDED = 10 * GB
/** The ratio rule only kicks in past this, so a 2KB text zip is never "a bomb". */
const RATIO_FLOOR = 64 * MB
const MAX_RATIO = 100

function fmtSize(n: number): string {
  if (n >= GB) return `${(n / GB).toFixed(1)} GB`
  if (n >= MB) return `${(n / MB).toFixed(1)} MB`
  if (n >= 1024) return `${(n / 1024).toFixed(0)} KB`
  return `${n} bytes`
}

/** Decompression-bomb guard. Returns a user-facing reason, or null when sane. */
export function bombCheck(l: ArchiveListing, name: string): string | null {
  const expanded = l.totalSize
  if (expanded > MAX_EXPANDED) {
    return `"${name}" expands to ${fmtSize(expanded)}, which is too large to extract safely.`
  }
  const phys = l.physicalSize
  if (phys > 0 && expanded > RATIO_FLOOR && expanded / phys > MAX_RATIO) {
    return `"${name}" expands to ${fmtSize(expanded)} from ${fmtSize(phys)} ` +
      `(${Math.round(expanded / phys)}:1) and was refused as a possible decompression bomb.`
  }
  return null
}

// ---------------- multi-part volume sets ----------------

export interface VolumeInfo {
  /** this file belongs to a multi-volume set */
  isVolume: boolean
  /** the volume the tools must be pointed at (never a middle part) */
  primary: string
  /** every file in the set, in volume order (primary first) */
  members: string[]
  /** `p` itself is the primary volume */
  isPrimary: boolean
}

const NOT_A_SET = (p: string): VolumeInfo => ({ isVolume: false, primary: p, members: [p], isPrimary: true })

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

async function siblings(dir: string): Promise<string[]> {
  return fsp.readdir(dir).catch(() => [] as string[])
}

const numOf = (s: string): number => Number(s.replace(/^0+(?=\d)/, '')) || 0

/**
 * Recognize `.partN.rar`, `.rNN`, `.7z.NNN`/`.NNN`, `.zNN` sets and report the
 * volume that must be operated on. A set is ONE logical archive: extracting the
 * primary pulls in every other part, and selecting parts 2..N must not extract
 * anything a second time.
 */
export async function volumeInfo(p: string): Promise<VolumeInfo> {
  const dir = path.dirname(p)
  const base = path.basename(p)

  // foo.part01.rar / foo.part1.rar
  let m = /^(.*)\.part(\d+)\.rar$/i.exec(base)
  if (m) {
    const stem = m[1]
    const re = new RegExp(`^${escapeRe(stem)}\\.part(\\d+)\\.rar$`, 'i')
    const found = (await siblings(dir)).filter(n => re.test(n))
      .sort((a, b) => numOf(re.exec(a)![1]) - numOf(re.exec(b)![1]))
    if (found.length) {
      const members = found.map(n => path.join(dir, n))
      return { isVolume: found.length > 1, primary: members[0], members, isPrimary: members[0] === p }
    }
    return NOT_A_SET(p)
  }

  // foo.rar + foo.r00 / foo.r01 (RAR 2/3 style)
  m = /^(.*)\.r(\d{2,})$/i.exec(base)
  if (m) {
    const stem = m[1]
    return rarOldSet(dir, stem, p)
  }
  if (/\.rar$/i.test(base)) {
    const stem = base.slice(0, -4)
    const names = await siblings(dir)
    const re = new RegExp(`^${escapeRe(stem)}\\.r\\d{2,}$`, 'i')
    if (names.some(n => re.test(n))) return rarOldSet(dir, stem, p, names)
    return NOT_A_SET(p)
  }

  // foo.zip + foo.z01 (spanned zip; the .zip is the LAST volume but the one to open)
  m = /^(.*)\.z(\d{2,})$/i.exec(base)
  if (m) return zipSpanSet(dir, m[1], p)
  if (/\.zip$/i.test(base)) {
    const stem = base.slice(0, -4)
    const names = await siblings(dir)
    const re = new RegExp(`^${escapeRe(stem)}\\.z\\d{2,}$`, 'i')
    if (names.some(n => re.test(n))) return zipSpanSet(dir, stem, p, names)
    return NOT_A_SET(p)
  }

  // foo.7z.001 / foo.tar.002 / anything.NNN  (7-Zip split volumes)
  m = /^(.*)\.(\d{3,})$/.exec(base)
  if (m) {
    const stem = m[1]
    const re = new RegExp(`^${escapeRe(stem)}\\.(\\d{3,})$`)
    const found = (await siblings(dir)).filter(n => re.test(n))
      .sort((a, b) => numOf(re.exec(a)![1]) - numOf(re.exec(b)![1]))
    if (found.length) {
      const members = found.map(n => path.join(dir, n))
      return { isVolume: found.length > 1, primary: members[0], members, isPrimary: members[0] === p }
    }
  }
  return NOT_A_SET(p)
}

async function rarOldSet(dir: string, stem: string, p: string, names?: string[]): Promise<VolumeInfo> {
  const all = names ?? await siblings(dir)
  const re = new RegExp(`^${escapeRe(stem)}\\.r(\\d{2,})$`, 'i')
  const parts = all.filter(n => re.test(n)).sort((a, b) => numOf(re.exec(a)![1]) - numOf(re.exec(b)![1]))
  const head = all.find(n => n.toLowerCase() === `${stem.toLowerCase()}.rar`)
  if (!head && parts.length < 2) return NOT_A_SET(p)
  const members = [...(head ? [path.join(dir, head)] : []), ...parts.map(n => path.join(dir, n))]
  const primary = members[0]
  return { isVolume: members.length > 1, primary, members, isPrimary: primary === p }
}

async function zipSpanSet(dir: string, stem: string, p: string, names?: string[]): Promise<VolumeInfo> {
  const all = names ?? await siblings(dir)
  const re = new RegExp(`^${escapeRe(stem)}\\.z(\\d{2,})$`, 'i')
  const parts = all.filter(n => re.test(n)).sort((a, b) => numOf(re.exec(a)![1]) - numOf(re.exec(b)![1]))
  const head = all.find(n => n.toLowerCase() === `${stem.toLowerCase()}.zip`)
  if (!head) return NOT_A_SET(p)
  const members = [path.join(dir, head), ...parts.map(n => path.join(dir, n))]
  return { isVolume: members.length > 1, primary: members[0], members, isPrimary: members[0] === p }
}

/** Cheap, name-only test — no filesystem access. For UI badges/grouping. */
export function looksLikeVolume(name: string): boolean {
  return /\.part\d+\.rar$/i.test(name) || /\.r\d{2,}$/i.test(name)
    || /\.z\d{2,}$/i.test(name) || /\.\d{3,}$/.test(name)
}

/** Extensions LiqExplorer treats as archives (7-Zip 23.01 handles all of these). */
export const ARCHIVE_EXTS = new Set([
  '7z', 'zip', 'rar', 'tar', 'gz', 'tgz', 'bz2', 'tbz', 'tbz2', 'xz', 'txz', 'lzma',
  'zst', 'cab', 'iso', 'lzh', 'lha', 'arj', 'wim', 'dmg', 'cpio', 'rpm', 'deb', 'jar',
  'war', 'apk', 'xpi', 'epub', 'chm', 'msi', 'vhd', 'vhdx', 'squashfs', 'z',
])

export function isArchiveName(name: string): boolean {
  const i = name.lastIndexOf('.')
  if (i < 0) return looksLikeVolume(name)
  return ARCHIVE_EXTS.has(name.slice(i + 1).toLowerCase()) || looksLikeVolume(name)
}
