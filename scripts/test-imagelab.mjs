/**
 * Offline tests for src/main/imagelab — the engine ported from YandexLab.
 *
 * These are the ORIGINAL assertions from YandexLab's scripts/test-yandex.mjs, carried across
 * unchanged. That is the whole point of the exercise: the port is only trustworthy if the tests
 * that caught the original bugs still pass against the TypeScript. Every one of them encodes a
 * failure that actually happened — the digit-eating filename regex, the WebP that could not be
 * measured and was therefore waved through, the dead tunnel that marked 5,132 images failed.
 *
 * Nothing here touches the network or the filesystem beyond this project, so it stays green on a
 * dead uplink. The modules are TypeScript, so they are transpiled to a temp dir with the esbuild
 * the app already stages, then imported.
 *
 * Run: node scripts/test-imagelab.mjs
 */
import { execFileSync } from 'node:child_process'
import { readFileSync, existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { mkdtempSync, rmSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import path from 'node:path'

const here = path.dirname(fileURLToPath(import.meta.url))
const src = path.join(here, '..', 'src', 'main', 'imagelab')
const esbuild = process.env.ESBUILD_BINARY_PATH
  || path.join(process.env.HOME, '.cache/liq-run/liqexplorer/esbuild')

const out = mkdtempSync(path.join(tmpdir(), 'imagelab-test-'))
process.on('exit', () => { try { rmSync(out, { recursive: true, force: true }) } catch {} })

const NAMES = ['names', 'quality', 'imgsize', 'imghash', 'banned', 'transport', 'upgrade']
const SHARED = ['imagelab']
execFileSync(esbuild, [
  ...NAMES.map(n => path.join(src, n + '.ts')),
  '--format=esm', '--platform=node', '--outdir=' + out,
], { stdio: ['ignore', 'ignore', 'inherit'] })
// A SEPARATE call: esbuild re-roots its output on the common parent of all entry points, so mixing
// main/imagelab with shared/ silently moves everything into subdirectories.
execFileSync(esbuild, [
  ...SHARED.map(n => path.join(here, '..', 'src', 'shared', n + '.ts')),
  '--format=esm', '--platform=node', '--outdir=' + path.join(out, 'shared'),
], { stdio: ['ignore', 'ignore', 'inherit'] })

/** every module under its YandexLab alias, so the assertions below are untouched */
const M = {}
for (const n of NAMES) M[n] = await import(path.join(out, n + '.js'))
for (const n of SHARED) M[n] = await import(path.join(out, 'shared', n + '.js'))

/** the VENDORED parser, required as-is — the same file the app bundles */
const require = createRequire(import.meta.url)
const Y = require(path.join(src, 'vendor', 'yandex.js'))

let pass = 0
let fail = 0
function ok(cond, name, extra) {
  if (cond) {
    pass++
    console.log(`  \u2713 ${name}`)
  } else {
    fail++
    console.log(`  \u2717 ${name}${extra ? ' \u2014 ' + extra : ''}`)
  }
}
function eq(a, b, name) {
  ok(a === b, name, `got ${JSON.stringify(a)}, want ${JSON.stringify(b)}`)
}

console.log('\nFilenames (the digit-eating regex)')
{
  const N = M.names
  // The bug: `[ -<>…]` made a range over 0x20–0x3C, deleting every digit from every filename.
  eq(N.safeName('Photo 2024 test'), 'Photo 2024 test', 'digits survive')
  eq(N.safeName('Sunset [1080x1523]'), 'Sunset [1080x1523]', 'a resolution suffix survives intact')
  eq(N.safeName('12345'), '12345', 'an all-digit title is not swallowed into the fallback')
  eq(N.safeName('well-known name'), 'well-known name', 'hyphens survive')
  eq(N.safeName('café niño 東京'), 'café niño 東京', 'unicode survives')

  ok(!/[<>:"/\\|?*]/.test(N.safeName('a<b>c:d"e/f\\g|h?i*j')), 'every Windows-reserved character is removed')
  eq(N.safeName('   '), 'image', 'a blank title falls back')
  eq(N.safeName(null), 'image', 'null falls back rather than throwing')
  eq(N.safeName('trailing dot.'), 'trailing dot', 'a trailing dot is trimmed (Windows refuses it)')
  eq(N.safeName('CON'), '_CON', 'a reserved device name is escaped')
  ok(N.safeName('x'.repeat(400)).length <= 110, 'over-long names are truncated')

  eq(N.extFromUrl('https://e.com/a.jpg', ''), '.jpg', 'extension from the URL')
  eq(N.extFromUrl('https://e.com/a.jpg', 'image/webp'), '.webp', 'Content-Type WINS over a lying URL')
  eq(N.extFromUrl('https://e.com/a?x=1', ''), '.jpg', 'a URL with no extension defaults to .jpg')
  eq(N.extFromUrl('https://e.com/a.JPEG', ''), '.jpg', 'JPEG normalises to .jpg')
  eq(N.extFromUrl('not a url', 'image/png'), '.png', 'an unparseable URL still uses the type')

  eq(N.nameWithDims('Sunset', 1200, 800), 'Sunset [1200x800]', 'verified dimensions are appended')
  eq(N.nameWithDims('Sunset', 0, 0), 'Sunset', 'unknown dimensions append nothing')
}

console.log('\nURL upgrades (thumbnail → original)')
{
  const U = M.upgrade
  const has = (url, want) => U.upgradeCandidates(url).some((c) => c.includes(want))

  ok(has('https://i.pinimg.com/236x/40/bd/5c/abc.jpg', '/originals/'), 'pinimg 236x → originals')
  ok(has('https://i.pinimg.com/474x/40/bd/5c/abc.jpg', '/originals/'), 'pinimg 474x → originals')
  ok(
    U.upgradeCandidates('https://upload.wikimedia.org/wikipedia/commons/thumb/a/ab/Cat.jpg/800px-Cat.jpg')
      .some((c) => c.endsWith('/commons/a/ab/Cat.jpg')),
    'wikimedia thumb → the original path'
  )
  ok(
    U.upgradeCandidates('https://i0.wp.com/site.com/img.jpg?w=300&ssl=1').some((c) => !/[?&]w=/.test(c)),
    'wp.com photon: the size parameters are dropped'
  )
  ok(has('https://i.ytimg.com/vi/abc/hqdefault.jpg', 'maxresdefault'), 'ytimg hqdefault → maxresdefault')
  ok(has('https://64.media.tumblr.com/abc_500.jpg', '_1280.jpg'), 'tumblr _500 → _1280')
  ok(has('https://cdn.shopify.com/s/files/1/img_400x.jpg', 'img.jpg'), 'shopify size suffix is stripped')

  eq(U.upgradeCandidates('https://i.pinimg.com/originals/a/b/c.jpg').length, 0, 'an already-original pinimg yields no guess')
  eq(U.upgradeCandidates('not a url').length, 0, 'garbage yields nothing rather than throwing')
  eq(U.upgradeCandidates('').length, 0, 'empty yields nothing')
  ok(U.upgradeCandidates('https://x.com/a.jpg?w=100').every((c) => c !== 'https://x.com/a.jpg?w=100'), 'a candidate is never the input itself')

  ok(U.isYandexPreview('https://avatars.mds.yandex.net/i?id=abc'), 'a Yandex preview is recognised')
  ok(!U.isYandexPreview('https://i.pinimg.com/originals/a.jpg'), 'a third-party original is not a preview')
  ok(
    U.isThumbnailOnly({ sources: ['https://avatars.mds.yandex.net/i?id=a'] }),
    'an item with only a Yandex preview is thumbnail-only — the case worth spending a search on'
  )
  ok(
    !U.isThumbnailOnly({ sources: ['https://i.pinimg.com/originals/a.jpg', 'https://avatars.mds.yandex.net/i?id=a'] }),
    'an item with a real original is not thumbnail-only'
  )
  ok(U.isThumbnailOnly({ sources: [] }), 'an item with no sources counts as thumbnail-only')
}


console.log('\nPlaceholder fingerprints')
{
  const H = M.imghash
  const B = M.banned

  // Synthetic pixels: a left-dark/right-light split, and its inverse.
  const make = (fn, w = 32, h = 32) => {
    const data = Buffer.alloc(w * h * 4)
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const v = fn(x, y, w, h), p = (y * w + x) * 4
      data[p] = v; data[p + 1] = v; data[p + 2] = v; data[p + 3] = 255
    }
    return { data, width: w, height: h, order: 'rgba' }
  }
  const split = make((x, _y, w) => (x < w / 2 ? 20 : 230))
  const flat = make(() => 128)
  const noise = make((x, y) => ((x * 37 + y * 91) % 256))

  eq(H.dHash(split).length, 16, 'a fingerprint is 16 hex characters (64 bits)')
  eq(H.hamming(H.dHash(split), H.dHash(split)), 0, 'the same image fingerprints identically')
  ok(H.hamming(H.dHash(split), H.dHash(noise)) > 10, 'different images fingerprint differently')

  // Scale invariance is the whole point: a host re-serving its notice smaller must still match.
  const half = make((x, _y, w) => (x < w / 2 ? 20 : 230), 16, 16)
  ok(H.hamming(H.dHash(split), H.dHash(half)) <= 6, 'rescaling does not change the fingerprint much')

  ok(H.flatness(flat) < 0.02, 'a solid colour reads as flat')
  ok(H.flatness(noise) > 0.1, 'a busy image does not')

  eq(H.dHash({ data: Buffer.alloc(4), width: 1, height: 1 }), '', 'a 1px image yields no fingerprint rather than a colliding one')
  eq(H.dHash(null), '', 'null yields no fingerprint rather than throwing')
  eq(H.hamming('abc', ''), 64, 'an incomparable pair is maximally distant, never accidentally close')

  // BGRA vs RGBA is a silent-wrongness bug, so it must actually differ.
  const red = { data: Buffer.from([255, 0, 0, 255, 0, 0, 255, 255]), width: 2, height: 1 }
  ok(
    H.toGray({ ...red, order: 'rgba' })[0] !== H.toGray({ ...red, order: 'bgra' })[0],
    'channel order is honoured (getBitmap returns BGRA; treating it as RGBA hashes the wrong thing)'
  )

  const banned = [{ id: 'x', hash: H.dHash(split), label: 'test' }]
  ok(H.matchBanned(H.dHash(split), banned), 'an exact match is caught')
  ok(!H.matchBanned(H.dHash(noise), banned), 'an unrelated image is not')
  ok(!H.matchBanned('', banned), 'an empty fingerprint never matches')

  ok(B.BUILTIN_BANNED.some((b) => b.hash === '0090b60000000607'), 'the PiXhost removal notice ships as a built-in (hash from the RUNTIME pipeline, not ImageMagick)')
  ok(B.BUILTIN_BANNED.every((b) => b.hash && b.label), 'every built-in has a fingerprint and a label')
  ok(B.BUILTIN_BANNED.every((b) => /^[0-9a-f]{16}$/.test(b.hash)), 'every built-in hash is a well-formed 64-bit fingerprint')
}


console.log('\nWebP dimensions without a decoder')
{
  const S = M.imgsize

  /** Build a minimal but structurally real WebP: RIFF header, one chunk, padded past 30 bytes. */
  const riff = (tag, payload) => {
    const head = Buffer.alloc(12)
    head.write('RIFF', 0, 'latin1')
    head.writeUInt32LE(4 + 8 + payload.length, 4)
    head.write('WEBP', 8, 'latin1')
    const ch = Buffer.alloc(8)
    ch.write(tag, 0, 'latin1')
    ch.writeUInt32LE(payload.length, 4)
    return Buffer.concat([head, ch, payload, Buffer.alloc(16)])
  }
  const lossy = (w, h) => {
    const p = Buffer.alloc(10)
    p.set([0, 0, 0, 0x9d, 0x01, 0x2a], 0)
    p.writeUInt16LE(w, 6)
    p.writeUInt16LE(h, 8)
    return riff('VP8 ', p)
  }
  const lossless = (w, h) => {
    const p = Buffer.alloc(5)
    p[0] = 0x2f
    p.writeUInt32LE((w - 1) | ((h - 1) << 14), 1)
    return riff('VP8L', p)
  }
  const extended = (w, h) => {
    const p = Buffer.alloc(10)
    p.writeUIntLE(w - 1, 4, 3)
    p.writeUIntLE(h - 1, 7, 3)
    return riff('VP8X', p)
  }

  const a = S.webpSize(lossy(1920, 1080))
  eq(a && a.width, 1920, 'simple lossy width')
  eq(a && a.height, 1080, 'simple lossy height')
  eq(a && a.kind, 'lossy', 'and reports which variant it read')

  const b = S.webpSize(lossless(800, 600))
  eq(b && b.width, 800, 'lossless width (14 bits, stored minus one)')
  eq(b && b.height, 600, 'lossless height')

  const c = S.webpSize(extended(4000, 3000))
  eq(c && c.width, 4000, 'extended/animated canvas width (24 bits, stored minus one)')
  eq(c && c.height, 3000, 'extended canvas height')

  // The largest each field can hold — an off-by-one in the masking shows up here and nowhere else.
  const big = S.webpSize(lossy(16383, 16383))
  eq(big && big.width, 16383, 'the 14-bit ceiling reads back exactly')

  // Null means UNKNOWN. Callers treat 0×0 as unproven, so a wrong guess here is worse than no answer.
  eq(S.webpSize(Buffer.from('not an image at all, really no')), null, 'a non-WebP buffer is null, not a size')
  eq(S.webpSize(Buffer.alloc(0)), null, 'an empty buffer is null')
  eq(S.webpSize(lossy(640, 480).subarray(0, 20)), null, 'a truncated header is null rather than a guess')
  const jpegish = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(40)])
  eq(S.webpSize(jpegish), null, 'a JPEG is not mistaken for a WebP')
  const noSync = lossy(100, 100)
  noSync[23] = 0x00
  eq(S.webpSize(noSync), null, 'a lossy chunk without its sync code is refused')
}

console.log('\nJudging a copy before saving it')
{
  const Q = M.quality
  const v = (p) => Q.rungVerdict(p).verdict

  // A rung that makes its own claim is held to it tightly.
  eq(v({ claimW: 4000, claimH: 3000, realW: 4000, realH: 3000 }), 'accept', 'a copy that delivers its claim is taken')
  eq(v({ claimW: 4000, claimH: 3000, realW: 3000, realH: 2200 }), 'accept', 'and so is one that broadly delivers it')
  eq(v({ claimW: 4000, claimH: 3000, realW: 160, realH: 120 }), 'undersized', 'a 160×120 standing in for 4000×3000 is refused')

  // With no claim of its own — a CDN upgrade guess — it is judged against what the SERP advertised
  // for the picture, leniently, because the picture may genuinely not exist that large anywhere.
  eq(v({ advertisedW: 375, advertisedH: 500, realW: 257, realH: 126 }), 'undersized',
    'the real case: a 257×126 notice cannot stand in for a 375×500 photo')
  eq(v({ advertisedW: 375, advertisedH: 500, realW: 340, realH: 460 }), 'accept',
    'but a copy merely a little smaller than advertised is fine')
  eq(v({ advertisedW: 4000, advertisedH: 3000, realW: 2000, realH: 1500 }), 'accept',
    'half the advertised width is a quarter of the area — still accepted, the ad is a weak signal')

  // The claim on the rung wins over the item's advertised size, being a promise about THAT file.
  eq(v({ claimW: 200, claimH: 200, advertisedW: 4000, advertisedH: 3000, realW: 200, realH: 200 }), 'accept',
    'a small rung that is honest about being small is taken, whatever the item advertises')

  eq(v({ realW: 800, realH: 600 }), 'accept', 'nothing to check against → accepted, as before')
  eq(v({ claimW: 4000, claimH: 3000, realW: 0, realH: 0 }), 'unmeasurable',
    'what cannot be measured is never rejected — it is reported as unmeasurable')
  eq(v({}), 'unmeasurable', 'and an empty judgement is unmeasurable, not an accept')
}

console.log('\nTelling a dead tunnel from a dead host')
{
  const T = M.transport
  const proxyDown = new Error('net::ERR_PROXY_CONNECTION_FAILED')
  const socksDown = new Error('net::ERR_SOCKS_CONNECTION_FAILED')
  const hostUnreachable = new Error('net::ERR_SOCKS_CONNECTION_HOST_UNREACHABLE')

  ok(T.isTransportDown(proxyDown), 'a refused proxy is a transport failure')
  ok(T.isLocalTransport(proxyDown), 'and it can only be our side')
  ok(T.isTransportDown(hostUnreachable), 'the proxy failing to reach a host is a transport failure')
  ok(!T.isLocalTransport(hostUnreachable), 'but it might be that one host, so it is not conclusive')
  ok(!T.isTransportDown(new Error('HTTP 404')), 'a 404 is the host, not the route')
  ok(!T.isTransportDown(new Error('too small (503 bytes)')), 'and so is a block page')
  ok(!T.isTransportDown(null), 'no error is not an outage')
  ok(T.isTransportDown('net::ERR_TUNNEL_CONNECTION_FAILED'), 'a bare string works too — errors arrive both ways')

  // Three proxy-refused in a row is conclusive even from ONE host: the crawl's search side only ever
  // talks to Yandex, and it has to be able to report an outage.
  {
    const d = T.makeOutageDetector()
    ok(!d.fail(proxyDown, 'yandex.ru'), 'one is not an outage')
    ok(!d.fail(proxyDown, 'yandex.ru'), 'two is not an outage')
    ok(d.fail(proxyDown, 'yandex.ru'), 'three proxy-refused from one host IS an outage')
  }
  // A success in between proves traffic flows, so the streak has to start over.
  {
    const d = T.makeOutageDetector()
    d.fail(proxyDown, 'a.com')
    d.fail(proxyDown, 'a.com')
    d.ok()
    ok(!d.fail(proxyDown, 'a.com'), 'a success in the middle resets the streak')
  }
  // A normal failure also proves the route works — it got an answer from somewhere.
  {
    const d = T.makeOutageDetector()
    d.fail(proxyDown, 'a.com')
    d.fail(proxyDown, 'a.com')
    ok(!d.fail(new Error('HTTP 404'), 'a.com'), 'a 404 clears it too — something answered')
  }
  // One unreachable host must never pause a job that is otherwise fine.
  {
    const d = T.makeOutageDetector()
    let tripped = false
    for (let i = 0; i < 10; i++) tripped = d.fail(hostUnreachable, 'onebadcdn.com') || tripped
    ok(!tripped, 'ten host-unreachables from ONE host is that host, not an outage')
    const d2 = T.makeOutageDetector()
    let t2 = false
    const hosts = ['a.com', 'b.com', 'c.com']
    for (let i = 0; i < 6; i++) t2 = d2.fail(hostUnreachable, hosts[i % 3]) || t2
    ok(t2, 'but six across three hosts is the route')
  }
  eq(T.makeOutageDetector().fail(socksDown, 'a.com'), false, 'the detector never trips on the first error')

  // A blackholed proxy produces no error of its own — only silence. The deadline wrapper turns that
  // into an error carrying `timedOut`, which has to count without string-matching the message.
  {
    const ourTimeout = Object.assign(new Error('no reply in 60s (image)'), { timedOut: true })
    ok(T.isTransportDown(ourTimeout), 'our own deadline counts as a transport failure')
    ok(!T.isLocalTransport(ourTimeout), 'but leniently — one slow host times out too')
    ok(T.isTransportDown(new Error('net::ERR_TIMED_OUT')), "and so does Chromium's own timeout")

    const d = T.makeOutageDetector()
    let tripped = false
    for (let i = 0; i < 10; i++) tripped = d.fail(ourTimeout, 'slowhost.com') || tripped
    ok(!tripped, 'ten timeouts from ONE host is a slow host, not a dead route')

    const d2 = T.makeOutageDetector()
    let t2 = false
    for (let i = 0; i < 6; i++) t2 = d2.fail(ourTimeout, `host${i}.com`) || t2
    ok(t2, 'six across six hosts with nothing succeeding IS a dead route')
  }
}


console.log('\nSERP parsing (live fixtures)')
{
  const fx = path.join(here, 'fixtures')
  const p0 = path.join(fx, 'serp-p0.html')
  const p1 = path.join(fx, 'serp-p1.html')
  if (!existsSync(p0)) {
    console.log('  ! fixtures missing — run fixtures/refresh.sh (needs the VPN gateway)')
  } else {
    const a = Y.parseSerp(readFileSync(p0, 'utf8'), 'https://yandex.com/images/search')
    ok(!a.captcha, 'fixture is not a captcha page')
    ok(a.items.length >= 20, `page 0 yields a full page of results (${a.items.length})`)
    ok(a.hasNext, 'page 0 reports a next page')
    eq(a.nextPage, 1, 'and names it as p=1')

    const it = a.items[0]
    ok(Boolean(it.id), 'items carry an id')
    ok(/^https:\/\//.test(it.thumb), 'thumb is absolute https (Yandex ships it scheme-relative)')
    ok(it.sources.length >= 1, 'items carry at least one full-size source')
    ok(it.sources.every((s) => /^https?:\/\//.test(s)), 'every source is absolute')
    ok(new Set(it.sources).size === it.sources.length, 'the source chain has no duplicates')
    ok(it.width > 0 && it.height > 0, 'dimensions are populated')
    ok(typeof it.title === 'string', 'title is a string even when absent')

    if (existsSync(p1)) {
      const b = Y.parseSerp(readFileSync(p1, 'utf8'), 'https://yandex.com/images/search?p=1')
      ok(b.items.length >= 20, `page 1 yields results too (${b.items.length})`)
      const ids = new Set(a.items.map((x) => x.id))
      const overlap = b.items.filter((x) => ids.has(x.id)).length
      ok(overlap > 0, `pages overlap (${overlap}/${b.items.length}) — proving dedup is required, not defensive`)
      ok(overlap < b.items.length, 'but page 1 is mostly new')
    }
  }

  if (existsSync(p0)) {
    const a = Y.parseSerp(readFileSync(p0, 'utf8'), 'https://yandex.com/images/search')
    console.log('\nSize ladder (what "best quality" chooses from)')
    const multi = a.items.filter((i) => i.sizes.length > 1)
    ok(multi.length > 0, `results carry more than one size (${multi.length}/${a.items.length} do)`)
    const it = multi[0] || a.items[0]
    const areas = it.sizes.map((s) => s.w * s.h)
    ok(areas.every((v, i) => i === 0 || areas[i - 1] >= v), 'the ladder is sorted largest-area first')
    ok(new Set(it.sizes.map((s) => s.url)).size === it.sizes.length, 'no duplicate URLs on the ladder')
    ok(it.sizes.every((s) => /^https:\/\//.test(s.url)), 'every rung is an absolute https URL')
    ok(
      JSON.stringify(it.sources) === JSON.stringify(it.sizes.map((s) => s.url)),
      'sources mirror the ladder, so the stage and the downloader agree on preference order'
    )
    const thumbRung = it.sizes[it.sizes.length - 1]
    ok(/avatars\.mds\.yandex\.net/.test(thumbRung.url), 'the Yandex-hosted thumb is the LAST resort, not the first')
    ok(Array.isArray(a.otherSizes), 'otherSizes is always an array, even when Yandex ships an object')
  }

  const junk = Y.parseSerp('<html><body>nothing here</body></html>', 'https://yandex.com/images/search')
  ok(!junk.captcha && junk.items.length === 0 && junk.empty, 'an unparseable page is empty, not a crash')
  ok(junk.unparsed, 'and says it could not find a state blob')
}


// ---------------------------------------------------------------- batch stop rule (phase 4)
//
// New here, not carried across: YandexLab downloaded into a folder, so it never had to decide
// whether to keep consuming a QUEUE OF FILES. These test the wiring that decides it, because the
// failure being prevented is silent — a run that marks everything bad and reports success.
{
  console.log('\nbatch stop rule')
  const T = M.transport
  const cand = (url, code) => ({ url, transport: !!code, errorCode: code || '' })
  const PROXY = 'net::ERR_PROXY_CONNECTION_FAILED'
  const TIMEOUT = 'net::ERR_TIMED_OUT'

  // one file's worth of candidates that all answered: no evidence of anything
  {
    const d = T.makeOutageDetector()
    ok(!T.observeCandidates(d, [cand('https://a.example/1.jpg'), cand('https://b.example/2.jpg')]),
      'candidates that answered are not evidence of an outage')
    eq(d.streak, 0, 'and leave no streak behind')
  }

  // the real shape of a dead tunnel: findBetter bails after the FIRST transport error, so each
  // file contributes exactly one — which is why the detector has to span files
  {
    const d = T.makeOutageDetector()
    const one = () => T.observeCandidates(d, [cand('https://a.example/x.jpg', PROXY)])
    ok(!one(), 'one proxy-refused file is not an outage')
    ok(!one(), 'two is still not an outage')
    ok(one(), 'three in a row IS the route being gone')
  }

  // a success anywhere in the run clears it — the only evidence a route works is traffic on it
  {
    const d = T.makeOutageDetector()
    T.observeCandidates(d, [cand('https://a.example/1.jpg', PROXY)])
    T.observeCandidates(d, [cand('https://a.example/2.jpg', PROXY)])
    T.observeCandidates(d, [cand('https://b.example/3.jpg')])          // one worked
    ok(!T.observeCandidates(d, [cand('https://a.example/4.jpg', PROXY)]),
      'a single success resets the streak, so the next failure starts from one')
  }

  // and within ONE file: candidates are shown in order, so a success partway down clears what
  // came above it
  {
    const d = T.makeOutageDetector()
    ok(!T.observeCandidates(d, [
      cand('https://a.example/1.jpg', PROXY),
      cand('https://a.example/2.jpg', PROXY),
      cand('https://a.example/3.jpg'),                                 // answered
      cand('https://a.example/4.jpg', PROXY),
    ]), 'a success partway down one file clears the failures above it')
  }

  // timeouts are the WEAKER class: a blackholed proxy looks like this, but so does one slow host
  {
    const d = T.makeOutageDetector()
    let tripped = false
    for (let i = 0; i < 5; i++) {
      if (T.observeCandidates(d, [cand('https://slow.example/' + i + '.jpg', TIMEOUT)])) tripped = true
    }
    ok(!tripped, 'five timeouts against ONE host are a slow host, not an outage')
    const d2 = T.makeOutageDetector()
    let hit = false
    for (let i = 0; i < 6; i++) {
      const host = i % 2 ? 'https://a.example/' : 'https://b.example/'
      if (T.observeCandidates(d2, [cand(host + i + '.jpg', TIMEOUT)])) hit = true
    }
    ok(hit, 'six timeouts across two hosts, with nothing working in between, is the route')
  }

  // a 404 is a remote server answering — proof traffic flows, not evidence against it
  {
    const d = T.makeOutageDetector()
    for (let i = 0; i < 10; i++) T.observeCandidates(d, [cand('https://a.example/' + i + '.jpg')])
    eq(d.streak, 0, 'ordinary host failures never build a streak')
  }

  ok(typeof T.observeCandidates === 'function', 'the stop rule is exported for the batch scanner')
}

// ------------------------------------------------------- the shape warning (phase 4)
//
// dHash resamples to a fixed grid, so it is blind to aspect ratio and a differently CROPPED copy
// passes the same-picture test. Measured live: a 250x293 portrait matched a 1200x800 landscape,
// and both really were the same painting. The warning is what sends the user to look.
{
  console.log('\nshape warning')
  const A = M.imagelab.aspectWarning
  ok(!A(250, 378, 844, 1280), 'a faithful enlargement raises nothing')
  ok(!A(800, 600, 1600, 1200), 'and neither does an exact 2x')
  ok(!A(1000, 750, 2000, 1490), 'nor a re-encode that rounds a pixel off')
  const w = A(250, 293, 1200, 800)
  ok(!!w, 'a portrait crop matched to a landscape copy DOES warn')
  ok(/portrait becomes landscape/.test(w || ''), 'and says which way round', w)
  ok(/different shape/.test(A(1000, 400, 1000, 700) || ''), 'a stretch within one orientation warns too')
  ok(!A(0, 0, 100, 100) && !A(100, 100, 0, 0), 'an unmeasured side never warns rather than dividing by zero')
}

console.log(`\n${pass} passed, ${fail} failed\n`)
process.exit(fail ? 1 : 0)
