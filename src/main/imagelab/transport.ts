// Ported from projects/web/YandexLab/lib/transport.js — see imagelab/README.md.
//
// Telling "this host said no" apart from "nothing is leaving this machine".
//
// Written after a real overnight loss: the SOCKS proxies stopped listening while an infinite run
// was going, and because the proxy rules deliberately carry no `direct://` fallback — a dead tunnel
// must fail rather than leak — every single fetch came back `net::ERR_PROXY_CONNECTION_FAILED`. The
// downloader could not tell that from a 404, so it walked the rest of the queue at roughly 25 items
// a minute, marked 5,132 images failed, ran off the end of its list and reported the job *done*.
// Nothing was wrong with any of those images.
//
// The distinction is not cosmetic. A host error is about one remote server and the right response
// is to move on to the next item; a transport error means the request never left, so the right
// response is to stop consuming the queue entirely and get the route back.

/**
 * Errors that can ONLY be our side: the proxy refused us, the SOCKS handshake failed, the tunnel
 * could not be built. No remote server is involved in any of these, so one is enough to be
 * suspicious and a short run of them is proof.
 */
export const LOCAL_TRANSPORT_ERRORS = [
  'ERR_PROXY_CONNECTION_FAILED',
  'ERR_SOCKS_CONNECTION_FAILED',
  'ERR_TUNNEL_CONNECTION_FAILED',
  'ERR_MANDATORY_PROXY_CONFIGURATION_FAILED',
  'ERR_PROXY_AUTH_REQUESTED',
  'ERR_PROXY_AUTH_UNSUPPORTED',
  'ERR_PROXY_CERTIFICATE_INVALID',
]

/**
 * Transport errors that might still be about one remote host — the proxy is alive and answering,
 * and what it is saying is that IT cannot reach the address we asked for. Kept separate on purpose:
 * treating one unreachable CDN as a dead tunnel would pause a job that is otherwise working.
 */
const HOST_TRANSPORT_ERRORS = [
  'ERR_SOCKS_CONNECTION_HOST_UNREACHABLE',
  // A blackholed proxy — the failure mode seen on 2026-08-16, where the SOCKS port accepted the
  // connection in 2 ms and then relayed nothing, ever. It produces no error of its own, only
  // silence until something gives up, so a timeout has to be admissible evidence. It stays in the
  // weaker class because one genuinely slow host times out too; several across different hosts,
  // with no success in between, is the route.
  'ERR_TIMED_OUT',
  'ERR_CONNECTION_TIMED_OUT',
  'ERR_EMPTY_RESPONSE',
]

export const TRANSPORT_ERRORS = [...LOCAL_TRANSPORT_ERRORS, ...HOST_TRANSPORT_ERRORS]

const LOCAL_RE = new RegExp(LOCAL_TRANSPORT_ERRORS.join('|'), 'i')
const TRANSPORT_RE = new RegExp(TRANSPORT_ERRORS.join('|'), 'i')

const text = (err: unknown): string =>
  typeof err === 'string' ? err : String((err as Error | null)?.message || err || '')

/**
 * Is this failure about our own route out, rather than about the server we asked?
 *
 * `err.timedOut` is set by our own deadline wrapper, so a request we abandoned counts the same as
 * one Chromium timed out — the point is that nothing came back, and matching on a message string
 * would break the first time that wording changed.
 */
export function isTransportDown(err: unknown): boolean {
  if (!err) return false
  if ((err as { timedOut?: boolean }).timedOut) return true
  return TRANSPORT_RE.test(text(err))
}

/** …and is it the kind that cannot possibly be the remote host's doing? */
export function isLocalTransport(err: unknown): boolean {
  return Boolean(err) && !(err as { timedOut?: boolean }).timedOut && LOCAL_RE.test(text(err))
}

export interface OutageDetector {
  /** A download (or search) failed. Returns true when this tips us into "the route is down". */
  fail(err: unknown, host?: string): boolean
  /** Anything that worked. */
  ok(): void
  readonly streak: number
  readonly hosts: number
}

/**
 * Decides when a run of transport errors means the route is genuinely gone.
 *
 * Guards against crying outage over nothing, matched to how much each error actually proves:
 *
 * - A proxy-refused error involves no remote party at all, so a short streak is conclusive — and it
 *   has to be, because the search side of a crawl only ever talks to one host and would otherwise
 *   never be able to report an outage at all.
 * - A host-unreachable error is the proxy talking about somewhere else, so it needs both a longer
 *   streak and more than one distinct host before it counts. One dead CDN is not an outage.
 *
 * Any success clears everything: the only evidence that a route works is traffic on it.
 */
export function makeOutageDetector(
  { localStreak = 3, streak = 6, hosts = 2 }: { localStreak?: number; streak?: number; hosts?: number } = {},
): OutageDetector {
  let run = 0
  let localRun = 0
  const seen = new Set<string>()
  const reset = (): void => {
    run = 0
    localRun = 0
    seen.clear()
  }
  return {
    fail(err: unknown, host?: string): boolean {
      if (!isTransportDown(err)) {
        // A normal host failure is not evidence of an outage — and it proves traffic is flowing.
        reset()
        return false
      }
      run++
      if (host) seen.add(host)
      if (isLocalTransport(err)) {
        localRun++
        if (localRun >= localStreak) return true
      }
      return run >= streak && seen.size >= hosts
    },
    ok: reset,
    get streak() {
      return run
    },
    get hosts() {
      return seen.size
    },
  }
}

/** the shape the batch scanner observes — a judged candidate, but only the parts that matter here */
export interface TransportObservable {
  url: string
  /** the request never left this machine */
  transport?: boolean
  /** the raw network error, which is what the regexes above are written against */
  errorCode?: string
}

const hostOf = (url: string): string => {
  try { return new URL(url).host } catch { return '' }
}

/**
 * Show one file's worth of results to the detector, and say whether the route is now gone.
 *
 * Split out of the batch scanner so it can be tested without a network, a window, or Electron —
 * this is the rule that decides whether a run keeps consuming its queue, and the failure it exists
 * to prevent (5,132 images marked bad by a dead tunnel, then reported DONE) is silent by nature.
 *
 * Order matters and is deliberate: candidates are shown in the order they were tried, so a success
 * partway down clears a streak built up above it. Anything that answered at all — including a 404
 * — is proof that traffic is flowing, and the only evidence that a route works is traffic on it.
 */
export function observeCandidates(detector: OutageDetector, tried: TransportObservable[]): boolean {
  let down = false
  for (const c of tried) {
    if (c.transport) {
      if (detector.fail(c.errorCode || '', hostOf(c.url))) down = true
    } else {
      detector.ok()
    }
  }
  return down
}
