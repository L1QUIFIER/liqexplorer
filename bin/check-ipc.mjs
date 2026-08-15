// Catch the silent failure this codebase's IPC pattern invites.
//
// Main-process modules self-register their handlers with
// `ipcMain.handle(CH('name'))` so nobody has to edit ipc.ts. The catch: a
// module that nothing imports never runs, so its handlers never register — and
// because the preload is a generic passthrough, the renderer's call fails only
// at the moment a user clicks the thing. Both the duplicate finder and Send to
// shipped that way today and looked completely fine until they were used.
//
// So: every verb the renderer invokes must be registered SOMEWHERE in main, and
// the module registering it must be reachable from main/index.ts.
//
// A warning, not an error: it should never block a build over a false positive
// (a verb built from a variable, say), only make the real thing impossible to
// miss.
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'

const ROOT = resolve(dirname(new URL(import.meta.url).pathname), '..')

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) walk(p, out)
    else if (p.endsWith('.ts')) out.push(p)
  }
  return out
}

const files = walk(join(ROOT, 'src'))
const read = (f) => readFileSync(f, 'utf8')

// verbs the renderer asks for
const called = new Map()          // verb -> first file that calls it
for (const f of files.filter(f => f.includes('/renderer/'))) {
  const src = read(f)
  // Optional chaining is not optional here. media/*.ts reaches the bridge as
  // `window.liq?.invoke?.('verb')` because those modules also run in the pop-out
  // window, which never boots core/app and so has no imported `liq`. A pattern
  // matching only `liq.invoke('verb')` silently ignored every one of them — the
  // guard reported "all registered" while a whole feature's IPC was unchecked.
  for (const m of src.matchAll(/\bliq\??\.invoke\??\.?\(\s*'([A-Za-z0-9_]+)'/g)) {
    if (!called.has(m[1])) called.set(m[1], f)
  }
}

// verbs main registers, and the file that does it
const handled = new Map()         // verb -> file
for (const f of files.filter(f => f.includes('/main/'))) {
  const src = read(f)
  for (const m of src.matchAll(/ipcMain\.handle\(\s*CH\(\s*'([A-Za-z0-9_]+)'/g)) {
    handled.set(m[1], f)
  }
  // several modules wrap it as a local `handle('verb', fn)` that swallows a
  // duplicate registration; those count exactly the same
  if (/function handle\(\s*method: string/.test(src)) {
    for (const m of src.matchAll(/^\s*handle\(\s*'([A-Za-z0-9_]+)'/gm)) handled.set(m[1], f)
  }
  // ipc.ts registers a whole object of verbs at once
  if (f.endsWith('/ipc.ts')) {
    for (const m of src.matchAll(/^\s{2}([A-Za-z0-9_]+)\s*:\s*(?:\(|async)/gm)) handled.set(m[1], f)
  }
}

// which main files are reachable from index.ts (one hop is enough: side-effect
// imports are what this is about, and they are all listed there directly)
const reachable = new Set()
const seen = new Set()
function follow(file) {
  if (seen.has(file)) return
  seen.add(file)
  reachable.add(file)
  let src
  try { src = read(file) } catch { return }
  for (const m of src.matchAll(/from\s+'(\.[^']+)'|import\s+'(\.[^']+)'/g)) {
    const rel = m[1] ?? m[2]
    const base = resolve(dirname(file), rel)
    for (const cand of [base + '.ts', join(base, 'index.ts')]) {
      try { statSync(cand); follow(cand); break } catch { /* not this one */ }
    }
  }
}
follow(join(ROOT, 'src/main/index.ts'))

const problems = []
for (const [verb, caller] of called) {
  const where = handled.get(verb)
  const rel = (p) => p.slice(ROOT.length + 1)
  if (!where) {
    problems.push(`  ${verb}: called in ${rel(caller)}, but no ipcMain.handle registers it`)
  } else if (!reachable.has(where)) {
    problems.push(`  ${verb}: registered in ${rel(where)}, but nothing imports that file — `
      + `add an import to src/main/index.ts or the handler never runs`)
  }
}

if (problems.length) {
  console.error('\n[33mIPC CHECK — these calls will fail at runtime:[0m')
  for (const p of problems) console.error(p)
  console.error('')
} else {
  console.log(`ipc check: ${called.size} renderer verbs, all registered and reachable`)
}
