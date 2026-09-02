/**
 * Opens a pooled connection to a provider host ahead of the first real request.
 *
 * HTTP connection reuse in Bun/undici is keyed on origin (scheme + host + port),
 * not path — so a throwaway `HEAD /` handshake leaves a warm TLS session in the
 * pool that the first `POST /v1/messages` (or `/chat/completions`) then reuses,
 * skipping DNS, the TLS handshake, and HTTP/2 connection setup on the latency
 * path the user is actually waiting on.
 *
 * Deliberately unauthenticated and result-ignoring: the endpoint will answer
 * 401/403/404/405 and that is fine — the connection is what we came for. Any
 * failure (offline, DNS down, proxy) is swallowed; the real request will surface
 * it properly a moment later.
 */

let warmed: string | undefined

export function warmConnection(baseURL: string | undefined): void {
  if (!baseURL) return
  let origin: string
  try {
    origin = new URL(baseURL).origin
  } catch {
    return
  }
  // Once per origin per process — a second call is just wasted work.
  if (warmed === origin) return
  warmed = origin

  void fetch(`${origin}/`, {
    method: 'HEAD',
    signal: AbortSignal.timeout(5_000),
  }).catch(() => {})
}

/** Test-only: forget which origin was warmed so a later call re-warms. */
export function resetPrewarmForTests(): void {
  warmed = undefined
}
