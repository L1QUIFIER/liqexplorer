// Play the things Chromium cannot: MPEG-2 DVD rips, HEVC, AC3 soundtracks,
// H.264 trapped inside an AVI.
//
// ffmpeg transcodes into FRAGMENTED MP4 on stdout, and the bytes go straight to
// a <video> element through the liqplay:// protocol. Fragmented is what makes
// this feel instant: an ordinary MP4 puts its index at the END, so nothing can
// play until the whole file exists, whereas frag_keyframe+empty_moov emits a
// playable header immediately and self-describing fragments after it. Measured
// on a 711 MB MPEG-2 + AC3 rip off the share, seeking to 5:00 and encoding with
// NVENC: 161-245 ms to the first byte, running about 40x faster than realtime.
//
// SEEKING IS A RESTART. A transcode has no byte index, so there is nothing for
// a Range request to address. Instead the renderer asks for a new stream with a
// new `t=`, and ffmpeg's own input seek (-ss BEFORE -i, which seeks by index
// rather than decoding up to the point) starts there. The renderer presents one
// continuous timeline over the top; see media/transcoded.ts.
//
// THROTTLING IS NOT NEEDED, and that is worth stating because it looks missing.
// ffmpeg runs far ahead of playback, but the pipe gives us backpressure for
// free: Chromium reads at its own pace, the pipe buffer fills, and ffmpeg
// blocks on write. The one requirement is that this file must never read ahead
// into a buffer of its own, which is why the ReadableStream below pulls one
// chunk per pull() and pauses stdout between them.
import { protocol } from 'electron'
import { spawn, type ChildProcess } from 'node:child_process'
import { decidePlay, type PlayMode, type StreamInfo } from '../../shared/playplan'
import { streamInfo } from './mediainfo'
import { holdThumbnails } from './protocols'

/** at most this many transcodes at once; a third request kills the oldest */
const MAX_JOBS = 2
/** an ffmpeg that has produced nothing for this long is wedged (dead mount) */
const STALL_MS = 30_000
/** cap for inline surfaces — the preview pane and hover previews are small, and
 *  encoding a 4K source at full size to show it in a 320px box is pure waste */
const INLINE_HEIGHT = 720

interface Job {
  child: ChildProcess
  path: string
  started: number
}

const jobs = new Set<Job>()

function killJob(job: Job): void {
  jobs.delete(job)
  try { job.child.kill('SIGKILL') } catch { /* already gone */ }
}

/** Kill everything. Called on quit so no ffmpeg outlives the app. */
export function stopAllTranscodes(): void {
  for (const job of [...jobs]) killJob(job)
}

/**
 * ffmpeg arguments for one play mode.
 *
 * `-ss` goes BEFORE `-i` on purpose: input seeking jumps via the container
 * index and costs milliseconds, while output seeking decodes and discards
 * everything up to the seek point, which on a 40-minute file is most of a
 * minute of wasted work per scrub.
 */
export function ffmpegArgs(
  path: string, mode: PlayMode, startSec: number, maxHeight: number, info: StreamInfo, nvenc: boolean,
  /** which audio track to carry, as an index among AUDIO streams. -1 keeps
   *  ffmpeg's own default pick, which is what an unasked-for file should get. */
  audioTrack: number,
  /** where the result goes: a pipe for live playback, or a real file for the
   *  background cache. The two want DIFFERENT muxer flags — fragmented so the
   *  first byte is playable, versus faststart so a finished file opens fast —
   *  which is why this is a parameter rather than post-filtering the arg list. */
  target: { kind: 'stream' } | { kind: 'file'; file: string } = { kind: 'stream' },
): string[] {
  const pre = ['-hide_banner', '-loglevel', 'error']
  if (startSec > 0) pre.push('-ss', String(startSec))
  pre.push('-i', path)

  const out: string[] = []
  // Selecting a track means selecting ALL of them explicitly: the moment -map
  // appears, ffmpeg's automatic stream picking switches off, so the video has
  // to be named too or the output arrives with sound and no picture.
  if (audioTrack >= 0) {
    if (info.vcodec) out.push('-map', '0:v:0')
    out.push('-map', `0:a:${audioTrack}`)
  }
  if (mode === 'remux') {
    out.push('-c', 'copy')
  } else if (mode === 'audio') {
    out.push('-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k', '-ac', '2')
  } else {
    // never upscale: a 480p DVD rip shown in a 720p box should stay 480p
    const targetHeight = info.height > 0 ? Math.min(maxHeight, info.height) : maxHeight
    if (info.height > targetHeight) out.push('-vf', `scale=-2:${targetHeight}`)
    out.push(...(nvenc
      ? ['-c:v', 'h264_nvenc', '-preset', 'p4', '-rc', 'vbr', '-cq', '28', '-maxrate', '6M', '-bufsize', '12M']
      : ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '25', '-maxrate', '6M', '-bufsize', '12M']))
    // yuv420p because NVENC will happily emit 10-bit from a 10-bit source and
    // Chromium's h264 decoder does not take it
    out.push('-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '192k', '-ac', '2')
  }
  // -sn/-dn: a subtitle or data track has no home in this muxer and makes
  // ffmpeg fail outright rather than skip it
  out.push('-sn', '-dn')
  if (target.kind === 'file') {
    return [...pre, ...out, '-f', 'mp4', '-movflags', '+faststart', '-y', target.file]
  }
  return [
    ...pre, ...out,
    '-f', 'mp4',
    '-movflags', 'frag_keyframe+empty_moov+default_base_moof',
    '-frag_duration', '500000',
    'pipe:1',
  ]
}

/** Probed once: whether this machine's ffmpeg can really use the GPU. Presence
 *  in `-encoders` is not proof — a driver mismatch fails only at encode time. */
let nvencOK: boolean | null = null

async function hasNvenc(): Promise<boolean> {
  if (nvencOK !== null) return nvencOK
  nvencOK = await new Promise<boolean>(resolve => {
    let child: ChildProcess
    try {
      child = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error',
        '-f', 'lavfi', '-i', 'testsrc2=size=64x64:rate=1:duration=1',
        '-c:v', 'h264_nvenc', '-f', 'null', '-'], { stdio: 'ignore' })
    } catch { resolve(false); return }
    const timer = setTimeout(() => { try { child.kill('SIGKILL') } catch { /* gone */ } resolve(false) }, 15_000)
    child.on('error', () => { clearTimeout(timer); resolve(false) })
    child.on('exit', (code) => { clearTimeout(timer); resolve(code === 0) })
  })
  return nvencOK
}

interface PlayRequest { path: string; start: number; maxHeight: number; audioTrack: number }

function parse(rawUrl: string): PlayRequest | null {
  let u: URL
  try { u = new URL(rawUrl) } catch { return null }
  const path = u.searchParams.get('path') ?? ''
  if (!path.startsWith('/')) return null
  const start = Math.max(0, Number(u.searchParams.get('t')) || 0)
  const h = Number(u.searchParams.get('h')) || INLINE_HEIGHT
  const rawA = u.searchParams.get('a')
  const a = rawA === null ? -1 : Number(rawA)
  return {
    path, start,
    maxHeight: Math.max(144, Math.min(2160, h)),
    audioTrack: Number.isInteger(a) && a >= 0 ? a : -1,
  }
}

async function handlePlay(rawUrl: string): Promise<Response> {
  const req = parse(rawUrl)
  if (!req) return new Response('bad request', { status: 400 })

  const info = await streamInfo(req.path)
  if (!info) return new Response('not media', { status: 415 })
  const plan = decidePlay(info)
  if (plan.mode === 'none') return new Response(plan.why, { status: 415 })

  // oldest-first, because the newest request is the one the user is waiting on
  while (jobs.size >= MAX_JOBS) {
    const oldest = [...jobs].sort((a, b) => a.started - b.started)[0]
    if (!oldest) break
    killJob(oldest)
  }

  const args = ffmpegArgs(req.path, plan.mode, req.start, req.maxHeight, info, await hasNvenc(), req.audioTrack)
  let child: ChildProcess
  try {
    child = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] })
  } catch {
    return new Response('ffmpeg is not installed', { status: 500 })
  }
  const job: Job = { child, path: req.path, started: Date.now() }
  jobs.add(job)
  // this stream and the grid thumbnailer read the same share; the stream wins
  // for a few seconds while it fills its buffer
  holdThumbnails()

  const stdout = child.stdout!
  stdout.pause()
  // stderr must be drained or a chatty ffmpeg fills the pipe and deadlocks
  child.stderr?.resume()
  child.stderr?.on('error', () => {})

  let stall: NodeJS.Timeout | null = null
  const armStall = (fail: () => void): void => {
    if (stall) clearTimeout(stall)
    stall = setTimeout(() => { killJob(job); fail() }, STALL_MS)
    stall.unref?.()
  }

  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      stdout.on('end', () => { if (stall) clearTimeout(stall); jobs.delete(job); try { controller.close() } catch { /* closed */ } })
      stdout.on('error', () => { if (stall) clearTimeout(stall); killJob(job); try { controller.close() } catch { /* closed */ } })
      child.on('exit', () => { jobs.delete(job) })
    },
    // one chunk per pull, so the only buffer in play is the OS pipe and
    // Chromium's own — ffmpeg blocks on write once they are full
    pull(controller) {
      return new Promise<void>((resolve) => {
        armStall(() => { try { controller.close() } catch { /* closed */ } resolve() })
        const chunk = stdout.read() as Buffer | null
        if (chunk) {
          if (stall) clearTimeout(stall)
          controller.enqueue(new Uint8Array(chunk))
          resolve()
          return
        }
        stdout.once('readable', () => {
          if (stall) clearTimeout(stall)
          const next = stdout.read() as Buffer | null
          if (next) controller.enqueue(new Uint8Array(next))
          resolve()
        })
      })
    },
    // the renderer changed src, seeked, or the element went away
    cancel() { killJob(job) },
  })

  return new Response(body, {
    status: 200,
    headers: {
      'content-type': 'video/mp4',
      // there is no index to range into, and claiming otherwise makes Chromium
      // issue byte requests this stream cannot answer
      'accept-ranges': 'none',
      'cache-control': 'no-store',
      'x-liq-mode': plan.mode,
    },
  })
}

export function registerPlayProtocol(): void {
  protocol.handle('liqplay', (req) =>
    handlePlay(req.url).catch(() => new Response('', { status: 500 })))
}

export const __test = { parse, ffmpegArgs }
