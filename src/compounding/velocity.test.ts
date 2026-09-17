import { expect, test } from 'bun:test'

process.env.ANTHROPIC_API_KEY ??= 'test-key-for-velocity-test'

const { MIN_SPLIT, evidenceVelocity, renderVelocity } = await import('./velocity.ts')
import type { EvidenceCost, GenerationRecord } from '../evolve/ledger.ts'

let n = 0
function gen(cost?: Partial<EvidenceCost>): GenerationRecord {
  n += 1
  const record: GenerationRecord = {
    generation: n,
    at: n,
    hypothesis: 'h',
    rationale: 'r',
    targetFiles: [],
    changedFiles: [],
    verdict: 'rejected',
    reason: '',
    model: 'm',
  }
  if (cost) {
    record.evidenceCost = { tasksRun: 5, tasksCarried: 0, tasksSkipped: 0, tasksTotal: 54, tokens: 1000, msToVerdict: 1000, ...cost }
  }
  return record
}

test('an empty ledger has no velocity to report', () => {
  const report = evidenceVelocity([])
  expect(report.all.verdicts).toBe(0)
  expect(renderVelocity(report)).toContain('no generations yet')
})

test('generations from before the accounting are counted as unaccounted, not as free', () => {
  // The two generations in the ledger from August cost a full sweep each. Folding
  // them in as zero would report a saving that never happened.
  const report = evidenceVelocity([gen(), gen()])
  expect(report.all.verdicts).toBe(0)
  expect(report.unaccounted).toBe(2)
  expect(renderVelocity(report)).toContain('predate the accounting')
})

test('velocity is task runs per verdict against what a sweep would have cost', () => {
  const report = evidenceVelocity([gen({ tasksRun: 4, tasksTotal: 54, tokens: 2000 }), gen({ tasksRun: 6, tasksTotal: 54, tokens: 4000 })])
  expect(report.all.verdicts).toBe(2)
  expect(report.all.tasksPerVerdict).toBe(5)
  expect(report.all.tokensPerVerdict).toBe(3000)
  expect(report.avoided).toBeCloseTo((108 - 10) / 108, 5)

  const line = renderVelocity(report)
  expect(line).toContain('2 verdict(s) at 5.0 task run(s) each')
  expect(line).toContain('against 54 for a full sweep')
  expect(line).toContain('91% not paid for')
})

test('the trend splits the recorded generations in half and says which way it went', () => {
  const cheapening = evidenceVelocity([
    gen({ tasksRun: 20 }),
    gen({ tasksRun: 20 }),
    gen({ tasksRun: 4 }),
    gen({ tasksRun: 2 }),
  ])
  expect(cheapening.earlier!.tasksPerVerdict).toBe(20)
  expect(cheapening.later!.tasksPerVerdict).toBe(3)
  expect(cheapening.cheapening).toBe(true)
  expect(renderVelocity(cheapening)).toContain('verdicts are getting cheaper')

  const worsening = evidenceVelocity([gen({ tasksRun: 2 }), gen({ tasksRun: 2 }), gen({ tasksRun: 30 }), gen({ tasksRun: 30 })])
  expect(worsening.cheapening).toBe(false)
  expect(renderVelocity(worsening)).toContain('no cheaper')
})

test('a trend is not claimed before there is one', () => {
  const report = evidenceVelocity([gen({ tasksRun: 3 })])
  expect(report.cheapening).toBeUndefined()
  expect(renderVelocity(report)).toContain(`${MIN_SPLIT - 1} more verdict(s)`)
})
