import { afterAll, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * elia's first principles, held to the code (axioms.ts).
 *
 * One counterexample per principle, run against the real enforcing code — the
 * input a system without that principle would get wrong. If an enforcement is
 * weakened, the principle's test fails; if a principle is added with nothing
 * behind it, the coverage test fails. This file is immutable to `elia evolve`
 * (src/evolve/sandbox.ts), so a self-improvement cannot pass by editing it.
 */

process.env.ANTHROPIC_API_KEY ??= 'test-key-for-principles-conformance'

const { AXIOMS, principlesSection } = await import('./axioms.ts')
type AxiomId = import('./axioms.ts').AxiomId

const scratch = mkdtempSync(join(tmpdir(), 'elia-principles-'))
afterAll(() => rmSync(scratch, { recursive: true, force: true }))

function completedGraph(): import('../autonomy/goalGraph.ts').GoalGraphSnapshot {
  return {
    version: 2,
    runId: 'principles',
    goal: 'g',
    rootId: 'goal:root',
    verificationCommands: ['bun test'],
    nodes: [1, 2].map((index) => ({
      id: `step:${index}`, kind: 'step' as const, title: `step ${index}`, files: [], dependsOn: [], status: 'completed' as const,
      attemptCount: 1, maxAttempts: 2, idempotencyKey: `key-${index}`, evidenceIds: [], createdAt: 0, updatedAt: 0,
    })),
    actions: [],
    evidence: [],
    approvals: [{ id: 'approval:plan', kind: 'plan' as const, subject: 'proposal', status: 'approved' as const, at: 0 }],
    updatedAt: 0,
  }
}

const CONFORMANCE: Record<AxiomId, () => void | Promise<void>> = {
  'evidence-over-assertion': async () => {
    const { assessCompletion } = await import('../autonomy/outcome.ts')
    // Every step says it finished and the run reports "completed" — but the checks did not pass.
    const claimed = assessCompletion({ outcome: 'completed', graph: completedGraph(), verificationPassed: false, reviewPassed: true, planApproved: true })
    expect(claimed.state).not.toBe('verified')
    // The same run with checks that ran and passed is verified: the gate listens to evidence, not to nothing.
    expect(assessCompletion({ outcome: 'completed', graph: completedGraph(), verificationPassed: true, reviewPassed: true, planApproved: true }).state).toBe('verified')
  },

  'checks-must-discriminate': async () => {
    const { decideSearch } = await import('../reason/decide.ts')
    const { admitProbe } = await import('../reason/probe.ts')
    // The project's tests would pass for every attempt at these, so they choose nothing.
    expect(decideSearch('where is the retry policy configured?', ['bun run test']).plan).toBeUndefined()
    expect(decideSearch('build a snake game as a single html page', ['bun run test']).plan).toBeUndefined()
    // A repair changes what the tests exercise, so they can tell attempts apart.
    expect(decideSearch('fix the failing test in src/parser.ts', ['bun run test']).plan).toBeDefined()
    // A check elia writes itself is refused while it passes on the unchanged tree.
    const green = { exitCode: 0, pass: 1, fail: 0, errors: 0, ran: 1, output: '' }
    const red = { exitCode: 1, pass: 0, fail: 1, errors: 0, ran: 1, output: '' }
    expect(admitProbe(green).admitted).toBe(false)
    expect(admitProbe(red).admitted).toBe(true)
  },

  'unchecked-is-not-passed': async () => {
    const { acceptanceVerdict } = await import('../autonomy/acceptance.ts')
    const { mapCompletionToVerify } = await import('../autonomy/outcome.ts')
    const { auditAndCorrect } = await import('../reason/audit.ts')
    // Nobody reported on the promised criterion: unmet, not met.
    expect(acceptanceVerdict(['over the limit, the API returns 429'], undefined).verdict).toBe('revise')
    // Partial progress is recorded as a failure to verify, never as a pass.
    expect(mapCompletionToVerify('partial').verify).toBe('fail')
    // A clean audit has no verdict to give: it can find something wrong, never declare something right.
    const clean = await auditAndCorrect({ reply: () => 'All done.', cwd: scratch, correct: async () => { throw new Error('nothing to correct') } })
    expect(Object.keys(clean)).toEqual(['before'])
  },

  'assumptions-are-debts': async () => {
    const { checkPremises } = await import('./premises.ts')
    const { assumptionOutcome, auditPlanFeasibility } = await import('../autonomy/assumptions.ts')
    const repo = join(scratch, 'assumptions')
    mkdirSync(repo, { recursive: true })
    writeFileSync(join(repo, 'package.json'), JSON.stringify({ scripts: { test: 'bun test' } }))
    // A session plan's premise is checked before anything is built on it.
    expect(checkPremises(['`src/api/client.ts` holds the HTTP client'], repo)[0]?.verdict).toBe('false')
    // A pipeline plan that verifies with a script the project lacks is refused at approval.
    const issues = auditPlanFeasibility({ goal: 'g', understanding: '', assumptions: [], steps: [], risks: [], verification: ['bun run lint'], outOfScope: [] }, repo)
    expect(issues.some((issue) => issue.severity === 'blocker' && issue.detail.includes('lint'))).toBe(true)
    // What nobody checked is carried forward as unverified, not dropped.
    expect(assumptionOutcome(['the queue is FIFO'], undefined).briefing).toContain('Unverified assumptions')
  },

  'irreversible-needs-consent': async () => {
    const { assessAction, createActionGovernor } = await import('../autonomy/governor.ts')
    const push = { name: 'run_command', input: { command: 'git push origin main' } }
    expect(assessAction(push, scratch).risk).toBe('critical')
    const unattended = createActionGovernor({ mode: 'unattended', cwd: scratch })
    expect((await unattended.check(push)).allowed).toBe(false)
    // Reversible local work is not held up: consent is for what cannot be undone.
    expect((await unattended.check({ name: 'read_file', input: { path: 'package.json' } })).allowed).toBe(true)
  },

  'failure-is-data': async () => {
    const { groupFaults, readFaults, recordFault } = await import('../recovery/faults.ts')
    const { logSwallowedError } = await import('../diagnostics.ts')
    const { summarizeDiagnostics } = await import('../recovery/selfRepair.ts')
    const faults = join(scratch, 'faults.ndjson')
    function brokenInEliasSource(): never {
      const value = undefined as unknown as { length: number }
      return value.length as never
    }
    try {
      brokenInEliasSource()
    } catch (error) {
      recordFault(error, { source: 'turn', command: 'repl' }, faults)
    }
    // Recorded, and read back as a bug with a place in the source to repair.
    const [group] = groupFaults(readFaults(faults))
    expect(group?.latest.frames[0]).toContain('src/principles/conformance.test.ts')
    // A handled error is not silent either: it is logged and something reads the log.
    const diagnostics = join(scratch, 'diagnostics.ndjson')
    logSwallowedError('principles', new Error('degraded'), undefined, diagnostics)
    expect(summarizeDiagnostics(diagnostics).total).toBe(1)
  },

  'uncertainty-is-priced': async () => {
    const { chooseHarness, successLowerBound } = await import('../reason/library.ts')
    // Nineteen of twenty is a better bet than three of three, though its mean is lower.
    expect(successLowerBound({ runs: 3, verifiedRuns: 3 })).toBeLessThan(successLowerBound({ runs: 20, verifiedRuns: 19 }))
    // Two lucky runs do not crown a harness: the library is still measuring.
    const lucky = { signature: 'repair/checked/single', harnessId: 'wide', runs: 2, verifiedRuns: 2, totalAttempts: 4, totalCost: 0, totalElapsedMs: 0, lastAt: 0 }
    expect(chooseHarness('repair/checked/single', ['single', 'wide', 'deep'], { version: 1, records: [lucky] }).exploring).toBe(true)
  },

  'judge-is-not-judged': async () => {
    const { isImmutablePath } = await import('../evolve/sandbox.ts')
    for (const path of ['src/evolve/fitness.ts', 'src/evolve/sandbox.ts', 'src/principles/axioms.ts', 'src/principles/conformance.test.ts', 'src/reason/audit.test.ts', 'values/value-core.md']) {
      expect(isImmutablePath(path)).toBe(true)
    }
    // How elia meets its principles stays improvable; only the principles and their proof are fixed.
    expect(isImmutablePath('src/reason/audit.ts')).toBe(false)
  },

  'death-is-expected': async () => {
    const { writeSessionEnded, writeSessionHeartbeat } = await import('../sessionRegistry.ts')
    const { findUncleanExits } = await import('../recovery/uncleanExits.ts')
    const { createJournal, readEvents } = await import('../autonomy/journal.ts')
    const status = join(scratch, 'session-status')
    const beat = (sessionId: string) => ({ sessionId, pid: 999_003, mode: 'dev', providerLabel: 't', model: 't', startedAt: Date.now() - 1_000, busy: true, lastAction: 'Running', taskSummary: '', messageCount: 2 })
    writeSessionHeartbeat(beat('died'), status)
    writeSessionEnded(beat('ended'), status)
    const exits = findUncleanExits({ sessionStatusDir: status, runsDir: join(scratch, 'runs'), sessionsDir: join(scratch, 'sessions'), faultsPath: join(scratch, 'none.ndjson'), isAlive: () => false })
    // The next start finds the one that died, and only that one.
    expect(exits.map((exit) => exit.id)).toEqual(['died'])
    // A run says who is running it, so its death can be told from its progress.
    const runId = `principles-${Date.now().toString(36)}`
    createJournal(runId, 'g')
    expect(readEvents(runId).find((event) => event.kind === 'run-start')?.data.pid).toBe(process.pid)
  },
}

test('every principle has a counterexample in this suite, and nothing here is unaccounted for', () => {
  expect(Object.keys(CONFORMANCE).sort()).toEqual(AXIOMS.map((entry) => entry.id).sort())
})

test('every principle names enforcing code that exists and exports what it names', async () => {
  const root = join(import.meta.dir, '..', '..')
  for (const entry of AXIOMS) {
    expect(entry.enforcedBy.length).toBeGreaterThan(0)
    for (const target of entry.enforcedBy) {
      const [file, symbol] = target.split('#') as [string, string]
      expect(existsSync(join(root, file))).toBe(true)
      const module = (await import(join(root, file))) as Record<string, unknown>
      expect(typeof module[symbol]).toBe('function')
    }
  }
})

for (const [index, entry] of AXIOMS.entries()) {
  test(`principle ${index + 1} (${entry.id}): ${entry.truth}`, CONFORMANCE[entry.id])
}

test('every mode\'s system prompt, lead and sub-agent, reasons from the same principles the code enforces', async () => {
  const config = await import('../config.ts')
  const section = principlesSection()
  for (const mode of ['dev', 'cyber', 'sports', 'fitness', 'battmann', 'datascience', 'sysintel'] as const) {
    expect(config.systemPromptForMode(mode)).toContain(section)
  }
  expect(config.SUBAGENT_SYSTEM_PROMPT).toContain(section)
  for (const entry of AXIOMS) expect(section).toContain(entry.truth)
})
