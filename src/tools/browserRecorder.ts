/**
 * Console and network capture for the `browser` tool.
 *
 * The bridge is request/response: `callCdp` opens a socket, runs one command,
 * and closes it. Console messages and network activity are *event streams* —
 * `Runtime.consoleAPICalled`, `Network.responseReceived` — so there is no window
 * in which to receive them, and holding a socket open across actions would mean
 * rewriting the transport for every bridge kind (MCP, bridge command, CDP).
 *
 * So the recording happens in the page instead. A small script wraps `console.*`,
 * `fetch` and `XMLHttpRequest`, and listens for `error` / `unhandledrejection`,
 * keeping the last N of each in a ring buffer on `window`. Reading it back is an
 * ordinary `Runtime.evaluate` — the exact shape every other action already uses,
 * so it works on every bridge with no transport change at all.
 *
 * Load-time errors are the ones worth having, and a script injected after
 * navigation misses them. On the CDP path the recorder is registered with
 * `Page.addScriptToEvaluateOnNewDocument` *before* `Page.navigate`, so it is
 * installed ahead of the page's own scripts and catches the error that happens
 * during boot. Other bridges fall back to installing on first read, which still
 * captures everything from that point on.
 */

/** Ring-buffer depth per stream, in the page. Enough for a boot sequence without holding a page's whole history. */
const MAX_ENTRIES = 200

/**
 * The recorder, as page source. Idempotent: a second install is a no-op, so
 * registering it on new documents *and* self-installing on read cannot double-wrap
 * `console.error` and report every message twice.
 */
export const RECORDER_SOURCE = `(() => {
  const KEY = '__eliaRecorder'
  if (window[KEY]) return { installed: false, alreadyInstalled: true }
  const MAX = ${MAX_ENTRIES}
  const state = { console: [], network: [] }
  window[KEY] = state
  const push = (list, entry) => { list.push(entry); if (list.length > MAX) list.shift() }
  const fmt = (value) => {
    try {
      if (typeof value === 'string') return value
      if (value instanceof Error) return value.stack || (value.name + ': ' + value.message)
      return JSON.stringify(value)
    } catch { return String(value) }
  }
  for (const level of ['log', 'info', 'warn', 'error', 'debug']) {
    const original = console[level]
    if (typeof original !== 'function') continue
    console[level] = function (...args) {
      push(state.console, { level, text: args.map(fmt).join(' ').slice(0, 2000), at: Date.now() })
      return original.apply(this, args)
    }
  }
  addEventListener('error', (event) => {
    push(state.console, { level: 'error', text: (event.message || 'script error') + ' (' + (event.filename || '?') + ':' + (event.lineno || 0) + ')', at: Date.now() })
  })
  addEventListener('unhandledrejection', (event) => {
    push(state.console, { level: 'error', text: 'Unhandled promise rejection: ' + fmt(event.reason), at: Date.now() })
  })
  const originalFetch = window.fetch
  if (typeof originalFetch === 'function') {
    window.fetch = function (...args) {
      const input = args[0]
      const url = typeof input === 'string' ? input : (input && input.url) ? input.url : String(input)
      const started = Date.now()
      return originalFetch.apply(this, args).then(
        (response) => {
          push(state.network, { kind: 'fetch', url: String(url).slice(0, 500), status: response.status, ok: response.ok, ms: Date.now() - started })
          return response
        },
        (error) => {
          push(state.network, { kind: 'fetch', url: String(url).slice(0, 500), status: 0, ok: false, error: fmt(error), ms: Date.now() - started })
          throw error
        },
      )
    }
  }
  const Xhr = window.XMLHttpRequest
  if (typeof Xhr === 'function' && Xhr.prototype) {
    const open = Xhr.prototype.open
    const send = Xhr.prototype.send
    Xhr.prototype.open = function (method, url, ...rest) {
      this.__eliaMethod = method
      this.__eliaUrl = url
      return open.call(this, method, url, ...rest)
    }
    Xhr.prototype.send = function (...args) {
      const started = Date.now()
      this.addEventListener('loadend', () => {
        push(state.network, { kind: 'xhr', method: this.__eliaMethod, url: String(this.__eliaUrl).slice(0, 500), status: this.status, ok: this.status >= 200 && this.status < 400, ms: Date.now() - started })
      })
      return send.apply(this, args)
    }
  }
  return { installed: true }
})()`

/**
 * Read one stream back, installing the recorder first if it is not there yet.
 *
 * The self-install matters on a bridge that cannot pre-register the script: the
 * first read then comes back empty but *recording*, which is an honest answer —
 * far better than "no console output" for a page that was never being watched.
 */
export function readRecorderExpression(stream: 'console' | 'network', limit: number, errorsOnly: boolean): string {
  return `(() => {
  const installResult = ${RECORDER_SOURCE}
  const state = window.__eliaRecorder
  if (!state) return { recording: false, reason: 'the page blocked the recorder' }
  const all = state[${JSON.stringify(stream)}] || []
  ${errorsOnly ? `const kept = all.filter((e) => e.level === 'error' || e.ok === false)` : 'const kept = all'}
  return {
    recording: true,
    installedNow: installResult.installed === true,
    total: all.length,
    returned: Math.min(kept.length, ${limit}),
    entries: kept.slice(-${limit}),
  }
})()`
}

interface ConsoleEntry { level?: string; text?: string; at?: number }
interface NetworkEntry { kind?: string; method?: string; url?: string; status?: number; ok?: boolean; ms?: number; error?: string }
interface RecorderRead {
  recording?: boolean
  reason?: string
  installedNow?: boolean
  total?: number
  entries?: unknown[]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/**
 * A read result as lines a model can act on, rather than raw JSON.
 *
 * "recording from now on" is stated explicitly whenever the recorder had to
 * install itself: an empty result then means *nothing has happened yet*, not
 * *the page is clean*, and conflating those is exactly how a broken page gets
 * reported as working.
 */
export function formatRecorderRead(stream: 'console' | 'network', value: unknown): string | undefined {
  // A browser MCP with native console/network tools answers in its own shape,
  // not the recorder's. Say so by returning undefined rather than mangling it,
  // and let the caller fall back to the ordinary formatter.
  if (!isRecord(value) || typeof (value as RecorderRead).recording !== 'boolean') return undefined
  const read = value as RecorderRead
  if (read.recording === false) return `browser ${stream}: not recording — ${read.reason ?? 'the recorder is not installed on this page'}`

  const entries = Array.isArray(read.entries) ? read.entries : []
  const preamble = read.installedNow
    ? `The recorder was not running on this page and has just been installed, so nothing before this call was captured. Act in the page, then read ${stream} again.`
    : ''

  if (entries.length === 0) {
    return preamble || `browser ${stream}: nothing captured (${read.total ?? 0} total entries)`
  }

  const lines = entries.map((entry) => {
    if (!isRecord(entry)) return `  ${String(entry)}`
    if (stream === 'console') {
      const item = entry as ConsoleEntry
      return `  [${(item.level ?? 'log').toUpperCase()}] ${item.text ?? ''}`
    }
    const item = entry as NetworkEntry
    const status = item.error ? `FAILED ${item.error}` : `${item.status ?? '?'}`
    return `  ${item.ok === false ? '✗' : '✓'} ${(item.method ?? item.kind ?? 'req').toUpperCase()} ${item.url ?? ''} → ${status} (${item.ms ?? '?'}ms)`
  })

  const header = `browser ${stream}: ${entries.length} of ${read.total ?? entries.length} entries`
  return [preamble, header, ...lines].filter(Boolean).join('\n')
}
