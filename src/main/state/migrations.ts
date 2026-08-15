// Settings migrations.
//
// loadSettings() is a plain `{...DEFAULT_SETTINGS, ...stored}` merge, which means
// changing a default does NOTHING for anyone who already has that key written to
// disk — and every key gets written the first time the user touches Options.
// So a default that turns out to be wrong can only be corrected here.
//
// Rules:
//  - A migration runs at most once, gated on `settingsVersion`.
//  - It must be safe to run against a settings file from ANY older version,
//    including one where the key it edits is absent.
//  - It changes what the app DOES, so it only ever corrects a default the user
//    is unlikely to have chosen deliberately. Anything a user might reasonably
//    want kept is left alone.
import type { AppSettings } from '../../shared/types'

/** Bump this when adding a migration; it is the index one past the last one. */
export const SETTINGS_VERSION = 2

type Migration = (s: Record<string, unknown>) => void

/** Index i upgrades a file at version i to version i+1. */
const MIGRATIONS: Migration[] = [
  // 0 -> 1: stop claiming video for the in-app viewer.
  //
  // The viewer used to open every video, including ones Chromium has no decoder
  // for — which put a panel with a dead play button in front of the user instead
  // of letting their real player open. The default now excludes video; this
  // carries that correction to profiles that already stored the old list.
  //
  // Only the exact old default is rewritten. Someone who had deliberately picked
  // a different combination gets to keep it.
  (s) => {
    const kinds = s.mediaViewerKinds
    if (!Array.isArray(kinds)) return
    const was = [...kinds].sort().join(',')
    if (was !== 'audio,image,pdf,text,video') return
    s.mediaViewerKinds = kinds.filter(k => k !== 'video')
  },

  // 1 -> 2: claim video again — the reason for migration 0 is gone.
  //
  // Migration 0 removed video because the viewer could not actually play most
  // of it: no HEVC, no MPEG-2, no AC3, no demuxer for AVI/WMV/FLV, so opening a
  // video in-app frequently produced a panel with a dead play button. Handing
  // those files to the desktop's real player was the honest answer AT THE TIME.
  //
  // It is not the answer any more. platform/transcode.ts streams anything
  // ffmpeg can read, and playback falls through to it automatically — including
  // for the silent case where Chromium renders the picture and drops an audio
  // track it cannot decode. So the original objection no longer holds, and a
  // file manager that can show you the file is better than one that cannot.
  //
  // Same rule as before: only the list migration 0 produced is rewritten.
  // Anyone who has since chosen their own combination keeps it.
  (s) => {
    const kinds = s.mediaViewerKinds
    if (!Array.isArray(kinds)) return
    const was = [...kinds].sort().join(',')
    if (was !== 'audio,image,pdf,text') return
    s.mediaViewerKinds = [...kinds, 'video']
  },
]

/**
 * Bring a settings object read from disk up to date, in place.
 * Returns true when something changed and the file should be rewritten.
 */
export function migrateSettings(raw: Record<string, unknown>): boolean {
  const from = typeof raw.settingsVersion === 'number' ? raw.settingsVersion : 0
  if (from >= SETTINGS_VERSION) return false
  for (let v = Math.max(0, from); v < MIGRATIONS.length; v++) {
    try {
      MIGRATIONS[v](raw)
    } catch {
      // A broken migration must not make the app unstartable. Skipping one
      // leaves that correction unapplied, which is survivable; throwing here
      // would leave the user with no settings at all.
    }
  }
  raw.settingsVersion = SETTINGS_VERSION
  return true
}

/** Applied to DEFAULT_SETTINGS so a brand-new profile is not "version 0". */
export function stampVersion(s: AppSettings): AppSettings {
  return { ...s, settingsVersion: SETTINGS_VERSION }
}
