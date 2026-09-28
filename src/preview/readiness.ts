/** HTTP + rendered-content checks so "Preview ready" is never announced for a
 * server that is not up yet or a page that renders blank. */

import { stripReloadScript } from './reloadScript.ts'
import { isExplicitLocalHostname, publicFetch } from '../networkPolicy.ts'

export interface RenderCheck {
  ok: boolean
  /** A short, actionable reason when `ok` is false. */
  reason?: string
  status?: number
  bodyBytes?: number
}

const MAX_REDIRECTS = 5

/**
 * Fetches a preview target with the same public-address rules as `web_fetch`.
 *
 * A preview URL that is not a loopback host is a destination the model chose,
 * and the fetch below is a real request to it — so it must not be able to reach
 * private or metadata addresses, and a redirect to one must not be followed.
 * Loopback stays on plain `fetch`: that is the tool's purpose (the operator's
 * own dev server), and there is no loopback-to-truth ambiguity to protect.
 */
async function fetchOnce(url: URL, signal?: AbortSignal): Promise<{ res?: Response; reason?: string }> {
  if (isExplicitLocalHostname(url.hostname)) {
    try {
      return { res: await fetch(url, { signal, redirect: 'follow' }) }
    } catch (error) {
      return { reason: error instanceof Error ? error.message : String(error) }
    }
  }
  try {
    // publicFetch validates the target, pins its DNS answer to the connect-time
    // lookup, and never follows redirects — a hop to a private address returns
    // a 3xx for the caller to refuse instead of silently fetching the callback.
    return { res: await publicFetch(url, { signal }) }
  } catch (error) {
    return { reason: error instanceof Error ? error.message : String(error) }
  }
}

/** Follows up to `MAX_REDIRECTS` http(s) redirects, re-running the public-address
 * policy on every hop the way web_fetch does; a hop that fails policy ends the chain. */
async function fetchResolved(url: URL, signal?: AbortSignal): Promise<{ res?: Response; reason?: string }> {
  let current = url
  const seen = new Set<string>([current.toString()])
  for (let hop = 0; hop < MAX_REDIRECTS; hop += 1) {
    const attempt = await fetchOnce(current, signal)
    if (attempt.reason !== undefined || !attempt.res) return attempt
    const res = attempt.res
    if (res.status < 300 || res.status >= 400) return { res }
    const location = res.headers.get('location')
    if (!location) return { res }
    let next: URL
    try {
      next = new URL(location, current)
    } catch {
      return { reason: `redirect to an unparsable location (${location})` }
    }
    if (seen.has(next.toString())) return { reason: `redirect loop at ${next.toString()}` }
    seen.add(next.toString())
    res.body?.cancel().catch(() => {})
    current = next
  }
  return { reason: `more than ${MAX_REDIRECTS} redirects` }
}

/** Polls `url` until it answers with any HTTP status (the socket is accepting), or times out. */
export async function waitForHttp(url: string, timeoutMs = 10_000, signal?: AbortSignal): Promise<RenderCheck> {
  const deadline = Date.now() + timeoutMs
  let lastError = 'no response'
  while (Date.now() < deadline) {
    if (signal?.aborted) return { ok: false, reason: 'aborted' }
    let target: URL
    try {
      target = new URL(url)
    } catch {
      return { ok: false, reason: `invalid URL: ${url}` }
    }
    const attempt = await fetchOnce(target, AbortSignal.timeout(2_000))
    // Any status means the server is listening and routing — that is all this
    // check proves. Content is validated separately by `checkRendered`.
    if (attempt.reason === undefined && attempt.res) return { ok: true, status: attempt.res.status }
    lastError = attempt.reason ?? lastError
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  return { ok: false, reason: `server did not respond within ${Math.round(timeoutMs / 1000)}s (${lastError})` }
}

export interface RenderOptions {
  /**
   * Whether `url` is served by a plain static server (elia's own preview
   * server) rather than a real dev server.
   *
   * It gates the raw-source-module check below, which is only ever a failure
   * for a static server. A running Vite/Next dev server serves that exact
   * markup *correctly* — it transforms the module on request — so applying the
   * check to a dev-server URL rejects a page that renders perfectly well.
   * Defaults to true: every caller that does not say otherwise is serving from
   * elia's own static server.
   */
  staticServer?: boolean
}

/**
 * Fetches the app root and checks it actually renders something. Catches the
 * common "blank white page" failures: a non-2xx root, an empty body, a
 * dev/runtime error page, or a bundler source `index.html` being served raw by
 * a static server (the browser can't execute the TypeScript modules it points
 * at, so nothing paints).
 */
export async function checkRendered(url: string, signal?: AbortSignal, options: RenderOptions = {}): Promise<RenderCheck> {
  let target: URL
  try {
    target = new URL(url)
  } catch {
    return { ok: false, reason: `invalid URL: ${url}` }
  }
  const attempted = await fetchResolved(target, signal ?? AbortSignal.timeout(5_000))
  if (attempted.reason !== undefined || !attempted.res) {
    return { ok: false, reason: `could not fetch ${url}: ${attempted.reason ?? 'no response'}` }
  }
  const res = attempted.res
  if (res.status >= 400) return { ok: false, reason: `root returned HTTP ${res.status}`, status: res.status }

  const served = await res.text().catch(() => '')
  // elia's own preview server appends a live-reload script to every HTML
  // response. At ~135 bytes it is more than three times the threshold below, so
  // measuring the served bytes meant *every* page passed the blank check —
  // an empty file included. Measure what the project produced, not what the
  // server added to it.
  const body = stripReloadScript(served)
  const bytes = Buffer.byteLength(body)
  if (bytes < 40) return { ok: false, reason: 'the page body is essentially empty', status: res.status, bodyBytes: bytes }

  const contentType = res.headers.get('content-type') ?? ''
  if (contentType.includes('text/html')) {
    const lower = body.toLowerCase()
    // A raw Vite/CRA source entry: points at a module that must be transformed.
    const rawSourceModule = (options.staticServer ?? true)
      && /<script[^>]+type=["']module["'][^>]+src=["'][^"']*(?:\/src\/|\.tsx|\.jsx|main\.ts)["']/i.test(body)
      && !/\/assets\/[a-z0-9._-]+\.js/i.test(body)
    if (rawSourceModule) {
      return {
        ok: false,
        status: res.status,
        bodyBytes: bytes,
        reason: 'this looks like an unbuilt bundler app served as a static file — the browser cannot run its source modules, so it renders blank. Build it (or run its dev server) first.',
      }
    }
    if (lower.includes('failed to resolve import') || lower.includes('internal server error') || lower.includes('vite error overlay')) {
      return { ok: false, status: res.status, bodyBytes: bytes, reason: 'the dev server returned an error page' }
    }
  }
  return { ok: true, status: res.status, bodyBytes: bytes }
}
