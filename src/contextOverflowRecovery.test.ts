import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ChatMessage } from './providers/types.ts'
import { estimateTokens, shrinkForOversizedRequest } from './compaction.ts'
import { capacityRetryDelayMs, isCapacityError, isRequestTooLargeError } from './providerErrors.ts'
import { boundToolResult, MAX_TOOL_RESULT_CHARS } from './toolOutputBudget.ts'
import { buildTurnDiff } from './autonomy/turnDiff.ts'
import { competenceReport, recordOutcome } from './autonomy/outcomes.ts'

/**
 * Session mu0t6bvd-urf6i6 (2026-09-14), end to end: `git add .` and two
 * `git diff --cached` calls put ~600 KB of tool output into the conversation,
 * mercury-2.5 refused the next request with the message below, elia treated it
 * as fatal, and the saved history made every later prompt in the session fail
 * the same way. Each test here pins one link of that chain.
 */
const MERCURY_OVERFLOW = 'You exceeded the maximum context length for this model of 260000. Please reduce the length of the messages or completion.'

const dirs: string[] = []
function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), 'elia-overflow-'))
  dirs.push(dir)
  return dir
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

// --- 1. the error is recognised as "too big", so elia shrinks and retries ---

test("mercury's context-overflow message is a too-large request, not a fatal error", () => {
  expect(isCapacityError(MERCURY_OVERFLOW)).toBe(true)
  expect(isRequestTooLargeError(MERCURY_OVERFLOW)).toBe(true)
  // Size, not rate: waiting cannot make it fit, so no delay.
  expect(capacityRetryDelayMs(MERCURY_OVERFLOW)).toBe(0)
})

test('other common context-window spellings are recognised', () => {
  for (const message of [
    "This model's maximum context length is 128000 tokens. However, your messages resulted in 140000 tokens.",
    'Input is too long for requested model.',
    'The input exceeds the context window of this model',
    'request exceeds the maximum context length',
  ]) {
    expect(isRequestTooLargeError(message)).toBe(true)
  }
})

// --- 2. the shrink can cut the tail when that is where the bulk is ---

/** The live shape: a short history, then three huge results inside the last few messages. */
function overflowedSession(): ChatMessage[] {
  const messages: ChatMessage[] = [{ role: 'user', content: [{ type: 'text', text: 'create a website for openai updates' }] }]
  for (let i = 0; i < 12; i++) {
    messages.push({ role: 'assistant', content: [{ type: 'tool_use', id: `s${i}`, name: 'todo_write', input: {} }] })
    messages.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: `s${i}`, content: 'ok', is_error: false }] })
  }
  for (const [i, size] of [201_513, 205_303, 205_291].entries()) {
    messages.push({ role: 'assistant', content: [{ type: 'tool_use', id: `g${i}`, name: 'run_command', input: { command: 'git diff --cached' } }] })
    messages.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: `g${i}`, content: `exit code: 0\nstdout:\n${'+'.repeat(size)}\nEND`, is_error: false }] })
  }
  return messages
}

test('an overflow caused by the most recent tool results can still be shrunk', () => {
  const messages = overflowedSession()
  const before = estimateTokens(messages)
  expect(shrinkForOversizedRequest(messages)).toBe(true)
  expect(estimateTokens(messages)).toBeLessThan(before / 10)
})

test('a tail result keeps both ends and says what was dropped', () => {
  const messages = overflowedSession()
  shrinkForOversizedRequest(messages)
  const last = messages.at(-1)!.content[0]!
  expect(last.type).toBe('tool_result')
  if (last.type === 'tool_result') {
    expect(last.content.startsWith('exit code: 0')).toBe(true)
    expect(last.content.endsWith('END')).toBe(true)
    expect(last.content).toContain('dropped from the middle')
  }
})

test('the shrink still reports false when nothing anywhere is worth cutting', () => {
  const messages: ChatMessage[] = [
    { role: 'user', content: [{ type: 'text', text: 'hi' }] },
    { role: 'assistant', content: [{ type: 'tool_use', id: 'a', name: 'read_file', input: {} }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'a', content: 'x'.repeat(2_000), is_error: false }] },
  ]
  expect(shrinkForOversizedRequest(messages)).toBe(false)
})

// --- 3. one result can no longer flood the context in the first place ---

test('a result under budget passes through untouched', () => {
  const text = 'exit code: 0\nstdout:\nok'
  expect(boundToolResult(text, 'run_command', scratch())).toBe(text)
})

test('an oversized result is bounded, and the full text is spilled to a file the model can read', () => {
  const dir = scratch()
  const text = `HEAD\n${'w'.repeat(300_000)}\nTAIL`
  const bounded = boundToolResult(text, 'run_command', dir)
  expect(bounded.length).toBeLessThan(MAX_TOOL_RESULT_CHARS + 1_000)
  expect(bounded.startsWith('HEAD')).toBe(true)
  expect(bounded).toContain('TAIL')
  const spilled = readdirSync(dir)
  expect(spilled).toHaveLength(1)
  expect(bounded).toContain(join(dir, spilled[0]!))
  expect(readFileSync(join(dir, spilled[0]!), 'utf8')).toBe(text)
})

test('spilled outputs are pruned so the directory stays bounded', () => {
  const dir = scratch()
  for (let i = 0; i < 55; i++) boundToolResult('z'.repeat(MAX_TOOL_RESULT_CHARS + 1), 'read_file', dir)
  expect(readdirSync(dir).length).toBeLessThanOrEqual(50)
})

// --- 4. the self-review gets its diff from elia, never from `git add .` ---

test('the turn diff covers what the turn wrote and leaves out dependencies, build output and lockfiles', () => {
  const root = scratch()
  const app = join(root, 'src', 'App.tsx')
  const pkg = join(root, 'package.json')
  const lock = join(root, 'bun.lock')
  const dep = join(root, 'node_modules', 'react', 'index.js')
  const built = join(root, 'dist', 'index.html')
  mkdirSync(join(root, 'src'), { recursive: true })
  mkdirSync(join(root, 'node_modules', 'react'), { recursive: true })
  mkdirSync(join(root, 'dist'), { recursive: true })
  writeFileSync(app, 'export const App = () => "new"\n')
  writeFileSync(pkg, '{ "name": "after" }\n')
  writeFileSync(lock, 'lock\n')
  writeFileSync(dep, 'module.exports = 1\n')
  writeFileSync(built, '<html></html>\n')

  const diff = buildTurnDiff({ [app]: null, [pkg]: '{ "name": "before" }\n', [lock]: null, [dep]: null, [built]: null }, root)

  expect(diff.files.sort()).toEqual(['package.json', 'src/App.tsx'])
  // Reviewers read the changed files by these, so no base directory is left to guess.
  expect(diff.absolute.sort()).toEqual([app, pkg].sort())
  expect(diff.skipped.sort()).toEqual(['bun.lock', 'dist/index.html', 'node_modules/react/index.js'])
  expect(diff.text).toContain('+export const App = () => "new"')
  expect(diff.text).toContain('-{ "name": "before" }')
  expect(diff.text).toContain('+{ "name": "after" }')
})

test('a file the turn wrote back unchanged is not in the diff', () => {
  const root = scratch()
  const file = join(root, 'same.ts')
  writeFileSync(file, 'x\n')
  expect(buildTurnDiff({ [file]: 'x\n' }, root).files).toEqual([])
})

// --- 5. a turn that crashed is not learned from as a success ---

test('a failed turn does not count as landing clean', () => {
  const path = join(scratch(), 'outcomes.jsonl')
  const base = { prompt: 'p', filesChanged: 3, domains: ['frontend' as const], editRetries: 0, toolErrors: 0, verify: 'none' as const, repairAttempts: 0, aborted: false }
  recordOutcome(base, path)
  recordOutcome({ ...base, failed: true }, path)
  const report = competenceReport(path)
  expect(report.changingTurns).toBe(2)
  expect(report.cleanTurns).toBe(1)
})
