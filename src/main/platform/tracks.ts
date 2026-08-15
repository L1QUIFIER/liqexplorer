// Enumerate a file's audio and subtitle tracks, and turn a text subtitle track
// into WebVTT that a <track> element can use.
//
// Both halves are ffprobe/ffmpeg calls that must never wedge the app, so both
// go through the same deadline-and-SIGKILL discipline as the rest of the media
// code. Extraction is capped as well as timed: a subtitle track is normally
// tens of kilobytes, and something claiming to be one that keeps producing
// megabytes is a reason to stop, not to keep reading.
import { ipcMain } from 'electron'
import { spawn, type ChildProcess } from 'node:child_process'
import * as fsp from 'node:fs/promises'
import { CH } from '../../shared/ipc'
import { probeStreams } from './mediainfo'
import {
  BITMAP_SUB_CODECS, TEXT_SUB_CODECS,
  type AudioTrack, type MediaTracks, type SubTrack,
} from '../../shared/tracks'

/** extracting a whole subtitle track means reading the container through; on a
 *  4 GB remote file that is not instant, but it is bounded */
const EXTRACT_MS = 45_000
/** a text subtitle track for a feature film is ~100 KB */
const MAX_VTT_BYTES = 4 * 1024 * 1024

interface Stream {
  index?: number
  codec_name?: string
  codec_type?: string
  channels?: number
  tags?: Record<string, string>
  disposition?: Record<string, number>
}

function run(bin: string, args: string[], ms: number, capOut: number): Promise<{ code: number | null; out: string; timedOut: boolean }> {
  return new Promise(resolve => {
    let child: ChildProcess
    try {
      child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    } catch {
      resolve({ code: -1, out: '', timedOut: false })
      return
    }
    let out = ''
    let capped = false
    let timedOut = false
    child.stdout?.setEncoding('utf8')
    child.stdout?.on('data', (d: string) => {
      if (out.length >= capOut) {
        // stop the child rather than just ignoring the rest: a runaway producer
        // would otherwise keep the CPU busy until its deadline
        if (!capped) { capped = true; try { child.kill('SIGKILL') } catch { /* gone */ } }
        return
      }
      out += d
    })
    // drained, never read: an undrained stderr pipe deadlocks a chatty ffmpeg
    child.stderr?.resume()
    child.stdout?.on('error', () => {})
    child.stderr?.on('error', () => {})
    const timer = setTimeout(() => { timedOut = true; try { child.kill('SIGKILL') } catch { /* gone */ } }, ms)
    let settled = false
    const finish = (code: number | null): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ code, out, timedOut })
    }
    child.on('error', () => finish(-1))
    child.on('close', (code) => finish(code))
  })
}

const cache = new Map<string, MediaTracks>()
const MAX_CACHE = 500

/** path+mtime+size, the same identity the rest of the media code uses */
async function key(p: string): Promise<string | null> {
  try {
    const st = await fsp.stat(p)
    if (!st.isFile()) return null
    return `${p}\0${st.mtimeMs}\0${st.size}`
  } catch { return null }
}

export async function mediaTracks(p: string): Promise<MediaTracks> {
  const empty: MediaTracks = { audio: [], subs: [] }
  if (!p.startsWith('/')) return empty
  const k = await key(p)
  if (!k) return empty
  const hit = cache.get(k)
  if (hit) return hit

  // the SHARED probe: opening a video used to spawn one ffprobe here and another
  // in streamInfo, for an answer that cannot differ between the two
  const data = await probeStreams(p)
  const out: MediaTracks = { audio: [], subs: [] }
  try {
    const streams = (data?.streams ?? []) as Stream[]
    let a = 0
    let s = 0
    for (const st of streams) {
      const tags = st.tags ?? {}
      const lang = String(tags.language ?? tags.LANGUAGE ?? '')
      const title = String(tags.title ?? tags.TITLE ?? '')
      const isDefault = st.disposition?.default === 1
      if (st.codec_type === 'audio') {
        out.audio.push({
          n: a++, codec: String(st.codec_name ?? ''), channels: Number(st.channels) || 0,
          lang, title, isDefault,
        } satisfies AudioTrack)
      } else if (st.codec_type === 'subtitle') {
        const codec = String(st.codec_name ?? '')
        out.subs.push({
          n: s++, codec, lang, title, isDefault,
          // unknown codecs are treated as NOT text: offering one and failing is
          // worse than not offering it, and the list still shows it exists
          textBased: TEXT_SUB_CODECS.has(codec) && !BITMAP_SUB_CODECS.has(codec),
        } satisfies SubTrack)
      }
    }
  } catch { /* not a media file: an empty answer is the right answer */ }

  if (cache.size >= MAX_CACHE) cache.clear()
  cache.set(k, out)
  return out
}

/**
 * Extract subtitle track `n` as WebVTT.
 *
 * Returns '' rather than throwing for everything that can go wrong — a missing
 * track, a bitmap track asked for by mistake, a timeout — because the caller is
 * a subtitle menu, and a subtitle that fails to load must never take the video
 * down with it.
 */
export async function subtitleVtt(p: string, n: number): Promise<string> {
  if (!p.startsWith('/') || !Number.isInteger(n) || n < 0) return ''
  const tracks = await mediaTracks(p)
  const track = tracks.subs.find(t => t.n === n)
  // refuse bitmap tracks HERE rather than letting ffmpeg refuse them: the error
  // is identical either way, but this costs no process
  if (!track || !track.textBased) return ''

  const r = await run('ffmpeg',
    ['-v', 'error', '-i', p, '-map', `0:s:${n}`, '-f', 'webvtt', '-'], EXTRACT_MS, MAX_VTT_BYTES)
  if (r.timedOut) return ''
  const out = r.out.trim()
  // a WebVTT file must start with the magic; anything else is ffmpeg noise
  if (!out.startsWith('WEBVTT')) return ''
  return out
}

ipcMain.handle(CH('mediaTracks'), (_e, p: string) => mediaTracks(p))
ipcMain.handle(CH('subtitleVtt'), (_e, p: string, n: number) => subtitleVtt(p, n))
