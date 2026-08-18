// "Which of these will actually play?"
//
// The app already knows: media/render.ts decides per file whether Chromium can
// decode it and whether ffmpeg would have to convert it first, and the viewer
// uses that decision every time it opens something. But the knowledge was only
// ever applied one file at a time, at the moment you tried to watch it — so a
// library's worth of problems could only be discovered by opening a library's
// worth of files.
//
// This asks the same question of a whole folder and returns the answer as a
// list. The three outcomes are the ones the viewer already distinguishes:
//
//   plays     Chromium has the codecs and the container
//   converts  ffmpeg can stream it, but it has to be transcoded first
//   fails     nothing here can show it
//
// ffprobe is asked ONCE per file and only for the files whose extension makes
// them worth asking about, because probing a folder of JPEGs would spawn a
// process per picture for no answer.
import { ipcMain } from 'electron'
import { spawn } from 'node:child_process'
import * as path from 'node:path'
import { CH } from '../../shared/ipc'
import type { HealthResult, HealthRow } from '../../shared/mediahealth'
import { walkTree } from './treewalk'
import { resolveTools } from './tools'

/** containers Chromium can demux; anything else needs remuxing at least */
const NATIVE_CONTAINERS = new Set(['mp4', 'm4v', 'mov', 'webm', 'mkv', 'ogg', 'ogv', 'mp3', 'm4a', 'wav', 'flac', 'opus', 'oga', 'aac'])
/** video/audio codecs Chromium ships (measured against this Electron build) */
const NATIVE_VIDEO = new Set(['h264', 'vp8', 'vp9', 'av1', 'theora'])
const NATIVE_AUDIO = new Set(['aac', 'mp3', 'opus', 'vorbis', 'flac', 'pcm_s16le', 'pcm_s24le', 'pcm_u8'])

/**
 * Hard cap on files examined in one run.
 *
 * Only the DIRECTORY count was capped, which bounded the walk but not the
 * memory: a media library with a hundred thousand clips in four thousand
 * folders collected a hundred thousand paths and then ran ffprobe on every one
 * of them. Both the list and the running time have to be bounded, and the
 * result says when the cap was reached rather than presenting a partial answer
 * as a complete one.
 */
const MAX_FILES = 5000

const MEDIA_EXT = new Set([
  'mp4', 'm4v', 'mkv', 'avi', 'mov', 'wmv', 'flv', 'webm', 'mpg', 'mpeg', 'm2ts', 'ts', 'vob', '3gp', 'ogv',
  'mp3', 'flac', 'wav', 'm4a', 'aac', 'ogg', 'oga', 'opus', 'wma',
])

interface Probe { video: string; audio: string; container: string; seconds: number }

function probe(file: string): Promise<Probe | null> {
  const ffprobe = resolveTools().ffprobe
  if (!ffprobe) return Promise.resolve(null)
  return new Promise(resolve => {
    let done = false
    const finish = (v: Probe | null): void => { if (!done) { done = true; resolve(v) } }
    try {
      const c = spawn(ffprobe, [
        '-v', 'error',
        '-show_entries', 'stream=codec_type,codec_name:format=format_name,duration',
        '-of', 'default=nw=1', '--', file,
      ], { stdio: ['ignore', 'pipe', 'ignore'] })
      let out = ''
      c.stdout.on('data', d => { out += String(d) })
      const t = setTimeout(() => { try { c.kill('SIGKILL') } catch { /* gone */ } finish(null) }, 15_000)
      c.on('error', () => { clearTimeout(t); finish(null) })
      c.on('close', () => {
        clearTimeout(t)
        // codec_name lines arrive in stream order, paired with codec_type
        const names = [...out.matchAll(/^codec_name=(.+)$/gm)].map(m => m[1])
        const types = [...out.matchAll(/^codec_type=(.+)$/gm)].map(m => m[1])
        let video = ''
        let audio = ''
        for (let i = 0; i < types.length; i++) {
          if (types[i] === 'video' && !video) video = names[i] ?? ''
          if (types[i] === 'audio' && !audio) audio = names[i] ?? ''
        }
        finish({
          video, audio,
          container: /^format_name=(.+)$/m.exec(out)?.[1] ?? '',
          seconds: Number(/^duration=(.+)$/m.exec(out)?.[1] ?? 0) || 0,
        })
      })
    } catch { finish(null) }
  })
}

function verdict(file: string, p: Probe | null): HealthRow {
  const ext = path.extname(file).replace(/^\./, '').toLowerCase()
  const name = path.basename(file)
  if (!p) {
    return { path: file, name, state: 'fails', why: 'ffprobe could not read it', video: '', audio: '', seconds: 0 }
  }
  // A file ffprobe READ but found nothing in.
  //
  // ffprobe exits 0 on a truncated or garbage file — it prints "moov atom not
  // found" to stderr and returns success — so `p` arrives as a perfectly
  // ordinary Probe with empty codecs. The checks below then read an empty
  // video codec as "no video stream, which is fine" and take the container
  // from the file EXTENSION, so 4 KB of random bytes named .mp4 was reported
  // as "plays". A measurement that came back empty is not a pass; it is the
  // strongest evidence there is that the file is broken, and this tool exists
  // to find exactly that.
  if (!p.video && !p.audio) {
    return {
      path: file, name, state: 'fails',
      why: 'no audio or video stream — truncated, or not really a media file',
      video: '', audio: '', seconds: 0,
    }
  }
  const containerOK = NATIVE_CONTAINERS.has(ext)
  const videoOK = !p.video || NATIVE_VIDEO.has(p.video)
  const audioOK = !p.audio || NATIVE_AUDIO.has(p.audio)

  if (containerOK && videoOK && audioOK) {
    return { path: file, name, state: 'plays', why: '', video: p.video, audio: p.audio, seconds: p.seconds }
  }
  const reasons: string[] = []
  if (!containerOK) reasons.push(`${ext.toUpperCase()} container`)
  if (!videoOK) reasons.push(`${p.video} video`)
  if (!audioOK) reasons.push(`${p.audio} audio`)
  // ffmpeg is present, so anything it can read can at least be streamed
  const state = resolveTools().ffmpeg ? 'converts' : 'fails'
  return {
    path: file, name, state,
    why: reasons.join(' + ') + (state === 'converts' ? ' — converted on the fly' : ' — and ffmpeg is not installed'),
    video: p.video, audio: p.audio, seconds: p.seconds,
  }
}

export async function scanMediaHealth(root: string): Promise<HealthResult> {
  const empty: HealthResult = { ok: false, root, rows: [], plays: 0, converts: 0, fails: 0, scanned: 0 }
  if (!root || !root.startsWith('/')) return { ...empty, error: 'Not a folder on this computer.' }
  if (!resolveTools().ffprobe) return { ...empty, error: 'This needs ffprobe, which is not installed.' }

  const files: string[] = []
  await walkTree([root], {
    onFile: (f) => {
      const ext = path.extname(f.name).replace(/^\./, '').toLowerCase()
      if (files.length < MAX_FILES && MEDIA_EXT.has(ext)) files.push(f.path)
    },
    maxDirs: 4000,
  })

  const rows: HealthRow[] = []
  // four at a time: one ffprobe per file is cheap, four hundred at once is not
  for (let i = 0; i < files.length; i += 4) {
    const slice = files.slice(i, i + 4)
    const probes = await Promise.all(slice.map(probe))
    slice.forEach((f, k) => rows.push(verdict(f, probes[k])))
  }

  // problems first: a report you have to scroll to find the bad news in is a
  // report that gets closed before you find it
  const rank = { fails: 0, converts: 1, plays: 2 } as const
  rows.sort((a, b) => rank[a.state] - rank[b.state] || a.name.localeCompare(b.name))
  return {
    ok: true, root, rows,
    plays: rows.filter(r => r.state === 'plays').length,
    converts: rows.filter(r => r.state === 'converts').length,
    fails: rows.filter(r => r.state === 'fails').length,
    scanned: rows.length,
    truncated: rows.length >= MAX_FILES || undefined,
  }
}

ipcMain.handle(CH('mediaHealth'), (_e, root: string) => scanMediaHealth(root))
