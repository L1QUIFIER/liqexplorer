// Painting a bin's icon, in one place.
//
// The tray tile and the Drop Bins settings list both draw the same thing, and
// they must agree: an icon you pick in the editor that looks different in the
// tray is worse than no choice at all. So this is the only code that turns a
// BinIcon into pixels, and both callers go through it.
//
// The four kinds are deliberately different mechanisms rather than one:
//   builtin  inline SVG, so it inherits currentColor and the theme
//   emoji    text, so it needs no files and survives a profile copy
//   image    a real file in the profile, served over liqfile:// — the renderer
//            has no filesystem access, and this is the scheme already used for
//            thumbnails
//   themed   liqicon://, the freedesktop lookup the rest of the app uses
import { previewURL } from '../../shared/preview'
import type { BinAction, BinConfig } from '../../shared/bins'
import { liq } from '../core/app'

/** Where imported pictures live. Asked for once; it cannot change while the app
 *  runs, and every tile would otherwise pay an IPC round trip to draw. */
let iconDir = ''
let iconDirAsked: Promise<void> | null = null

export function primeBinIcons(): Promise<void> {
  const pending = iconDirAsked ?? liq.invoke('binIconsDir')
    .then((d: string) => { iconDir = d || '' })
    .catch(() => { iconDir = '' })
  iconDirAsked = pending
  return pending
}

/** liqfile:// URL for a stored picture, or '' before the directory is known */
export function binImageURL(value: string): string {
  if (!iconDir || !value) return ''
  // a cache-buster keyed to nothing but the name would defeat itself; replacing
  // an icon reuses the file name, so the URL carries the load time instead
  return previewURL(`${iconDir}/${value}`) + `&v=${stamp}`
}

/** bumped whenever an icon is re-imported, so the tile does not show the old
 *  picture out of Chromium's memory cache */
let stamp = 0
export function bumpBinIconCache(): void { stamp++ }

/**
 * Draw `bin`'s icon into a fresh element.
 *
 * `svgFor` is passed in rather than imported: the built-in shapes live in
 * views/dropbins.ts next to the tray they were drawn for, and importing them
 * here would make this module depend on the view it is meant to serve.
 */
export function paintBinIcon(
  bin: BinConfig, svgFor: (a: BinAction) => string, size = 16,
): HTMLElement {
  const icon = bin.icon
  if (icon && icon.kind === 'emoji' && icon.value) {
    const span = document.createElement('span')
    span.className = 'db-ico-emoji'
    span.textContent = icon.value.slice(0, 4)
    span.style.fontSize = `${Math.round(size * 1.05)}px`
    return span
  }
  if (icon && icon.kind === 'image' && icon.value) {
    const img = document.createElement('img')
    img.className = 'db-ico-img'
    img.width = size
    img.height = size
    img.draggable = false
    img.alt = ''
    img.src = binImageURL(icon.value)
    // a picture that will not load must not leave a hole where the icon was
    img.addEventListener('error', () => {
      const fallback = document.createElement('span')
      fallback.innerHTML = svgFor(bin.action)
      img.replaceWith(...fallback.childNodes)
    })
    return img
  }
  if (icon && icon.kind === 'themed' && icon.value) {
    const img = document.createElement('img')
    img.className = 'db-ico-img'
    img.width = size
    img.height = size
    img.draggable = false
    img.alt = ''
    img.src = `liqicon://${encodeURIComponent(icon.value)}?size=${size * 2}`
    img.addEventListener('error', () => {
      const fallback = document.createElement('span')
      fallback.innerHTML = svgFor(bin.action)
      img.replaceWith(...fallback.childNodes)
    })
    return img
  }
  const span = document.createElement('span')
  span.innerHTML = svgFor(bin.action)
  return span
}

/** the class that tints a tile, or '' for the theme default */
export function binColorClass(bin: BinConfig): string {
  return bin.color && bin.color !== 'default' ? ` db-c-${bin.color}` : ''
}
