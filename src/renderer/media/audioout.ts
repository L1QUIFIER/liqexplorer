// Which speakers does the sound come out of?
//
// Chromium binds a media element to an output device WHEN THE ELEMENT STARTS,
// and then keeps it there. Connect Bluetooth headphones halfway through a film
// and the desktop moves its default, every other application follows — and this
// one keeps playing out of the speakers you just walked away from. Nothing in
// the app is wrong, which is why it is so annoying: the fix has to be asked for
// explicitly.
//
// `setSinkId('')` re-binds an element to whatever the default is NOW. That is
// the whole mechanism. The rest of this module is about when to call it:
//
//   * FOLLOW THE DEFAULT, but only while the user has not chosen otherwise.
//     Someone who deliberately sent audio to the HDMI monitor does not want a
//     headset connecting in another room to steal it back. A manual choice is
//     therefore sticky and `devicechange` stops re-pointing.
//
//   * RE-BIND, NOT RESTART. Setting the sink mid-playback keeps position and
//     play state; the element is not touched otherwise. Verified against a
//     playing clip rather than assumed, because a "fix" that silently restarts
//     the video would be worse than the problem.
//
//   * SAY SO, ONCE. The switch is invisible if it works and baffling if it does
//     not, so the viewer gets one short note naming the device.
//
// enumerateDevices() gives real labels here without a getUserMedia prompt, so
// the picker can be built without asking for microphone permission — which
// would be an outrageous thing to ask in order to choose an output.

/** main pushes here when the desktop's default output moves */
export const AUDIO_DEFAULT_CHANGED = 'liqpush:audio-default'

export interface AudioOutput {
  id: string
  label: string
}

/** '' means "follow the system default" */
let chosen = ''
const listeners = new Set<(outs: AudioOutput[]) => void>()
let elements = new Set<HTMLMediaElement>()
let watching = false

/** the output devices the browser can see, default first */
export async function listOutputs(): Promise<AudioOutput[]> {
  try {
    const all = await navigator.mediaDevices.enumerateDevices()
    return all
      .filter(d => d.kind === 'audiooutput')
      .map(d => ({ id: d.deviceId, label: d.label || 'Audio output' }))
  } catch {
    return []
  }
}

export function chosenOutput(): string { return chosen }

/** human name of the current choice, for a menu tick or a status line */
export async function chosenLabel(): Promise<string> {
  if (!chosen) return 'System default'
  const outs = await listOutputs()
  return outs.find(o => o.id === chosen)?.label ?? 'System default'
}

async function bind(el: HTMLMediaElement, sink: string): Promise<boolean> {
  const anyEl = el as HTMLMediaElement & { setSinkId?: (id: string) => Promise<void> }
  if (typeof anyEl.setSinkId !== 'function') return false
  try {
    await anyEl.setSinkId(sink)
    return true
  } catch {
    // a device that vanished between the menu opening and the click, or one the
    // page is not allowed to use: staying where we are is the safe answer
    return false
  }
}

/**
 * Put every playing element on `id` ('' = system default) and remember it.
 *
 * Returns the label actually applied so the caller can say what happened.
 */
export async function useOutput(id: string): Promise<string> {
  chosen = id
  for (const el of elements) await bind(el, id)
  return chosenLabel()
}

/** track an element so it follows device changes for as long as it exists */
export function attachAudioOutput(el: HTMLMediaElement, onNote?: (text: string) => void): void {
  elements.add(el)
  // a fresh element starts on the default; apply an existing manual choice
  if (chosen) void bind(el, chosen)
  el.addEventListener('emptied', () => { elements.delete(el) })

  if (watching) return
  watching = true
  const react = (label: string): void => {
      void (async () => {
        // prune elements that were torn down without firing 'emptied'
        elements = new Set([...elements].filter(e => e.isConnected))
        for (const l of listeners) l(await listOutputs())
        // a manual choice wins: the whole point of choosing is that it sticks
        if (chosen) return
        let moved = false
        for (const e of elements) moved = (await bind(e, '')) || moved
        if (moved && onNote && label) onNote(`Sound moved to ${label}`)
      })()
  }
  // MAIN tells us, not the browser. navigator.mediaDevices.devicechange was the
  // first implementation and fired zero times on this machine for every case
  // that matters — see main/platform/audiodev.ts.
  try {
    window.liq.on(AUDIO_DEFAULT_CHANGED, (raw: unknown) => {
      const p = (raw ?? {}) as { label?: string; initial?: boolean }
      if (p.initial) return          // the state at launch is not a change
      react(String(p.label ?? ''))
    })
  } catch { /* no push channel; the picker still works */ }
}

/** notified when devices appear or disappear, so an open menu stays honest */
export function onOutputsChanged(fn: (outs: AudioOutput[]) => void): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}
