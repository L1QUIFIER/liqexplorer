// One switch for every free-floating surface's backdrop blur.
//
// The drop-bin dock, the ops card and the peek popover all hover over the file
// list with no scrim behind them, and all three read the same --bg-float /
// --float-blur tokens. Rather than plumbing a setting into three stylesheets,
// this toggles one class on the root element and the tokens do the rest.
//
// It lives here rather than in core/app.ts deliberately: app.ts is a large,
// frequently-edited file and this needs no part of it.
import { app } from '../core/app'
import type { AppSettings } from '../../shared/types'

function apply(s: AppSettings): void {
  // reusing the media viewer's existing switch: someone who turned the blur off
  // because it felt sluggish meant "everywhere", not "on that one panel"
  document.documentElement.classList.toggle('no-blur', s.mediaViewerTranslucent === false)
}

apply(app.settings)
app.on('settings-changed', (s: AppSettings) => apply(s))
