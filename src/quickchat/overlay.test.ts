import { afterEach, expect, test } from 'bun:test'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  appendToSessionLog,
  createOverlay,
  ensureNonBlocking,
  QUICKCHAT_TIMEOUT_MS,
  readQuickchatLog,
  withEscapeHandler,
  withIdleTimeout,
} from './overlay.ts'

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

const tempDirs: string[] = []

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function tempDir(): string {
  const dir = join(tmpdir(), `quickchat-overlay-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
  mkdirSync(dir, { recursive: true })
  tempDirs.push(dir)
  return dir
}

test('QUICKCHAT_TIMEOUT_MS is 60 seconds', () => {
  expect(QUICKCHAT_TIMEOUT_MS).toBe(60_000)
})

test('open/append/close lifecycle', () => {
  const overlay = createOverlay()
  expect(overlay.status).toBe('closed')
  expect(overlay.buffer).toBe('')
  expect(overlay.lastActivity).toBe(0)

  overlay.open('why is the build red?', 'feat/parser')
  expect(overlay.status).toBe('open')
  expect(overlay.buffer).toBe('')
  expect(overlay.question).toBe('why is the build red?')
  expect(overlay.contextLabel).toBe('feat/parser')
  expect(overlay.lastActivity).toBeGreaterThan(0)

  overlay.appendChunk('It ')
  overlay.appendChunk('looks like ')
  overlay.appendChunk('a type error.')
  expect(overlay.buffer).toBe('It looks like a type error.')

  overlay.close()
  expect(overlay.status).toBe('closed')
  // Appends after close are ignored.
  overlay.appendChunk('nope')
  expect(overlay.buffer).toBe('It looks like a type error.')

  // Reopening resets the buffer.
  overlay.open('next question', 'other')
  expect(overlay.status).toBe('open')
  expect(overlay.buffer).toBe('')
})

test('idle timeout closes an overlay that stops receiving chunks', async () => {
  const overlay = createOverlay()
  overlay.open('q', 'ctx')
  let fired = 0
  withIdleTimeout(overlay, 20, () => {
    fired += 1
  })
  await sleep(60)
  expect(fired).toBe(1)
  expect(overlay.status).toBe('closed')
})

test('idle timeout resets on every appendChunk', async () => {
  const overlay = createOverlay()
  overlay.open('q', 'ctx')
  let fired = 0
  withIdleTimeout(overlay, 60, () => {
    fired += 1
  })
  await sleep(30)
  // A chunk at t≈30 resets the 60ms window to fire at t≈90.
  overlay.appendChunk('still here')
  await sleep(40)
  expect(fired).toBe(0) // 40ms after the chunk: window not yet spent
  expect(overlay.status).toBe('open')
  await sleep(50) // 90ms after the chunk: window spent
  expect(fired).toBe(1)
  expect(overlay.status).toBe('closed')
})

test('idle timer can be stopped without firing', async () => {
  const overlay = createOverlay()
  overlay.open('q', 'ctx')
  let fired = 0
  const idle = withIdleTimeout(overlay, 20, () => {
    fired += 1
  })
  idle.stop()
  await sleep(60)
  expect(fired).toBe(0)
  expect(overlay.status).toBe('open')
  idle.stop()
})

test('escape handler consumes esc and closes an open overlay only', () => {
  const overlay = createOverlay()
  const onKey = withEscapeHandler(overlay)
  expect(onKey('a')).toEqual({ consumed: false })
  expect(overlay.status).toBe('closed')

  overlay.open('q', 'ctx')
  expect(onKey('esc')).toEqual({ consumed: true })
  expect(overlay.status).toBe('closed')

  // Closed: esc is no longer consumed.
  expect(onKey('esc')).toEqual({ consumed: false })
})

test('ensureNonBlocking surfaces the overlay unchanged', () => {
  const overlay = createOverlay()
  expect(ensureNonBlocking(overlay)).toBe(overlay)
  expect('sessionContinue' in (overlay as object)).toBe(false)
})

test('appendToSessionLog writes a JSONL line readable back, creating the directory', () => {
  const dir = tempDir()
  const logPath = appendToSessionLog('sess-1', { kind: 'quickchat', question: 'what broke?', answer: 'the parser' }, { dir })
  expect(existsSync(logPath)).toBe(true)

  let wrote: string
  try {
    wrote = readFileSync(logPath, 'utf8')
  } catch {
    throw new Error(`expected ${logPath} to be readable`)
  }
  expect(wrote.trim().split('\n')).toHaveLength(1)

  const entries = readQuickchatLog('sess-1', { dir })
  expect(entries).toHaveLength(1)
  expect(entries[0]?.kind).toBe('quickchat')
  expect(entries[0]?.question).toBe('what broke?')
  expect(entries[0]?.answer).toBe('the parser')
  expect(typeof entries[0]?.at).toBe('number')

  // A second entry appends (not overwrites) on the same line format.
  appendToSessionLog('sess-1', { kind: 'quickchat', question: 'and then?', answer: 'it passed' }, { dir })
  const entries2 = readQuickchatLog('sess-1', { dir })
  expect(entries2).toHaveLength(2)
  expect(entries2[1]?.question).toBe('and then?')
})

test('missing nested directory is created for the log', () => {
  const root = tempDir()
  const nested = join(root, 'deeply', 'nested')
  const logPath = appendToSessionLog('sess-deep', { kind: 'quickchat', question: 'q', answer: 'a' }, { dir: nested })
  expect(existsSync(logPath)).toBe(true)
  expect(readQuickchatLog('sess-deep', { dir: nested })).toHaveLength(1)
})

test('log failures are silent and return the path anyway', () => {
  const root = tempDir()
  const fileAsDir = join(root, 'not-a-dir')
  writeFileSync(fileAsDir, 'a file in the way')
  expect(() => appendToSessionLog('sess-1', { kind: 'quickchat', question: 'q', answer: 'a' }, { dir: fileAsDir })).not.toThrow()
  expect(readQuickchatLog('sess-1', { dir: fileAsDir })).toEqual([])
})

test('readQuickchatLog returns [] for a missing log and skips malformed lines', () => {
  const dir = tempDir()
  expect(readQuickchatLog('never-existed', { dir })).toEqual([])

  const logPath = appendToSessionLog('sess-mixed', { kind: 'quickchat', question: 'q', answer: 'a' }, { dir })
  try {
    writeFileSync(logPath, `${readFileSync(logPath, 'utf8')}not json{{{\n`)
  } catch {
    throw new Error('unexpected write failure')
  }
  const entries = readQuickchatLog('sess-mixed', { dir })
  expect(entries).toHaveLength(1)
  expect(entries[0]?.answer).toBe('a')
})

test('session ids are sanitized out of log paths', () => {
  const dir = tempDir()
  const logPath = appendToSessionLog('../../evil', { kind: 'quickchat', question: 'q', answer: 'a' }, { dir })
  expect(logPath).not.toContain('..')
  expect(logPath).toContain('.quickchat.jsonl')
  expect(readQuickchatLog('../../evil', { dir })).toHaveLength(1)
})