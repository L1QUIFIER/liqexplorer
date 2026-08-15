// Options dialog — Explorer's "Folder Options" (General tab) plus the Search
// tab that Windows keeps in Control Panel > Indexing Options. Opened from the
// command bar's "…" menu via app.emit('show-options').
//
// Everything applies immediately through app.setSettings() (same path the View
// menu uses), so there is no OK/Apply/Cancel dance to keep in sync.
import type { AppSettings, FolderKind, IndexStatus, MediaViewerKind, ViewMode } from '../../shared/types'
import { DEFAULT_SMART_RULES } from '../../shared/types'
import { PUSH } from '../../shared/ipc'
import { PEEK } from '../../shared/peek'
import type { ToolReport } from '../../shared/tools'
import type { ExtensionInfo } from '../../shared/nemo'
import type { ExtensionPreview, InstallResult, StoreEntry, StoreIndex } from '../../shared/extstore'
import { app, liq } from '../core/app'
import { formatSize, formatDate } from '../../shared/sort'
import { openModal, el, closeX } from './dialogs'

/** minutes; 0 = only when the user asks */
const REFRESH_CHOICES: [number, string][] = [
  [0, 'Manually'],
  [15, 'Every 15 minutes'],
  [30, 'Every 30 minutes'],
  [60, 'Every hour'],
  [240, 'Every 4 hours'],
  [1440, 'Once a day'],
]

let openCount = 0

export function mountOptions(): void {
  app.on('show-options', (tab?: OptionsTab) => { void show(tab) })
}

type OptionsTab = 'general' | 'view' | 'search' | 'system' | 'extensions'

async function show(initialTab: OptionsTab = 'general'): Promise<void> {
  if (openCount) return                   // one Options window, like Explorer
  openCount++

  let offStatus: (() => void) | null = null
  // no onEnter: Enter belongs to the path/exclusion inputs (the modal's Enter
  // handler fires first, on document capture, and would close the dialog)
  const modal = openModal({
    width: 520,
    className: 'dlg-options',
    onDismiss: () => close(),
  })
  const close = (): void => {
    offStatus?.()
    offStatus = null
    openCount = 0
    modal.close()
  }

  const titleRow = el('div', 'dlg-title')
  titleRow.appendChild(el('span', 'dlg-title-text', 'Options'))
  titleRow.appendChild(closeX(close))

  // Search sits ABOVE the tabs because it searches across them: a setting you
  // cannot find is usually one you are looking for on the wrong tab, so making
  // the user pick a tab first would preserve the exact problem it solves.
  const searchRow = el('div', 'opt-search')
  const searchBox = el('input', 'opt-search-input')
  searchBox.type = 'search'
  searchBox.placeholder = 'Search settings…'
  searchBox.spellcheck = false
  const searchCount = el('span', 'opt-search-count')
  searchRow.append(searchBox, searchCount)

  const tabs = el('div', 'dlg-tabs')
  const body = el('div', 'dlg-body opt-body')
  const general = el('div', 'opt-panel')
  const view = el('div', 'opt-panel')
  const search = el('div', 'opt-panel')
  const system = el('div', 'opt-panel')
  const extensions = el('div', 'opt-panel')
  body.append(general, view, search, system, extensions)

  const panels: [string, HTMLElement][] = [
    ['General', general], ['View', view], ['Search', search],
    ['System', system], ['Extensions', extensions]]
  const tabBtns = panels.map(([label]) => el('button', 'dlg-tab', label))
  const select = (i: number): void => {
    tabBtns.forEach((b, k) => b.classList.toggle('active', k === i))
    panels.forEach(([, p], k) => { p.hidden = k !== i })
  }
  tabBtns.forEach((b, i) => { b.addEventListener('click', () => select(i)); tabs.appendChild(b) })

  buildGeneral(general)
  buildView(view)
  offStatus = buildSearch(search, () => modal.closed)
  buildSystem(system)
  buildExtensions(extensions, close)
  select(initialTab === 'view' ? 1 : initialTab === 'search' ? 2
    : initialTab === 'system' ? 3 : initialTab === 'extensions' ? 4 : 0)

  // ---- search over everything the panels just built ----
  //
  // Indexed AFTER the fact rather than by registering each control as it is
  // created: the panels are built by forty-odd imperative calls, and threading
  // a registration argument through all of them to answer a display question
  // would be a lot of churn for no behaviour. The DOM already holds the label,
  // the hint and the section heading — which is exactly what a user types.
  interface Indexed { row: HTMLElement; group: HTMLElement; panel: HTMLElement; hay: string; wrapper?: HTMLElement }
  const indexed: Indexed[] = []
  panels.forEach(([tabName, panel]) => {
    panel.querySelectorAll<HTMLElement>('.opt-group').forEach(group => {
      const heading = group.querySelector('.opt-heading')?.textContent ?? ''
      // Index the LEAF control, not the wrapper. Several settings share an
      // .opt-inline row, so indexing the wrapper made a search for "subtitle"
      // reveal the unrelated checkbox sitting beside it. Wrappers are hidden
      // separately, once everything inside them is hidden.
      group.querySelectorAll<HTMLElement>(':scope > *').forEach(row => {
        if (row.classList.contains('opt-heading')) return
        const leaves = row.classList.contains('opt-inline')
          ? [...row.querySelectorAll<HTMLElement>(':scope > .opt-check, :scope > .opt-radio')]
          : []
        if (leaves.length) {
          for (const leaf of leaves) {
            indexed.push({
              row: leaf, group, panel,
              hay: `${tabName} ${heading} ${leaf.textContent ?? ''}`.toLowerCase(),
              wrapper: row,
            })
          }
          return
        }
        indexed.push({ row, group, panel, hay: `${tabName} ${heading} ${row.textContent ?? ''}`.toLowerCase() })
      })
    })
  })

  let searching = false
  function applySearch(): void {
    const q = searchBox.value.trim().toLowerCase()
    const terms = q.split(/\s+/).filter(Boolean)
    if (!terms.length) {
      if (searching) {
        searching = false
        for (const it of indexed) {
          it.row.hidden = false
          it.group.hidden = false
          if (it.wrapper) it.wrapper.hidden = false
        }
        body.classList.remove('is-searching')
        tabs.hidden = false
        // back to whichever tab was active before the search started
        const active = tabBtns.findIndex(b => b.classList.contains('active'))
        select(active >= 0 ? active : 0)
      }
      searchCount.textContent = ''
      return
    }
    searching = true
    body.classList.add('is-searching')
    // every panel is shown at once while searching — the whole point is to stop
    // caring which tab a setting lives on
    tabs.hidden = true
    panels.forEach(([, p]) => { p.hidden = false })
    let hits = 0
    for (const it of indexed) {
      const match = terms.every(t => it.hay.includes(t))
      it.row.hidden = !match
      if (match) hits++
    }
    // an .opt-inline wrapper whose controls all matched nothing would otherwise
    // sit there as an empty gap
    const wrappers = new Set(indexed.map(i => i.wrapper).filter(Boolean) as HTMLElement[])
    for (const w of wrappers) {
      w.hidden = ![...w.children].some(c => !(c as HTMLElement).hidden)
    }
    // a section with nothing left in it is noise
    for (const [, panel] of panels) {
      panel.querySelectorAll<HTMLElement>('.opt-group').forEach(g => {
        const anyVisible = [...g.children].some(c =>
          !(c as HTMLElement).hidden && !c.classList.contains('opt-heading'))
        g.hidden = !anyVisible
      })
    }
    searchCount.textContent = hits ? `${hits} setting${hits === 1 ? '' : 's'}` : 'nothing matches'
  }
  searchBox.addEventListener('input', applySearch)
  searchBox.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && searchBox.value) { e.stopPropagation(); searchBox.value = ''; applySearch() }
  })

  const buttons = el('div', 'dlg-buttons')
  const closeBtn = el('button', 'btn btn-primary', 'Close')
  closeBtn.addEventListener('click', close)
  buttons.appendChild(closeBtn)

  modal.dlg.append(titleRow, searchRow, tabs, body, buttons)
  setTimeout(() => searchBox.focus(), 30)
}

/**
 * System check: which external tools this machine has.
 *
 * The app carries no runtime dependencies and shells out for everything, so a
 * missing package does not break it — it removes a feature. Without this panel
 * that shows up as "why is there no PDF preview", with no way to find out. Each
 * missing entry carries the install command for THIS distribution, because the
 * package names differ (poppler-utils on Mint, poppler on Arch).
 */
function buildSystem(root: HTMLElement): void {
  const g = group(root, 'External tools')
  const intro = el('div', 'opt-hint',
    'LiqExplorer uses the tools already on your system rather than bundling its own. '
    + 'Anything missing here simply switches a feature off.')
  g.appendChild(intro)
  const list = el('div', 'opt-tools')
  g.appendChild(list)

  void liq.invoke('toolReport').then((rep: ToolReport) => {
    intro.textContent = `${rep.distro} (${rep.desktop}) — ${rep.items.filter(i => i.present).length} of `
      + `${rep.items.length} tools found. Anything missing switches a feature off, `
      + 'it does not break the app.'
    list.textContent = ''

    // Icons first: a desktop with no usable theme is the most VISIBLE failure
    // here — every row loses its picture — and the least self-explanatory, so
    // it does not belong at the bottom of a list of programs.
    const ic = rep.icons
    const irow = el('div', 'opt-tool' + (ic.ok ? ' is-ok' : ' is-bad'))
    const ihead = el('div', 'opt-tool-head')
    ihead.appendChild(el('span', 'opt-tool-dot', ic.ok ? '✓' : '✕'))
    ihead.appendChild(el('span', 'opt-tool-name', 'Icon theme'))
    ihead.appendChild(el('span', 'opt-tool-found',
      ic.ok ? ic.theme + (ic.configured && ic.configured !== ic.theme ? ` (${ic.configured} is not installed)` : '')
        : 'none usable'))
    irow.appendChild(ihead)
    irow.appendChild(el('div', 'opt-hint', ic.ok
      ? 'File and folder icons come from this theme.'
      : `Your desktop asks for "${ic.configured || 'nothing'}", which is not installed, and no other `
        + `theme here has file icons (${ic.installedCount} found). File rows will have no icons until one is installed.`))
    if (ic.install) {
      const cmd = el('div', 'opt-tool-cmd')
      cmd.appendChild(el('code', '', ic.install))
      const copy = el('button', 'btn', 'Copy')
      copy.addEventListener('click', () => {
        void navigator.clipboard.writeText(ic.install).then(() => { copy.textContent = 'Copied' })
      })
      cmd.appendChild(copy)
      irow.appendChild(cmd)
    }
    list.appendChild(irow)
    for (const it of rep.items) {
      const row = el('div', 'opt-tool' + (it.present ? ' is-ok' : it.optional ? ' is-warn' : ' is-bad'))
      const head = el('div', 'opt-tool-head')
      head.appendChild(el('span', 'opt-tool-dot', it.present ? '\u2713' : '\u2715'))
      head.appendChild(el('span', 'opt-tool-name', it.label))
      head.appendChild(el('span', 'opt-tool-found',
        it.present ? it.found : it.optional ? 'not installed (optional)' : 'not installed'))
      row.appendChild(head)
      row.appendChild(el('div', 'opt-hint', it.needed))
      if (it.install) {
        const cmd = el('div', 'opt-tool-cmd')
        cmd.appendChild(el('code', '', it.install))
        const copy = el('button', 'btn', 'Copy')
        copy.addEventListener('click', () => {
          void navigator.clipboard.writeText(it.install).then(() => { copy.textContent = 'Copied' })
        })
        cmd.appendChild(copy)
        row.appendChild(cmd)
      }
      list.appendChild(row)
    }
  }).catch(() => { intro.textContent = 'The system check could not run.' })
}

// ------------------------------------------------------------- extensions

const SOURCE_LABEL: Record<string, string> = {
  liq: 'Yours', user: 'Your Nemo actions', system: 'From the system',
}

/**
 * The Extensions manager.
 *
 * An extension here is a Nemo action, which is not a compromise but the point:
 * the format is already supported, already safe (Exec is tokenised and spawned
 * as argv, never through a shell), and already has things written for it — this
 * machine has fifteen from Cinnamon plus one the user wrote. So "add an
 * extension area" is mostly a matter of showing what is already loadable and
 * giving somewhere of our own to put new ones.
 *
 * The list deliberately includes extensions that CANNOT run. An action whose
 * dependency is missing is skipped silently by the menu, which turns "I
 * installed it and nothing happened" into a dead end; here it is listed as
 * blocked, with the missing binary named and the install command attached.
 */
function buildExtensions(root: HTMLElement, close: () => void): void {
  // Installed | Get more. One tab with two faces rather than two tabs, because
  // "what do I have" and "what could I have" are the same question asked twice
  // and the answer to one is the context for the other.
  const nav = el('div', 'opt-ext-nav')
  const tabInstalled = el('button', 'opt-ext-nav-btn active', 'Installed')
  const tabStore = el('button', 'opt-ext-nav-btn', 'Get more')
  nav.append(tabInstalled, tabStore)
  root.appendChild(nav)

  const paneInstalled = el('div')
  const paneStore = el('div')
  paneStore.hidden = true
  root.append(paneInstalled, paneStore)

  // each pane can make the other's list wrong, so each is given the other's
  // refresh rather than trying to guess when to reload
  let reloadStore: () => void = () => {}
  const reloadInstalled = buildInstalled(paneInstalled, close, () => reloadStore())

  let storeBuilt = false
  tabInstalled.addEventListener('click', () => {
    tabInstalled.classList.add('active'); tabStore.classList.remove('active')
    paneInstalled.hidden = false; paneStore.hidden = true
  })
  tabStore.addEventListener('click', () => {
    tabStore.classList.add('active'); tabInstalled.classList.remove('active')
    paneStore.hidden = false; paneInstalled.hidden = true
    // the index is fetched the first time it is looked at, not at startup:
    // opening Options should never wait on, or silently make, a network request
    if (!storeBuilt) {
      storeBuilt = true
      reloadStore = buildStore(paneStore, () => void reloadInstalled())
    }
  })
}

function buildInstalled(root: HTMLElement, close: () => void, afterChange: () => void): () => Promise<void> {
  const g = group(root, 'Extensions')
  const intro = el('div', 'opt-hint', 'Loading…')
  g.appendChild(intro)

  const list = el('div', 'opt-exts')
  g.appendChild(list)

  const actions = el('div', 'opt-exts-actions')
  const newBtn = el('button', 'btn btn-primary', 'New extension…')
  newBtn.title = 'Write a starter extension into your extensions folder and open the folder'
  const openBtn = el('button', 'btn', 'Open folder')
  openBtn.title = 'Show the folder your extensions live in'
  const fileBtn = el('button', 'btn', 'Install from file…')
  fileBtn.title = 'Install a .nemo_action or an extension .zip you already have'
  const reload = el('button', 'btn', 'Reload')
  actions.append(newBtn, fileBtn, reload, openBtn)
  g.appendChild(actions)

  const goToFolder = async (select?: string): Promise<void> => {
    const dir = await liq.invoke('extensionsDir') as string
    // the folder opens in the file manager itself, which is the whole point of
    // being one — so the dialog gets out of the way first
    close()
    await app.activeTab?.navigate(dir)
    if (select) app.activeTab?.setSelection(new Set([select]))
  }

  newBtn.addEventListener('click', () => {
    void liq.invoke('extensionCreate').then((file: string) => goToFolder(file))
  })
  openBtn.addEventListener('click', () => { void goToFolder() })
  reload.addEventListener('click', () => { void refresh() })
  fileBtn.addEventListener('click', () => {
    void (async () => {
      const picked = await liq.invoke('storePick').catch(() => []) as string[]
      if (!picked.length) return
      const r = await liq.invoke('storeInstallFile', picked[0]).catch(
        (e: Error) => ({ ok: false, error: String(e?.message ?? e) })) as InstallResult
      intro.textContent = r.ok ? `Installed "${r.name}".` : (r.error ?? 'That did not work.')
      await refresh()
      afterChange()
    })()
  })

  async function refresh(): Promise<void> {
    const items = await liq.invoke('extensionList').catch(() => []) as ExtensionInfo[]
    list.textContent = ''
    const live = items.filter(i => i.enabled && !i.blocked).length
    intro.textContent = items.length
      ? `${live} of ${items.length} available in the right-click menu. `
        + 'Extensions use the Nemo action format, so anything written for Nemo works here.'
      : 'No extensions found. "New extension…" writes a starter one you can edit.'

    for (const it of items) {
      const row = el('div', 'opt-ext' + (it.blocked ? ' is-blocked' : it.enabled ? '' : ' is-off'))

      const head = el('div', 'opt-ext-head')
      const box = el('input', 'opt-ext-toggle')
      box.type = 'checkbox'
      box.checked = it.enabled
      box.disabled = !!it.blocked
      box.title = it.blocked ? 'This cannot run until what it needs is installed' : 'Show this in the right-click menu'
      box.addEventListener('change', () => {
        void liq.invoke('extensionEnable', it.id, box.checked).then(() => refresh())
      })
      head.appendChild(box)
      head.appendChild(el('span', 'opt-ext-name', it.name))
      head.appendChild(el('span', 'opt-ext-src', SOURCE_LABEL[it.source] ?? it.source))
      row.appendChild(head)

      if (it.comment) row.appendChild(el('div', 'opt-hint', it.comment))
      row.appendChild(el('div', 'opt-ext-applies', it.applies))

      if (it.blocked === 'deps') {
        row.appendChild(el('div', 'opt-ext-bad',
          `Needs ${it.missing.join(', ')}, which ${it.missing.length === 1 ? 'is' : 'are'} not installed.`))
        if (it.install) {
          const cmd = el('div', 'opt-tool-cmd')
          cmd.appendChild(el('span', 'opt-ext-find', 'Find it with'))
          cmd.appendChild(el('code', '', it.install))
          const copy = el('button', 'btn', 'Copy')
          copy.addEventListener('click', () => {
            void navigator.clipboard.writeText(it.install).then(() => { copy.textContent = 'Copied' })
          })
          cmd.appendChild(copy)
          row.appendChild(cmd)
        }
      } else if (it.blocked === 'condition') {
        // Being honest about this beats running it: an unverifiable condition
        // once put Cinnamon's disk-formatting action in the menu for a text file
        row.appendChild(el('div', 'opt-ext-bad',
          'Its rules depend on something this app cannot check, so it is not offered here.'))
      }

      const exec = el('div', 'opt-ext-exec')
      exec.appendChild(el('code', '', it.exec))
      exec.title = it.id
      row.appendChild(exec)
      list.appendChild(row)
    }
  }
  void refresh()
  return refresh
}

/**
 * Browse and install from the registry.
 *
 * Returns a reload function so the installed pane can tell this one that
 * something changed under it.
 */
function buildStore(root: HTMLElement, afterChange: () => void): () => void {
  root.textContent = ''
  const g = group(root, 'Get more extensions')
  const intro = el('div', 'opt-hint', 'Loading…')
  g.appendChild(intro)

  const searchRow = el('div', 'opt-store-search')
  const box = el('input', 'opt-search-input')
  box.type = 'search'
  box.placeholder = 'Search extensions…'
  box.spellcheck = false
  const refreshBtn = el('button', 'btn', 'Refresh')
  refreshBtn.title = 'Fetch the list from the site again'
  searchRow.append(box, refreshBtn)
  g.appendChild(searchRow)

  const list = el('div', 'opt-exts')
  g.appendChild(list)

  let all: StoreEntry[] = []

  function paint(): void {
    const terms = box.value.trim().toLowerCase().split(/\s+/).filter(Boolean)
    const shown = all.filter(e => {
      const hay = `${e.name} ${e.description} ${e.author} ${e.uuid}`.toLowerCase()
      return terms.every(t => hay.includes(t))
    })
    list.textContent = ''
    if (!shown.length) {
      list.appendChild(el('div', 'opt-hint', all.length ? 'Nothing matches that.' : 'No extensions to show.'))
      return
    }
    for (const e of shown) {
      const row = el('div', 'opt-ext' + (e.installed ? ' is-installed' : ''))
      const head = el('div', 'opt-ext-head')
      if (e.icon) {
        const img = el('img', 'opt-ext-icon')
        img.src = e.icon
        img.addEventListener('error', () => { img.style.visibility = 'hidden' })
        head.appendChild(img)
      }
      head.appendChild(el('span', 'opt-ext-name', e.name))
      if (e.score) head.appendChild(el('span', 'opt-ext-score', `▲ ${e.score}`))
      head.appendChild(el('span', 'opt-ext-src', e.author ? `by ${e.author}` : 'community'))
      row.appendChild(head)
      if (e.description) row.appendChild(el('div', 'opt-hint', e.description))

      const buttons = el('div', 'opt-ext-buttons')
      if (e.installed) {
        if (e.updatable) {
          const up = el('button', 'btn btn-primary', 'Update')
          up.addEventListener('click', () => void doInstall(e, up))
          buttons.appendChild(up)
        } else {
          buttons.appendChild(el('span', 'opt-ext-have', '✓ Installed'))
        }
        const rm = el('button', 'btn', 'Remove')
        rm.addEventListener('click', () => {
          void liq.invoke('storeUninstall', e.uuid).then(() => { void load(false); afterChange() })
        })
        buttons.appendChild(rm)
      } else {
        const add = el('button', 'btn btn-primary', 'Install')
        add.addEventListener('click', () => void doInstall(e, add))
        buttons.appendChild(add)
      }
      row.appendChild(buttons)
      list.appendChild(row)
    }
    // icons are fetched for what is on screen, not for the whole catalogue
    const want = shown.filter(e => !e.icon).map(e => e.uuid)
    if (want.length) {
      void liq.invoke('storeIcons', want).then((got: Record<string, string>) => {
        let any = false
        for (const e of all) if (got[e.uuid]) { e.icon = got[e.uuid]; any = true }
        if (any) paint()
      }).catch(() => { /* icons are decoration */ })
    }
  }

  /**
   * Install, but show what it runs first.
   *
   * A Nemo action is a command line that runs with the user's privileges, and
   * these packages ship their own shell scripts. Downloading one to describe it
   * and then downloading it again to install costs a second request and is
   * worth it: consent to "install Backup this file" is not consent to run an
   * unseen script.
   */
  async function doInstall(e: StoreEntry, btn: HTMLButtonElement): Promise<void> {
    const was = btn.textContent
    btn.disabled = true
    btn.textContent = 'Checking…'
    const p = await liq.invoke('storePreview', e.uuid).catch(
      (err: Error) => ({ ok: false, error: String(err?.message ?? err) })) as ExtensionPreview
    btn.disabled = false
    btn.textContent = was
    if (!p.ok) { intro.textContent = p.error ?? 'That could not be read.'; return }

    const lines = [
      `It runs:  ${p.exec}`,
      p.scripts.length ? `It installs ${p.scripts.length} script${p.scripts.length === 1 ? '' : 's'}: ${p.scripts.slice(0, 4).join(', ')}${p.scripts.length > 4 ? '…' : ''}` : '',
      p.dependencies.length ? `It needs: ${p.dependencies.join(', ')}` : '',
      p.conditions.length ? 'It runs a script to decide when to appear.' : '',
    ].filter(Boolean)

    app.emit('show-confirm', {
      title: `Install "${p.name}"?`,
      message: `${p.comment || 'An extension from the Cinnamon community site.'}\n\n${lines.join('\n')}\n\n`
        + 'Extensions run commands with your account\'s permissions. Only install ones you trust.',
      okLabel: 'Install',
      onOk: () => {
        void (async () => {
          btn.disabled = true
          btn.textContent = 'Installing…'
          const r = await liq.invoke('storeInstall', e.uuid).catch(
            (err: Error) => ({ ok: false, error: String(err?.message ?? err) })) as InstallResult
          intro.textContent = r.ok ? `Installed "${r.name}".` : (r.error ?? 'That did not work.')
          await load(false)
          afterChange()
        })()
      },
    })
  }

  async function load(force: boolean): Promise<void> {
    intro.textContent = force ? 'Fetching…' : 'Loading…'
    const idx = await liq.invoke('storeIndex', force).catch(
      (e: Error) => ({ ok: false, entries: [], fetchedAt: 0, stale: false, error: String(e?.message ?? e) })) as StoreIndex
    all = idx.entries
    intro.textContent = idx.error
      ? idx.error
      : `${all.length} extensions from the Cinnamon community site. They use the Nemo action format, the same as yours.`
    paint()
  }

  box.addEventListener('input', paint)
  refreshBtn.addEventListener('click', () => { void load(true) })
  void load(false)
  return () => { void load(false) }
}

// ---------------------------------------------------------------- widgets

function group(parent: HTMLElement, heading: string): HTMLDivElement {
  const g = el('div', 'opt-group')
  g.appendChild(el('div', 'opt-heading', heading))
  parent.appendChild(g)
  return g
}

function check(
  parent: HTMLElement, label: string, checked: boolean,
  onChange: (v: boolean) => void, hint?: string,
): HTMLInputElement {
  const wrap = el('label', 'opt-check')
  const box = el('input')
  box.type = 'checkbox'
  box.checked = checked
  box.addEventListener('change', () => onChange(box.checked))
  wrap.append(box, el('span', '', label))
  if (hint) wrap.title = hint
  parent.appendChild(wrap)
  return box
}

/** a labelled number spinner: "Show N lines of the filename" */
function numberRow(
  parent: HTMLElement, before: string, value: number,
  opts: { min: number; max: number; step?: number; after?: string; hint?: string },
  onChange: (v: number) => void,
): HTMLInputElement {
  const row = el('label', 'opt-check')
  row.appendChild(el('span', '', before))
  const input = el('input', 'opt-num')
  input.type = 'number'
  input.min = String(opts.min)
  input.max = String(opts.max)
  input.step = String(opts.step ?? 1)
  input.value = String(value)
  input.addEventListener('change', () => {
    const n = Math.max(opts.min, Math.min(opts.max, Math.round(Number(input.value) || opts.min)))
    input.value = String(n)
    onChange(n)
  })
  row.appendChild(input)
  if (opts.after) row.appendChild(el('span', '', opts.after))
  if (opts.hint) row.appendChild(el('div', 'opt-hint', opts.hint))
  parent.appendChild(row)
  return input
}

/** a labelled dropdown; values are compared as strings */
function choiceRow<T extends string | number>(
  parent: HTMLElement, label: string, value: T,
  choices: [T, string][], onChange: (v: T) => void, hint?: string,
): HTMLSelectElement {
  const row = el('label', 'opt-check')
  row.appendChild(el('span', '', label))
  const sel = el('select', 'opt-select')
  for (const [v, text] of choices) {
    const o = document.createElement('option')
    o.value = String(v)
    o.textContent = text
    sel.appendChild(o)
  }
  sel.value = String(value)
  sel.addEventListener('change', () => {
    const raw = sel.value
    const match = choices.find(c => String(c[0]) === raw)
    if (match) onChange(match[0])
  })
  row.appendChild(sel)
  if (hint) row.appendChild(el('div', 'opt-hint', hint))
  parent.appendChild(row)
  return sel
}

function radio(
  parent: HTMLElement, name: string, label: string, checked: boolean, onPick: () => void,
): void {
  const wrap = el('label', 'opt-check')
  const b = el('input')
  b.type = 'radio'
  b.name = name
  b.checked = checked
  b.addEventListener('change', () => { if (b.checked) onPick() })
  wrap.append(b, el('span', '', label))
  parent.appendChild(wrap)
}

function dropdown(
  parent: HTMLElement, options: [string, string][], value: string, onPick: (v: string) => void,
): HTMLSelectElement {
  const sel = el('select', 'opt-select')
  for (const [v, label] of options) {
    const o = document.createElement('option')
    o.value = v
    o.textContent = label
    sel.appendChild(o)
  }
  sel.value = value
  sel.addEventListener('change', () => onPick(sel.value))
  parent.appendChild(sel)
  return sel
}

/** editable list of paths/patterns with a ✕ on every row */
function pathList(
  parent: HTMLElement, empty: string, get: () => string[], set: (v: string[]) => void,
): () => void {
  const list = el('div', 'opt-list')
  parent.appendChild(list)
  const render = (): void => {
    list.textContent = ''
    const items = get()
    if (!items.length) { list.appendChild(el('div', 'opt-list-empty', empty)); return }
    for (const item of items) {
      const row = el('div', 'opt-list-row')
      row.appendChild(el('span', 'opt-list-text', item))
      const x = el('button', 'opt-list-x', '✕')
      x.title = `Remove ${item}`
      x.setAttribute('aria-label', `Remove ${item}`)
      x.addEventListener('click', () => { set(get().filter(i => i !== item)); render() })
      row.appendChild(x)
      list.appendChild(row)
    }
  }
  render()
  return render
}

// ---------------------------------------------------------------- General tab

function buildGeneral(root: HTMLElement): void {
  const s = app.settings

  const open = group(root, 'Open File Explorer to')
  const openOptions: [string, string][] = [
    ['home', 'Home'],
    ['homeFolder', 'Home folder'],
    ['lastSession', 'Last session'],
  ]
  const custom = !['home', 'homeFolder', 'lastSession'].includes(s.openTo)
  if (custom) openOptions.push([s.openTo, s.openTo])
  openOptions.push(['__pick', 'Choose folder…'])
  const openSel = dropdown(open, openOptions, s.openTo, (v) => {
    if (v !== '__pick') { void app.setSettings({ openTo: v }); return }
    void (async () => {
      const picked: string | null = await liq.invoke('pickFolder', app.homePath).catch(() => null)
      if (!picked) { openSel.value = app.settings.openTo; return }
      const o = document.createElement('option')
      o.value = picked
      o.textContent = picked
      openSel.insertBefore(o, openSel.options[openSel.options.length - 1])
      openSel.value = picked
      void app.setSettings({ openTo: picked })
    })()
  })

  const click = group(root, 'Click items as follows')
  radio(click, 'opt-click', 'Single-click to open an item', s.singleClickOpen,
    () => { void app.setSettings({ singleClickOpen: true }) })
  radio(click, 'opt-click', 'Double-click to open an item', !s.singleClickOpen,
    () => { void app.setSettings({ singleClickOpen: false }) })

  const adv = group(root, 'Advanced settings')
  check(adv, 'Show hidden files, folders and drives', s.showHidden,
    v => { void app.setSettings({ showHidden: v }) })
  check(adv, 'Show file name extensions', s.showExtensions,
    v => { void app.setSettings({ showExtensions: v }) })
  check(adv, 'Remember each folder’s view settings', s.rememberPerFolder,
    v => { void app.setSettings({ rememberPerFolder: v }) })

  // Windows asks before a permanent delete and nothing else, which is how files
  // get moved into the wrong folder by a stray drag. All off by default except
  // the permanent-delete one, so nothing nags unless the user opts in.
  const confirm = group(root, 'Ask me before')
  check(confirm, 'Permanently deleting an item', s.confirmDelete,
    v => { void app.setSettings({ confirmDelete: v }) })
  check(confirm, 'Moving an item to the Recycle Bin', s.confirmTrash,
    v => { void app.setSettings({ confirmTrash: v }) })
  check(confirm, 'Moving or copying items by drag and drop', s.confirmDrop,
    v => { void app.setSettings({ confirmDrop: v }) },
    'Shows what will be moved or copied, and where, before it happens')
  check(confirm, 'Moving items with Cut and Paste', s.confirmMove,
    v => { void app.setSettings({ confirmMove: v }) })

  // Safe mode is the confirmation that stays worth reading, because it only
  // appears for the handful of cases that are almost certainly a mistake.
  const safety = group(root, 'Safety')
  const safeBox = check(safety, 'Safe mode — check moves that look like a mistake', s.safeMode,
    v => { void app.setSettings({ safeMode: v }); syncSafe(v) },
    'Asks when a system folder, a whole drive, your home folder or a hidden '
    + 'settings folder is involved, or when an unusually large number of items '
    + 'would move at once')
  const bulkRow = el('label', 'opt-check opt-indent')
  bulkRow.title = 'Set to 0 to never ask on item count alone'
  bulkRow.appendChild(el('span', '', 'Also ask when moving more than'))
  const bulkInput = el('input', 'opt-num')
  bulkInput.type = 'number'
  bulkInput.min = '0'
  bulkInput.max = '100000'
  bulkInput.step = '10'
  bulkInput.value = String(s.safeModeBulk)
  bulkInput.addEventListener('change', () => {
    const n = Math.max(0, Math.min(100000, Math.round(Number(bulkInput.value) || 0)))
    bulkInput.value = String(n)
    void app.setSettings({ safeModeBulk: n })
  })
  bulkRow.appendChild(bulkInput)
  bulkRow.appendChild(el('span', '', 'items at once'))
  safety.appendChild(bulkRow)
  const syncSafe = (on: boolean): void => {
    bulkRow.classList.toggle('opt-disabled', !on)
    bulkInput.disabled = !on
  }
  syncSafe(safeBox.checked)

  // History is separate from safe mode: one prevents the accident, the other
  // lets you work out what happened after one slipped through.
  const hist = group(root, 'Activity history')
  check(hist, 'Keep a record of copies, moves, renames and deletes', s.historyEnabled,
    v => { void app.setSettings({ historyEnabled: v }) },
    'Stored on this computer only. Records what happened, never file contents.')
  const histBtn = el('button', 'btn opt-btn', 'View history…')
  histBtn.addEventListener('click', () => app.emit('show-history'))
  hist.appendChild(histBtn)
}

// ---------------------------------------------------------------- View tab

function buildView(root: HTMLElement): void {
  const s = app.settings

  const theme = group(root, 'Appearance')
  dropdown(theme, [['system', 'Follow system theme'], ['light', 'Light'], ['dark', 'Dark']],
    s.theme, v => { void app.setSettings({ theme: v as AppSettings['theme'] }) })

  const layout = group(root, 'Layout')
  check(layout, 'Navigation pane', s.showNavPane,
    v => { void app.setSettings({ showNavPane: v }) })
  check(layout, 'Preview pane (Alt+P)', s.showPreviewPane,
    v => { void app.setSettings({ showPreviewPane: v }) })
  check(layout, 'Status bar', s.showStatusBar,
    v => { void app.setSettings({ showStatusBar: v }) })
  check(layout, 'Compact view (tighter rows)', s.compactView,
    v => { void app.setSettings({ compactView: v }) })
  check(layout, 'Details pane (Alt+Shift+P)', s.showDetailsPane !== false,
    v => { void app.setSettings({ showDetailsPane: v }) },
    'The right-hand pane with Preview, Details, Rename, Edit and Doc tabs')

  // ---- how names and sizes are written ----
  const presentation = group(root, 'Names and sizes')
  numberRow(presentation, 'Show', s.gridLabelLines || 2,
    { min: 1, max: 8, after: 'lines of the filename under an icon',
      hint: 'Longer names are shortened with an ellipsis. Selecting an item always shows the whole name.' },
    n => { void app.setSettings({ gridLabelLines: n }) })
  choiceRow(presentation, 'File sizes in', s.sizeUnits === 'binary' ? 'binary' : 'decimal',
    [['decimal', 'KB, MB, GB (1 KB = 1000 bytes)'], ['binary', 'KiB, MiB, GiB (1 KiB = 1024 bytes)']],
    v => { void app.setSettings({ sizeUnits: v }) },
    'Decimal is what Explorer and drive manufacturers print; binary is what the disk actually allocates')

  // ---- work done ahead of time ----
  const perf = group(root, 'Performance')
  numberRow(perf, 'Decode', s.preloadNeighbours ?? 2,
    { min: 0, max: 4, after: 'photos ahead in the viewer',
      hint: 'Measured on this share: an already-decoded photo opens in 2 ms against 48 ms cold. '
        + 'Set to 0 on a slow connection, where the extra reads compete with the photo you are looking at.' },
    n => { void app.setSettings({ preloadNeighbours: n }) })
  check(layout, 'Item check boxes', s.checkboxes,
    v => { void app.setSettings({ checkboxes: v }) })

  const listing = group(root, 'Files and folders')
  check(listing, 'Show folders before files', s.foldersFirst,
    v => { void app.setSettings({ foldersFirst: v }) })
  check(listing, 'Expand the navigation tree to the open folder', s.navExpandToCurrent,
    v => { void app.setSettings({ navExpandToCurrent: v }) })
  check(listing, 'Show thumbnails for files on network drives', s.thumbnailsRemote,
    v => { void app.setSettings({ thumbnailsRemote: v }) },
    'Off by default: thumbnailing a network share reads every file over the network')

  // ---- live media previews ----
  // Hover is the default because "all visible" on a folder of 200 clips is a
  // lot of decoders; the cap below is what keeps either mode honest.
  const live = group(root, 'Live previews')
  const liveRow = el('div', 'opt-inline')
  liveRow.appendChild(el('span', '', 'Play videos in the icon views'))
  dropdown(liveRow, [
    ['off', 'Never'],
    ['hover', 'When I point at one'],
    ['always', 'All of them, while visible'],
  ], s.liveMedia ?? 'hover', v => {
    void app.setSettings({ liveMedia: v as AppSettings['liveMedia'] })
    paintLive()
  })
  live.appendChild(liveRow)
  const liveOpts = el('div', 'opt-rules')
  live.appendChild(liveOpts)
  check(liveOpts, 'Scrub through the video by moving across it', s.liveMediaScrub,
    v => { void app.setSettings({ liveMediaScrub: v }) },
    'Like Plex or YouTube: the pointer’s position across the tile is a position '
    + 'in the video. Tiles narrower than 64px are too coarse to scrub.')
  check(liveOpts, 'Animate GIF and WebP images', s.liveMediaAnimated,
    v => { void app.setSettings({ liveMediaAnimated: v }) },
    'These animate as themselves — no decoder involved. The whole file has to be '
    + 'read, so large ones on a network drive are left as thumbnails.')
  check(liveOpts, 'Stop when the system asks to reduce motion', s.liveMediaReduceMotion,
    v => { void app.setSettings({ liveMediaReduceMotion: v }); paintLive() })
  const capRow = el('label', 'opt-check')
  capRow.appendChild(el('span', '', 'Play at most'))
  const capInput = el('input', 'opt-num')
  capInput.type = 'number'
  capInput.min = '1'
  capInput.max = '24'
  capInput.step = '1'
  capInput.value = String(s.liveMediaMax ?? 10)
  capInput.addEventListener('change', () => {
    const n = Math.max(1, Math.min(24, Math.round(Number(capInput.value) || 10)))
    capInput.value = String(n)
    void app.setSettings({ liveMediaMax: n })
  })
  capRow.appendChild(capInput)
  capRow.appendChild(el('span', '', 'videos at once'))
  liveOpts.appendChild(capRow)
  const liveNote = el('div', 'opt-note', '')
  live.appendChild(liveNote)
  function paintLive(): void {
    const off = app.settings.liveMedia === 'off'
    liveOpts.classList.toggle('is-off', off)
    const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches
    liveNote.textContent = reduced && app.settings.liveMediaReduceMotion
      ? 'Your desktop is currently asking for reduced motion, so live previews are off.'
      : ''
  }
  paintLive()

  // ---- smart view ----
  const smart = group(root, 'Choose the view automatically')
  check(smart, 'Set the view mode from what the folder contains', s.smartView,
    v => { void app.setSettings({ smartView: v }); paintSmart() },
    'A folder you have set by hand always keeps your choice')
  const thresholdRow = el('div', 'opt-inline')
  thresholdRow.appendChild(el('span', '', 'when at least'))
  dropdown(thresholdRow,
    [['0.5', 'half'], ['0.6', '60%'], ['0.75', '75%'], ['0.9', '90%']],
    String(s.smartViewThreshold ?? 0.6),
    v => { void app.setSettings({ smartViewThreshold: Number(v) }) })
  thresholdRow.appendChild(el('span', '', 'of the files match'))
  smart.appendChild(thresholdRow)

  const KINDS: [FolderKind, string][] = [
    ['images', 'Pictures'], ['video', 'Videos'], ['audio', 'Music'],
    ['documents', 'Documents'], ['code', 'Code and text'], ['archives', 'Archives'],
  ]
  const MODES: [string, string][] = [
    ['extra-large', 'Extra large icons'], ['large', 'Large icons'],
    ['medium', 'Medium icons'], ['small', 'Small icons'],
    ['list', 'List'], ['details', 'Details'], ['tiles', 'Tiles'], ['content', 'Content'],
  ]
  const rulesBox = el('div', 'opt-rules')
  smart.appendChild(rulesBox)
  for (const [kind, label] of KINDS) {
    const row = el('div', 'opt-inline')
    row.appendChild(el('span', 'opt-rule-label', label))
    const rule = () => app.settings.smartViewRules?.[kind] ?? DEFAULT_SMART_RULES[kind]
    dropdown(row, MODES, rule().mode, v => {
      void app.setSettings({
        smartViewRules: { ...app.settings.smartViewRules, [kind]: { ...rule(), mode: v as ViewMode } },
      })
    })
    check(row, 'with preview pane', !!rule().preview, v => {
      void app.setSettings({
        smartViewRules: { ...app.settings.smartViewRules, [kind]: { ...rule(), preview: v } },
      })
    })
    rulesBox.appendChild(row)
  }
  function paintSmart(): void {
    const on = app.settings.smartView
    thresholdRow.classList.toggle('is-off', !on)
    rulesBox.classList.toggle('is-off', !on)
  }
  paintSmart()

  // ---- floating media viewer ----
  // Off per kind rather than one switch: people want pictures and video in the
  // viewer but usually still want their editor for a .ts or a .conf.
  const media = group(root, 'Media viewer')
  check(media, 'Double-click opens media in a floating viewer', s.mediaViewer !== false,
    v => { void app.setSettings({ mediaViewer: v }); paintMedia() },
    'A translucent player that floats over the file list — you can keep clicking around behind it')
  const kindsRow = el('div', 'opt-inline')
  kindsRow.appendChild(el('span', 'opt-rule-label', 'Use it for'))
  const KIND_LABELS: [MediaViewerKind, string][] = [
    ['image', 'Pictures'], ['video', 'Video'], ['audio', 'Music'], ['pdf', 'PDF'], ['text', 'Text'],
  ]
  for (const [kind, label] of KIND_LABELS) {
    check(kindsRow, label, (app.settings.mediaViewerKinds ?? []).includes(kind), v => {
      const next = new Set<MediaViewerKind>(app.settings.mediaViewerKinds ?? [])
      if (v) next.add(kind); else next.delete(kind)
      void app.setSettings({ mediaViewerKinds: [...next] })
    })
  }
  media.appendChild(kindsRow)
  const kindsHint = el('div', 'opt-hint',
    'Anything the app cannot decode directly is converted as it plays, so all of '
    + 'these open here by default. Untick one to hand it back to its own '
    + 'application \u2014 right-click \u2192 "Open with" still works either way.')
  media.appendChild(kindsHint)

  const wheelRow = el('div', 'opt-inline')
  check(wheelRow, 'Mouse wheel moves between photos', s.mediaViewerWheelNav !== false,
    v => { void app.setSettings({ mediaViewerWheelNav: v }) },
    'Ctrl+wheel always zooms, and a zoomed-in picture keeps the wheel for zoom')
  check(wheelRow, 'Reverse wheel direction', !!s.mediaViewerWheelInvert,
    v => { void app.setSettings({ mediaViewerWheelInvert: v }) })
  media.appendChild(wheelRow)

  const autoRow = el('div', 'opt-inline')
  check(autoRow, 'Start playing straight away', s.mediaViewerAutoplay !== false,
    v => { void app.setSettings({ mediaViewerAutoplay: v }) })
  check(autoRow, 'Frosted translucent panel', s.mediaViewerTranslucent !== false,
    v => { void app.setSettings({ mediaViewerTranslucent: v }) },
    'Turn off if the blur feels sluggish — this machine has no GPU acceleration')
  media.appendChild(autoRow)

  // Formats Chromium cannot decode (MPEG-2 DVD rips, HEVC, AC3 soundtracks,
  // anything in an AVI/WMV/FLV) always play by streaming through ffmpeg. This
  // switch only governs whether a CONVERTED COPY is also kept, which is purely
  // a seeking-speed-for-disk trade — hence the size on the button.
  const cacheRow = el('div', 'opt-inline')
  check(cacheRow, 'Keep converted copies for instant seeking', s.mediaTranscodeCache !== false,
    v => { void app.setSettings({ mediaTranscodeCache: v }) },
    'Videos this app cannot play directly are converted in the background after '
    + 'the first viewing. Seeking then takes about 70 ms instead of 400 ms. '
    + 'Capped at 20 GB; files over 4 GB are never converted.')
  media.appendChild(cacheRow)

  const cacheBtnRow = el('div', 'opt-inline')
  const clearBtn = el('button', 'btn opt-btn', 'Clear converted videos')
  const cacheSize = el('span', 'opt-hint', '')
  const paintCacheSize = (): void => {
    void liq.invoke('mediaCacheSize').then((n: number) => {
      cacheSize.textContent = n > 0 ? `Using ${formatSize(n)}` : 'Nothing cached'
      clearBtn.disabled = !n
    }).catch(() => { cacheSize.textContent = '' })
  }
  clearBtn.addEventListener('click', () => {
    clearBtn.disabled = true
    void liq.invoke('mediaCacheClear').then(() => paintCacheSize()).catch(() => paintCacheSize())
  })
  cacheBtnRow.append(clearBtn, cacheSize)
  media.appendChild(cacheBtnRow)
  paintCacheSize()

  // ---- the media surfaces that grew their own behaviour ----
  const playbackRow = el('div', 'opt-inline')
  check(playbackRow, 'Remember where you were up to', s.mediaResume !== false,
    v => { void app.setSettings({ mediaResume: v }) },
    'Long videos reopen where you left them. Anything under 30 seconds, or watched to the end, is not remembered.')
  check(playbackRow, 'Play the next file when one ends', s.mediaAutoAdvance !== false,
    v => { void app.setSettings({ mediaAutoAdvance: v }) })
  media.appendChild(playbackRow)

  const previewRow = el('div', 'opt-inline')
  check(previewRow, 'Preview the frame under the scrub bar', s.mediaSeekPreview !== false,
    v => { void app.setSettings({ mediaSeekPreview: v }) },
    'Hovering the bar shows that moment as a picture')
  check(previewRow, 'Turn subtitles on automatically', !!s.subtitleAutoEnable,
    v => { void app.setSettings({ subtitleAutoEnable: v }) },
    'Picks the first readable track. Picture-based subtitles (Blu-ray, DVD) can never be shown here.')
  media.appendChild(previewRow)

  const sheetRow = el('div', 'opt-inline')
  numberRow(sheetRow, 'Scene-select frames', s.mediaSheetFrames || 12,
    { min: 4, max: 24, step: 4, hint: 'How many frames the G key lays out across a video' },
    n => { void app.setSettings({ mediaSheetFrames: n }) })
  choiceRow(sheetRow, 'Convert video at most', s.mediaMaxHeight || 720,
    [[480, '480p — fastest'], [720, '720p'], [1080, '1080p'], [1440, '1440p — slowest']],
    n => { void app.setSettings({ mediaMaxHeight: n }) },
    'Only applies to files that have to be converted to play at all')
  media.appendChild(sheetRow)

  function paintMedia(): void {
    const on = app.settings.mediaViewer !== false
    kindsRow.classList.toggle('is-off', !on)
    kindsHint.classList.toggle('is-off', !on)
    wheelRow.classList.toggle('is-off', !on)
    autoRow.classList.toggle('is-off', !on)
    cacheRow.classList.toggle('is-off', !on)
    cacheBtnRow.classList.toggle('is-off', !on)
    playbackRow.classList.toggle('is-off', !on)
    previewRow.classList.toggle('is-off', !on)
    sheetRow.classList.toggle('is-off', !on)
  }
  paintMedia()

  // ---- peek popover ----
  // Space is deliberately NOT switchable: it is the shortcut, and a shortcut
  // that can vanish is worse than one you never learn. Only the hover half,
  // which is the half that can get in the way, has a switch.
  const peek = group(root, 'Peek inside items')
  check(peek, 'Show a preview when the pointer rests on an item', s.hoverPeek !== false,
    v => { void app.setSettings({ hoverPeek: v }); paintPeek() },
    'Press Space to peek at the focused item at any time, whether this is on or off')
  const peekRow = el('div', 'opt-inline')
  peekRow.appendChild(el('span', '', 'after'))
  dropdown(peekRow,
    [['800', '0.8 seconds'], ['1200', '1.2 seconds'], ['1400', '1.4 seconds'],
      ['2000', '2 seconds'], ['3000', '3 seconds']],
    String(s.peekDelayMs ?? PEEK.defaultDelayMs),
    v => { void app.setSettings({ peekDelayMs: Number(v) }) })
  peek.appendChild(peekRow)
  function paintPeek(): void {
    peekRow.classList.toggle('is-off', app.settings.hoverPeek === false)
  }
  paintPeek()

  const home = group(root, 'Home page')
  check(home, 'Show recent files', s.showRecent,
    v => { void app.setSettings({ showRecent: v }) })
  check(home, 'Show frequently used folders in Quick access', s.showFrequent,
    v => { void app.setSettings({ showFrequent: v }) })
}

// ---------------------------------------------------------------- Search tab

function buildSearch(root: HTMLElement, closed: () => boolean): () => void {
  const s = app.settings
  let roots = [...s.indexRoots]
  let excludes = [...s.indexExcludes]

  /** save + let the indexer re-read the settings it schedules from */
  const patch = (p: Record<string, unknown>): Promise<unknown> =>
    app.setSettings(p)
      .then(() => liq.invoke('indexApplySettings'))
      .catch(() => { /* main not ready / settings write failed: keep the UI alive */ })

  // -- index status (live on PUSH.indexStatus)
  const st = group(root, 'Index')
  const statusLine = el('div', 'opt-status', 'Checking…')
  const rootsLine = el('div', 'opt-note', '')
  st.append(statusLine, rootsLine)

  // turning it on with nothing built yet starts the first scan straight away —
  // an empty index would silently keep every search on the slow path
  const enableBox = check(st, 'Keep an index of file names in these folders', s.indexEnabled,
    v => {
      void patch({ indexEnabled: v }).then(() => {
        if (v && !cur?.lastBuilt) return liq.invoke('buildIndex').then(paint)
        return paint(cur)
      })
    })

  // -- indexed folders
  const folders = group(root, 'Indexed folders')
  folders.appendChild(el('div', 'opt-note',
    'Empty means your home folder. Network shares are never covered by the system '
    + 'index (updatedb skips cifs/smb mounts), so add them here to search them quickly.'))
  const renderRoots = pathList(folders, 'Home folder (default)', () => roots, (v) => {
    roots = v
    patch({ indexRoots: roots })
  })
  const rootRow = el('div', 'opt-row')
  const rootInput = el('input', 'opt-input')
  rootInput.type = 'text'
  rootInput.placeholder = '/path/to/folder'
  rootInput.spellcheck = false
  const addRoot = async (p: string): Promise<void> => {
    const val = p.trim()
    if (!val) return
    const exists: boolean = await liq.pathExists(val).catch(() => false)
    if (!exists) { rootInput.classList.add('bad'); rootInput.title = 'That folder does not exist'; return }
    rootInput.classList.remove('bad')
    rootInput.title = ''
    if (!roots.includes(val)) { roots = [...roots, val]; patch({ indexRoots: roots }); renderRoots() }
    rootInput.value = ''
  }
  const addBtn = el('button', 'btn btn-small', 'Add')
  addBtn.addEventListener('click', () => { void addRoot(rootInput.value) })
  rootInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); void addRoot(rootInput.value) }
  })
  const browseBtn = el('button', 'btn btn-small', 'Browse…')
  browseBtn.addEventListener('click', () => {
    void (async () => {
      const picked: string | null = await liq.invoke('pickFolder', app.activeTab?.path).catch(() => null)
      if (picked) await addRoot(picked)
    })()
  })
  rootRow.append(rootInput, addBtn, browseBtn)
  folders.appendChild(rootRow)

  // -- exclusions
  const skip = group(root, 'Skip anything whose path contains')
  const renderSkips = pathList(skip, 'Nothing excluded', () => excludes, (v) => {
    excludes = v
    patch({ indexExcludes: excludes })
  })
  skip.appendChild(el('div', 'opt-note',
    'Adding or removing a folder re-scans straight away; exclusions and the '
    + 'hidden-files setting take effect the next time the index is built.'))
  const skipRow = el('div', 'opt-row')
  const skipInput = el('input', 'opt-input')
  skipInput.type = 'text'
  skipInput.placeholder = '/node_modules/'
  skipInput.spellcheck = false
  const addSkip = (): void => {
    const val = skipInput.value.trim()
    if (!val || excludes.includes(val)) { skipInput.value = ''; return }
    excludes = [...excludes, val]
    patch({ indexExcludes: excludes })
    renderSkips()
    skipInput.value = ''
  }
  const skipAdd = el('button', 'btn btn-small', 'Add')
  skipAdd.addEventListener('click', addSkip)
  skipInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); addSkip() }
  })
  skipRow.append(skipInput, skipAdd)
  skip.appendChild(skipRow)

  // -- behaviour
  const beh = group(root, 'Searching')
  check(beh, 'Use the index when the folder being searched is covered', s.searchUseIndex,
    v => patch({ searchUseIndex: v }),
    'Uncovered folders always fall back to a live walk of the folder tree')
  check(beh, 'Include hidden files and folders in the index', s.indexHidden,
    v => patch({ indexHidden: v }))
  const refreshRow = el('div', 'opt-row')
  refreshRow.appendChild(el('span', 'opt-inline-label', 'Refresh the index:'))
  dropdown(refreshRow,
    REFRESH_CHOICES.map(([v, label]) => [String(v), label] as [string, string]),
    String(s.indexRefreshMins),
    v => patch({ indexRefreshMins: Number(v) }))
  beh.appendChild(refreshRow)

  // -- actions
  const actions = el('div', 'opt-row opt-actions')
  const rebuild = el('button', 'btn btn-small', 'Rebuild now')
  const cancel = el('button', 'btn btn-small', 'Cancel')
  const clear = el('button', 'btn btn-small', 'Clear index')
  rebuild.addEventListener('click', () => { void liq.invoke('buildIndex').then(paint) })
  cancel.addEventListener('click', () => { void liq.invoke('cancelIndex').then(paint) })
  clear.addEventListener('click', () => { void liq.invoke('clearIndex').then(paint) })
  actions.append(rebuild, cancel, clear)
  root.appendChild(actions)

  // -- live status wiring
  let cur: IndexStatus | null = null
  function paint(status: IndexStatus | null): void {
    if (closed() || !status) return
    cur = status
    statusLine.textContent = describe(status)
    statusLine.classList.toggle('err', status.state === 'error')
    const here = app.activeTab?.path ?? ''
    const covered = !!here && !here.includes('://')
      && status.roots.some(r => here === r || here.startsWith(r.replace(/\/+$/, '') + '/'))
    rootsLine.textContent = status.state === 'ready' && here && !covered
      ? `Searches in ${here} are not indexed and run a live walk of the folder — add it below to speed them up.`
      : status.roots.length
        ? `Covers: ${status.roots.join(', ')}`
        : ''
    const scanning = status.state === 'scanning'
    rebuild.disabled = scanning || status.state === 'off'
    cancel.disabled = !scanning
    clear.disabled = scanning || (!status.files && !status.dirs)
    enableBox.checked = app.settings.indexEnabled
  }

  buildFileFinder(root, closed)

  void liq.invoke('getIndexStatus').then(paint).catch(() => paint(null))
  return liq.on(PUSH.indexStatus, (st2: IndexStatus) => paint(st2))
}

interface FfShareRow {
  share: string; root: string; localRoot: string | null; files: number; ageHours?: number
}
interface FfHealth {
  enabled: boolean; url: string; status: unknown | null; shares: FfShareRow[]
}

function ageText(hours?: number): string {
  if (hours === undefined) return 'age unknown'
  if (hours < 1) return 'updated just now'
  if (hours < 48) return `updated ${Math.round(hours)}h ago`
  return `updated ${Math.round(hours / 24)}d ago`
}

/**
 * FileFinder — an index served by another machine. Separate group from the local
 * index because they are different things solving the same problem: this one
 * needs no scan here at all, but only helps someone who runs the server.
 */
function buildFileFinder(root: HTMLElement, closed: () => boolean): void {
  const s = app.settings
  const g = group(root, 'Server index (FileFinder)')
  g.appendChild(el('div', 'opt-note',
    'Answers name searches on network shares from an index kept by a server, instead of '
    + 'walking the share over SMB. Only affects folders the server actually indexes; '
    + 'everything else is unchanged.'))

  const statusLine = el('div', 'opt-status', '')
  const sharesLine = el('div', 'opt-note', '')

  const enable = check(g, 'Use a FileFinder server for searches on network shares', s.filefinderEnabled,
    v => { void app.setSettings({ filefinderEnabled: v }).then(() => refresh(true)) })

  const urlRow = el('div', 'opt-row')
  urlRow.appendChild(el('span', 'opt-inline-label', 'Server:'))
  const url = el('input', 'opt-input') as HTMLInputElement
  url.type = 'text'
  url.placeholder = 'http://host:8090'
  url.value = s.filefinderUrl
  url.addEventListener('change', () => {
    void app.setSettings({ filefinderUrl: url.value.trim() }).then(() => refresh(true))
  })
  urlRow.appendChild(url)
  g.appendChild(urlRow)
  g.append(statusLine, sharesLine)

  const actions = el('div', 'opt-row opt-actions')
  const test = el('button', 'btn btn-small', 'Test connection')
  test.addEventListener('click', () => { void refresh(true) })
  actions.append(test)
  g.appendChild(actions)

  async function refresh(force: boolean): Promise<void> {
    if (closed()) return
    enable.checked = app.settings.filefinderEnabled
    if (!app.settings.filefinderEnabled) {
      statusLine.textContent = 'Off — searches use the local index or a live walk.'
      statusLine.classList.remove('err')
      sharesLine.textContent = ''
      return
    }
    statusLine.textContent = 'Checking…'
    let h: FfHealth | null = null
    try { h = await liq.invoke(force ? 'ffReset' : 'ffHealth', true) as FfHealth } catch { h = null }
    if (closed()) return
    if (!h || !h.status) {
      statusLine.textContent = `Cannot reach ${app.settings.filefinderUrl} — searches fall back to a live walk.`
      statusLine.classList.add('err')
      sharesLine.textContent = ''
      return
    }
    statusLine.classList.remove('err')
    const total = h.shares.reduce((n, sh) => n + (sh.files || 0), 0)
    statusLine.textContent = `Connected — ${total.toLocaleString()} files indexed across ${h.shares.length} share(s).`
    // A share the server indexes but this machine has not mounted cannot be
    // used: its results would name local paths that do not exist.
    sharesLine.textContent = h.shares.length
      ? h.shares.map(sh => sh.localRoot
        ? `${sh.share} → ${sh.localRoot} (${ageText(sh.ageHours)})`
        : `${sh.share} → not mounted here, skipped`).join(' · ')
      : ''
  }

  void refresh(false)
}

function describe(s: IndexStatus): string {
  const n = (v: number): string => v.toLocaleString('en-US')
  switch (s.state) {
    case 'off': return 'Indexing is off — every search walks the folder tree live.'
    case 'idle': return 'No index yet — use Rebuild now to build one.'
    case 'scanning': return `Scanning ${s.scanning?.root ?? ''} — ${n(s.scanning?.seen ?? 0)} items found…`
    case 'error': return `Index error: ${s.error ?? 'unknown'}`
    default:
      return `Ready — ${n(s.files)} files, ${n(s.dirs)} folders · built ${formatDate(s.lastBuilt)} · ${formatSize(s.dbBytes)}`
  }
}
