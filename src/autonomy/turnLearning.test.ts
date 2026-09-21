import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { blockerPrompt, learnFromTurn, learningMode, memoryReceipt, parseLessons, similarity, turnEvidence, worthLearningFrom } from './turnLearning.ts'
import type { ChatMessage, Provider, StreamTurnParams } from '../providers/types.ts'

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function lessonsFile(): string {
  const dir = mkdtempSync(join(tmpdir(), 'elia-turn-learning-'))
  dirs.push(dir)
  return join(dir, 'lessons.md')
}

const text = (value: string) => ({ type: 'text' as const, text: value })
const call = (id: string, name: string, input: Record<string, unknown>) => ({ type: 'tool_use' as const, id, name, input })
const result = (id: string, content: string, isError = false) => ({ type: 'tool_result' as const, tool_use_id: id, content, is_error: isError })

/** The `ls` → `dir` fumble from a real Windows session. */
const WINDOWS_TURN: ChatMessage[] = [
  { role: 'user', content: [text('earlier request')] },
  { role: 'user', content: [text('check what is in the project')] },
  { role: 'assistant', content: [call('a', 'run_command', { command: 'ls -la workspace' })] },
  { role: 'user', content: [result('a', "'ls' is not recognized as an internal or external command", true)] },
  { role: 'assistant', content: [call('b', 'run_command', { command: 'dir workspace' })] },
  { role: 'user', content: [result('b', ' Directory of D:\\elia\\workspace')] },
]

test('the receipt names what the turn is drawing on, or nothing at all', () => {
  expect(memoryReceipt({ lessons: 0, rationale: '', brainCards: '', weakCaution: '', regretNudge: '' })).toBeUndefined()
  const receipt = memoryReceipt({
    lessons: 9,
    rationale: '\n\n## Why\n- a.ts: x — y\n- b.ts: x — y',
    brainCards: '\n\n## Known\n### src/app.ts\n- fact',
    weakCaution: '\n\n## Proceed carefully — weak area\nPast turns on this project landed config 29% clean in the area this task touches.',
    regretNudge: '\n\nNote: the previous turn hit friction (2 repair passes were needed). Read more carefully.',
  })
  expect(receipt).toBe(
    '✦ memory · 9 lessons from earlier sessions · 2 recorded design decisions · past knowledge of 1 file · weak area here (config 29% clean) — taking extra care · last turn hit friction (2 repair passes were needed)',
  )
})

test('a failure later put right by the same tool is evidence; the fix is recorded with it', () => {
  const evidence = turnEvidence(WINDOWS_TURN, 1)
  expect(evidence.failures).toEqual([
    { failed: 'run_command ls -la workspace', error: "'ls' is not recognized as an internal or external command", fixedBy: 'run_command dir workspace' },
  ])
})

test('unresolved failures, approval denials and edit slips are not evidence', () => {
  const messages: ChatMessage[] = [
    { role: 'assistant', content: [call('a', 'run_command', { command: 'npm publish' }), call('b', 'edit_file', { path: 'a.ts' }), call('c', 'run_command', { command: 'make' })] },
    { role: 'user', content: [result('a', 'Action denied by the operator', true), result('b', 'old_string not found in the file', true), result('c', 'make: *** No rule', true)] },
    { role: 'assistant', content: [call('d', 'edit_file', { path: 'a.ts' })] },
    { role: 'user', content: [result('d', 'edited')] },
  ]
  expect(turnEvidence(messages, 0).failures).toEqual([])
})

test('only mechanically resolved friction is worth learning from', () => {
  const resolved = turnEvidence(WINDOWS_TURN, 1)
  expect(worthLearningFrom(resolved, { verify: 'none', repairAttempts: 0 })).toBe(true)
  expect(worthLearningFrom(resolved, { verify: 'fail', repairAttempts: 2 })).toBe(false)
  expect(worthLearningFrom({ failures: [], checkFailures: [] }, { verify: 'pass', repairAttempts: 0 })).toBe(false)
  expect(worthLearningFrom({ failures: [], checkFailures: ["The project's checks fail after your changes"] }, { verify: 'pass', repairAttempts: 1 })).toBe(true)
})

test('lessons are parsed from JSON, capped at two, and generic or already-known ones are dropped', () => {
  const known = ['On Windows use dir instead of ls to list directories']
  const reply = `Here you go: {"lessons": [
    "On Windows, list directories with dir, not ls",
    "Always double-check your work before finishing",
    "Run the Vite build with bun run build from workspace/laptop-suggestor, not the repo root",
    "short",
    "The dev server for this project must be started with bun --hot src/server.ts",
    "A fourth one that should not survive because the cap is two lessons"
  ]}`
  expect(parseLessons(reply, known)).toEqual([
    'Run the Vite build with bun run build from workspace/laptop-suggestor, not the repo root',
    'The dev server for this project must be started with bun --hot src/server.ts',
  ])
  expect(parseLessons('not json', known)).toEqual([])
  expect(similarity('use dir not ls on windows', 'On Windows use dir instead of ls')).toBe(1)
  // Two different facts about the same tool are not duplicates.
  expect(similarity('Run the tests with bun test, not node', 'Install dependencies with bun install before building')).toBeLessThan(0.7)
})

test('a lesson that tells the next run to fabricate whatever was not found is never kept', () => {
  // The three lessons below were written to a real project's lessons.md, and
  // the first was in context when a run wrote a stub "skill" for a name its own
  // searches had just shown did not exist.
  const reply = JSON.stringify({
    lessons: [
      'Verify that all imported module paths exist on disk and match the file name’s case; create placeholder files if any are missing to avoid TypeScript module-not-found errors.',
      "Before attempting to list or access the .agents/skills directory, idempotently create it with 'mkdir -p .agents/skills' so that Windows commands like 'dir' do not exit with code 1 when the folder is absent.",
      'If src/skills/registry.ts is referenced in imports but does not exist, create a minimal placeholder file (e.g., an empty module or export default {}) to avoid runtime file-not-found errors.',
      'The skills registry lives in src/tools/registry.ts, not src/skills/registry.ts',
    ],
  })
  expect(parseLessons(reply, [])).toEqual(['The skills registry lives in src/tools/registry.ts, not src/skills/registry.ts'])
})

function reflectingProvider(reply: string): Provider & { calls: StreamTurnParams[] } {
  const calls: StreamTurnParams[] = []
  return {
    calls,
    async streamTurn(params) {
      calls.push(params)
      return { content: [text(reply)], usage: { inputTokens: 50, outputTokens: 20, cacheReadTokens: 0, cacheWriteTokens: 0 } }
    },
  }
}

test('a resolved failure becomes a stored lesson, from real tool output, with provenance', async () => {
  const path = lessonsFile()
  const provider = reflectingProvider('{"lessons": ["On this Windows machine list directories with dir; ls is not available in cmd"]}')
  let reflected = false
  const learned = await learnFromTurn({
    provider,
    messages: WINDOWS_TURN,
    fromIndex: 1,
    request: 'check what is in the project',
    outcome: { verify: 'none', repairAttempts: 0 },
    cwd: '/tmp',
    lessonsPath: path,
    onReflecting: () => {
      reflected = true
    },
  })

  expect(learned.lessons).toEqual(['On this Windows machine list directories with dir; ls is not available in cmd'])
  expect(reflected).toBe(true)
  const prompt = (provider.calls[0]!.messages[0]!.content[0] as { text: string }).text
  expect(prompt).toContain("'ls' is not recognized")
  expect(prompt).toContain('✓ then worked: run_command dir workspace')
  expect(provider.calls[0]!.tools).toEqual([])
  const stored = readFileSync(path, 'utf8')
  expect(stored).toContain('On this Windows machine list directories with dir')
  expect(stored).toContain('source=interactive-auto')
})

test('a clean turn makes no model call and learns nothing', async () => {
  const provider = reflectingProvider('{"lessons": ["should never be asked"]}')
  const clean: ChatMessage[] = [
    { role: 'user', content: [text('build it')] },
    { role: 'assistant', content: [call('a', 'run_command', { command: 'bun run build' })] },
    { role: 'user', content: [result('a', 'built')] },
  ]
  const learned = await learnFromTurn({ provider, messages: clean, fromIndex: 0, request: 'build it', outcome: { verify: 'pass', repairAttempts: 0 }, cwd: '/tmp', lessonsPath: lessonsFile() })
  expect(learned.lessons).toEqual([])
  expect(provider.calls).toHaveLength(0)
})

test('a reflection call that fails never breaks the finished turn', async () => {
  const provider: Provider = {
    async streamTurn() {
      throw new Error('rate limited')
    },
  }
  const learned = await learnFromTurn({ provider, messages: WINDOWS_TURN, fromIndex: 1, request: 'x', outcome: { verify: 'none', repairAttempts: 0 }, cwd: '/tmp', lessonsPath: lessonsFile() })
  expect(learned.lessons).toEqual([])
})

// --- A turn that ended still broken teaches the constraint --------------------

test('a failure that was never fixed is captured as unresolved, minus denials and slips', () => {
  const messages: ChatMessage[] = [
    { role: 'assistant', content: [call('a', 'run_command', { command: 'npm publish' }), call('b', 'edit_file', { path: 'a.ts' }), call('c', 'run_command', { command: 'make' })] },
    { role: 'user', content: [result('a', 'Action denied by the operator', true), result('b', 'old_string not found in the file', true), result('c', 'make: *** No rule', true)] },
  ]
  expect(turnEvidence(messages, 0).unresolved).toEqual([{ failed: 'run_command make', error: 'make: *** No rule' }])
})

test('a failed turn teaches as a blocker instead of being discarded', () => {
  const stuck = turnEvidence(
    [
      { role: 'assistant', content: [call('a', 'run_command', { command: 'cargo build' })] },
      { role: 'user', content: [result('a', 'error: linker link.exe not found', true)] },
    ],
    0,
  )
  // The old gate returned false here and the turn taught nothing at all.
  expect(worthLearningFrom(stuck, { verify: 'fail', repairAttempts: 1 })).toBe(false)
  expect(learningMode(stuck, { verify: 'fail', repairAttempts: 1 })).toBe('blocker')
})

test('a resolved failure still takes the repair path, and a clean turn teaches nothing', () => {
  expect(learningMode(turnEvidence(WINDOWS_TURN, 1), { verify: 'pass', repairAttempts: 0 })).toBe('repair')
  expect(learningMode({ failures: [], checkFailures: [], unresolved: [] }, { verify: 'pass', repairAttempts: 0 })).toBeUndefined()
  // Failed, but nothing mechanical to point at — no lesson worth recording.
  expect(learningMode({ failures: [], checkFailures: [], unresolved: [] }, { verify: 'fail', repairAttempts: 0 })).toBeUndefined()
})

test('the blocker prompt asks for the constraint and forbids inventing a fix', () => {
  const prompt = blockerPrompt(
    'build the rust crate',
    { failures: [], checkFailures: [], unresolved: [{ failed: 'run_command cargo build', error: 'linker link.exe not found' }] },
    [],
  )
  expect(prompt).toContain('cargo build')
  expect(prompt).toContain('linker link.exe not found')
  expect(prompt).toContain('do NOT state one')
})

// Workers do most of the hands-on work and used to take every hard-won fact
// away with them: `learnFromTurn` ran only on the interactive REPL, so a builder
// that found `ls` failing and `dir` working taught the next session nothing.
// src/subagent.ts now runs the same gate over a worker's own conversation.
test('a sub-agent records its friction under its own source, so it can be retired separately', async () => {
  const path = lessonsFile()
  const provider = reflectingProvider('{"lessons": ["On this Windows machine list directories with dir; ls is not available in cmd"]}')
  const learned = await learnFromTurn({
    provider,
    messages: WINDOWS_TURN,
    fromIndex: 1,
    request: 'survey the project',
    // What a finished worker passes: no verification gate of its own.
    outcome: { verify: 'none', repairAttempts: 0 },
    cwd: '/tmp',
    lessonsPath: path,
    sources: { repair: 'subagent', blocker: 'subagent-blocker' },
  })

  expect(learned.lessons.length).toBe(1)
  const stored = readFileSync(path, 'utf8')
  expect(stored).toContain('source=subagent')
  expect(stored).not.toContain('source=interactive-auto')
})

test('a worker that finished with nothing going wrong costs no model call', async () => {
  const provider = reflectingProvider('{"lessons": ["should never be asked"]}')
  const clean: ChatMessage[] = [
    { role: 'user', content: [text('survey the project')] },
    { role: 'assistant', content: [call('a', 'read_file', { path: 'src/index.ts' })] },
    { role: 'user', content: [result('a', 'ok')] },
  ]
  const learned = await learnFromTurn({
    provider,
    messages: clean,
    fromIndex: 0,
    request: 'survey the project',
    outcome: { verify: 'none', repairAttempts: 0 },
    cwd: '/tmp',
    lessonsPath: lessonsFile(),
    sources: { repair: 'subagent', blocker: 'subagent-blocker' },
  })
  expect(learned.lessons).toEqual([])
  expect(provider.calls.length).toBe(0)
})
