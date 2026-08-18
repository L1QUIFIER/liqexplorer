// Watching the desktop's audio output, so playback can follow it.
//
// THE BROWSER API DOES NOT WORK FOR THIS, which is the reason this file exists.
// `navigator.mediaDevices.devicechange` is the documented way to hear about
// audio devices appearing and disappearing, and it was the first implementation.
// Measured on this machine: it fired ZERO times — not when the default sink
// changed, not when a sink was added, not when one was removed. An element
// therefore stayed bound to whatever device it started on, which is precisely
// the complaint: connect headphones mid-film and every other application moves
// while this one keeps playing to the speakers you walked away from.
//
// PipeWire/PulseAudio reports all of it. `pactl subscribe` is a line-per-event
// stream, and the two lines that matter are:
//
//     Event 'change' on server #…      the DEFAULT output changed
//     Event 'new'/'remove' on sink #…  a device appeared or went away
//
// The server event is the important one and is the half the browser has no
// concept of at all: "I just made these headphones the default" is not a change
// to the device LIST, so nothing in the web platform describes it.
//
// One long-lived child, restarted if it dies, and nothing is polled.
import { ipcMain } from 'electron'
import { spawn, type ChildProcess } from 'node:child_process'
import { CH } from '../../shared/ipc'
import { broadcast } from '../windows'

/** renderers listen on this; declared here rather than in the shared PUSH table
 *  so this feature owns its own channel (same reasoning as shared/pdfexport.ts) */
export const AUDIO_DEFAULT_CHANGED = 'liqpush:audio-default'

/** a burst of events (a Bluetooth connect emits several) collapses into one */
const DEBOUNCE_MS = 400
/** pactl died; do not spin if it is missing entirely */
const RESTART_MS = 5_000

let child: ChildProcess | null = null
let debounce: NodeJS.Timeout | null = null
let restart: NodeJS.Timeout | null = null
let lastDefault = ''

function currentDefault(): Promise<string> {
  return new Promise(resolve => {
    let out = ''
    try {
      const c = spawn('pactl', ['get-default-sink'], { stdio: ['ignore', 'pipe', 'ignore'] })
      c.stdout.on('data', d => { out += String(d) })
      const t = setTimeout(() => { try { c.kill('SIGKILL') } catch { /* gone */ } resolve('') }, 4000)
      c.on('error', () => { clearTimeout(t); resolve('') })
      c.on('close', () => { clearTimeout(t); resolve(out.trim()) })
    } catch { resolve('') }
  })
}

/** the human name of a sink, for a message worth reading */
function describe(sink: string): Promise<string> {
  if (!sink) return Promise.resolve('')
  return new Promise(resolve => {
    let out = ''
    try {
      const c = spawn('pactl', ['list', 'sinks'], { stdio: ['ignore', 'pipe', 'ignore'] })
      c.stdout.on('data', d => { out += String(d) })
      const t = setTimeout(() => { try { c.kill('SIGKILL') } catch { /* gone */ } resolve('') }, 5000)
      c.on('error', () => { clearTimeout(t); resolve('') })
      c.on('close', () => {
        clearTimeout(t)
        // find the block for this sink and read its Description
        const blocks = out.split(/\n(?=Sink #)/)
        for (const b of blocks) {
          if (!b.includes(`Name: ${sink}`)) continue
          resolve(/^\s*Description:\s*(.+)$/m.exec(b)?.[1]?.trim() ?? '')
          return
        }
        resolve('')
      })
    } catch { resolve('') }
  })
}

async function announce(): Promise<void> {
  const sink = await currentDefault()
  // only when it actually moved: pactl emits server events for volume changes
  // too, and a note saying the sound moved when it did not is worse than silence
  if (!sink || sink === lastDefault) return
  const first = !lastDefault
  lastDefault = sink
  const label = await describe(sink)
  broadcast(AUDIO_DEFAULT_CHANGED, { sink, label, initial: first })
}

function watch(): void {
  if (child) return
  try {
    child = spawn('pactl', ['subscribe'], { stdio: ['ignore', 'pipe', 'ignore'] })
  } catch { child = null; return }
  let buf = ''
  child.stdout?.on('data', d => {
    buf = (buf + String(d)).slice(-4000)
    const lines = buf.split('\n')
    buf = lines.pop() ?? ''
    for (const line of lines) {
      // 'server' is the default-output change; sink add/remove covers hardware
      if (!/on (server|sink) /.test(line)) continue
      if (debounce) clearTimeout(debounce)
      debounce = setTimeout(() => { debounce = null; void announce() }, DEBOUNCE_MS)
    }
  })
  const gone = (): void => {
    child = null
    if (restart) return
    restart = setTimeout(() => { restart = null; watch() }, RESTART_MS)
  }
  child.on('error', gone)
  child.on('close', gone)
}

let started = false
export function startAudioWatch(): void {
  if (started) return
  started = true
  void currentDefault().then(s => { lastDefault = s })
  watch()
}

export function stopAudioWatch(): void {
  if (debounce) { clearTimeout(debounce); debounce = null }
  if (restart) { clearTimeout(restart); restart = null }
  try { child?.kill('SIGKILL') } catch { /* already gone */ }
  child = null
}

ipcMain.handle(CH('audioDefaultSink'), async () => {
  const sink = await currentDefault()
  return { sink, label: await describe(sink) }
})
