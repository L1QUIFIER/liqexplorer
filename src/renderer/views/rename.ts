// Inline rename editor. Explorer semantics: initial selection = basename only
// (dirs: whole name), Enter/blur commit, Esc cancel, Tab/Shift+Tab commit and
// rename the next/previous row, '/' blocked at keystroke with a tooltip,
// errors keep the editor open with a red toast.
import { liq } from '../core/app'
import type { FileEntry } from '../../shared/types'

export interface RenameHost {
  canvas: HTMLElement
  entryFor(path: string): FileEntry | null
  /** canvas-relative rect of the item's label, null when not materialized */
  labelRectFor(path: string): { left: number; top: number; width: number; height: number } | null
  neighborOf(path: string, dir: 1 | -1): string | null
  /** icon-grid modes center the editor under the icon */
  gridMode(): boolean
  itemWidth(): number
  /** listing is still streaming — entries may be temporarily absent */
  loading(): boolean
  onCommitted(oldPath: string, newPath: string, chained: boolean): void
  toast(msg: string): void
}

export class Renamer {
  private wrap: HTMLElement | null = null
  private input: HTMLInputElement | null = null
  private path = ''
  private busy = false
  private tipTimer = 0

  constructor(private host: RenameHost) {}

  isActive(): boolean { return this.wrap !== null }

  begin(path: string): void {
    if (this.wrap) this.close()
    const e = this.host.entryFor(path)
    if (!e) return
    const rect = this.host.labelRectFor(path)
    if (!rect) return
    this.path = path

    const wrap = document.createElement('div')
    wrap.className = 'vh-rename'
    const grid = this.host.gridMode()
    const w = grid
      ? Math.max(90, this.host.itemWidth() - 12)
      : Math.min(360, Math.max(160, rect.width + 40))
    wrap.style.left = (grid ? rect.left + rect.width / 2 - w / 2 : rect.left - 4) + 'px'
    wrap.style.top = (rect.top - 3) + 'px'
    wrap.style.width = w + 'px'

    const input = document.createElement('input')
    input.type = 'text'
    input.spellcheck = false
    input.value = e.name
    wrap.appendChild(input)
    this.host.canvas.appendChild(wrap)
    this.wrap = wrap
    this.input = input

    input.focus()
    const dot = e.isDir ? -1 : e.name.lastIndexOf('.')
    input.setSelectionRange(0, dot > 0 ? dot : e.name.length)

    input.addEventListener('keydown', (ev) => this.onKey(ev))
    input.addEventListener('blur', () => {
      if (!this.busy && this.wrap) void this.commit()
    })
    input.addEventListener('input', () => {
      if (input.value.includes('/')) {
        input.value = input.value.replace(/\//g, '')
        this.tip("A file name can't contain /")
      }
    })
    // keep the view's mouse handlers from stealing interactions with the editor
    for (const t of ['mousedown', 'mouseup', 'dblclick', 'contextmenu'] as const) {
      wrap.addEventListener(t, (ev) => ev.stopPropagation())
    }
  }

  /** realign after a layout rebuild; closes if the entry vanished */
  reposition(): void {
    if (!this.wrap) return
    const rect = this.host.labelRectFor(this.path)
    if (!rect) {
      // while the listing is still streaming the entry may simply not have
      // arrived yet — keep the editor (and the user's typing) alive; only a
      // settled listing that lacks the path means it truly vanished
      if (this.host.loading()) return
      this.close()
      return
    }
    const grid = this.host.gridMode()
    const w = parseFloat(this.wrap.style.width) || 200
    this.wrap.style.left = (grid ? rect.left + rect.width / 2 - w / 2 : rect.left - 4) + 'px'
    this.wrap.style.top = (rect.top - 3) + 'px'
  }

  cancel(): void { this.close() }

  private onKey(ev: KeyboardEvent): void {
    ev.stopPropagation()
    if (ev.key === '/') {
      ev.preventDefault()
      this.tip("A file name can't contain /")
      return
    }
    if (ev.key === 'Enter') { ev.preventDefault(); void this.commit() }
    else if (ev.key === 'Escape') { ev.preventDefault(); this.close() }
    else if (ev.key === 'Tab') { ev.preventDefault(); void this.commit(ev.shiftKey ? -1 : 1) }
  }

  private tip(msg: string): void {
    if (!this.wrap) return
    let tip = this.wrap.querySelector('.vh-rename-tip') as HTMLElement | null
    if (!tip) {
      tip = document.createElement('div')
      tip.className = 'vh-rename-tip'
      this.wrap.appendChild(tip)
    }
    tip.textContent = msg
    if (this.tipTimer) clearTimeout(this.tipTimer)
    this.tipTimer = window.setTimeout(() => {
      this.wrap?.querySelector('.vh-rename-tip')?.remove()
      this.tipTimer = 0
    }, 1800)
  }

  private close(): void {
    // null the state BEFORE removing the node: removal can fire a blur, and the
    // blur handler must not see an active session (it would commit a cancel)
    const w = this.wrap
    this.wrap = null
    this.input = null
    this.path = ''
    w?.remove()
  }

  private async commit(next?: 1 | -1): Promise<void> {
    if (!this.wrap || !this.input || this.busy) return
    const oldPath = this.path
    const e = this.host.entryFor(oldPath)
    const name = this.input.value.trim()
    const chainTo = next ? this.host.neighborOf(oldPath, next) : null
    if (!e || !name || name === e.name) {
      this.close()
      if (chainTo) this.begin(chainTo)
      return
    }
    this.busy = true
    try {
      const r = await liq.renameOne(oldPath, name)
      if (!r?.ok) {
        this.host.toast(r?.error || 'The item could not be renamed.')
        this.input?.focus()
        this.input?.select()
        return
      }
      const parent = oldPath.slice(0, oldPath.lastIndexOf('/')) || '/'
      const newPath: string = r.newPath ?? parent + '/' + name
      this.close()
      this.host.onCommitted(oldPath, newPath, !!chainTo)
      if (chainTo) this.begin(chainTo)
    } finally {
      this.busy = false
    }
  }
}
