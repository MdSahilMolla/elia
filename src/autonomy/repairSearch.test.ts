import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.ANTHROPIC_API_KEY ??= 'test-key-for-repair-search-test'

const { repairApproachDirective, repairSearchEnabled, runStalledRepairSearch, stalledRepairHarnesses, stalledRepairSignature } = await import('./repairSearch.ts')
const { createActionGovernor } = await import('./governor.ts')
const { GoalGraphStore, activeGoalGraph, withGoalGraph, withoutGoalGraph } = await import('./goalGraph.ts')
const { APPROACHES_BY_CLASS } = await import('../reason/harness.ts')
const { readLibrary } = await import('../reason/library.ts')
const { runGit } = await import('./worktree.ts')
import type { VerificationOutcome } from './verify.ts'

let repo: string
let libraryDir: string
beforeEach(async () => {
  repo = mkdtempSync(join(tmpdir(), 'elia-repair-search-'))
  libraryDir = mkdtempSync(join(tmpdir(), 'elia-repair-library-'))
  writeFileSync(join(repo, 'answer.txt'), 'original\n')
  await runGit(['init', '-q', '-b', 'main'], repo)
  await runGit(['config', 'user.email', 'test@example.com'], repo)
  await runGit(['config', 'user.name', 'elia test'], repo)
  await runGit(['add', '-A'], repo)
  await runGit(['commit', '-q', '-m', 'seed'], repo)
})
afterEach(() => {
  rmSync(repo, { recursive: true, force: true })
  rmSync(libraryDir, { recursive: true, force: true })
})

const outcomeFor = (ok: boolean, extra: Partial<VerificationOutcome> = {}): VerificationOutcome => ({
  passed: ok,
  results: [{ command: 'check', exitCode: ok ? 0 : 1, stdout: '', stderr: ok ? '' : 'answer is wrong', elapsedMs: 1, timedOut: false }],
  ...extra,
})

/** The governed check, faked: green exactly when the checkout holds the right answer. */
const answerIsGood = async (_commands: string[], cwd?: string): Promise<VerificationOutcome> =>
  outcomeFor(readFileSync(join(cwd ?? '', 'answer.txt'), 'utf8').trim() === 'good')

const base = () => ({
  workspaceRoot: repo,
  runId: 'test-run',
  problem: 'answer.txt must say good',
  briefing: 'the goal',
  verification: ['check'],
  verificationRoot: repo,
  governor: createActionGovernor({ mode: 'unattended', maxActions: 50 }),
  spent: 0,
  files: ['answer.txt'],
  acceptanceCriteria: 0,
  protectedPaths: [] as string[],
  libraryFile: join(libraryDir, 'library.json'),
})

test('each repair pass is told a different way into the failure, and the old prompt is one switch away', () => {
  const first = repairApproachDirective(1, {})
  const second = repairApproachDirective(2, {})
  expect(first).toContain(APPROACHES_BY_CLASS.repair[0]!.id)
  expect(second).toContain(APPROACHES_BY_CLASS.repair[1]!.id)
  expect(first).not.toBe(second)
  // It wraps rather than running out.
  expect(repairApproachDirective(APPROACHES_BY_CLASS.repair.length + 1, {})).toBe(first)
  expect(repairApproachDirective(1, { ELIA_REPAIR_APPROACHES: 'off' })).toBe('')
  expect(repairApproachDirective(0, {})).toBe('')
})

test('the search is opt-in until it has run against a real model', () => {
  expect(repairSearchEnabled({})).toBe(false)
  expect(repairSearchEnabled({ ELIA_REPAIR_SEARCH: 'on' })).toBe(true)
  expect(repairSearchEnabled({ ELIA_REPAIR_SEARCH: 'off' })).toBe(false)
})

test('stalled repairs are filed apart from the REPL`s repair keys', () => {
  const signature = stalledRepairSignature({ files: ['a.ts', 'b.ts'], acceptanceCriteria: 2, hasCheck: true })
  expect(signature.taskClass).toBe('repair')
  expect(signature.key).toBe('stalled-repair/checked/multi')
  expect(stalledRepairSignature({ files: ['a.ts'], acceptanceCriteria: 0, hasCheck: true }).key).toBe('stalled-repair/checked/single')
})

test('the search opens with approaches the linear passes have not tried, one round wide', () => {
  const pool = APPROACHES_BY_CLASS.repair
  const [duo, trio] = stalledRepairHarnesses(0)
  expect([duo!.id, trio!.id]).toEqual(['duo', 'trio'])
  expect(duo!.width).toBe(2)
  expect(duo!.maxAttempts).toBe(2)
  expect(trio!.maxAttempts).toBe(3)
  expect(duo!.approaches[0]!.id).toBe(pool[0]!.id)

  const [rotated] = stalledRepairHarnesses(2)
  expect(rotated!.approaches[0]!.id).toBe(pool[2]!.id)
  // Rotated, not shortened: every approach is still on offer.
  expect(rotated!.approaches.map((approach) => approach.id).sort()).toEqual(pool.map((approach) => approach.id).sort())
})

test('the first attempt that passes the checks stops its sibling and is the only one merged', async () => {
  let siblingWasStopped = false
  const result = await runStalledRepairSearch({
    ...base(),
    async run({ cwd, approach, signal }) {
      if (approach.id === APPROACHES_BY_CLASS.repair[0]!.id) {
        writeFileSync(join(cwd, 'answer.txt'), 'good\n')
        return { text: 'fixed it', cost: 7 }
      }
      // The slow sibling works until it is told to stop.
      await new Promise<void>((resolve) => {
        if (signal?.aborted) resolve()
        else signal?.addEventListener('abort', () => resolve(), { once: true })
      })
      siblingWasStopped = true
      writeFileSync(join(cwd, 'answer.txt'), 'bad\n')
      return { text: 'slow', cost: 1 }
    },
    check: answerIsGood,
  })

  expect(result).toBeDefined()
  expect(siblingWasStopped).toBe(true)
  expect(result!.merged).toContain('answer.txt')
  expect(readFileSync(join(repo, 'answer.txt'), 'utf8').trim()).toBe('good')
  expect(result!.report).toBe('fixed it')
  // The planner opens with the smallest search no other contains: the trio holds the duo's two attempts and one more.
  expect(result!.harnessId).toBe('trio')
  // The stopped sibling's spend is still on the bill.
  expect(result!.attempts).toBe(3)
  expect(result!.tokens).toBe(9)

  const [record] = readLibrary(join(libraryDir, 'library.json')).records
  expect(record).toMatchObject({ signature: 'stalled-repair/checked/single', harnessId: 'trio', runs: 1, verifiedRuns: 1, totalAttempts: 3, totalCost: 9 })
})

test('when nothing passes, nothing is merged and the tree is as it was', async () => {
  const result = await runStalledRepairSearch({
    ...base(),
    async run({ cwd }) {
      writeFileSync(join(cwd, 'answer.txt'), 'bad\n')
      writeFileSync(join(cwd, 'scratch.txt'), 'debris\n')
      return { text: 'tried', cost: 3 }
    },
    check: answerIsGood,
  })

  expect(result).toBeUndefined()
  expect(readFileSync(join(repo, 'answer.txt'), 'utf8').trim()).toBe('original')
  expect(await Bun.file(join(repo, 'scratch.txt')).exists()).toBe(false)
  // It still counts as evidence about the harness: three attempts, none verified.
  const [record] = readLibrary(join(libraryDir, 'library.json')).records
  expect(record).toMatchObject({ runs: 1, verifiedRuns: 0, totalAttempts: 3 })
})

test('a check that ran no tests, or was refused, is not a pass', async () => {
  const fixes = async ({ cwd }: { cwd: string }) => {
    writeFileSync(join(cwd, 'answer.txt'), 'good\n')
    return { text: 'fixed', cost: 1 }
  }
  const inconclusive = await runStalledRepairSearch({
    ...base(),
    run: fixes,
    check: async () => outcomeFor(true, { inconclusive: 'ran no tests' }),
  })
  expect(inconclusive).toBeUndefined()

  const blocked = await runStalledRepairSearch({
    ...base(),
    run: fixes,
    check: async () => outcomeFor(true, { blocked: 'refused by the governor' }),
  })
  expect(blocked).toBeUndefined()
  expect(readFileSync(join(repo, 'answer.txt'), 'utf8').trim()).toBe('original')
})

test('a passing attempt that touched a sensitive path is not merged', async () => {
  const notes: string[] = []
  const result = await runStalledRepairSearch({
    ...base(),
    async run({ cwd }) {
      writeFileSync(join(cwd, 'answer.txt'), 'good\n')
      writeFileSync(join(cwd, '.env'), 'SECRET=1\n')
      return { text: 'fixed, and wrote a secret', cost: 1 }
    },
    check: answerIsGood,
    onNote: (text) => notes.push(text),
  })

  expect(result).toBeUndefined()
  expect(readFileSync(join(repo, 'answer.txt'), 'utf8').trim()).toBe('original')
  expect(await Bun.file(join(repo, '.env')).exists()).toBe(false)
  expect(notes.join('\n')).toContain('nothing was merged')
})

test('a passing attempt that touched the operator`s own uncommitted work is not merged', async () => {
  const result = await runStalledRepairSearch({
    ...base(),
    protectedPaths: ['answer.txt'],
    async run({ cwd }) {
      writeFileSync(join(cwd, 'answer.txt'), 'good\n')
      return { text: 'fixed', cost: 1 }
    },
    check: answerIsGood,
  })
  expect(result).toBeUndefined()
  expect(readFileSync(join(repo, 'answer.txt'), 'utf8').trim()).toBe('original')
})

test('an already-stopped run starts nothing', async () => {
  const controller = new AbortController()
  controller.abort()
  let ran = false
  const result = await runStalledRepairSearch({
    ...base(),
    signal: controller.signal,
    async run() {
      ran = true
      return { text: 'x' }
    },
    check: answerIsGood,
  })
  expect(result).toBeUndefined()
  expect(ran).toBe(false)
})

test('attempts run outside the goal graph, so they cannot replay each other`s actions', async () => {
  const graphDir = mkdtempSync(join(tmpdir(), 'elia-repair-graph-'))
  try {
    const graph = GoalGraphStore.open({ runId: 'graph-run', goal: 'g', dir: graphDir })
    let inside: unknown = 'unset'
    await withGoalGraph(graph, async () => {
      expect(activeGoalGraph()).toBe(graph)
      await withoutGoalGraph(async () => {
        inside = activeGoalGraph()
      })
      // Leaving the scope restores the run's own graph.
      expect(activeGoalGraph()).toBe(graph)
    })
    expect(inside).toBeUndefined()

    // And the search itself: whatever an attempt sees as its ambient graph.
    const seen: unknown[] = []
    await withGoalGraph(graph, () =>
      runStalledRepairSearch({
        ...base(),
        async run({ cwd }) {
          seen.push(activeGoalGraph())
          writeFileSync(join(cwd, 'answer.txt'), 'good\n')
          return { text: 'fixed' }
        },
        check: answerIsGood,
      }),
    )
    expect(seen.length).toBeGreaterThan(0)
    expect(seen.every((graphSeen) => graphSeen === undefined)).toBe(true)
  } finally {
    rmSync(graphDir, { recursive: true, force: true })
  }
})
