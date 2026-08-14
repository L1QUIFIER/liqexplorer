// Renderer bootstrap: construct core app state, mount all UI components.
import { app } from './core/app'
import { mountTitlebar } from './chrome/titlebar'
import { mountNavRow } from './chrome/navrow'
import { mountCommandBar } from './chrome/commandbar'
import { mountStatusBar } from './chrome/statusbar'
import { mountNavPane } from './nav/navpane'
import { mountViewHost } from './views/view-host'
import { mountHome } from './views/home'
import { mountMenus } from './menus/context-menus'
import { mountDialogs } from './dialogs/dialogs'
import { mountKeyboard } from './core/keyboard'

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
  mountViewHost($('viewhost'))
  mountHome($('homehost'))          // shows/hides itself opposite #viewhost (home://)
  mountStatusBar($('statusbar'))
  mountMenus()
  mountDialogs()
  mountKeyboard()
}

boot().catch(err => {
  document.body.innerHTML = `<pre style="color:red;padding:2em;user-select:text">${String(err?.stack ?? err)}</pre>`
})
