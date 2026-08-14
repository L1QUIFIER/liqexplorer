// Open the user's terminal at a path (Cinnamon setting; 'kitty' on this machine).
import { spawn, execFile } from 'node:child_process'

export async function openAt(dir: string): Promise<void> {
  execFile('gsettings', ['get', 'org.cinnamon.desktop.default-applications.terminal', 'exec'],
    (err, out) => {
      const term = err ? 'x-terminal-emulator' : out.trim().replace(/^'|'$/g, '') || 'x-terminal-emulator'
      const child = spawn(term, [], { cwd: dir, detached: true, stdio: 'ignore' })
      // without a listener, ENOENT (missing terminal / deleted cwd) is an
      // uncaught exception in the main process
      child.on('error', () => { /* ignore */ })
      child.unref()
    })
}
