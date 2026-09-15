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
  verification: [{ passed: true, results: [{ command: 'bun test', exitCode: 0 }] }],
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

  test('verification that "passed" without running a check does not qualify a run', () => {
    // What 2026-09-12-tona-tgmi — for a long time the only qualifying run — and
    // 2026-09-15-7cj7-8oi2 looked like: a plan with nothing runnable, recorded
    // as a pass.
    const root = project({
      empty: { ...verifiedReceipt, verification: [{ passed: true, results: [] }] },
      none: { ...verifiedReceipt, verification: [] },
    })
    const rows = Object.fromEntries(diagnoseTraceSupply(root).map((row) => [row.runId, row]))
    expect(rows.empty!.accepted).toBe(false)
    expect(rows.empty!.rejectedBy).toContain('verification "passed" without running a single check')
    expect(rows.none!.rejectedBy).toContain('verification never ran')
    expect(collectDistillableTraces(root)).toEqual([])
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

describe('a run that died before writing a receipt', () => {
  /** A run directory holding only the journal a killed run leaves behind. */
  function unfinished(events: Record<string, unknown>[], actions: Record<string, unknown>[] = []): string {
    const root = mkdtempSync(join(tmpdir(), 'elia-distill-unfinished-'))
    made.push(root)
    const dir = join(root, '.elia', 'runs', 'dead-run')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'events.ndjson'), events.map((event) => JSON.stringify(event)).join('\n'))
    if (actions.length > 0) writeFileSync(join(dir, 'actions.ndjson'), actions.map((action) => JSON.stringify(action)).join('\n'))
    return root
  }

  test('is reported with the phase it was in and what it last did, not just "never finished"', () => {
    // Every unfinished run used to read identically, naming no phase, no action
    // and no error — so nine of them in one report said nothing actionable.
    const rows = diagnoseTraceSupply(
      unfinished(
        [
          { seq: 0, at: 1000, kind: 'run-start', data: { runId: 'dead-run', goal: 'build a thing' } },
          { seq: 1, at: 2000, kind: 'phase', data: { phase: 'execute' } },
        ],
        [{ at: 26_000, actor: 'builder#1', tool: 'run_command', isError: true }],
      ),
    )
    expect(rows[0]!.accepted).toBe(false)
    const reason = rows[0]!.rejectedBy[0]!
    expect(reason).toContain('no receipt')
    expect(reason).toContain('execute')
    expect(reason).toContain('builder#1')
    expect(reason).toContain('run_command')
    expect(reason).toContain('which failed')
    expect(reason).toContain('25s in')
  })

  test('uses the last action even when it happened after the last journal event', () => {
    // Not every phase writes a phase event, so a run that looked like it died in
    // scaffold had in fact gone on working for another 20 seconds.
    const rows = diagnoseTraceSupply(
      unfinished(
        [
          { seq: 0, at: 1000, kind: 'run-start', data: {} },
          { seq: 1, at: 1500, kind: 'phase', data: { phase: 'scaffold' } },
        ],
        [{ at: 21_500, actor: 'assumptions#1', tool: 'grep', isError: false }],
      ),
    )
    expect(rows[0]!.rejectedBy[0]).toContain('assumptions#1')
    // 20.5s elapsed, and the journal's own last event was at 0.5s.
    expect(rows[0]!.rejectedBy[0]).toContain('21s in')
  })

  test('names what the run was doing inside a phase when the journal recorded it', () => {
    // Runs 2026-09-12-rud7-xpqd and 2026-09-13-6trz-872u died checking the
    // plan's assumptions, and read as having died writing the repository.
    const rows = diagnoseTraceSupply(
      unfinished(
        [
          { seq: 0, at: 1000, kind: 'run-start', data: {} },
          { seq: 1, at: 1500, kind: 'phase', data: { phase: 'scaffold', initialized: true } },
          { seq: 2, at: 1600, kind: 'phase', data: { phase: 'scaffold', activity: 'checking assumptions', assumptions: 3 } },
        ],
        [{ at: 16_000, actor: 'assumptions#1', tool: 'grep', isError: false }],
      ),
    )
    expect(rows[0]!.rejectedBy[0]).toContain('during the scaffold phase, checking assumptions; assumptions#1 had just run grep')
  })

  test('says so plainly when the run left no journal at all', () => {
    const rows = diagnoseTraceSupply(unfinished([]))
    expect(rows[0]!.rejectedBy[0]).toContain('left no journal')
  })

  test('a torn final line from a run killed mid-write does not lose the rest', () => {
    const root = mkdtempSync(join(tmpdir(), 'elia-distill-torn-'))
    made.push(root)
    const dir = join(root, '.elia', 'runs', 'dead-run')
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      join(dir, 'events.ndjson'),
      `${JSON.stringify({ seq: 0, at: 1000, kind: 'run-start', data: {} })}\n${JSON.stringify({ seq: 1, at: 3000, kind: 'phase', data: { phase: 'verify' } })}\n{"seq":2,"at":40`,
    )
    expect(diagnoseTraceSupply(root)[0]!.rejectedBy[0]).toContain('verify')
  })
})
