// The extension store's vocabulary, shared by the fetcher/installer in main
// (platform/extstore.ts) and the browse panel in the renderer.
//
// WHERE THE EXTENSIONS COME FROM. Nemo actions have exactly one curated
// registry: Cinnamon Spices (cinnamon-spices.linuxmint.com), the same place
// Mint's own "Add actions" dialog uses. It publishes a JSON index of every
// action with a score, an author and a zip, which is what makes a searchable
// store possible at all. GitHub hosts plenty of individual actions but is not
// an index of them, so "search everywhere" honestly means: search the registry,
// and install anything else from a file or a URL.

/** One action as the registry describes it. */
export interface StoreEntry {
  uuid: string
  name: string
  description: string
  author: string
  /** the registry's score (upvotes); the closest thing to popularity it has */
  score: number
  /** epoch seconds of the last edit upstream — how "update available" is decided */
  lastEdited: number
  /** bytes, from the index, so the size is known before the download starts */
  size: number
  /** liqfile:// URL of the cached icon, '' when there is none yet */
  icon: string
  installed: boolean
  /** installed, but the registry has a newer version */
  updatable: boolean
}

export interface StoreIndex {
  ok: boolean
  entries: StoreEntry[]
  /** epoch ms the index was fetched; 0 when it has never been fetched */
  fetchedAt: number
  /** true when the network failed and this came from the on-disk cache */
  stale: boolean
  error?: string
}

/**
 * What an extension will actually DO, shown before it is installed.
 *
 * A Nemo action's Exec is a command line that runs with the user's privileges,
 * and a Spices package can ship its own shell scripts for it to call. That is
 * the entire threat model of this feature, so the answer is not a warning in
 * the abstract — it is this: the exact command, the scripts that come with it,
 * and what it says it needs.
 */
export interface ExtensionPreview {
  ok: boolean
  error?: string
  uuid: string
  name: string
  comment: string
  author: string
  /** the Exec line, verbatim */
  exec: string
  /** relative paths of executable files in the package */
  scripts: string[]
  /** binaries the action declares it needs */
  dependencies: string[]
  /** conditions it declares; 'exec' ones run a script to decide applicability */
  conditions: string[]
  /** total unpacked bytes */
  size: number
}

export interface InstallResult {
  ok: boolean
  error?: string
  /** absolute path of the installed .nemo_action */
  file?: string
  name?: string
}

/** Hard limits. A registry entry is a few hundred KB; anything near these is
 *  not an action and should be refused rather than streamed to disk. */
export const STORE = {
  indexUrl: 'https://cinnamon-spices.linuxmint.com/json/actions.json',
  baseUrl: 'https://cinnamon-spices.linuxmint.com',
  /** re-fetch the index at most this often; the cache serves the rest */
  indexTtlMs: 6 * 60 * 60 * 1000,
  /** a download bigger than this is refused outright */
  maxDownloadBytes: 25 * 1024 * 1024,
  /** every network call gets one of these */
  timeoutMs: 25_000,
  /** an `exec` condition that has not answered by now is treated as "no" */
  conditionTimeoutMs: 1500,
} as const
