// "What is using all the space?" — recursive folder sizes.
//
// The app could size a FILE and never a FOLDER, which on a media library
// spanning hundreds of gigabytes is the question you actually have. Explorer
// answers it in Properties; this answers it for every child at once and ranks
// them, because the useful form of the question is "which of these is the big
// one", not "how big is this one I already suspected".
//
// Sizes are APPARENT size (st.size), not blocks on disk. Two reasons: it is
// what every other size in this app means, so the numbers agree with the
// listing; and st.blocks over a CIFS mount describes the server's allocation,
// which is not the thing the user is trying to reclaim.
//
// Hard links are counted once (treewalk.ts collapses them by dev+ino), so a
// tree of linked media does not report space that freeing it would not return.
import { ipcMain } from 'electron'
import type { IpcMainInvokeEvent, WebContents } from 'electron'
import * as path from 'node:path'
import { CH } from '../../shared/ipc'
import { USAGE_PUSH, USAGE_TOP_FILES, type UsageProgress, type UsageResult, type UsageRow } from '../../shared/diskusage'
import { walkTree } from './treewalk'

let nextId = 1
const cancelled = new Set<number>()

function send(wc: WebContents, msg: UsageProgress): void {
  if (!wc.isDestroyed()) wc.send(USAGE_PUSH, msg)
}

export async function scanUsage(wc: WebContents, root: string): Promise<UsageResult> {
  const empty: UsageResult = {
    ok: false, root, children: [], biggest: [], totalBytes: 0, totalFiles: 0, problems: [],
  }
  if (!root || !root.startsWith('/')) return { ...empty, error: 'Not a folder on this computer.' }

  const scanId = nextId++
  const base = root.endsWith('/') ? root.slice(0, -1) : root
  /** bytes and file counts per IMMEDIATE child of root */
  const childBytes = new Map<string, number>()
  const childFiles = new Map<string, number>()
  const childIsDir = new Map<string, boolean>()
  /** a bounded max-list; keeping every file in memory is what makes this tool
   *  unusable on the tree it is most needed for */
  const biggest: UsageRow[] = []
  const problems: string[] = []
  let totalBytes = 0
  let totalFiles = 0
  let dirs = 0
  let current = base
  let lastPush = 0

  const push = (force = false): void => {
    const now = Date.now()
    if (!force && now - lastPush < 120) return
    lastPush = now
    send(wc, { scanId, dirs, files: totalFiles, bytes: totalBytes, current })
  }

  /** which immediate child of root this path belongs to */
  const bucketFor = (p: string): string => {
    if (!p.startsWith(base + '/')) return base
    const rest = p.slice(base.length + 1)
    const slash = rest.indexOf('/')
    return slash < 0 ? p : path.join(base, rest.slice(0, slash))
  }

  await walkTree([base], {
    cancelled: () => cancelled.has(scanId),
    onDir: (dir) => { dirs++; current = dir; push() },
    onProblem: (dir, why) => { if (problems.length < 50) problems.push(`${dir} — ${why}`) },
    onFile: (f) => {
      const size = f.stat.size
      totalBytes += size
      totalFiles++
      const bucket = bucketFor(f.path)
      childBytes.set(bucket, (childBytes.get(bucket) ?? 0) + size)
      childFiles.set(bucket, (childFiles.get(bucket) ?? 0) + 1)
      if (!childIsDir.has(bucket)) childIsDir.set(bucket, bucket !== f.path)

      // keep the top N by size without sorting the whole tree
      if (biggest.length < USAGE_TOP_FILES) {
        biggest.push({ path: f.path, name: f.name, isDir: false, bytes: size, files: 1, share: 0 })
        if (biggest.length === USAGE_TOP_FILES) biggest.sort((a, b) => b.bytes - a.bytes)
      } else if (size > biggest[biggest.length - 1].bytes) {
        biggest[biggest.length - 1] = { path: f.path, name: f.name, isDir: false, bytes: size, files: 1, share: 0 }
        biggest.sort((a, b) => b.bytes - a.bytes)
      }
      push()
    },
  })

  const wasCancelled = cancelled.has(scanId)
  cancelled.delete(scanId)
  send(wc, { scanId, dirs, files: totalFiles, bytes: totalBytes, current: '', done: true })

  const children: UsageRow[] = [...childBytes.entries()].map(([p, bytes]) => ({
    path: p,
    name: path.basename(p) || p,
    isDir: childIsDir.get(p) ?? true,
    bytes,
    files: childFiles.get(p) ?? 0,
    share: totalBytes ? bytes / totalBytes : 0,
  })).sort((a, b) => b.bytes - a.bytes)

  biggest.sort((a, b) => b.bytes - a.bytes)
  for (const b of biggest) b.share = totalBytes ? b.bytes / totalBytes : 0

  return {
    ok: true, root: base, children, biggest: biggest.slice(0, USAGE_TOP_FILES),
    totalBytes, totalFiles, problems, cancelled: wasCancelled || undefined,
  }
}

ipcMain.handle(CH('scanUsage'), (e: IpcMainInvokeEvent, root: string) => scanUsage(e.sender, root))
ipcMain.handle(CH('cancelUsage'), (_e, id: number) => { cancelled.add(id) })
