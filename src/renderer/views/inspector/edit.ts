// The Edit tab: crop, straighten, rotate, flip, resize.
//
// The renderer never touches a pixel. It draws a box over an <img> and sends
// main a recipe; ImageMagick does the work (see main/ops/imageedit.ts for why).
// That is what keeps EXIF and ICC intact — verified: a crop through this path
// preserves DateTimeOriginal and Model, which a canvas round-trip would destroy.
//
// The crop box is stored as FRACTIONS of the image, never pixels. The <img> here
// is whatever size the pane happens to be, so fractions are the only thing that
// survives a resize of the pane, a rotation, and the jump to full resolution on
// save.
//
// The on-screen straighten/rotate preview is a CSS transform, i.e. an
// APPROXIMATION — it is labelled as such, and "Preview result" round-trips the
// real argument builder so what you check is what you get.
import { app, liq } from '../../core/app'
import type { FileEntry } from '../../../shared/types'
import { previewURL } from '../../../shared/preview'
import type { InspectorPage, Subject } from './shell'

type Aspect = { label: string; ratio: number | null }

const ASPECTS: Aspect[] = [
  { label: 'Free', ratio: null },
  { label: '1:1', ratio: 1 },
  { label: '4:3', ratio: 4 / 3 },
  { label: '3:2', ratio: 3 / 2 },
  { label: '16:9', ratio: 16 / 9 },
  { label: '3:4', ratio: 3 / 4 },
  { label: '9:16', ratio: 9 / 16 },
]

interface Box { x: number; y: number; w: number; h: number }

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K, cls?: string, text?: string,
): HTMLElementTagNameMap[K] {
  const n = document.createElement(tag)
  if (cls) n.className = cls
  if (text !== undefined) n.textContent = text
  return n
}

export function createEditPage(): InspectorPage {
  const root = el('div', 'ins-page ins-edit')
  root.dataset.tab = 'edit'

  let entry: FileEntry | null = null
  let dirty = false

  // crop as fractions of the image, always
  let box: Box = { x: 0, y: 0, w: 1, h: 1 }
  let aspect: number | null = null
  let straighten = 0
  let rotate: 0 | 90 | 180 | 270 = 0
  let flipH = false
  let flipV = false

  // ---- chrome ----
  const stage = el('div', 'ed-stage')
  const img = el('img', 'ed-img')
  img.draggable = false
  const cropEl = el('div', 'ed-crop')
  for (const h of ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w']) {
    const g = el('div', `ed-h ed-h-${h}`)
    g.dataset.dir = h
    cropEl.appendChild(g)
  }
  stage.append(img, cropEl)

  const controls = el('div', 'ed-controls')
  const status = el('div', 'ed-status')

  root.append(stage, controls, status)

  // ---- geometry ----

  /** where the <img> actually is inside the stage, in stage coordinates */
  function imgRect(): DOMRect | null {
    if (!img.naturalWidth) return null
    return img.getBoundingClientRect()
  }

  function paintCrop(): void {
    const r = imgRect()
    const s = stage.getBoundingClientRect()
    if (!r || !s.width) { cropEl.hidden = true; return }
    cropEl.hidden = false
    cropEl.style.left = `${r.left - s.left + box.x * r.width}px`
    cropEl.style.top = `${r.top - s.top + box.y * r.height}px`
    cropEl.style.width = `${box.w * r.width}px`
    cropEl.style.height = `${box.h * r.height}px`
    const pw = Math.round(box.w * img.naturalWidth)
    const ph = Math.round(box.h * img.naturalHeight)
    status.textContent = `${pw} × ${ph} px`
      + (straighten ? `  ·  straightened ${straighten.toFixed(1)}°` : '')
      + (rotate ? `  ·  rotated ${rotate}°` : '')
  }

  function applyPreviewTransform(): void {
    const parts: string[] = []
    if (rotate) parts.push(`rotate(${rotate}deg)`)
    if (straighten) parts.push(`rotate(${straighten}deg)`)
    if (flipH) parts.push('scaleX(-1)')
    if (flipV) parts.push('scaleY(-1)')
    img.style.transform = parts.join(' ')
  }

  function clampBox(b: Box): Box {
    const w = Math.min(1, Math.max(0.02, b.w))
    const h = Math.min(1, Math.max(0.02, b.h))
    return {
      w, h,
      x: Math.min(1 - w, Math.max(0, b.x)),
      y: Math.min(1 - h, Math.max(0, b.y)),
    }
  }

  /** keep the requested aspect, in IMAGE pixels rather than fractions —
   *  a 4:3 box on a 3:2 photo is not 4:3 in fraction space */
  function withAspect(b: Box): Box {
    if (!aspect || !img.naturalWidth) return clampBox(b)
    const iw = img.naturalWidth
    const ih = img.naturalHeight
    const pw = b.w * iw
    const ph = b.h * ih
    // keep the larger dimension, derive the other
    let nw = pw
    let nh = pw / aspect
    if (nh > ih) { nh = ih; nw = ih * aspect }
    if (nh > ph * 1.0001 && nw > pw * 1.0001) { nh = ph; nw = ph * aspect }
    return clampBox({ x: b.x, y: b.y, w: nw / iw, h: nh / ih })
  }

  // ---- crop dragging ----

  function startBoxDrag(e: PointerEvent, dir: string | null): void {
    const r = imgRect()
    if (!r || e.button !== 0) return
    e.preventDefault()
    const start = { ...box }
    const ox = e.clientX
    const oy = e.clientY

    const move = (ev: PointerEvent): void => {
      const dx = (ev.clientX - ox) / r.width
      const dy = (ev.clientY - oy) / r.height
      let next: Box
      if (!dir) {
        next = clampBox({ ...start, x: start.x + dx, y: start.y + dy })
      } else {
        let { x, y, w, h } = start
        if (dir.includes('w')) { x = start.x + dx; w = start.w - dx }
        if (dir.includes('e')) { w = start.w + dx }
        if (dir.includes('n')) { y = start.y + dy; h = start.h - dy }
        if (dir.includes('s')) { h = start.h + dy }
        next = withAspect({ x, y, w, h })
      }
      box = next
      dirty = true
      paintCrop()
    }
    const up = (): void => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  cropEl.addEventListener('pointerdown', (e) => {
    const h = (e.target as HTMLElement).dataset.dir
    startBoxDrag(e, h ?? null)
  })
  // dragging on the image outside the box draws a fresh one
  img.addEventListener('pointerdown', (e) => {
    const r = imgRect()
    if (!r || e.button !== 0) return
    e.preventDefault()
    const ox = (e.clientX - r.left) / r.width
    const oy = (e.clientY - r.top) / r.height
    const move = (ev: PointerEvent): void => {
      const cx = (ev.clientX - r.left) / r.width
      const cy = (ev.clientY - r.top) / r.height
      box = withAspect({
        x: Math.min(ox, cx), y: Math.min(oy, cy),
        w: Math.abs(cx - ox), h: Math.abs(cy - oy),
      })
      dirty = true
      paintCrop()
    }
    const up = (): void => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  })

  // ---- controls ----

  function button(into: HTMLElement, label: string, title: string, fn: () => void): HTMLButtonElement {
    const b = el('button', 'ed-btn', label)
    b.title = title
    b.type = 'button'
    b.addEventListener('click', fn)
    into.appendChild(b)
    return b
  }

  function buildControls(): void {
    controls.textContent = ''

    const aspRow = el('div', 'ed-row')
    aspRow.appendChild(el('span', 'ed-lbl', 'Crop'))
    for (const a of ASPECTS) {
      const b = button(aspRow, a.label, `Crop to ${a.label}`, () => {
        aspect = a.ratio
        box = withAspect(box)
        dirty = true
        paintCrop()
        buildControls()
      })
      b.classList.toggle('on', aspect === a.ratio)
    }
    controls.appendChild(aspRow)

    const rotRow = el('div', 'ed-row')
    rotRow.appendChild(el('span', 'ed-lbl', 'Turn'))
    button(rotRow, '⟲', 'Rotate left', () => { rotate = ((rotate + 270) % 360) as 0|90|180|270; dirty = true; applyPreviewTransform(); paintCrop() })
    button(rotRow, '⟳', 'Rotate right', () => { rotate = ((rotate + 90) % 360) as 0|90|180|270; dirty = true; applyPreviewTransform(); paintCrop() })
    button(rotRow, '⇄', 'Flip horizontally', () => { flipH = !flipH; dirty = true; applyPreviewTransform() })
    button(rotRow, '⇅', 'Flip vertically', () => { flipV = !flipV; dirty = true; applyPreviewTransform() })
    controls.appendChild(rotRow)

    const strRow = el('div', 'ed-row')
    strRow.appendChild(el('span', 'ed-lbl', 'Straighten'))
    const slider = el('input', 'ed-slider')
    slider.type = 'range'
    slider.min = '-15'; slider.max = '15'; slider.step = '0.1'
    slider.value = String(straighten)
    const val = el('span', 'ed-num', `${straighten.toFixed(1)}°`)
    slider.addEventListener('input', () => {
      straighten = Number(slider.value)
      val.textContent = `${straighten.toFixed(1)}°`
      dirty = true
      applyPreviewTransform()
      paintCrop()
    })
    strRow.append(slider, val)
    controls.appendChild(strRow)

    const saveRow = el('div', 'ed-row ed-save')
    button(saveRow, 'Reset', 'Discard these changes', () => { reset(); paintCrop(); buildControls() })
    const copyBtn = button(saveRow, 'Save a copy', 'Write a new file beside the original', () => void save({ mode: 'copy' }))
    copyBtn.classList.add('primary')
    button(saveRow, 'Replace…', 'Replace the original (it goes to the Recycle Bin first)', () => {
      app.emit('show-confirm', {
        title: 'Replace the original?',
        message: `"${entry?.name}" will be replaced. The original goes to the Recycle Bin, so this can be undone.`,
        okLabel: 'Replace',
        danger: true,
        onOk: () => void save({ mode: 'replace' }),
      })
    })
    controls.appendChild(saveRow)
  }

  function reset(): void {
    box = { x: 0, y: 0, w: 1, h: 1 }
    aspect = null
    straighten = 0
    rotate = 0
    flipH = flipV = false
    dirty = false
    applyPreviewTransform()
  }

  async function save(dest: { mode: 'copy' | 'replace' }): Promise<void> {
    if (!entry) return
    status.textContent = 'Working…'
    const cropped = box.w < 0.999 || box.h < 0.999 || box.x > 0.001 || box.y > 0.001
    const r = await liq.invoke('applyEdit', {
      path: entry.path,
      dest,
      recipe: {
        autoOrient: true,
        straighten: straighten || undefined,
        rotate: rotate || undefined,
        flip: flipH && flipV ? 'hv' : flipH ? 'h' : flipV ? 'v' : undefined,
        crop: cropped ? box : undefined,
        strip: false,
      },
    }).catch((e: Error) => ({ ok: false, error: String(e?.message ?? e) }))

    if (!r?.ok) {
      status.textContent = r?.error || 'That did not work.'
      return
    }
    status.textContent = dest.mode === 'replace' ? 'Replaced.' : 'Saved a copy.'
    dirty = false
    void app.activeTab?.refresh()
  }

  // ---- lifecycle ----

  function render(sub: Subject): void {
    const e = sub.entries[0]
    if (!e || e.isDir) { entry = null; root.textContent = ''; return }
    if (entry?.path === e.path) return       // same file: keep the user's in-progress crop
    entry = e
    reset()
    img.style.transform = ''
    img.src = previewURL(e.path)
    img.onload = () => { paintCrop() }
    buildControls()
    status.textContent = 'Loading…'
  }

  const ro = new ResizeObserver(() => paintCrop())
  ro.observe(stage)

  return {
    el: root,
    render,
    isDirty: () => dirty,
    suspend() { /* nothing playing; the crop is kept deliberately */ },
  }
}
