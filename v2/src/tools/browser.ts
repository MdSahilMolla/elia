import type { Tool } from './types.ts'
import { taskSessions } from '../taskSessions.ts'
import { readBoundedOutput, terminateProcessGroup } from '../shell.ts'

/** Actions supported by the browser bridge. The bridge can be a user-Chrome MCP wrapper or CDP endpoint. */
export type BrowserAction = 'status' | 'navigate' | 'refresh' | 'back' | 'forward' | 'snapshot' | 'click' | 'type' | 'press' | 'scroll' | 'wait' | 'wait_for' | 'extract' | 'verify'

interface BrowserRequest {
  action: BrowserAction
  url?: string
  target?: string
  text?: string
  key?: string
  selector?: string
  direction?: 'up' | 'down' | 'top' | 'bottom'
  amount?: number
  expectText?: string
  expectUrl?: string
  ms?: number
}

interface BrowserResult {
  ok?: boolean
  result?: unknown
  output?: unknown
  error?: string
  [key: string]: unknown
}

const MAX_TEXT_LENGTH = 20_000
const MAX_WAIT_MS = 30_000
const MAX_SCROLL_PX = 4_000
const MAX_EXPECTATION_LENGTH = 4_000
const BROWSER_DEADLINE_MS = 45_000
const MAX_BROWSER_OUTPUT_LENGTH = 200_000
const SAFE_RETRY_ACTIONS = new Set<BrowserAction>(['status', 'snapshot', 'extract', 'verify', 'wait_for'])

export const browserTool: Tool = {
  name: 'browser',
  description: `Control the user's browser through a configured bridge. Use status first, then navigate, refresh/back/forward, snapshot/extract, click, type, press, scroll, wait_for, or verify as needed. Add expectText or expectUrl after state-changing work so Elia observes the final page instead of assuming a transport success means the UI changed. The bridge can be a user-Chrome connector or a Chrome DevTools endpoint configured outside Elia. Never bypass authentication, CAPTCHAs, paywalls, or site safety controls. Actions that change page state (click, type, press, scroll, verify) go through Elia's action governor for approval before this tool ever runs them — do not expect or ask for a separate confirmation token here.`,
  input_schema: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['status', 'navigate', 'refresh', 'back', 'forward', 'snapshot', 'click', 'type', 'press', 'scroll', 'wait', 'wait_for', 'extract', 'verify'],
        description: 'Browser action to perform',
      },
      url: { type: 'string', description: 'Absolute http(s) URL for navigate; verify may use this as an expected URL prefix' },
      target: {
        type: 'string',
        description: 'CSS selector prefixed with css: or visible text/label for click; use the exact target when possible',
      },
      text: { type: 'string', description: 'Text to type' },
      key: { type: 'string', description: 'Keyboard key such as Enter, Tab, Escape, ArrowDown' },
      selector: { type: 'string', description: 'Optional CSS selector for extract, wait_for, or verify' },
      direction: { type: 'string', enum: ['up', 'down', 'top', 'bottom'], description: 'Scroll direction' },
      amount: { type: 'number', description: 'Scroll distance in pixels, capped at 4000' },
      expectText: { type: 'string', description: 'Text that must appear in the post-action snapshot' },
      expectUrl: { type: 'string', description: 'URL prefix or exact URL that must match after the action' },
      ms: { type: 'number', description: 'Milliseconds to wait, capped at 30 seconds' },
    },
    required: ['action'],
  },
  async execute(input) {
    const request = validateRequest(input)
    const session = taskSessions.create('browser', `Browser: ${request.action}`, 'Queued browser action')
    taskSessions.update(session.id, { status: 'running', action: request.action, detail: request.url ?? request.target ?? request.text?.slice(0, 120) ?? 'Working' })
    try {
      const result = await withDeadline(runBrowserRequest(request), BROWSER_DEADLINE_MS, 'browser action timed out')
      const output = formatBrowserResult(result)
      taskSessions.update(session.id, { status: 'done', action: 'Finished', detail: output.slice(0, 240) })
      return `${output}\nTask session: ${session.id}`
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      taskSessions.update(session.id, { status: 'failed', action: 'Failed', detail, error: detail })
      return `Browser action failed: ${detail}\n\n${browserSetupHint()}\nTask session: ${session.id}`
    }
  },
}

export function validateRequest(input: Record<string, unknown>): BrowserRequest {
  const action = input.action
  if (typeof action !== 'string' || !['status', 'navigate', 'refresh', 'back', 'forward', 'snapshot', 'click', 'type', 'press', 'scroll', 'wait', 'wait_for', 'extract', 'verify'].includes(action)) {
    throw new Error('action must be one of status, navigate, refresh, back, forward, snapshot, click, type, press, scroll, wait, wait_for, extract, or verify')
  }

  const request: BrowserRequest = { action: action as BrowserAction }
  if (action === 'navigate') {
    const url = input.url
    if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) throw new Error('navigate requires an absolute http(s) url')
    request.url = url
  }
  if (action === 'click') {
    if (typeof input.target !== 'string' || input.target.trim().length === 0) throw new Error('click requires target')
    request.target = input.target.trim()
  }
  if (action === 'type') {
    if (typeof input.text !== 'string') throw new Error('type requires text')
    if (input.text.length > MAX_TEXT_LENGTH) throw new Error(`type text exceeds ${MAX_TEXT_LENGTH} characters`)
    request.text = input.text
  }
  if (action === 'press') {
    if (typeof input.key !== 'string' || input.key.trim().length === 0) throw new Error('press requires key')
    request.key = input.key.trim()
  }
  if (action === 'scroll') {
    const direction = input.direction
    if (direction !== 'up' && direction !== 'down' && direction !== 'top' && direction !== 'bottom') throw new Error('scroll requires direction up, down, top, or bottom')
    request.direction = direction
    const amount = typeof input.amount === 'number' && Number.isFinite(input.amount) ? Math.round(input.amount) : 800
    request.amount = Math.max(1, Math.min(MAX_SCROLL_PX, amount))
  }
  if (action === 'wait' || action === 'wait_for') {
    const ms = typeof input.ms === 'number' && Number.isFinite(input.ms) ? Math.round(input.ms) : 500
    request.ms = Math.max(0, Math.min(MAX_WAIT_MS, ms))
  }
  if (action === 'wait_for' || action === 'verify' || action === 'extract') {
    if (input.selector !== undefined) {
      if (typeof input.selector !== 'string' || input.selector.trim().length === 0) throw new Error(`${action} selector must be a non-empty string`)
      request.selector = input.selector.trim()
    }
  }
  for (const key of ['expectText', 'expectUrl'] as const) {
    if (input[key] !== undefined) {
      if (typeof input[key] !== 'string' || input[key].length === 0 || input[key].length > MAX_EXPECTATION_LENGTH) throw new Error(`${key} must be a non-empty string of at most ${MAX_EXPECTATION_LENGTH} characters`)
      request[key] = input[key]
    }
  }
  if (action === 'extract' && input.selector !== undefined) {
    if (typeof input.selector !== 'string' || input.selector.trim().length === 0) throw new Error('extract selector must be a non-empty string')
    request.selector = input.selector.trim()
  }
  if (action === 'verify' && !request.expectText && !request.expectUrl && !request.selector) throw new Error('verify requires expectText, expectUrl, or selector')
  return request
}

async function runBrowserRequest(request: BrowserRequest): Promise<BrowserResult | string> {
  let lastError: unknown
  const attempts = SAFE_RETRY_ACTIONS.has(request.action) ? 2 : 1
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const result = await dispatchBrowserRequest(request)
      return request.action === 'verify' ? verifyBrowserResult(result, request) : request.expectText || request.expectUrl ? verifyAfterAction(result, request) : result
    } catch (error) {
      lastError = error
      if (attempt < attempts) await Bun.sleep(150 * attempt)
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError))
}

async function verifyAfterAction(result: BrowserResult | string, request: BrowserRequest): Promise<BrowserResult | string> {
  const observation = await dispatchBrowserRequest({ action: 'snapshot' })
  verifyBrowserResult(observation, request)
  return { ok: true, result: { action: result, verification: observation } }
}

function verifyBrowserResult(result: BrowserResult | string, request: BrowserRequest): BrowserResult | string {
  const text = typeof result === 'string' ? result : JSON.stringify(result.result ?? result.output ?? result)
  if (request.expectText && !text.toLowerCase().includes(request.expectText.toLowerCase())) throw new Error(`post-action verification failed: expected text not found: ${request.expectText}`)
  if (request.expectUrl) {
    const url = extractUrl(result)
    if (!url || !(url === request.expectUrl || url.startsWith(request.expectUrl))) throw new Error(`post-action verification failed: expected URL ${request.expectUrl}, observed ${url ?? '(none)'}`)
  }
  return result
}

function extractUrl(result: BrowserResult | string): string | undefined {
  if (typeof result === 'string') return undefined
  const payload = (result.result ?? result.output ?? result) as Record<string, unknown>
  if (typeof payload.url === 'string') return payload.url
  const verification = payload.verification
  return verification && typeof verification === 'object' && typeof (verification as Record<string, unknown>).url === 'string'
    ? (verification as Record<string, unknown>).url as string
    : undefined
}

async function dispatchBrowserRequest(request: BrowserRequest): Promise<BrowserResult | string> {
  if (request.action === 'wait') {
    await Bun.sleep(request.ms ?? 500)
    return { ok: true, result: `waited ${request.ms ?? 500}ms` }
  }
  if (request.action === 'wait_for') {
    const deadline = Date.now() + (request.ms ?? 500)
    let last: BrowserResult | string = { ok: true, result: {} }
    do {
      last = await dispatchBrowserRequest({ action: request.selector ? 'extract' : 'snapshot', selector: request.selector })
      try {
        return verifyBrowserResult(last, request)
      } catch {
        if (Date.now() >= deadline) throw new Error(`wait_for timed out after ${request.ms ?? 500}ms`)
        await Bun.sleep(Math.min(250, Math.max(25, deadline - Date.now())))
      }
    } while (Date.now() < deadline)
    return last
  }

  const bridgeCommand = process.env.ELIA_BROWSER_BRIDGE_COMMAND?.trim()
  if (bridgeCommand) return callBridge(bridgeCommand, request)

  const mcpServer = process.env.ELIA_BROWSER_MCP_SERVER?.trim()
  if (mcpServer) return callMcpTool(mcpServer, request)

  const cdpUrl = process.env.ELIA_BROWSER_CDP_URL?.trim()
  if (cdpUrl) return callCdp(cdpUrl, request)

  throw new Error('no browser bridge is configured')
}

async function callMcpTool(server: string, request: BrowserRequest): Promise<BrowserResult | string> {
  const actionKey = request.action.toUpperCase()
  const toolName = process.env[`ELIA_BROWSER_${actionKey}_TOOL`] ?? defaultMcpToolName(request.action)
  const proc = Bun.spawn(['manus-mcp-cli', '-s', server, 'tool', 'call', toolName, '-i', JSON.stringify(request)], {
    stdout: 'pipe',
    stderr: 'pipe',
    ...(process.platform === 'win32' ? {} : { detached: true }),
  })
  const { stdout, stderr, exitCode } = await collectBrowserProcess(proc, BROWSER_DEADLINE_MS)
  if (exitCode !== 0) throw new Error(`MCP browser tool ${toolName} exited with code ${exitCode}${stderr.trim() ? `: ${stderr.trim()}` : ''}`)
  return parseBridgeOutput(stdout)
}

async function callBridge(command: string, request: BrowserRequest): Promise<BrowserResult | string> {
  const shellArgs = process.platform === 'win32' ? ['cmd', '/c', command] : ['sh', '-c', command]
  const proc = Bun.spawn(shellArgs, { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe', ...(process.platform === 'win32' ? {} : { detached: true }) })
  proc.stdin.write(`${JSON.stringify(request)}\n`)
  proc.stdin.end()

  const { stdout, stderr, exitCode } = await collectBrowserProcess(proc, BROWSER_DEADLINE_MS)
  if (exitCode !== 0) throw new Error(`bridge exited with code ${exitCode}${stderr.trim() ? `: ${stderr.trim()}` : ''}`)

  return parseBridgeOutput(stdout)
}

function parseBridgeOutput(stdout: string): BrowserResult | string {
  const raw = stdout.trim()
  if (!raw) return '(browser bridge returned no output)'
  const lastLine = raw.split('\n').at(-1) ?? raw
  try {
    const parsed = JSON.parse(lastLine) as BrowserResult
    if (parsed.ok === false || parsed.error) throw new Error(parsed.error ?? 'browser bridge reported failure')
    return parsed
  } catch (error) {
    if (error instanceof Error && error.message !== 'Unexpected end of JSON input' && !error.message.startsWith('Unexpected token')) throw error
    return raw
  }
}

function defaultMcpToolName(action: BrowserAction): string {
  return `browser_${action}`
}

async function callCdp(endpoint: string, request: BrowserRequest): Promise<BrowserResult> {
  const websocketUrl = endpoint.startsWith('ws://') || endpoint.startsWith('wss://') ? endpoint : await discoverCdpTarget(endpoint)
  const socket = new WebSocket(websocketUrl)
  let nextId = 1
  const pending = new Map<number, { resolve: (value: BrowserResult) => void; reject: (error: Error) => void }>()

  const pendingResult = new Promise<BrowserResult>((resolve, reject) => {
    socket.addEventListener('open', async () => {
      try {
        const response = await cdpRequest(socket, pending, () => nextId++, 'Runtime.enable', {})
        if (response.error) throw new Error(response.error ?? 'failed to enable runtime')
        const command = await cdpCommandFor(request)
        const final = await cdpRequest(socket, pending, () => nextId++, command.method, command.params)
        if (final.error) throw new Error(final.error ?? 'browser command failed')
        if (request.action === 'press') {
          const keyUp = await cdpRequest(socket, pending, () => nextId++, 'Input.dispatchKeyEvent', {
            type: 'keyUp',
            key: request.key,
          })
          if (keyUp.error) throw new Error(keyUp.error ?? 'browser key-up failed')
        }
        resolve({ ok: true, result: final.result ?? {} })
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)))
      } finally {
        socket.close()
      }
    })
    socket.addEventListener('message', (event) => {
      try {
        const message = JSON.parse(String(event.data)) as { id?: number; result?: BrowserResult; error?: { message?: string } }
        if (typeof message.id !== 'number') return
        const item = pending.get(message.id)
        if (!item) return
        pending.delete(message.id)
        if (message.error) item.resolve({ error: message.error.message ?? 'CDP error' })
        else item.resolve(message.result ?? {})
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)))
      }
    })
    const rejectPending = (error: Error) => {
      for (const item of pending.values()) item.reject(error)
      pending.clear()
    }
    socket.addEventListener('error', () => {
      const error = new Error('could not connect to the Chrome DevTools endpoint')
      rejectPending(error)
      reject(error)
    })
    socket.addEventListener('close', () => {
      const error = new Error('Chrome DevTools endpoint closed before the action completed')
      rejectPending(error)
      reject(error)
    })
  })

  try {
    return await withDeadline(pendingResult, BROWSER_DEADLINE_MS, 'Chrome DevTools action timed out')
  } catch (error) {
    socket.close()
    throw error
  }
}

function cdpRequest(
  socket: WebSocket,
  pending: Map<number, { resolve: (value: BrowserResult) => void; reject: (error: Error) => void }>,
  nextId: () => number,
  method: string,
  params: Record<string, unknown>,
): Promise<BrowserResult> {
  const id = nextId()
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject })
    try {
      socket.send(JSON.stringify({ id, method, params }))
    } catch (error) {
      pending.delete(id)
      reject(error instanceof Error ? error : new Error(String(error)))
    }
  })
}

async function cdpCommandFor(request: BrowserRequest): Promise<{ method: string; params: Record<string, unknown> }> {
  if (request.action === 'status') return evaluate('({ url: location.href, title: document.title })')
  if (request.action === 'navigate') return { method: 'Page.navigate', params: { url: request.url } }
  if (request.action === 'refresh') return { method: 'Page.reload', params: { ignoreCache: false } }
  if (request.action === 'back') return evaluate('history.back(); ({ ok: true, url: location.href })')
  if (request.action === 'forward') return evaluate('history.forward(); ({ ok: true, url: location.href })')
  if (request.action === 'snapshot') return evaluate('({ url: location.href, title: document.title, text: document.body?.innerText?.slice(0, 20000) ?? "" })')
  if (request.action === 'extract') {
    const selector = JSON.stringify(request.selector ?? 'body')
    return evaluate(`({ selector: ${selector}, text: document.querySelector(${selector})?.innerText?.slice(0, 20000) ?? "" })`)
  }
  if (request.action === 'click') {
    const target = JSON.stringify(request.target)
    return evaluate(`(() => { const target = ${target}; const selector = target.startsWith('css:') ? target.slice(4) : null; const candidates = selector ? [document.querySelector(selector)] : Array.from(document.querySelectorAll('button,a,input,[role="button"],label')); const element = candidates.find((item) => item && (selector || (item.innerText || item.getAttribute('aria-label') || item.getAttribute('value') || '').trim().toLowerCase() === target.toLowerCase())); if (!element) return { ok: false, error: 'target not found' }; element.click(); return { clicked: target }; })()`)
  }
  if (request.action === 'type') {
    const text = JSON.stringify(request.text ?? '')
    return evaluate(`(() => { const element = document.activeElement; if (!element) return { ok: false, error: 'no active element' }; const value = ${text}; if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) { const prototype = element instanceof HTMLInputElement ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype; const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set; setter?.call(element, element.value + value); element.dispatchEvent(new InputEvent('input', { inputType: 'insertText', data: value, bubbles: true })); } else if (element instanceof HTMLElement && element.isContentEditable) { document.execCommand('insertText', false, value); } else { return { ok: false, error: 'active element is not text-editable' }; } return { activeElement: element.tagName, textLength: value.length }; })()`)
  }
  if (request.action === 'press') {
    return { method: 'Input.dispatchKeyEvent', params: { type: 'keyDown', key: request.key, text: request.key === 'Enter' ? '\\r' : undefined } }
  }
  if (request.action === 'scroll') {
    const direction = request.direction
    const amount = request.amount ?? 800
    const expression = direction === 'top' ? 'window.scrollTo(0, 0); ({ ok: true, y: window.scrollY })' : direction === 'bottom' ? 'window.scrollTo(0, document.body.scrollHeight); ({ ok: true, y: window.scrollY })' : `window.scrollBy(0, ${direction === 'up' ? -amount : amount}); ({ ok: true, y: window.scrollY })`
    return evaluate(expression)
  }
  if (request.action === 'verify') {
    const selector = JSON.stringify(request.selector ?? 'body')
    return evaluate(`({ url: location.href, title: document.title, text: document.querySelector(${selector})?.innerText?.slice(0, 20000) ?? '' })`)
  }
  return { method: 'Runtime.evaluate', params: { expression: '({ ok: true })', returnByValue: true } }
}

function evaluate(expression: string): { method: string; params: Record<string, unknown> } {
  return { method: 'Runtime.evaluate', params: { expression, returnByValue: true, awaitPromise: true } }
}

async function discoverCdpTarget(endpoint: string): Promise<string> {
  const base = endpoint.replace(/\/$/, '')
  const response = await fetch(`${base}/json/list`, { signal: AbortSignal.timeout(BROWSER_DEADLINE_MS) })
  if (!response.ok) throw new Error(`Chrome DevTools target discovery returned ${response.status}`)
  const targets = (await response.json()) as { type?: string; webSocketDebuggerUrl?: string }[]
  const page = targets.find((target) => target.type === 'page' && target.webSocketDebuggerUrl)
  if (!page?.webSocketDebuggerUrl) throw new Error('no page target found at the Chrome DevTools endpoint')
  return page.webSocketDebuggerUrl
}

async function collectBrowserProcess(proc: Bun.Subprocess, timeoutMs: number): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  let timedOut = false
  const timeout = setTimeout(() => {
    timedOut = true
    terminateProcessGroup(proc)
  }, timeoutMs)
  let completed = false
  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      readBoundedOutput(proc.stdout as ReadableStream<Uint8Array>, MAX_BROWSER_OUTPUT_LENGTH),
      readBoundedOutput(proc.stderr as ReadableStream<Uint8Array>, MAX_BROWSER_OUTPUT_LENGTH),
      proc.exited,
    ])
    if (timedOut) throw new Error(`browser bridge timed out after ${timeoutMs}ms`)
    completed = true
    return { stdout, stderr, exitCode }
  } finally {
    clearTimeout(timeout)
    if (!completed) terminateProcessGroup(proc)
  }
}

async function withDeadline<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

function formatBrowserResult(value: BrowserResult | string): string {
  if (typeof value === 'string') return value
  const payload = value.result ?? value.output ?? value
  return typeof payload === 'string' ? payload : JSON.stringify(payload, null, 2)
}

function browserSetupHint(): string {
  return 'Configure ELIA_BROWSER_MCP_SERVER for an enabled user-Chrome connector, ELIA_BROWSER_BRIDGE_COMMAND for a trusted wrapper, or ELIA_BROWSER_CDP_URL for a Chrome DevTools endpoint. Keep credentials in the bridge environment, not in Elia prompts or source files.'
}
