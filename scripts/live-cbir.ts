// A LIVE check of the phase-3 reverse-image rung. Not part of the test suite — it talks to Yandex.
//
//   bash scripts/live-cbir.sh /path/to/image.jpg
//
// It answers the only questions the offline suite cannot: does the hidden-window upload handshake
// still work against Yandex's current uploader, does the URL it hands back carry a cbir_id, and
// does forcing cbir_page=similar actually turn that into results.
import { app } from 'electron'
import { reverseUrlForFile, harvest } from '../src/main/imagelab/cbir'
import { findBetter } from '../src/main/imagelab/better'
import { inspectImage } from '../src/main/imagelab/inspect'

// a hidden window still needs a GPU-less Chromium to come up cleanly on :99
app.commandLine.appendSwitch('disable-gpu')
// The handshake window is the ONLY window this harness ever opens, so destroying it trips
// Electron's default "all windows closed -> quit" and tears the process down in the middle of the
// harvest that follows. The app proper never sees this because it always has a main window.
app.on('window-all-closed', () => { /* the script decides when it is finished */ })

const file = process.argv[process.argv.length - 1]

async function main(): Promise<void> {
  console.log('file:', file)
  const facts = await inspectImage(file)
  console.log('local:', facts.width + '×' + facts.height, facts.ext, facts.bytes + 'B')

  console.log('\n--- 1. upload handshake')
  const t0 = Date.now()
  const rev = await reverseUrlForFile(file)
  console.log('took', Date.now() - t0, 'ms ->', JSON.stringify(rev))
  if (!rev.ok || !rev.url) { app.exit(1); return }

  console.log('\n--- 2. harvest')
  const serp = await harvest(rev.url)
  console.log('ok=%s captcha=%s items=%d otherSizes=%d hasNext=%s',
    serp.ok, serp.captcha, serp.items.length, serp.otherSizes.length, serp.hasNext)
  if (serp.error) console.log('error:', serp.error)
  for (const s of serp.otherSizes.slice(0, 5)) console.log('  otherSize', s.w + '×' + s.h, s.url.slice(0, 90))
  for (const it of serp.items.slice(0, 3)) {
    console.log('  item', it.width + '×' + it.height, it.domain, '|', it.title.slice(0, 50))
  }

  console.log('\n--- 3. findBetter end to end (useSearch)')
  const t1 = Date.now()
  const res = await findBetter(file, undefined, undefined, true)
  console.log('took', Date.now() - t1, 'ms')
  console.log('ok=%s captcha=%s tried=%d', res.ok, res.captcha, res.tried.length)
  if (res.error) console.log('error:', res.error)
  for (const t of res.tried.slice(0, 12)) {
    console.log('  ', t.verdict ?? '-', t.width ? t.width + '×' + t.height : '', t.origin, t.url.slice(0, 80))
  }
  if (res.best) {
    console.log('BEST:', res.best.width + '×' + res.best.height, res.best.url)
    const gain = (res.best.width * res.best.height) / Math.max(1, facts.width * facts.height)
    console.log('gain:', gain.toFixed(1) + '× the area of the local copy')
  }
  app.exit(0)
}

app.whenReady().then(main).catch(e => { console.error('FAILED', e); app.exit(1) })
