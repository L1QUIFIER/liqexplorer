// Native drag-out (files to other apps). Chromium XDND source with text/uri-list.
import { app } from 'electron'
import type { WebContents } from 'electron'
import * as path from 'node:path'

export function startDrag(wc: WebContents, paths: string[]): void {
  if (!paths.length) return
  wc.startDrag({
    file: paths[0],
    files: paths,
    // __dirname is dist/main after bundling; getAppPath() is the project root
    icon: path.join(app.getAppPath(), 'assets', 'drag.png'),
  } as any)
}
