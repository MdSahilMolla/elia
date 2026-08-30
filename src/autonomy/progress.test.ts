import { expect, test } from 'bun:test'
import { assessProgress, errorSignature, failureFingerprints, type AttemptSnapshot } from './progress.ts'
import type { VerificationOutcome } from './verify.ts'
import type { CriticVerdict } from './types.ts'

function result(command: string, exitCode: number, stdout = '', stderr = '', timedOut = false) {
  return { command, exitCode, stdout, stderr, elapsedMs: 10, timedOut }
}

function verification(passed: boolean, results: ReturnType<typeof result>[]): VerificationOutcome {
  return { passed, results }
}

// --- errorSignature ---

test('errorSignature strips paths, line numbers, and hashes so the same error fingerprints identically across machines', () => {
  const a = errorSignature('D:\\elia\\src\\foo.ts:42:10 - error TS2322: Type string is not assignable to number')
  const b = errorSignature('/home/ci/work/src/foo.ts:9:3 - error TS2322: Type string is not assignable to number')
  expect(a).toBe(b)
  // The TS error code is stable across machines, so it is kept; the path and the
  // line:col are not, so they are normalized away.
  expect(a).toContain('ts2322')
  expect(a).not.toContain('foo.ts')
  expect(a).not.toContain('42')
})

test('errorSignature picks the assertion line out of a noisy test dump', () => {
  const sig = errorSignature(['bun test v1.3', '', 'src/x.test.ts:', '  Expected: 4', '  Received: 5', '', '1 fail'].join('\n'))
  expect(sig).toContain('expected')
})

test('errorSignature falls back to the first line when nothing salient matches', () => {
  expect(errorSignature('just some output\nmore output')).toBe('just some output')
  expect(errorSignature('')).toBe('no-output')
})

// --- failureFingerprints ---

test('a passing verification with no verdict has no fingerprints', () => {
  expect(failureFingerprints(verification(true, [result('bun test', 0)]))).toEqual([])
})

test('failed commands and blocking review issues both contribute fingerprints; minor issues do not', () => {
  const v = verification(false, [result('bun run typecheck', 0), result('bun test', 1, 'Expected: 1\nReceived: 2', '')])
  const verdict: CriticVerdict = {
    verdict: 'revise',
    summary: 'problems',
    issues: [
      { severity: 'blocker', file: 'src/a.ts', detail: 'SQL injection in query builder' },
      { severity: 'minor', detail: 'nit: rename variable' },
    ],
  }
  const fps = failureFingerprints(v, verdict)
  expect(fps.some((f) => f.startsWith('verify:bun test::'))).toBe(true)
  expect(fps.some((f) => f.startsWith('review:blocker:src/a.ts:'))).toBe(true)
  expect(fps.some((f) => f.includes('rename variable'))).toBe(false)
})

test('a timed-out command fingerprints as a timeout regardless of partial output', () => {
  const fps = failureFingerprints(verification(false, [result('bun test', 1, 'partial', '', true)]))
  expect(fps).toEqual(['verify:bun test::timeout'])
})

// --- assessProgress ---

const snap = (attempt: number, failures: string[]): AttemptSnapshot => ({ attempt, failures })

test('before any repair attempt, always continue', () => {
  expect(assessProgress([]).recommendation).toBe('continue')
  expect(assessProgress([snap(0, ['verify:x::a'])]).trend).toBe('first-attempt')
  expect(assessProgress([snap(0, ['verify:x::a'])]).recommendation).toBe('continue')
})

test('identical failures on consecutive attempts is a stall — stop and hand off', () => {
  const a = assessProgress([snap(0, ['verify:test::expected <n>', 'verify:lint::x']), snap(1, ['verify:test::expected <n>', 'verify:lint::x'])])
  expect(a.trend).toBe('stalled')
  expect(a.recommendation).toBe('stop')
  expect(a.repeated).toHaveLength(2)
})

test('strictly fewer failures than the previous attempt is converging — keep going', () => {
  const a = assessProgress([snap(0, ['verify:a::1', 'verify:b::2', 'verify:c::3']), snap(1, ['verify:a::1'])])
  expect(a.trend).toBe('converging')
  expect(a.recommendation).toBe('continue')
})

test('more failures than before, or new failures at equal count, is diverging — stop', () => {
  expect(assessProgress([snap(0, ['verify:a::1']), snap(1, ['verify:a::1', 'verify:b::2'])]).trend).toBe('diverging')
  expect(assessProgress([snap(0, ['verify:a::1', 'verify:b::2']), snap(1, ['verify:a::1', 'verify:c::3'])]).trend).toBe('diverging')
  expect(assessProgress([snap(0, ['verify:a::1']), snap(1, ['verify:b::2'])]).recommendation).toBe('stop')
})

test('a failure that survives every one of three-plus attempts is a stall even while the total count drifts down', () => {
  const a = assessProgress([
    snap(0, ['verify:core::boom', 'verify:x::1', 'verify:y::2']),
    snap(1, ['verify:core::boom', 'verify:x::1']),
    snap(2, ['verify:core::boom']),
  ])
  expect(a.trend).toBe('stalled')
  expect(a.repeated).toContain('verify:core::boom')
})

test('the latest attempt passing is reported as resolved', () => {
  expect(assessProgress([snap(0, ['verify:a::1']), snap(1, [])]).trend).toBe('resolved')
})
