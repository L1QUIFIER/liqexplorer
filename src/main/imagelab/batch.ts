// Batch mode — looking for better copies of many pictures, and knowing when to stop.
//
// The whole reason this module exists separately from `better.ts` is the stop rule, and the stop
// rule exists because of one measured night: the SOCKS proxies stopped listening mid-run, every
// fetch failed identically, the downloader could not tell that from a 404, and it walked the rest
// of the queue at 25 items a minute, marked **5,132 images failed**, ran off the end and reported
// the job DONE. Nothing was wrong with any of those images.
//
// So a batch here does three things a loop would not:
//
//   * It carries ONE OutageDetector across the whole run. A single transport error is not evidence
//     — a proxy that cannot reach one CDN is ordinary. Several, across different hosts, with no
//     success in between, is the route being gone. The detector is what tells those apart, and it
//     has to span files because `findBetter` already bails after the first one within a file.
//   * It stops on a captcha instead of paging deeper into the block, because a captcha renders as
//     an ordinary layout with no images and is otherwise indistinguishable from "found nothing".
//   * It NEVER writes anything. A scan produces a plan; applying it is a separate, explicit call
//     with the rows the user actually approved.
//
// It is strictly sequential. Yandex counts per IP and cannot see windows or tabs, so parallelism
// would multiply the request rate while looking perfectly reasonable from inside the app — and the
// pacing queue in cbir.ts would serialise it anyway.
import { ipcMain } from 'electron'
import * as path from 'node:path'
import { CH, PUSH } from '../../shared/ipc'
import { broadcast } from '../windows'
import type { BatchProgress, BatchRow, BatchStop, Candidate } from '../../shared/imagelab'
import { findBetter } from './better'
import { inspectImage } from './inspect'
import { saveBetter } from './replace'
import { makeOutageDetector, observeCandidates } from './transport'

/** one run at a time: two concurrent scans would double the request rate against one rate limit */
let active: { runId: number; cancelled: boolean } | null = null
let nextRunId = 1

function emit(p: BatchProgress): void {
  broadcast(PUSH.imageBatch, p)
}

/** a row for a picture nothing has been done to yet */
async function baseRow(file: string): Promise<BatchRow> {
  const f = await inspectImage(file)
  return {
    file,
    name: f.name || path.basename(file),
    ext: f.ext,
    bytes: f.bytes,
    width: f.width,
    height: f.height,
    area: f.area,
    state: 'waiting',
    best: null,
    gain: 0,
    looked: 0,
    error: f.error,
  }
}

/**
 * Look for a better copy of every picture in `files`, reporting as it goes.
 *
 * Returns the finished plan. Nothing is written; `applyBatch` does that, and only for the rows the
 * user ticked.
 */
export async function scanBatch(files: string[]): Promise<{ runId: number; rows: BatchRow[]; stopped?: BatchStop }> {
  const runId = nextRunId++
  active = { runId, cancelled: false }
  const me = active

  // The thresholds are the ported defaults: a proxy-refused error involves no remote party at all,
  // so 3 in a row is conclusive; a host-unreachable error is the proxy talking about somewhere
  // else, so it needs 6 and at least 2 distinct hosts. One dead CDN is not an outage.
  const outage = makeOutageDetector()

  const rows: BatchRow[] = []
  for (const f of files) rows.push(await baseRow(f))

  // the whole plan, before any work: 40 pictures should look like 40 pictures immediately
  emit({ runId, done: 0, total: rows.length, rows })

  let stopped: BatchStop | undefined
  let done = 0

  for (const row of rows) {
    if (me.cancelled) { stopped = 'cancelled'; break }

    // a picture that could not even be measured has nothing to compare a candidate against
    if (row.error || !row.area) {
      row.state = 'error'
      row.error = row.error ?? 'This picture could not be measured.'
      emit({ runId, done: ++done, total: rows.length, row })
      continue
    }

    row.state = 'looking'
    emit({ runId, done, total: rows.length, row })

    const res = await findBetter(row.file, undefined, undefined, true)
    if (me.cancelled) { stopped = 'cancelled'; break }

    row.looked = res.tried.length

    // Feed the detector BEFORE deciding what this row means. Every candidate that never left the
    // machine is one piece of evidence, tagged with the host it was aimed at — the host count is
    // what stops one unreachable CDN from reading as a dead tunnel.
    const outageNow = observeCandidates(outage, res.tried as Candidate[])

    if (res.captcha) {
      row.state = 'stopped'
      emit({ runId, done, total: rows.length, row })
      stopped = 'captcha'
      break
    }
    if (outageNow) {
      // The detector has spoken: going on would mark the rest of the list bad for a reason that has
      // nothing to do with those pictures. That is the 5,132-image failure, exactly.
      row.state = 'stopped'
      row.error = res.error
      emit({ runId, done, total: rows.length, row })
      stopped = 'transport'
      break
    }
    if (res.transportDown) {
      // ONE file that could not get a request out is not an outage — one unreachable CDN is
      // ordinary, and stopping on it would abandon a run that is otherwise working. But it must not
      // be reported as "nothing better found" either: nothing was ever looked at.
      row.state = 'error'
      row.error = res.error ?? 'nothing could be reached for this picture'
      emit({ runId, done: ++done, total: rows.length, row })
      continue
    }

    if (res.best) {
      row.state = 'found'
      row.best = res.best
      row.gain = (res.best.width * res.best.height) / (row.area || 1)
    } else {
      row.state = 'nothing'
      row.error = res.error
    }
    emit({ runId, done: ++done, total: rows.length, row })
  }

  // whatever was never reached says so, rather than looking like "checked, nothing found"
  if (stopped) for (const r of rows) if (r.state === 'waiting' || r.state === 'looking') r.state = 'stopped'

  emit({ runId, done, total: rows.length, finished: true, stopped, rows })
  if (active === me) active = null
  return { runId, rows, stopped }
}

/**
 * Write the approved copies.
 *
 * Still nothing destructive: each one lands beside its original as "name (better).jpg", exactly as
 * the single-picture path does.
 */
export async function applyBatch(rows: { file: string; best: Candidate }[]): Promise<{
  saved: { file: string; saved: string }[]
  failed: { file: string; error: string }[]
}> {
  const runId = nextRunId++
  const saved: { file: string; saved: string }[] = []
  const failed: { file: string; error: string }[] = []
  let done = 0
  for (const r of rows) {
    const out = await saveBetter(r.file, r.best)
    done++
    if (out.ok && out.file) {
      saved.push({ file: r.file, saved: out.file })
      broadcast(PUSH.imageBatchApply, { runId, done, total: rows.length, file: r.file, saved: out.file })
    } else {
      failed.push({ file: r.file, error: out.error ?? 'could not be saved' })
      broadcast(PUSH.imageBatchApply, { runId, done, total: rows.length, file: r.file, error: out.error })
    }
  }
  broadcast(PUSH.imageBatchApply, { runId, done, total: rows.length, finished: true })
  return { saved, failed }
}

ipcMain.handle(CH('imageBatchScan'), (_e, files: string[]) => {
  if (active) return Promise.resolve({ runId: 0, rows: [], busy: true })
  return scanBatch(Array.isArray(files) ? files.filter(f => typeof f === 'string' && f.startsWith('/')) : [])
})

ipcMain.handle(CH('imageBatchCancel'), () => {
  if (active) active.cancelled = true
  return { ok: true }
})

ipcMain.handle(CH('imageBatchApply'), (_e, rows: { file: string; best: Candidate }[]) =>
  applyBatch(Array.isArray(rows) ? rows.filter(r => r?.file && r?.best?.url) : []))
