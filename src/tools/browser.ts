import type { Tool } from './types.ts'
import { taskSessions } from '../taskSessions.ts'

/** Actions supported by the browser bridge. The bridge can be a user-Chrome MCP wrapper or CDP endpoint. */
export type BrowserAction = 'status' | 'navigate' | 'snapshot' | 'click' | 'type' | 'press' | 'wait' | 'extract'

interface BrowserRequest {
  action: BrowserAction
  url?: string
  target?: string
  text?: string
  key?: string
  selector?: string
  ms?: number
  confirmed?: boolean
  confirmationToken?: string
}

interface BrowserResult {
  ok?: boolean
  result?: unknown
  output?: unknown
  error?: string
  [key: string]: unknown
}

const SENSITIVE_WORDS = /\b(buy|purchase|pay|checkout|send|publish|delete|remove|confirm|submit|transfer|wire|post|tweet|message|cancel|subscribe)\b/i
const MAX_TEXT_LENGTH = 20_000
const MAX_WAIT_MS = 30_000
const BROWSER_DEADLINE_MS = 45_000
const APPROVAL_TTL_MS = 5 * 60_000
const pendingApprovals = new Map<string, { fingerprint: string; expiresAt: number }>()

export const browserTool: Tool = {
  name: 'browser',
  description: `Control the user's browser through a configured bridge. Use status first, then navigate, snapshot/extract, click, type, press, or wait as needed. The bridge can be a user-Chrome connector or a Chrome DevTools endpoint configured outside Elia. Read the page after important actions and verify the final state instead of assuming a click worked. Never bypass authentication, CAPTCHAs, paywalls, or site safety controls. Actions that look like sending, purchasing, publishing, deleting, or changing subscriptions pause with an exact approval token; the token must be supplied after the user approves that exact side effect.`,
  input_schema: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['status', 'navigate', 'snapshot', 'click', 'type', 'press', 'wait', 'extract'],
        description: 'Browser action to perform',
      },
      url: { type: 'string', description: 'Absolute http(s) URL for navigate' },
      target: {
        type: 'string',
        description: 'CSS selector prefixed with css: or visible text/label for click; use the exact target when possible',
      },
      text: { type: 'string', description: 'Text to type' },
      key: { type: 'string', description: 'Keyboard key such as Enter, Tab, Escape, ArrowDown' },
      selector: { type: 'string', description: 'Optional CSS selector for extract' },
      ms: { type: 'number', description: 'Milliseconds to wait, capped at 30 seconds' },
      confirmed: {
        type: 'boolean',
        description: 'Legacy confirmation flag; sensitive actions also require the exact confirmationToken returned by a paused action',
      },
      confirmationToken: {
        type: 'string',
        description: 'Exact approval token returned after a sensitive action is paused; expires after five minutes and is bound to the action details',
      },
    },
    required: ['action'],
  },
  async execute(input) {
    const request = validateRequest(input)
    const session = taskSessions.create('browser', `Browser: ${request.action}`, 'Queued browser action')
    const sideEffectText = [request.target, request.text, request.url].filter(Boolean).join(' ')
    const needsConfirmation = SENSITIVE_WORDS.test(sideEffectText) && request.action !== 'status' && request.action !== 'snapshot' && request.action !== 'extract'
    if (needsConfirmation && !consumeApproval(request)) {
      const token = createApprovalToken(request)
      taskSessions.update(session.id, { status: 'paused', action: 'Awaiting confirmation', detail: 'This action may create an external side effect' })
      return `Confirmation required before browser action "${request.action}". Ask the user to approve this exact action, then retry with confirmationToken=${token}. The token expires in five minutes and cannot be reused for a changed target, recipient, or message. Task session: ${session.id}`
    }

    taskSessions.update(session.id, { status: 'running', action: request.action, detail: request.url ?? request.target ?? request.text?.slice(0, 120) ?? 'Working' })
    try {
      const result = await withDeadline(dispatchBrowserRequest(request), BROWSER_DEADLINE_MS, 'browser action timed out')
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
  if (typeof action !== 'string' || !['status', 'navigate', 'snapshot', 'click', 'type', 'press', 'wait', 'extract'].includes(action)) {
    throw new Error('action must be one of status, navigate, snapshot, click, type, press, wait, or extract')
  }

  const request: BrowserRequest = { action: action as BrowserAction, confirmed: input.confirmed === true }
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
  if (action === 'wait') {
    const ms = typeof input.ms === 'number' && Number.isFinite(input.ms) ? Math.round(input.ms) : 500
    request.ms = Math.max(0, Math.min(MAX_WAIT_MS, ms))
  }
  if (input.confirmationToken !== undefined) {
    if (typeof input.confirmationToken !== 'string' || input.confirmationToken.trim().length === 0) throw new Error('confirmationToken must be a non-empty string')
    request.confirmationToken = input.confirmationToken.trim()
  }
  if (action === 'extract' && input.selector !== undefined) {
    if (typeof input.selector !== 'string' || input.selector.trim().length === 0) throw new Error('extract selector must be a non-empty string')
    request.selector = input.selector.trim()
  }
  return request
}

async function dispatchBrowserRequest(request: BrowserRequest): Promise<BrowserResult | string> {
  if (request.action === 'wait') {
    await Bun.sleep(request.ms ?? 500)
    return { ok: true, result: `waited ${request.ms ?? 500}ms` }
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
  const proc = Bun.spawn(['sh', '-c', command], { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe', detached: true })
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
    socket.addEventListener('error', () => reject(new Error('could not connect to the Chrome DevTools endpoint')))
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
    socket.send(JSON.stringify({ id, method, params }))
  })
}

async function cdpCommandFor(request: BrowserRequest): Promise<{ method: string; params: Record<string, unknown> }> {
  if (request.action === 'status') return evaluate('({ url: location.href, title: document.title })')
  if (request.action === 'navigate') return { method: 'Page.navigate', params: { url: request.url } }
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
    if (process.platform !== 'win32' && proc.pid) {
      try {
        process.kill(-proc.pid, 'SIGTERM')
      } catch {
        proc.kill()
      }
    } else {
      proc.kill()
    }
  }, timeoutMs)
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout as ReadableStream<Uint8Array>).text(),
    new Response(proc.stderr as ReadableStream<Uint8Array>).text(),
    proc.exited,
  ])
  clearTimeout(timeout)
  if (timedOut) throw new Error(`browser bridge timed out after ${timeoutMs}ms`)
  return { stdout, stderr, exitCode }
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

function requestFingerprint(request: BrowserRequest): string {
  return JSON.stringify({ action: request.action, url: request.url ?? '', target: request.target ?? '', text: request.text ?? '', key: request.key ?? '', selector: request.selector ?? '', ms: request.ms ?? 0 })
}

function createApprovalToken(request: BrowserRequest): string {
  const token = `approval_${crypto.randomUUID()}`
  pendingApprovals.set(token, { fingerprint: requestFingerprint(request), expiresAt: Date.now() + APPROVAL_TTL_MS })
  return token
}

function consumeApproval(request: BrowserRequest): boolean {
  if (!request.confirmed || !request.confirmationToken) return false
  const approval = pendingApprovals.get(request.confirmationToken)
  if (!approval) return false
  if (approval.expiresAt <= Date.now()) {
    pendingApprovals.delete(request.confirmationToken)
    return false
  }
  if (approval.fingerprint !== requestFingerprint(request)) return false
  pendingApprovals.delete(request.confirmationToken)
  return true
}

export function isSensitiveBrowserInput(input: Record<string, unknown>): boolean {
  const text = [input.target, input.text, input.url].filter((value): value is string => typeof value === 'string').join(' ')
  return SENSITIVE_WORDS.test(text)
}
