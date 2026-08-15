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
import { mountFavoriteMarks } from './views/favmark'
import { mountScrollHover } from './core/scrollhover'
// side-effect import: views/dropbins.ts builds its own container and injects
// its own stylesheet at import time, so it has no mount function to call
import './views/dropbins'
// side-effect: drives the no-blur class for every floating surface
import './chrome/surfaces'

async function boot() {
  ;(window as unknown as { app: typeof app }).app = app  // for CDP-driven testing
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
  await app.init()
  const $ = (id: string) => document.getElementById(id)!
  mountTitlebar($('titlebar'))
  mountNavRow($('navrow'))
  mountCommandBar($('commandbar'))
  mountNavPane($('navpane'))
  // both panes: each gets its own view host + Home page (the second stays
  // hidden until the tab is split). See views/panes.ts.
  mountPanes()
  mountPreviewPane($('sidepane'))   // after the command bar: it wires .cb-preview
  mountStatusBar($('statusbar'))
  mountMenus()
  mountDialogs()
  mountKeyboard()
  mountScrollHover()
  mountFavoriteMarks()   // so listings can mark pinned files
  // last: it asks main for the capability report and may add a bar
  mountStartupNotice()
}

boot().catch(err => {
  document.body.innerHTML = `<pre style="color:red;padding:2em;user-select:text">${String(err?.stack ?? err)}</pre>`
})
