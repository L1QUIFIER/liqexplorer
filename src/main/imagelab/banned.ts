// Ported from projects/web/YandexLab/lib/banned.js — see imagelab/README.md.
//
// Known placeholders — images that download perfectly and are not the picture.
//
// "Picture Removed", "This image has been deleted", hotlink-protection banners, expired-CDN
// notices. They arrive as HTTP 200 with a valid image body, so nothing in the transport layer can
// flag them; only the pixels can. Measured on one real job: 44 of 914 saved files were the same
// PiXhost removal notice, filed under real photo titles.
//
// Each entry is a `dHash` fingerprint (see imagelab/imghash.ts). Matching is by Hamming distance,
// so a host re-encoding or rescaling its notice still matches. Validated against the sample: all
// copies scored distance 0, while six unrelated photographs scored 28–39 — the default tolerance
// of 6 sits in a very wide margin.
//
// `dims` is advisory only, shown in the UI. Matching NEVER uses dimensions: a size rule would ban
// every genuinely small image alongside the notice.
import type { BannedEntry } from './imghash'

/**
 * ⚠ A FINGERPRINT IS ONLY VALID FOR THE PIPELINE THAT PRODUCED IT.
 *
 * These hashes MUST be computed the way YandexLab's `fingerprint()` computes them — decode with
 * Electron's `nativeImage`, resize to 32×32 with `quality: 'good'`, hash the BGRA bitmap. The first
 * version of this list was seeded from an ImageMagick RGBA dump of the same file and produced
 * `0000a00000000002`; the runtime pipeline produces `0090b60000000607` for the identical image.
 * Nine bits apart — it would never have matched at any sane tolerance, and the feature would have
 * looked implemented while silently catching nothing.
 *
 * FOR THIS PORT that is a live constraint, not history: whatever LiqExplorer ends up decoding and
 * resizing with must reproduce that pipeline exactly, or this entry is dead weight. Verify against
 * a known sample before trusting it, and prefer adding entries through a "ban this as a
 * placeholder" action that fingerprints through the real path — a hand-computed hash cannot be
 * checked and will drift.
 */
export const BUILTIN_BANNED: BannedEntry[] = [
  {
    id: 'pixhost-removed',
    hash: '0090b60000000607',
    label: 'PiXhost — "Picture Removed"',
    dims: '257×126',
    builtin: true,
  },
]

/**
 * Why a placeholder is worth *retrying* rather than just discarding.
 *
 * A removal notice means that ONE mirror is dead, not that the picture is gone from the web. The
 * downloader walks a ladder of copies, so the right response is to reject this rung and continue —
 * which is why detection lives inside the fetch loop rather than as a post-pass over the folder.
 */
export const PLACEHOLDER_ACTION = 'try-next-source'
