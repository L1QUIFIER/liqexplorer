// The startup sanity check: "is anything this app needs actually missing?"
//
// WHY IT INTERRUPTS AT ALL. Everything here is already visible in
// Options → System, and that was the whole of it — which meant the only way to
// discover that, say, no icon theme was installed was to already suspect it and
// go looking. The failures this catches do not announce themselves: a missing
// icon theme shows as rows with no pictures, a missing ffmpeg as videos that
// never play, and neither says why. So the check runs once at startup and says
// so plainly, with the fix attached.
//
// WHY IT IS NOT A DIALOG. A modal on launch trains people to dismiss modals on
// launch. This is a bar under the toolbar: visible, ignorable, and gone for good
// once dismissed — unless the SET of problems changes, which is a new fact and
// gets one new mention. That signature is what stops it nagging while still
// letting it speak up when something breaks later.
import { app, liq } from '../core/app'
import { reportProblems, type ToolReport } from '../../shared/tools'

const DISMISS_KEY = 'startup-notice-dismissed'

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K, cls?: string, text?: string,
): HTMLElementTagNameMap[K] {
  const n = document.createElement(tag)
  if (cls) n.className = cls
  if (text !== undefined) n.textContent = text
  return n
}

/** what is wrong, as a stable string — the same problems must not re-warn */
function signature(p: { required: string[]; optional: string[]; icons: boolean }): string {
  return JSON.stringify([p.icons, p.required.slice().sort(), p.optional.slice().sort()])
}

/**
 * One sentence naming the actual problem.
 *
 * Deliberately not "some optional components are unavailable": the reason this
 * exists is that the symptoms are anonymous, so the message has to be the thing
 * a person would search for.
 */
function describe(p: { required: string[]; optional: string[]; icons: boolean }): string {
  const parts: string[] = []
  if (p.icons) parts.push('no icon theme is installed, so files have no icons')
  if (p.required.length) parts.push(`${p.required.join(' and ')} ${p.required.length === 1 ? 'is' : 'are'} missing`)
  if (p.optional.length) {
    const n = p.optional.length
    parts.push(n <= 2
      ? `${p.optional.join(' and ')} ${n === 1 ? 'is' : 'are'} not installed, so some features are off`
      : `${n} optional tools are not installed, so some features are off`)
  }
  const s = parts.join('; ')
  return s.charAt(0).toUpperCase() + s.slice(1) + '.'
}

export function mountStartupNotice(): void {
  void liq.invoke('toolReport').then((rep: ToolReport) => {
    const p = reportProblems(rep)
    // optional tools alone are not worth a bar: this machine has two missing by
    // choice, and a permanent complaint about a deliberate choice is noise.
    // Icons and required tools are real breakage.
    if (!p.icons && !p.required.length) return
    if (localStorage.getItem(DISMISS_KEY) === signature(p)) return

    const bar = el('div', 'notice-bar' + (p.icons || p.required.length ? ' is-bad' : ''))
    bar.appendChild(el('span', 'notice-icon', '⚠'))
    bar.appendChild(el('span', 'notice-text', describe(p)))

    const review = el('button', 'btn btn-primary', 'Review')
    review.addEventListener('click', () => { app.emit('show-options', 'system') })
    bar.appendChild(review)

    const close = el('button', 'notice-x', '✕')
    close.title = 'Dismiss. This comes back only if something else breaks.'
    close.addEventListener('click', () => {
      localStorage.setItem(DISMISS_KEY, signature(p))
      bar.remove()
    })
    bar.appendChild(close)

    document.getElementById('commandbar')?.after(bar)
  }).catch(() => { /* the check itself failing is not worth a bar */ })
}
