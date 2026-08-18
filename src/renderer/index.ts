// Renderer bootstrap: construct core app state, mount all UI components.
import { app } from './core/app'
import { mountTitlebar } from './chrome/titlebar'
import { mountNavRow } from './chrome/navrow'
import { mountCommandBar } from './chrome/commandbar'
import { mountStatusBar } from './chrome/statusbar'
import { mountNavPane } from './nav/navpane'
import { mountPanes } from './views/panes'
import { mountPreviewPane } from './views/preview'
import { mountMenus } from './menus/context-menus'
import { mountDialogs } from './dialogs/dialogs'
import { mountKeyboard } from './core/keyboard'
import { mountStartupNotice } from './chrome/notice'
import { initPick, mountPickBar } from './chrome/pickbar'
import { mountFavoriteMarks } from './views/favmark'
import { mountDiskUsage } from './dialogs/diskusage'
import { mountReports } from './dialogs/reports'
import { mountScrollHover } from './core/scrollhover'
import { setPhase, startRendererHealth } from './core/health'
// side-effect import: views/dropbins.ts builds its own container and injects
// its own stylesheet at import time, so it has no mount function to call
import './views/dropbins'
// side-effect: drives the no-blur class for every floating surface
import './chrome/surfaces'

async function boot() {
  ;(window as unknown as { app: typeof app }).app = app  // for CDP-driven testing
  // FIRST: every step below is a candidate for "it freezes when I open it", and
  // a monitor started after the slow step measures nothing.
  startRendererHealth()
  // A drop on any surface without its own handler (titlebar, dialogs, ...) must
  // never fall through to Chromium's default, which navigates to the file.
  // Bubble phase + defaultPrevented check keep the view/navpane drops working.
  document.addEventListener('dragover', (e) => {
    if (e.defaultPrevented) return
    e.preventDefault()
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'none'
  })
  document.addEventListener('drop', (e) => {
    if (!e.defaultPrevented) e.preventDefault()
  })
  // BEFORE app.init(): a picker's row filter has to be in place before the
  // first folder lists, or the dialog opens showing files the caller excluded.
  setPhase('picker init')
  const pick = await initPick()
  setPhase('app.init (settings, places, session)')
  await app.init()
  const $ = (id: string) => document.getElementById(id)!
  mountTitlebar($('titlebar'))
  mountNavRow($('navrow'))
  mountCommandBar($('commandbar'))
  setPhase('navigation pane')
  mountNavPane($('navpane'))
  // both panes: each gets its own view host + Home page (the second stays
  // hidden until the tab is split). See views/panes.ts.
  setPhase('file panes')
  mountPanes()
  setPhase('preview pane')
  mountPreviewPane($('sidepane'))   // after the command bar: it wires .cb-preview
  mountStatusBar($('statusbar'))
  mountMenus()
  mountDialogs()
  mountKeyboard()
  mountScrollHover()
  mountFavoriteMarks()   // so listings can mark pinned files
  mountDiskUsage()
  mountReports()
  // last: it asks main for the capability report and may add a bar
  setPhase('startup notice')
  mountStartupNotice()
  setPhase('idle')
  // the startup measurement closes on the first listing that actually paints
  app.on('tab-listing', () => window.dispatchEvent(new Event('liq-first-listing')))
  if (pick) mountPickBar($('pickbar'))
}

boot().catch(err => {
  document.body.innerHTML = `<pre style="color:red;padding:2em;user-select:text">${String(err?.stack ?? err)}</pre>`
})
