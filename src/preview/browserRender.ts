/**
 * The render check that actually runs the page.
 *
 * `checkRendered` (readiness.ts) is an HTTP fetch: it proves the server answers
 * and the HTML is not empty. It never executes a line of the page's script, so
 * a page that throws on boot, points at a missing stylesheet, or renders an
 * empty `<div id="root">` passes it, and the turn is recorded `verify: pass`.
 * That is the "verify=pass is hollow on frontend" gap: the recorded history
 * says the deliverable was checked when only the transport was.
 *
 * This loads the page in elia's own headless Chromium (the same owned browser
 * the `browser` tool falls back to: no login state, no window), holds the
 * DevTools socket open for the whole load so boot-time events are captured,
 * and then judges what a person would see: an uncaught exception, a failed
 * script/stylesheet/document load, or a screen with nothing visible on it is a
 * failed render. Console errors are kept as evidence but do not fail the page
 * on their own — libraries log benign errors often enough that failing on them
 * would teach the repair loop to chase noise.
 *
 * When no Chromium-family browser is installed (or `ELIA_RENDER_BROWSER=off`),
 * the caller keeps the HTTP result, marked `depth: 'http'`, so nothing claims a
 * browser looked when none did.
 */

import { checkRendered, type RenderCheck, type RenderOptions } from './readiness.ts'

export interface PageObservation {
  /** Set when navigation itself failed (DNS, refused, aborted). */
  navigationError?: string
  /** Uncaught exceptions and unhandled rejections, as the browser reported them. */
  exceptions: string[]
  /** `console.error` calls and browser-level error log entries. */
  consoleErrors: string[]
  /** Document/script/stylesheet loads that failed or returned >= 400. */
  failedResources: string[]
  /** Visible text characters after load, whitespace-trimmed. */
  visibleTextChars: number
  /** Visible elements with a non-zero box (text, media, inputs, canvases). */
  visibleElements: number
}

export interface BrowserRenderCheck extends RenderCheck {
  /** How deep the check went: `http` fetched the markup, `browser` ran the page. */
  depth: 'http' | 'browser'
  /** Evidence that did not fail the page but is worth showing the model. */
  warnings?: string[]
  /** Set when the browser check could not run, so the HTTP result stands alone. */
  browserUnavailable?: string
}

const CRITICAL_RESOURCE_TYPES = new Set(['Document', 'Script', 'Stylesheet'])
const SETTLE_MS = 600
const LOAD_TIMEOUT_MS = 10_000
const MAX_EVIDENCE = 5
const OBSERVE_DEADLINE_MS = 25_000

/** A favicon miss is the one failed request every bare static page has; it says nothing about the deliverable. */
function isNoise(text: string): boolean {
  return /favicon\.ico/i.test(text)
}

function clip(text: string): string {
  const line = text.split('\n')[0]!.trim()
  return line.length > 240 ? `${line.slice(0, 237)}...` : line
}

/** Pure verdict over what the browser saw. Exported for tests. */
export function judgePageObservation(observation: PageObservation): { ok: boolean; reason?: string; warnings: string[] } {
  const warnings = observation.consoleErrors.filter((line) => !isNoise(line)).slice(0, MAX_EVIDENCE).map((line) => `console error: ${clip(line)}`)
  if (observation.navigationError) return { ok: false, reason: `the page did not load in the browser: ${clip(observation.navigationError)}`, warnings }
  const exceptions = observation.exceptions.filter((line) => !isNoise(line))
  if (exceptions.length > 0) {
    const more = exceptions.length > 1 ? ` (+${exceptions.length - 1} more)` : ''
    return { ok: false, reason: `the page threw while loading: ${clip(exceptions[0]!)}${more}`, warnings }
  }
  const failed = observation.failedResources.filter((line) => !isNoise(line))
  if (failed.length > 0) {
    const more = failed.length > 1 ? ` (+${failed.length - 1} more)` : ''
    return { ok: false, reason: `a resource the page needs failed to load: ${clip(failed[0]!)}${more}`, warnings }
  }
  if (observation.visibleTextChars === 0 && observation.visibleElements === 0) {
    return { ok: false, reason: 'the page loaded but nothing is visible on screen — the script never filled the page, or everything is hidden', warnings }
  }
  return { ok: true, warnings }
}

/** Whether the browser-backed check should run. Off under `bun test` unless asked for, so suites never spawn Chromium by accident. */
export function browserRenderEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const mode = (env.ELIA_RENDER_BROWSER ?? '').trim().toLowerCase()
  if (mode === 'on' || mode === '1' || mode === 'true') return true
  if (mode === 'off' || mode === '0' || mode === 'false') return false
  if ((env.ELIA_BROWSER ?? '').trim().toLowerCase() === 'off') return false
  return env.NODE_ENV !== 'test'
}

/** What the page shows, measured in the page after load. */
const VISIBILITY_PROBE = `(() => {
  const body = document.body
  const text = body ? (body.innerText || '').trim().length : 0
  let visible = 0
  if (body) {
    for (const el of body.querySelectorAll('img,svg,canvas,video,iframe,input,button,textarea,select')) {
      const box = el.getBoundingClientRect()
      const style = getComputedStyle(el)
      if (box.width > 0 && box.height > 0 && style.visibility !== 'hidden' && style.display !== 'none' && Number(style.opacity) !== 0) visible += 1
      if (visible >= 50) break
    }
  }
  return { text, visible }
})()`

interface CdpMessage {
  id?: number
  method?: string
  params?: Record<string, unknown>
  result?: Record<string, unknown>
  error?: { message?: string }
}

/**
 * Loads `url` in a fresh tab of the browser at `cdpOrigin` and records what happened.
 * The tab is its own target, so this never disturbs a page the `browser` tool is driving.
 */
export async function observePageInBrowser(url: string, cdpOrigin: string, signal?: AbortSignal): Promise<PageObservation> {
  const created = await fetch(`${cdpOrigin}/json/new?about:blank`, { method: 'PUT', signal: AbortSignal.timeout(5_000) })
  if (!created.ok) throw new Error(`could not open a browser tab (DevTools returned ${created.status})`)
  const target = (await created.json()) as { id?: string; webSocketDebuggerUrl?: string }
  if (!target.webSocketDebuggerUrl || !target.id) throw new Error('the browser did not return a debuggable tab')

  const observation: PageObservation = { exceptions: [], consoleErrors: [], failedResources: [], visibleTextChars: 0, visibleElements: 0 }
  const resourceTypes = new Map<string, { type: string; url: string }>()
  const socket = new WebSocket(target.webSocketDebuggerUrl)
  const pending = new Map<number, (message: CdpMessage) => void>()
  let nextId = 1
  let loaded: (() => void) | undefined
  const loadFired = new Promise<void>((resolve) => { loaded = resolve })

  const send = (method: string, params: Record<string, unknown> = {}): Promise<CdpMessage> => new Promise((resolve) => {
    const id = nextId++
    pending.set(id, resolve)
    socket.send(JSON.stringify({ id, method, params }))
  })

  socket.addEventListener('message', (event) => {
    let message: CdpMessage
    try {
      message = JSON.parse(String(event.data)) as CdpMessage
    } catch {
      return
    }
    if (typeof message.id === 'number') {
      pending.get(message.id)?.(message)
      pending.delete(message.id)
      return
    }
    const params = message.params ?? {}
    switch (message.method) {
      case 'Page.loadEventFired':
        loaded?.()
        break
      case 'Runtime.exceptionThrown': {
        const details = params.exceptionDetails as { text?: string; exception?: { description?: string } } | undefined
        observation.exceptions.push(details?.exception?.description ?? details?.text ?? 'uncaught exception')
        break
      }
      case 'Runtime.consoleAPICalled': {
        if (params.type !== 'error') break
        const args = (params.args as { value?: unknown; description?: string }[] | undefined) ?? []
        observation.consoleErrors.push(args.map((arg) => arg.description ?? String(arg.value ?? '')).join(' '))
        break
      }
      case 'Log.entryAdded': {
        const entry = params.entry as { level?: string; text?: string; url?: string } | undefined
        if (entry?.level === 'error') observation.consoleErrors.push(`${entry.text ?? ''}${entry.url ? ` (${entry.url})` : ''}`)
        break
      }
      case 'Network.requestWillBeSent': {
        const request = params.request as { url?: string } | undefined
        if (typeof params.requestId === 'string') resourceTypes.set(params.requestId, { type: String(params.type ?? ''), url: request?.url ?? '' })
        break
      }
      case 'Network.responseReceived': {
        const response = params.response as { status?: number; url?: string } | undefined
        const type = String(params.type ?? '')
        if (CRITICAL_RESOURCE_TYPES.has(type) && (response?.status ?? 0) >= 400) observation.failedResources.push(`${type.toLowerCase()} ${response?.url ?? ''} returned HTTP ${response?.status}`)
        break
      }
      case 'Network.loadingFailed': {
        const known = typeof params.requestId === 'string' ? resourceTypes.get(params.requestId) : undefined
        const type = String(params.type ?? known?.type ?? '')
        if (CRITICAL_RESOURCE_TYPES.has(type) && params.canceled !== true) observation.failedResources.push(`${type.toLowerCase()} ${known?.url ?? ''} failed (${String(params.errorText ?? 'load failed')})`)
        break
      }
    }
  })

  const opened = new Promise<void>((resolve, reject) => {
    socket.addEventListener('open', () => resolve())
    socket.addEventListener('error', () => reject(new Error('could not connect to the browser tab')))
  })

  try {
    await opened
    await Promise.all([send('Runtime.enable'), send('Log.enable'), send('Page.enable'), send('Network.enable')])
    const navigated = await send('Page.navigate', { url })
    const navError = navigated.error?.message ?? (typeof navigated.result?.errorText === 'string' ? navigated.result.errorText : undefined)
    if (navError) {
      observation.navigationError = navError
      return observation
    }
    const aborted = new Promise<void>((resolve) => signal?.addEventListener('abort', () => resolve(), { once: true }))
    await Promise.race([loadFired, Bun.sleep(LOAD_TIMEOUT_MS), aborted])
    // Cut short is not "broken": throw so the caller keeps the HTTP verdict instead of failing the page.
    if (signal?.aborted) throw new Error('browser render check was cut short before the page finished loading')
    // Let boot code that runs after `load` (frameworks mounting, fetches resolving) finish painting.
    await Bun.sleep(SETTLE_MS)
    const probe = await send('Runtime.evaluate', { expression: VISIBILITY_PROBE, returnByValue: true })
    const value = (probe.result?.result as { value?: { text?: number; visible?: number } } | undefined)?.value
    observation.visibleTextChars = value?.text ?? 0
    observation.visibleElements = value?.visible ?? 0
    return observation
  } finally {
    socket.close()
    fetch(`${cdpOrigin}/json/close/${target.id}`, { signal: AbortSignal.timeout(2_000) }).catch(() => undefined)
  }
}

export interface PageVerifyDeps {
  browserEndpoint?: () => Promise<string>
  enabled?: boolean
  http?: typeof checkRendered
  observe?: typeof observePageInBrowser
}

/**
 * The render check verification should use: HTTP first (cheap, catches a dead
 * server or an empty body), then the page actually run in a browser. A browser
 * that cannot be started leaves the HTTP verdict standing, labelled as such.
 */
export async function verifyPageRender(url: string, signal?: AbortSignal, options: RenderOptions = {}, deps: PageVerifyDeps = {}): Promise<BrowserRenderCheck> {
  const http = await (deps.http ?? checkRendered)(url, signal, options)
  if (!http.ok) return { ...http, depth: 'http' }
  if (!(deps.enabled ?? browserRenderEnabled())) return { ...http, depth: 'http', browserUnavailable: 'browser render check is turned off' }

  let origin: string
  try {
    const endpoint = deps.browserEndpoint ?? (async () => (await import('../tools/browserOwned.ts')).ownedBrowserEndpoint())
    origin = await endpoint()
  } catch (error) {
    return { ...http, depth: 'http', browserUnavailable: error instanceof Error ? error.message : String(error) }
  }
  let observation: PageObservation
  try {
    // A wedged browser must not wedge verification: past the deadline the HTTP verdict stands.
    let timer: ReturnType<typeof setTimeout> | undefined
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`browser render check timed out after ${OBSERVE_DEADLINE_MS / 1000}s`)), OBSERVE_DEADLINE_MS)
    })
    try {
      observation = await Promise.race([(deps.observe ?? observePageInBrowser)(url, origin, signal), deadline])
    } finally {
      clearTimeout(timer)
    }
  } catch (error) {
    return { ...http, depth: 'http', browserUnavailable: error instanceof Error ? error.message : String(error) }
  }
  const verdict = judgePageObservation(observation)
  return {
    ok: verdict.ok,
    ...(verdict.reason ? { reason: verdict.reason } : {}),
    ...(http.status !== undefined ? { status: http.status } : {}),
    ...(http.bodyBytes !== undefined ? { bodyBytes: http.bodyBytes } : {}),
    depth: 'browser',
    ...(verdict.warnings.length > 0 ? { warnings: verdict.warnings } : {}),
  }
}

/** Says how deep a passing check went, for the transcript: a pass that never ran the page must not read like one that did. */
export function renderDepthNote(check: RenderCheck | BrowserRenderCheck): string {
  if (!('depth' in check)) return ''
  if (check.depth === 'browser') return check.warnings?.length ? ` [ran in browser; ${check.warnings.length} console error(s)]` : ' [ran in browser]'
  return check.browserUnavailable ? ` [HTTP only — ${check.browserUnavailable}]` : ' [HTTP only]'
}
