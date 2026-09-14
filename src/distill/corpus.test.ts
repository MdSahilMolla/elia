import { expect, test, describe, afterAll } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { collectDistillableTraces, diagnoseTraceSupply } from './corpus.ts'

const made: string[] = []

function project(receipts: Record<string, unknown>): string {
  const root = mkdtempSync(join(tmpdir(), 'elia-distill-corpus-'))
  made.push(root)
  for (const [runId, receipt] of Object.entries(receipts)) {
    const dir = join(root, '.elia', 'runs', runId)
    mkdirSync(dir, { recursive: true })
    if (receipt !== null) writeFileSync(join(dir, 'receipt.json'), JSON.stringify(receipt))
  }
  return root
}

afterAll(() => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true })
})

const verifiedReceipt = {
  runId: 'good',
  goal: 'add a route',
  outcome: 'completed',
  completion: { state: 'verified' },
  verdict: { verdict: 'approve' },
  verification: [{ passed: true }],
  proposal: { steps: [{ role: 'builder', title: 'build', files: ['src/a.ts'] }], verification: ['bun test'] },
  completedAt: 1,
}

describe('diagnoseTraceSupply', () => {
  test('a qualifying run is reported as accepted with no rejections', () => {
    const rows = diagnoseTraceSupply(project({ good: verifiedReceipt }))
    expect(rows).toHaveLength(1)
    expect(rows[0]!.accepted).toBe(true)
    expect(rows[0]!.rejectedBy).toEqual([])
  })

  test('a run directory with no receipt is named as an unfinished run', () => {
    const rows = diagnoseTraceSupply(project({ aborted: null }))
    expect(rows[0]!.accepted).toBe(false)
    expect(rows[0]!.rejectedBy[0]).toContain('no receipt')
  })

  test('a failed run reports every stage it failed, not just the first', () => {
    // The breakdown is the whole point: "not enough traces" reads identically
    // whether runs keep failing or the pipeline is broken, and those need
    // opposite responses.
    const rows = diagnoseTraceSupply(
      project({
        bad: {
          ...verifiedReceipt,
          outcome: 'needs-attention',
          completion: { state: 'failed' },
          verification: [{ passed: false }, { passed: false }],
        },
      }),
    )
    const reasons = rows[0]!.rejectedBy.join(' | ')
    expect(rows[0]!.accepted).toBe(false)
    expect(reasons).toContain('outcome=needs-attention')
    expect(reasons).toContain('completion=failed')
    expect(reasons).toContain('never passed')
  })

  test('a review verdict of revise disqualifies the run', () => {
    const rows = diagnoseTraceSupply(project({ r: { ...verifiedReceipt, verdict: { verdict: 'revise' } } }))
    expect(rows[0]!.rejectedBy.join(' ')).toContain('revise')
  })

  test('unreadable JSON is reported rather than silently skipped', () => {
    const root = project({})
    const dir = join(root, '.elia', 'runs', 'broken')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'receipt.json'), '{not json')
    const rows = diagnoseTraceSupply(root)
    expect(rows[0]!.rejectedBy).toEqual(['unreadable receipt'])
  })

  test('a project with no runs directory yields nothing rather than throwing', () => {
    expect(diagnoseTraceSupply(mkdtempSync(join(tmpdir(), 'elia-empty-')))).toEqual([])
  })

  test('its accept verdict agrees with what the collector actually keeps', () => {
    // The diagnostic re-implements the filter, so it can drift from the real one
    // and start explaining rejections that are not happening. This pins them
    // together on the cases that matter.
    const root = project({
      good: verifiedReceipt,
      aborted: { ...verifiedReceipt, runId: 'aborted', outcome: 'aborted', completion: { state: 'aborted' } },
      unreviewed: { ...verifiedReceipt, runId: 'unreviewed', verdict: { verdict: 'revise' } },
    })
    const acceptedByDiagnostic = diagnoseTraceSupply(root)
      .filter((r) => r.accepted)
      .map((r) => r.runId)
      .sort()
    const keptByCollector = collectDistillableTraces(root)
      .map((t) => t.runId)
      .sort()
    expect(acceptedByDiagnostic).toEqual(['good'])
    expect(keptByCollector).toEqual(['good'])
  })
})
