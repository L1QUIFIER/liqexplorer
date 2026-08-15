// "Change folder icon" — Explorer's Customize ▸ Change Icon, adapted to
// freedesktop themes: pick one of the theme's folder variants (Papirus ships a
// colour set), browse for your own image, or reset to the default.
//
// The chosen icon is written both to our own map (used while listing, because
// reading GIO metadata per row would be far too slow) and to
// metadata::custom-icon, which is what Nemo reads — so a folder customised here
// looks customised there too.
import { app, liq } from '../core/app'
import { openModal, el, closeX } from './dialogs'

/** theme icon names worth offering; unavailable ones are dropped after probing */
const CANDIDATES = [
  'folder',
  'folder-documents', 'folder-download', 'folder-music', 'folder-pictures',
  'folder-videos', 'folder-images', 'folder-code', 'folder-development',
  'folder-games', 'folder-important', 'folder-bookmark', 'folder-cloud',
  'folder-remote', 'folder-locked', 'folder-print', 'folder-publicshare',
  'folder-templates', 'folder-script', 'folder-text', 'folder-temp',
  'folder-red', 'folder-orange', 'folder-yellow', 'folder-green',
  'folder-cyan', 'folder-blue', 'folder-violet', 'folder-magenta',
  'folder-grey', 'folder-brown',
]

const ICON_PX = 48

export function mountFolderIcon(): void {
  app.on('show-folder-icon', (path: string) => { void show(path) })
}

async function show(dir: string): Promise<void> {
  const current = await liq.invoke('getFolderIcon', dir).catch(() => null) as string | null
  let picked: string | null = current
  let dirty = false

  const modal = openModal({ width: 460, className: 'dlg-foldericon', onDismiss: () => modal.close() })

  const titleRow = el('div', 'dlg-title')
  titleRow.appendChild(el('span', 'dlg-title-text', `Change icon for "${dir.split('/').pop() || dir}"`))
  titleRow.appendChild(closeX(() => modal.close()))

  const body = el('div', 'dlg-body fi-body')
  const grid = el('div', 'fi-grid')
  body.appendChild(grid)

  const tiles = new Map<string, HTMLElement>()
  const mark = (): void => {
    for (const [name, tile] of tiles) tile.classList.toggle('selected', name === picked)
  }

  const addTile = (name: string): void => {
    const tile = el('button', 'fi-tile')
    tile.title = name
    const img = document.createElement('img')
    img.width = ICON_PX
    img.height = ICON_PX
    img.draggable = false
    img.src = name.startsWith('/')
      ? `liqicon://${encodeURIComponent(name)}?size=${ICON_PX}`
      : `liqicon://${encodeURIComponent(name)},folder?size=${ICON_PX}`
    // a theme that lacks this variant serves nothing — drop the tile entirely
    img.addEventListener('error', () => { tile.remove(); tiles.delete(name) }, { once: true })
    tile.appendChild(img)
    tile.addEventListener('click', () => { picked = name; dirty = true; mark() })
    tile.addEventListener('dblclick', () => { picked = name; dirty = true; void apply() })
    grid.appendChild(tile)
    tiles.set(name, tile)
  }

  // a previously chosen custom image goes first so it can be re-selected
  if (current && current.startsWith('/')) addTile(current)
  for (const n of CANDIDATES) addTile(n)
  mark()

  const buttons = el('div', 'dlg-buttons')
  const browseBtn = el('button', 'btn', 'Browse…')
  const resetBtn = el('button', 'btn', 'Reset')
  const okBtn = el('button', 'btn btn-primary', 'Apply')
  const cancelBtn = el('button', 'btn', 'Cancel')
  buttons.append(browseBtn, resetBtn, okBtn, cancelBtn)

  browseBtn.addEventListener('click', () => {
    void liq.invoke('pickImage').then((file: string | null) => {
      if (!file) return
      addTile(file)
      picked = file
      dirty = true
      mark()
    })
  })
  resetBtn.addEventListener('click', () => { picked = null; dirty = true; mark() })
  cancelBtn.addEventListener('click', () => modal.close())
  okBtn.addEventListener('click', () => { void apply() })

  async function apply(): Promise<void> {
    if (!dirty) { modal.close(); return }
    okBtn.disabled = true
    const r = await liq.invoke('setFolderIcon', dir, picked) as { ok: boolean; error?: string }
    modal.close()
    if (!r?.ok && r?.error) {
      app.emit('show-confirm', {
        title: 'Change icon', message: r.error, okLabel: 'OK', cancelLabel: null,
      })
      return
    }
    app.activeTab?.refresh()
  }

  modal.dlg.append(titleRow, body, buttons)
}
