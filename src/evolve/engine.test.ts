import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// engine.ts pulls in the agent loop, which resolves a provider at import time.
process.env.ANTHROPIC_API_KEY ??= 'test-key-for-local-tests'

const { eliaVersion, renderFailureEvidence, standsOnWinner } = await import('./engine.ts')
const { gateDecision, meanGainOver, sealedCompare } = await import('./acceptance.ts')
const { compareScorecards } = await import('./fitness.ts')
const { archiveNearMiss, readArchive } = await import('./archive.ts')
import type { GenerationRecord, Metrics } from './ledger.ts'
import type { SealedVerdict } from './acceptance.ts'
import type { TaskOutcome } from './fitness.ts'
import type { NearMiss } from './archive.ts'

function metrics(passed: string[], failed: string[]): Metrics {
  return { passRate: passed.length / (passed.length + failed.length), passed, failed, totalTokens: 100_000, totalElapsedMs: 60_000 }
}

/** Metrics carrying a per-task pass rate, the shape repeats give the loop. */
function rated(ids: readonly string[], taskRates: Record<string, number>): Metrics {
  const passed = ids.filter((id) => (taskRates[id] ?? 0) >= 1)
  const failed = ids.filter((id) => (taskRates[id] ?? 0) < 1)
  return { passRate: passed.length / ids.length, passed, failed, taskRates, totalTokens: 100_000, totalElapsedMs: 60_000 }
}

function failure(taskId: string, steps: number, overrides: Partial<TaskOutcome> = {}): TaskOutcome {
  return { taskId, weight: 1, passed: false, detail: 'did the wrong thing', steps, elapsedMs: 1_000, totalTokens: 100, ...overrides }
}

test('renderFailureEvidence is the funnel’s evidence helper: capped at 8, error over detail, kept runs named', () => {
  // attemptGeneration (engine.ts:344) collects the shown failures and hands them
  // to this helper for the `proposed` stage's brief. Empty evidence stays silent.
  expect(renderFailureEvidence([])).toBe('')

  const evidence = [
    failure('hist-abc', 3, { error: 'the test process crashed', stopReason: 'error' }),
    failure('precise-edit', 5, { keptDir: '/tmp/kept/precise-edit' }),
    failure('hard-1', 9),
  ]
  const rendered = renderFailureEvidence(evidence)
  // The error outranks the detail, and the execution stop reason is reported.
  expect(rendered).toContain('- hist-abc (3 steps, stopped: error): the test process crashed')
  // A detail is shown only where there was no process error.
  expect(rendered).toContain('- hard-1 (9 steps): did the wrong thing')
  expect(rendered).toContain('its final state is kept at /tmp/kept/precise-edit')
  expect(rendered).not.toContain('more not shown')

  // Evidence beyond MAX_EVIDENCE_TASKS is sliced, with the remainder counted.
  const many = Array.from({ length: 12 }, (_, i) => failure(`task-${i}`, 2))
  const capped = renderFailureEvidence(many)
  expect(capped.match(/^- /gm)).toHaveLength(8)
  expect(capped).toContain('(4 more not shown)')
  expect(capped).not.toContain('task-8')
  expect(capped).not.toContain('task-11')
})

test('the funnel’s gate helper: a sealed rejection stops the run even on a legacy win, and a sealed accept never rescues a legacy loss', () => {
  // attemptGeneration posts a rejection at the `better`/`confirmed` stages
  // through `gateDecision(gate, comparison.better, sealed)` (engine.ts:598,
  // :625). The funnel stage strings themselves are inline posts that only a
  // live run reaches, so the decision helper is what is pinned here — the two
  // combinations acceptance.test.ts does not exercise.
  const accept = { bit: 'accept', reason: 'e-value cleared' } as SealedVerdict
  const reject = { bit: 'reject', reason: 'e-value below the level' } as SealedVerdict

  // `both` demands both gates: a legacy win whose sealed verdict rejects does
  // not post `better` — the two real measurements found nothing certifiable.
  expect(gateDecision('both', true, reject)).toBe(false)
  // `legacy` (the default) is the legacy rule alone: the sealed bit is recorded
  // beside the victory, never the decision, so an accept cannot overrule a loss.
  expect(gateDecision('legacy', false, accept)).toBe(false)
})

test('the confirmation pair must clear the same gate independently, and reuses the same spent level', () => {
  // engine.ts:607-631: a provisional win is re-measured in an independent
  // baseline/candidate pair before it may touch live code. `comparisonIndex` is
  // computed once (line 593) and handed to the confirmation's sealedCompare
  // unchanged (line 623), so the second measurement spends no extra level from
  // the lifetime budget — the needed e-value is identical.
  const all = Array.from({ length: 54 }, (_, i) => `t${String(i).padStart(2, '0')}`)
  const baseline = metrics(all.slice(0, 50), all.slice(50))
  const candidate = metrics(all.slice(0, 52), all.slice(52))
  const comparisonIndex = 1

  const better = compareScorecards(baseline, candidate)
  expect(better.better).toBe(true)
  const provisional = sealedCompare(baseline, candidate, { index: comparisonIndex })
  expect(provisional.bit).toBe('reject')

  const confirmationSealed = sealedCompare(baseline, candidate, { index: comparisonIndex })
  expect(confirmationSealed.needed).toBe(provisional.needed)
  expect(confirmationSealed.level).toBe(provisional.level)

  // `both`: the reproduced legacy win alone does not clear the confirmation —
  // the sealed verdict still rejects, so the engine rejects with
  // "provisional improvement did not reproduce" (engine.ts:625-631).
  expect(gateDecision('both', better.better, confirmationSealed)).toBe(false)
  // `legacy` (default): a reproduced legacy win promotes; the sealed bit is recorded only.
  expect(gateDecision('legacy', better.better, confirmationSealed)).toBe(true)
})

let dir: string
let evolution: string
let sandboxRoot: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'elia-engine-'))
  evolution = join(dir, '.evolution')
  sandboxRoot = join(dir, 'gen-7')
  mkdirSync(join(sandboxRoot, 'src', 'autonomy'), { recursive: true })
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

function miss(shownQuality: number, gainedShown: readonly string[]): NearMiss {
  writeFileSync(join(sandboxRoot, 'src', 'autonomy', 'loop.ts'), 'improved loop')
  return {
    generation: 7,
    hypothesis: 'retry the gate once before giving up',
    verdict: 'rejected',
    reason: 'provisional improvement did not reproduce',
    sandboxRoot,
    changedFiles: ['src/autonomy/loop.ts'],
    base: new Map([['src/autonomy/loop.ts', 'h1']]),
    shownQuality,
    gainedShown,
  }
}

test('keepSteppingStone’s gate is a positive gain on the shown half, computed by meanGainOver', () => {
  // The archive decrees that a rejected candidate is kept only when it moved the
  // tasks the proposer was shown the right way (archive.ts:97). keepSteppingStone
  // (engine.ts:324-341) computes that number with `meanGainOver(baseline,
  // candidate, split.train)` and hands it to archiveNearMiss — only a live run
  // reaches it, so this pins the glue with the two halves it composes, in a temp dir.
  const ids = ['t01', 't02', 't03', 't04', 't05', 't06']
  const shown = new Set(['t01', 't02', 't03'])
  const baseline = rated(ids, { t01: 0, t02: 0, t03: 0, t04: 0, t05: 0, t06: 0 })

  // A gain that landed entirely on the held-out half scores zero on shown —
  // built from nothing the proposer was told, it is no stepping stone (I2).
  const heldOutOnly = rated(ids, { t01: 0, t02: 0, t03: 0, t04: 1, t05: 0, t06: 0 })
  expect(meanGainOver(baseline, heldOutOnly, shown)).toBe(0)
  expect(archiveNearMiss(miss(meanGainOver(baseline, heldOutOnly, shown), []), evolution)).toBeUndefined()
  expect(readArchive(evolution)).toHaveLength(0)

  // A shown-half gain is the exact quality number the archive ranks on.
  const shownGain = rated(ids, { t01: 1, t02: 0, t03: 0, t04: 1, t05: 0, t06: 0 })
  expect(meanGainOver(baseline, shownGain, shown)).toBeCloseTo(1 / 3, 9)
  const stone = archiveNearMiss(miss(meanGainOver(baseline, shownGain, shown), ['t01']), evolution)!
  expect(stone.area).toBe('autonomy')
  expect(stone.target).toBe('synthetic')
  expect(readArchive(evolution)).toHaveLength(1)
})

// promoteTo (engine.ts:708-733) is the one flagged behavior that is genuinely
// unreachable offline: the `branch` path sits after the model hypothesised, the
// sandbox built, and both live measurement pairs ran, so a test would have to
// fake a model. The nearest pure subfunction is promoteToBranch (sandbox.ts),
// whose two properties the engine's wiring depends on — the branch holds only
// the candidate's change with the working tree untouched, and a file with
// uncommitted local edits is refused as a LiveTreeConflict — are already pinned
// by sandbox.test.ts and deliberately not duplicated here.

test('only a promotion that is in the live tree becomes the next generation’s baseline', () => {
  // A branch promotion leaves the working tree alone, so the next candidate is cut
  // from source without the win; measuring it against a baseline that has the win
  // would hold it to a gain it was never given.
  const record = (overrides: Partial<GenerationRecord>): GenerationRecord => ({
    generation: 1, at: 1, hypothesis: '', rationale: '', targetFiles: [], changedFiles: [], verdict: 'rejected', reason: '', model: 'm', candidate: metrics(['a'], []), ...overrides,
  })
  expect(standsOnWinner(record({ verdict: 'promoted' }))).toBe(true)
  expect(standsOnWinner(record({ verdict: 'promoted', branch: 'evolve/gen-1-2026-09-24', commit: 'abc' }))).toBe(false)
  // Once landing fast-forwarded the branch into the checkout, the win is in the tree after all.
  expect(standsOnWinner(record({ verdict: 'promoted', branch: 'evolve/gen-1-2026-09-24', commit: 'abc', landed: { previousHead: 'def', at: 1 } }))).toBe(true)
  expect(standsOnWinner(record({ verdict: 'rejected' }))).toBe(false)
  expect(standsOnWinner(record({ verdict: 'promoted', candidate: undefined }))).toBe(false)
})

test('eliaVersion reads the version elia is running', () => {
  // A leaf reporter (engine.ts:949); it has no dir parameter to redirect, so it
  // reads the repo's own package.json. Best-effort and stable.
  expect(eliaVersion()).toMatch(/^\d+\.\d+\.\d+/)
})