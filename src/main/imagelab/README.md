# imagelab — the image-upgrade engine

Ported from **`projects/web/YandexLab/lib/`** (2026-08-15), phase 1 of
`docs/PLAN-better-images.md`. Nothing here is wired into the app yet; it is the engine the
"find a better version of this image" feature will be built on.

| module | what it decides |
|---|---|
| `upgrade.ts` | candidate "bigger" URLs for an image, by rewriting CDN size paths |
| `quality.ts` | `rungVerdict()` — is a downloaded copy genuinely the picture, or a placeholder |
| `imghash.ts` | dHash perceptual fingerprint + Hamming distance + flatness |
| `banned.ts` | known placeholder fingerprints ("Picture Removed" notices) |
| `imgsize.ts` | WebP dimensions from the container header, for what Electron cannot decode |
| `transport.ts` | "this host said no" vs "nothing is leaving this machine" |
| `names.ts` | safe filenames, correct extension from Content-Type |

`exits.js` (VPN exit bookkeeping) was **not** ported — it belongs to YandexLab's proxy rig, and its
own finding was that all ten exits share one address, so it buys nothing here. `yandex.js` (SERP
parsing, `cbir` URLs) arrived in **phase 3**, vendored rather than ported: see below.

## Tests

`scripts/test-imagelab.mjs` — 135 assertions, **carried across unchanged** from YandexLab's
`scripts/test-yandex.mjs`. That is the point of the port: it is only trustworthy if the tests that
caught the original bugs still pass against the TypeScript.

```
npm run test:imagelab
```

Offline, no network, no fixtures. The modules are TypeScript, so the runner transpiles them with
the esbuild the app already stages and imports the result.

## Two constraints that will silently break this if ignored

**1. A fingerprint is only valid for the pipeline that produced it.** `banned.ts`'s built-in hash
was computed by decoding with Electron's `nativeImage`, resizing to 32×32 at `quality: 'good'` and
hashing the **BGRA** bitmap. Seeding the same list from an ImageMagick RGBA dump of the identical
file produced a hash nine bits away — it would never have matched at any sane tolerance, and the
feature would have looked implemented while catching nothing. Whatever LiqExplorer decodes with
must reproduce that pipeline, or the entry is dead weight. Verify against a known sample.

**2. WebP cannot be decoded by `nativeImage`,** which is why `imgsize.ts` exists. A WebP that
measured 0×0 made `rungVerdict` return `unmeasurable`, the caller accepted it, and the walk stopped
before reaching the mirrors that had the real photo. Measured on one job: 1741 of 1744 JPEGs
carried a placeholder. The format the feature is named after is the one that broke its predecessor.

## A third, learned during this port

`names.js` is not a UTF-8 file — its `ILLEGAL_RE` contains two **raw control bytes** (0x00 and
0x1F) forming a `\x00-\x1f` range. `file` reports it as `data`, grep silently refuses to search it,
and a terminal renders the class as if it held a space and a hyphen. Transcribing what the screen
showed produced a port that ate hyphens out of every filename — a new instance of the module's own
founding bug, caught only by the ported test. The TypeScript uses proper `\x00-\x1f` escapes.

## Phase 2 (built)

`inspect.ts` · `fetch.ts` · `better.ts` · `replace.ts` — the local half of the feature, reachable
over IPC as `imageInspect`, `imageFindBetter`, `imageSaveBetter`. No search engine, no browser
window, no UI yet.

**Nothing is deleted.** A better copy is written *beside* the original as `name (better).jpg` and
verified after it lands. Swapping the files is left to the app's ordinary trash and rename, which
are already queued through the ops engine and already undoable — so this module never grows a
destructive path of its own. (`startOp` records undo but discards the awaitable handle, and
`runInternal` is awaitable but skips recording, so a main-side swap could have had one or the
other, not both.)

Three bars a candidate must clear, each from a measured failure: it must not be a known
**placeholder**, it must be **the same picture** (dHash within 10 bits — an unrelated photo
measured 37 bits away in testing), and it must be **meaningfully bigger** (1.2× area, because an
upscale is bigger and worse).

### The finding that shapes phase 3

Phase 2 was planned as "URL rewrite + source page", which assumes a local file can name where it
came from. It cannot, here. `user.xdg.origin.url` is the freedesktop convention for that, and the
CIFS share *does* support user extended attributes — but measured across this machine's Downloads,
**nothing sets it**: neither Firefox nor Chrome on Linux writes one. So the rewrite and page rungs
work perfectly (verified end to end against a local server) and have no input for an arbitrary
picture on disk.

That makes the reverse search phase 3's whole job rather than an optimisation: it is the only thing
that can turn a local file into a URL. Until then `imageFindBetter` is exercisable by handing it a
URL, and it reads the xattr when one exists.

## Phase 3 (built, verified live)

`cbir.ts` + `vendor/yandex.js` — the rung that turns a LOCAL file into a search. Reachable from
**Tools ▸ Find a better version…** (`src/renderer/dialogs/betterimage.ts`).

Yandex's old upload endpoint answers `400 Incorrect avatar size`, so instead the file is handed to
Yandex's OWN uploader in a hidden `BrowserWindow` via CDP `DOM.setFileInputFiles`, and the
`cbir_id` URL it navigates to is the answer. When they change the handshake, their page changes
with it.

Measured end to end on 2026-08-16, a 250×378 JPEG: handshake 1.5 s, whole run 12.5 s, result
844×1280 — **11.4× the area**. The engine also rejected a 4814×6896 candidate as
`different-picture`, which is the entire reason the dHash bar exists: it was by far the biggest
number on the page and it was not the same photograph.

### Three things this cost to learn

**1. The file input is a RACE, not a lookup.** `loadURL` resolves when the document has loaded;
Yandex builds the `input[type=file]` afterwards. A cold run took 3.6 s and worked. The very next
run, with the page cached, reached the query in **281 ms** and reported "Yandex may have changed
it" — same code, same site, opposite answer. It is a poll with a deadline now, and the document is
re-fetched each pass because nodeIds do not survive a DOM rebuild.

**2. Destroying the hidden window can quit the app.** With no other window open, Electron's default
`window-all-closed` fires and tears the process down mid-harvest. The app proper always has a main
window so it never sees this; `scripts/live-cbir.ts` has to install a no-op handler.

**3. `otherSizes` is empty for an upload.** Yandex's "other sizes" picker needs a picture it already
knows; an uploaded one has no original, so it returns nothing and the per-result `sizes` ladders
carry the whole load. Relying on `otherSizes` alone would return zero every time.

### What is NOT verified

The **captcha path** has not been seen live — `isCaptcha()` is exercised only by the fixtures. If a
captcha ever renders as something the fixtures do not cover, a block would read as "found nothing".

## The renderer never sees a remote URL

The renderer's CSP allows `img-src 'self' liqicon: liqthumb: liqfile: data:` and nothing remote,
deliberately: it is what stops a search result's address from becoming a request this app makes
just by rendering a page. So candidate previews are fetched in main and handed back as a `data:`
URL (`imagePreview`), downscaled to 480px. WebP passes through as raw bytes, because `nativeImage`
cannot decode it but Blink can.

Shared wire types live in `src/shared/imagelab.ts` and `main/imagelab` imports them BACK, so there
is one definition. The first draft kept a second copy and immediately invented a verdict
(`unmeasurable`) that `quality.ts` has never produced.

## Testing it live

```
bash scripts/live-cbir.sh /path/to/picture.jpg     # talks to Yandex under Xvfb on :99
```

## Phase 4 (built, verified live)

`batch.ts` + `src/renderer/dialogs/betterbatch.ts` — many pictures at once, as a **plan**. Selecting
more than one picture in Tools ▸ Find a better version… opens the table instead of the
single-picture dialog.

The scan writes nothing. It produces a list — thumbnail, what you have, the best candidate, the
gain — and every row starts **unticked**. Ticking is the approval; saving is a separate call with
only the rows the user chose. Rows can be expanded into the same side-by-side the single dialog
uses, because the engine can prove a candidate is the same picture and bigger but not that it is
the same crop.

Measured 2026-08-16 on four pictures (three real, one deliberately corrupt): 3 of 4 found copies at
13.1×, 11.6× and 11.4× the area, sorted biggest-gain-first; the corrupt file reported "could not be
measured" with its checkbox disabled; all three saved beside untouched originals.

### The stop rule is the reason this module exists

Rule 4 of the plan says batch cannot ship without it, and it is the one behaviour whose failure is
SILENT — a run that marks everything bad and reports success. So:

- One `OutageDetector` spans the **whole run**, not one file. It has to: `findBetter` already bails
  after the first transport error within a file, so each file contributes at most one piece of
  evidence.
- The decision lives in `transport.ts` as `observeCandidates()`, deliberately away from anything
  that imports Electron, so `scripts/test-imagelab.mjs` can test it with no network and no window.
  Seven assertions cover it, including the two that matter most: **a single success anywhere clears
  the streak** (the only evidence a route works is traffic on it), and **five timeouts against one
  host are a slow host, not an outage**.
- One file that cannot reach anything is marked `error`, not `nothing` — "nothing better found" is
  a lie when nothing was ever looked at.

### Two things found by looking rather than asserting

**dHash is blind to aspect ratio.** It resamples to a fixed 9×8 grid, so a differently *cropped*
copy passes the same-picture test legitimately — a 250×293 portrait matched a 1200×800 landscape,
and both really were the same painting. `aspectWarning()` now flags it in both dialogs. It is a
warning, not a bar: sometimes the wider copy is the uncropped original, sometimes it is a banner
with the subject off-centre, and only the person looking can tell.

**The plan has to arrive whole.** The first build emitted only rows that CHANGED, so a 40-picture
selection showed an empty box that trickled, and on Stop the rows never reached stayed invisible.
`BatchProgress.rows` now carries the full list twice — once before any work, once at the end.

### Renderer trap worth remembering

`liq.on()` RETURNS its unsubscribe; there is no `liq.off`. Writing `liq.off?.(…)` type-checks,
does nothing, and leaks a listener per dialog reopen — the stale ones keep painting rows into a
dialog that is no longer on screen.

## The sibling tool

`platform/similar.ts` + `renderer/dialogs/similar.ts` — "Find repeated pictures on this PC" — runs
the SAME perceptual comparison against your own disk instead of the web. It is not part of
imagelab (it uses ImageMagick rather than `nativeImage`, because it must survive formats
`nativeImage` cannot decode), but it answers the other half of the question and the two dialogs
hand off to each other: the repeats dialog ends with "Look for better versions of the keepers".

Three things were wrong with it and are worth not repeating:

- **It rendered through the generic text report** — a name and a byte count per row. The question
  it asks is "which of these pictures do you want to keep", and it never showed a picture.
- **It reported no progress.** One ImageMagick process per picture, then an all-pairs comparison,
  all invisible, then a dialog appeared. Indistinguishable from a hang, and unstoppable.
- **It picked the keeper by BYTES.** A re-saved PNG is regularly larger on disk and smaller in
  pixels than the JPEG beside it, so it recommended deleting the higher-resolution copy. Verified
  against a deliberate case: 300x454 at 243 KB versus 500x756 at 113 KB. It keeps pixels now, and
  bytes only break ties.

Stop keeps its work: cancelling during fingerprinting groups what was already done (measured: 156
of 300) rather than discarding it and reporting "0 checked, no repeats found".
