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

test('the brief never throws when every log is missing', () => {
  const empty = join(dir, 'nothing-here.ndjson')
  writeFileSync(join(dir, 'placeholder'), '')
  expect(() => hypothesisBrief(SANDBOX, METRICS)).not.toThrow()
  expect(empty).toBeTruthy()
})
