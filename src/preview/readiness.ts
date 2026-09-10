/** HTTP + rendered-content checks so "Preview ready" is never announced for a
 * server that is not up yet or a page that renders blank. */

export interface RenderCheck {
  ok: boolean
  /** A short, actionable reason when `ok` is false. */
  reason?: string
  status?: number
  bodyBytes?: number
}

/** Polls `url` until it answers with any HTTP status (the socket is accepting), or times out. */
export async function waitForHttp(url: string, timeoutMs = 10_000, signal?: AbortSignal): Promise<RenderCheck> {
  const deadline = Date.now() + timeoutMs
  let lastError = 'no response'
  while (Date.now() < deadline) {
    if (signal?.aborted) return { ok: false, reason: 'aborted' }
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(2_000) })
      // Any status means the server is listening and routing — that is all this
      // check proves. Content is validated separately by `checkRendered`.
      return { ok: true, status: res.status }
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error)
      await new Promise((resolve) => setTimeout(resolve, 250))
    }
  }
  return { ok: false, reason: `server did not respond within ${Math.round(timeoutMs / 1000)}s (${lastError})` }
}

/**
 * Fetches the app root and checks it actually renders something. Catches the
 * common "blank white page" failures: a non-2xx root, an empty body, a
 * dev/runtime error page, or a bundler source `index.html` being served raw by
 * a static server (the browser can't execute the TypeScript modules it points
 * at, so nothing paints).
 */
export async function checkRendered(url: string, signal?: AbortSignal): Promise<RenderCheck> {
  let res: Response
  try {
    res = await fetch(url, { signal: signal ?? AbortSignal.timeout(5_000) })
  } catch (error) {
    return { ok: false, reason: `could not fetch ${url}: ${error instanceof Error ? error.message : String(error)}` }
  }
  if (res.status >= 400) return { ok: false, reason: `root returned HTTP ${res.status}`, status: res.status }

  const body = await res.text().catch(() => '')
  const bytes = Buffer.byteLength(body)
  if (bytes < 40) return { ok: false, reason: 'the page body is essentially empty', status: res.status, bodyBytes: bytes }

  const contentType = res.headers.get('content-type') ?? ''
  if (contentType.includes('text/html')) {
    const lower = body.toLowerCase()
    // A raw Vite/CRA source entry: points at a module that must be transformed.
    const rawSourceModule = /<script[^>]+type=["']module["'][^>]+src=["'][^"']*(?:\/src\/|\.tsx|\.jsx|main\.ts)["']/i.test(body)
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
