import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.ANTHROPIC_API_KEY ??= 'test-key-for-reason-test'

const { reason, resolveVerifier } = await import('./reason.ts')
const { libraryPath, readLibrary } = await import('./library.ts')
const { commandVerifier, probeVerifier } = await import('./verify.ts')
const { taskSignature } = await import('./signature.ts')
import type { Producer } from './select.ts'
import type { Candidate } from './verify.ts'

let dir: string
let file: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'elia-reason-'))
  file = libraryPath(dir)
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

const CHECKS = { test: 'bun --version', build: 'bun --version' }

/** Answers correctly only on the named approach, so a test can say which line of attack had to be found. */
const producerThatNeeds = (winningApproach: string, onCall?: () => void): Producer => async (input) => {
  onCall?.()
  return { id: `${input.approach.id}-${input.round}`, approach: input.approach.id, text: input.approach.id === winningApproach ? 'right' : 'wrong', cost: 1 }
}

const probeFor = (correct: string) => async () =>
  probeVerifier({
    id: 'synthesized',
    async probe(candidate: Candidate) {
      const passed = candidate.text === correct
      return { passed, detail: passed ? 'the written check passed' : 'the written check failed', progress: passed ? 1 : 0 }
    },
  })

test('a question is answered without buying a search', async () => {
  const outcome = await reason({
    request: 'what does the provider fallback do?',
    checks: CHECKS,
    produce: async () => {
      throw new Error('the producer must not be called for a question')
    },
    libraryFile: file,
  })

  expect(outcome.searched).toBe(false)
  expect(outcome.receipt).toContain('no search')
  expect(readLibrary(file).records).toEqual([])
})

test('a repair is searched, verified, and the run is filed under its signature', async () => {
  const outcome = await reason({
    request: 'fix the failing test in src/parser.ts',
    checks: {},
    produce: producerThatNeeds('from-the-code'),
    synthesizeProbe: probeFor('right'),
    forceHarnessId: 'wide',
    libraryFile: file,
  })

  expect(outcome.searched).toBe(true)
  expect(outcome.signature.key).toBe('repair/unchecked/single')
  expect(outcome.result?.verified).toBe(true)
  expect(outcome.result?.best?.approach).toBe('from-the-code')
  expect(outcome.receipt).toContain('verified')

  const record = readLibrary(file).records.find((entry) => entry.harnessId === 'wide')!
  expect(record.signature).toBe('repair/unchecked/single')
  expect(record.runs).toBe(1)
  expect(record.verifiedRuns).toBe(1)
})

test('a failed search is filed too — the library has to see what did not work', async () => {
  const outcome = await reason({
    request: 'fix the crash on startup',
    checks: {},
    produce: producerThatNeeds('nothing-matches-this'),
    synthesizeProbe: probeFor('right'),
    forceHarnessId: 'wide',
    libraryFile: file,
  })

  expect(outcome.result?.verified).toBe(false)
  expect(outcome.receipt).toContain('no attempt passed')

  const record = readLibrary(file).records[0]!
  expect(record.runs).toBe(1)
  expect(record.verifiedRuns).toBe(0)
})

test('with no check available the answer comes back marked unproven', async () => {
  const outcome = await reason({
    request: 'fix the crash on startup',
    checks: {},
    // No synthesizeProbe: there is nothing executable, so agreement is all there is.
    produce: async (input) => ({ id: input.approach.id, approach: input.approach.id, text: 'the same answer', cost: 1 }),
    forceHarnessId: 'wide',
    libraryFile: file,
  })

  expect(outcome.result?.best).toBeDefined()
  expect(outcome.result?.verified).toBe(false)
  expect(outcome.receipt).toContain('unproven')
  expect(outcome.receipt).toContain('no executable check was available')
  // Unanimity did not get filed as a success.
  expect(readLibrary(file).records[0]!.verifiedRuns).toBe(0)
})

test('the library steers the second run of the same shape', async () => {
  const request = 'fix the failing test in src/parser.ts'
  // Five runs is what the library requires before it will prefer anything.
  for (let run = 0; run < 5; run += 1) {
    await reason({ request, checks: {}, produce: producerThatNeeds('from-the-failure'), synthesizeProbe: probeFor('right'), forceHarnessId: 'deep', libraryFile: file })
  }

  let calls = 0
  const outcome = await reason({
    request,
    checks: {},
    produce: producerThatNeeds('from-the-failure', () => {
      calls += 1
    }),
    synthesizeProbe: probeFor('right'),
    libraryFile: file,
  })

  expect(outcome.harness?.id).toBe('deep')
  expect(outcome.choice).toContain('verified 5/5')
  expect(calls).toBeGreaterThan(0)
})

test('an aborted search is not recorded — it is the user changing their mind, not evidence', async () => {
  const controller = new AbortController()
  const outcome = await reason({
    request: 'fix the failing test',
    checks: {},
    produce: async (input) => {
      controller.abort()
      return { id: 'c', approach: input.approach.id, text: 'wrong', cost: 1 }
    },
    synthesizeProbe: probeFor('right'),
    forceHarnessId: 'wide',
    libraryFile: file,
    signal: controller.signal,
  })

  expect(outcome.result?.stopped).toBe('aborted')
  expect(readLibrary(file).records).toEqual([])
})

test('the project test command is composed behind the cheap build check', async () => {
  const signature = taskSignature('fix the failing test', { hasExecutableCheck: true })
  const resolved = await resolveVerifier({ kind: 'project-tests', checks: CHECKS, signature })

  expect(resolved.degraded).toBe(false)
  expect(typeof resolved.verifier === 'function' ? 'consensus' : resolved.verifier.id).toBe('project checks')
})

test('a harness that wanted a real check and got none says so', async () => {
  const signature = taskSignature('add a helper', { hasExecutableCheck: false })
  const resolved = await resolveVerifier({ kind: 'synthesized-probe', checks: {}, signature })

  expect(resolved.degraded).toBe(true)
})

test('a command verifier passes on exit 0 and fails with the output as evidence', async () => {
  const passing = await commandVerifier({ command: 'bun --version' }).run({ id: 'c', approach: 'a', text: '', cwd: dir })
  expect(passing.passed).toBe(true)
  expect(passing.strength).toBe('executed')

  writeFileSync(join(dir, 'fail.ts'), 'console.error("the check said no")\nprocess.exit(3)\n')
  const failing = await commandVerifier({ command: 'bun fail.ts' }).run({ id: 'c', approach: 'a', text: '', cwd: dir })
  expect(failing.passed).toBe(false)
  expect(failing.detail).toContain('exited 3')
  expect(failing.evidence).toContain('the check said no')
})

test('a candidate with no working tree cannot pass a command check', async () => {
  const verdict = await commandVerifier({ command: 'bun --version' }).run({ id: 'c', approach: 'a', text: '' })
  expect(verdict.passed).toBe(false)
  expect(verdict.detail).toContain('no working tree')
})
