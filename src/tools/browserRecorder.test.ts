import { expect, test } from 'bun:test'
import { RECORDER_SOURCE, formatRecorderRead, readRecorderExpression } from './browserRecorder.ts'

/**
 * The recorder ships as a source string, so nothing typechecks it and a syntax
 * slip would only ever surface in a real browser. These tests run it for real in
 * a stand-in page, so a broken recorder fails here instead of silently returning
 * "nothing captured" against a page that was throwing the whole time.
 */
function page(): { run: (source: string) => unknown; win: Record<string, unknown>; listeners: Record<string, ((event: unknown) => void)[]> } {
  const listeners: Record<string, ((event: unknown) => void)[]> = {}
  const printed: string[] = []
  const win: Record<string, unknown> = {}
  const consoleStub: Record<string, unknown> = {}
  for (const level of ['log', 'info', 'warn', 'error', 'debug']) {
    consoleStub[level] = (...args: unknown[]) => printed.push(`${level}:${args.join(' ')}`)
  }
  win.console = consoleStub
  const addEventListener = (type: string, handler: (event: unknown) => void) => {
    ;(listeners[type] ??= []).push(handler)
  }
  const run = (source: string): unknown =>
    // eslint-disable-next-line no-new-func
    new Function('window', 'console', 'addEventListener', `return ${source}`)(win, consoleStub, addEventListener)
  return { run, win, listeners }
}

test('the recorder installs, and installing twice does not double-wrap', () => {
  const { run } = page()
  expect(run(RECORDER_SOURCE)).toEqual({ installed: true })
  expect(run(RECORDER_SOURCE)).toEqual({ installed: false, alreadyInstalled: true })
})

test('the recorder captures console output and still calls through', () => {
  const { run, win } = page()
  run(RECORDER_SOURCE)
  const patched = win.console as { log: (...args: unknown[]) => void; error: (...args: unknown[]) => void }
  patched.error('boom', { code: 42 })
  patched.log('ordinary')
  const state = win.__eliaRecorder as { console: { level: string; text: string }[] }
  expect(state.console).toHaveLength(2)
  expect(state.console[0]).toMatchObject({ level: 'error', text: 'boom {"code":42}' })
  expect(state.console[1]).toMatchObject({ level: 'log', text: 'ordinary' })
})

test('the recorder captures uncaught errors and unhandled rejections', () => {
  const { run, win, listeners } = page()
  run(RECORDER_SOURCE)
  listeners.error?.[0]?.({ message: 'x is not a function', filename: 'app.js', lineno: 12 })
  listeners.unhandledrejection?.[0]?.({ reason: 'network down' })
  const state = win.__eliaRecorder as { console: { level: string; text: string }[] }
  expect(state.console[0]!.text).toBe('x is not a function (app.js:12)')
  expect(state.console[1]!.text).toBe('Unhandled promise rejection: network down')
})

test('the recorder records a failed fetch without swallowing the rejection', async () => {
  const { run, win } = page()
  win.fetch = () => Promise.reject(new Error('connection refused'))
  run(RECORDER_SOURCE)
  const patched = win.fetch as (url: string) => Promise<unknown>
  await expect(patched('https://api.example.com/items')).rejects.toThrow('connection refused')
  const state = win.__eliaRecorder as { network: { url: string; ok: boolean; error: string }[] }
  expect(state.network[0]).toMatchObject({ url: 'https://api.example.com/items', ok: false })
  expect(state.network[0]!.error).toContain('connection refused')
})

test('the recorder records a successful fetch and returns the real response', async () => {
  const { run, win } = page()
  win.fetch = () => Promise.resolve({ status: 200, ok: true, marker: 'real' })
  run(RECORDER_SOURCE)
  const patched = win.fetch as (url: string) => Promise<{ marker: string }>
  expect((await patched('https://api.example.com/ok')).marker).toBe('real')
  const state = win.__eliaRecorder as { network: { status: number; ok: boolean }[] }
  expect(state.network[0]).toMatchObject({ status: 200, ok: true })
})

test('reading installs the recorder when it is missing, and says the buffer is empty for that reason', () => {
  const { run } = page()
  const read = run(readRecorderExpression('console', 50, false)) as { recording: boolean; installedNow: boolean; entries: unknown[] }
  expect(read).toMatchObject({ recording: true, installedNow: true, entries: [] })
})

test('errorsOnly keeps errors and failed requests only', () => {
  const { run, win } = page()
  run(RECORDER_SOURCE)
  const patched = win.console as { log: (...args: unknown[]) => void; error: (...args: unknown[]) => void }
  patched.log('noise')
  patched.error('the real problem')
  const read = run(readRecorderExpression('console', 50, true)) as { entries: { text: string }[]; total: number }
  expect(read.total).toBe(2)
  expect(read.entries).toHaveLength(1)
  expect(read.entries[0]!.text).toBe('the real problem')
})

test('a just-installed empty read is reported as "not captured yet", not as a clean page', () => {
  const text = formatRecorderRead('console', { recording: true, installedNow: true, total: 0, entries: [] })
  expect(text).toContain('has just been installed')
  expect(text).toContain('read console again')
})

test('captured entries format as actionable lines', () => {
  expect(formatRecorderRead('console', { recording: true, total: 1, entries: [{ level: 'error', text: 'x is not a function' }] }))
    .toContain('[ERROR] x is not a function')
  expect(formatRecorderRead('network', { recording: true, total: 1, entries: [{ kind: 'fetch', url: '/api/items', status: 500, ok: false, ms: 12 }] }))
    .toContain('✗ FETCH /api/items → 500 (12ms)')
})

test('a browser MCP answering in its own shape falls through to the ordinary formatter', () => {
  expect(formatRecorderRead('console', { messages: ['from a playwright MCP'] })).toBeUndefined()
  expect(formatRecorderRead('console', 'a plain string result')).toBeUndefined()
})
