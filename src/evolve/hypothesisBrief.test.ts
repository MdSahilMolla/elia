import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.ANTHROPIC_API_KEY ??= 'test-key-for-hypothesis-brief-test'

const { hypothesisBrief } = await import('./engine.ts')
import type { Metrics } from './ledger.ts'

/**
 * What the proposer actually reads.
 *
 * The loop has run two generations and promoted nothing, and the reason was
 * never visible: no test rendered the brief, so nobody could see that it said
 * nothing about how elia behaves on real work. These assertions are about
 * *ordering and framing* rather than wording — the field evidence must sit
 * behind the benchmark evidence, which is the only signal the promotion gate
 * can score.
 */

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'elia-brief-'))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

const METRICS: Metrics = { passRate: 0.86, passed: ['precise-edit'], failed: ['find-symbol'], totalTokens: 1_000, totalElapsedMs: 60_000 }
const SANDBOX = { root: 'C:/fake/sandbox', generation: 1 } as never

test('the brief renders with no model, and no ledgers on disk', () => {
  const brief = hypothesisBrief(SANDBOX, METRICS)

  expect(brief).toContain('## How you are scored')
  expect(brief).toContain('## What you may not change')
  expect(brief).toContain('FAILING: find-symbol')
})

test('field evidence sits after the benchmark evidence and before the immutable list', () => {
  const evidence = [{ taskId: 'find-symbol', passed: false, steps: 12, detail: 'did not find it', weight: 1 }] as never
  const brief = hypothesisBrief(SANDBOX, METRICS, evidence)

  const benchmarkAt = brief.indexOf('## Why the failing tasks failed')
  const immutableAt = brief.indexOf('## What you may not change')
  expect(benchmarkAt).toBeGreaterThan(-1)
  expect(immutableAt).toBeGreaterThan(benchmarkAt)

  const fieldAt = brief.indexOf('## What actually goes wrong in real use')
  if (fieldAt > -1) {
    // Ordering is the claim: the benchmark evidence is the stronger signal and
    // the only one the gate can score, so it must be read first.
    expect(fieldAt).toBeGreaterThan(benchmarkAt)
    expect(fieldAt).toBeLessThan(immutableAt)
  }
})

test('a held-out task appears nowhere in the brief the proposer reads', async () => {
  const { blindEvidence, blindMetrics, halfMetrics, splitTasks } = await import('./split.ts')
  const ids = ['precise-edit', 'find-symbol', 'fix-failing-test', 'propagate-rename', 'hist-7c2db18', 'hist-fa1f598', 'slugify', 'stats-median']
  const tasks = ids.map((id) => ({ id, weight: 1, prompt: id, setup: async () => {}, check: async () => ({ passed: true, detail: '' }) }))
  const split = splitTasks(tasks)
  expect(split.heldOut.length).toBeGreaterThan(0)

  // Every task fails, so every one of them has an id, a step count and a
  // failure detail that could reach the brief. Only the shown half may.
  const rows = tasks.map((task) => ({ taskId: task.id, weight: 1, passed: false, detail: `${task.id} blew up`, steps: 9, elapsedMs: 1, totalTokens: 1, model: 'm' }))
  const whole: Metrics = {
    passRate: 0,
    passed: [],
    failed: ids,
    steps: Object.fromEntries(ids.map((id) => [id, 9])),
    totalTokens: 1_000,
    totalElapsedMs: 60_000,
  }

  const brief = hypothesisBrief(SANDBOX, blindMetrics(whole, split, halfMetrics(rows, split.train).passRate), blindEvidence(rows, split))

  for (const heldOut of split.heldOut) expect(brief).not.toContain(heldOut.id)
  for (const shown of split.train) expect(brief).toContain(shown.id)
})

test('the brief never throws when every log is missing', () => {
  const empty = join(dir, 'nothing-here.ndjson')
  writeFileSync(join(dir, 'placeholder'), '')
  expect(() => hypothesisBrief(SANDBOX, METRICS)).not.toThrow()
  expect(empty).toBeTruthy()
})

test('the proposer sees what the agent did on a failing task, and only for the first few', async () => {
  const { renderFailureEvidence } = await import('./engine.ts')
  const failing = (id: string) => ({ taskId: id, weight: 1, passed: false, detail: 'nothing was pushed', steps: 19, elapsedMs: 1, totalTokens: 1, stopReason: 'step-budget', trace: `1. run_command {"command":"git clone"} → ok: ${id}` })
  const brief = renderFailureEvidence(['a', 'b', 'c', 'd', 'e'].map(failing))
  expect(brief).toContain('- a (19 steps, stopped: step-budget): nothing was pushed')
  expect(brief).toContain('    1. run_command {"command":"git clone"} → ok: a')
  expect(brief).toContain('→ ok: d')
  // Every proposer step re-sends the brief; a fifth trace is paid for thirty times.
  expect(brief).not.toContain('→ ok: e')
  expect(brief).toContain('- e (19 steps')
})
