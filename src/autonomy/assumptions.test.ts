import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { assumptionOutcome, auditPlanFeasibility, createAssumptionTool, type AssumptionCheck } from './assumptions.ts'
import type { Proposal } from './types.ts'

function plan(overrides: Partial<Proposal> = {}): Proposal {
  return {
    goal: 'build an API',
    understanding: '',
    assumptions: [],
    steps: [{ id: 's1', title: 'Setup', role: 'builder', instructions: 'do it', files: ['package.json'], dependsOn: [] }],
    risks: [],
    verification: ['bun test'],
    outOfScope: [],
    ...overrides,
  }
}

// --- what elia can decide by itself, before anything runs ---

test('a step planned to write a protected path is caught before a worker starts', () => {
  const issues = auditPlanFeasibility(
    plan({ steps: [{ id: 's1', title: 'Configure', role: 'builder', instructions: 'x', files: ['src/config.ts', '.env'], dependsOn: [] }] }),
  )

  expect(issues).toHaveLength(1)
  expect(issues[0]!.severity).toBe('blocker')
  expect(issues[0]!.detail).toContain('.env')
  expect(issues[0]!.detail).toContain('cannot succeed as written')
})

test('the same mistake stated as a belief is caught even when no step names the file', () => {
  // Verbatim from a real run: the plan wrote down the exact reason it would
  // fail, then planned around it anyway.
  const issues = auditPlanFeasibility(
    plan({ assumptions: ['Environment variables will be read from a .env file at runtime; the file can be created by the builder.'] }),
  )

  expect(issues).toHaveLength(1)
  expect(issues[0]!.detail).toContain('protected file can be written')
})

test('an ordinary plan raises nothing', () => {
  expect(auditPlanFeasibility(plan({ assumptions: ['Bun is installed', 'The tests need no external services'] }))).toEqual([])
})

test('merely mentioning .env is not a problem — only claiming it can be written is', () => {
  expect(auditPlanFeasibility(plan({ assumptions: ['The JWT secret is read from .env at runtime'] }))).toEqual([])
})

// --- what checking the assumptions tells the run ---

const assumptions = ['bcryptjs is compatible with Bun', 'the .env file can be created by the builder', 'the user wants a REST API rather than GraphQL']

function check(assumption: string, verdict: AssumptionCheck['verdict'], evidence = 'checked'): AssumptionCheck {
  return { assumption, verdict, evidence }
}

test('a false assumption reaches every worker, with the evidence and what to do about it', () => {
  const outcome = assumptionOutcome(assumptions, [
    check(assumptions[0]!, 'holds', 'bun add bcryptjs succeeded and the import resolves'),
    check(assumptions[1]!, 'false', '.env is a protected path; write_file refuses it'),
    check(assumptions[2]!, 'unverifiable', 'the goal does not say, and nobody can be asked mid-run'),
  ])

  expect(outcome.falsified).toHaveLength(1)
  expect(outcome.unverifiable).toHaveLength(1)
  expect(outcome.summary).toBe('1 of 3 assumption(s) hold, 1 false, 1 unverifiable.')
  expect(outcome.briefing).toContain('turned out to be WRONG')
  expect(outcome.briefing).toContain('protected path')
  expect(outcome.briefing).toContain('revise_plan')
  expect(outcome.briefing).toContain('open questions')
})

test('when everything holds, workers are not given a wall of caveats', () => {
  const outcome = assumptionOutcome(assumptions, assumptions.map((assumption) => check(assumption, 'holds')))
  expect(outcome.briefing).toBe('')
  expect(outcome.summary).toBe('3 of 3 assumption(s) hold.')
})

test('an unchecked plan is told it is unchecked rather than treated as verified', () => {
  const outcome = assumptionOutcome(assumptions, undefined)
  expect(outcome.summary).toContain('went unchecked')
  expect(outcome.briefing).toContain('Unverified assumptions')
  // Not a failure — the plan simply rests on what it always rested on.
  expect(outcome.falsified).toEqual([])
})

test('a plan with no assumptions says so and adds nothing', () => {
  const outcome = assumptionOutcome([], undefined)
  expect(outcome.briefing).toBe('')
  expect(outcome.summary).toContain('no assumptions')
})

// --- the tool ---

test('the tool refuses a report that skips an assumption', async () => {
  const capture = createAssumptionTool(assumptions)

  await expect(capture.tool.execute({ results: [{ assumption: assumptions[0], verdict: 'holds', evidence: 'x' }] })).rejects.toThrow('missing a verdict for 2')
  expect(capture.taken()).toBeUndefined()

  const complete = await capture.tool.execute({
    results: assumptions.map((assumption) => ({ assumption, verdict: 'holds', evidence: 'x' })),
  })
  expect(complete).toContain('3 assumption check(s)')
  expect(capture.taken()).toHaveLength(3)
})

test('"unverifiable" is a real answer, not a failure to report', async () => {
  const capture = createAssumptionTool(['the user prefers REST'])
  await capture.tool.execute({ results: [{ assumption: 'the user prefers REST', verdict: 'unverifiable', evidence: 'nobody to ask' }] })

  expect(capture.taken()?.[0]?.verdict).toBe('unverifiable')
})

test('a plan that says it will hardcode a secret is stopped before anything is built', () => {
  // Verbatim from a real run's risks list.
  const issues = auditPlanFeasibility(
    plan({ risks: ["JWT secret must be defined; we will hard-code a dev secret in the code (e.g., 'dev-secret') for simplicity."] }),
    '/nonexistent',
  )

  expect(issues).toHaveLength(1)
  expect(issues[0]!.detail).toContain('hardcode a credential')
})

test('hardcoding something that is not a credential is nobody\u2019s business here', () => {
  expect(auditPlanFeasibility(plan({ risks: ['We will hard-code the default page size for now.'] }), '/nonexistent')).toEqual([])
})

test('a verification command naming a script the project does not have can never pass', () => {
  const dir = mkdtempSync(join(tmpdir(), 'elia-plan-'))
  try {
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ scripts: { test: 'bun test' } }))
    const issues = auditPlanFeasibility(plan({ verification: ['bun run typecheck', 'bun run test'] }), dir)

    expect(issues).toHaveLength(1)
    expect(issues[0]!.detail).toContain('"typecheck"')
    expect(issues[0]!.detail).toContain('Available scripts: test')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a project whose manifest does not exist yet is naming scripts it is about to write', () => {
  // A scratch run creates package.json as its first step; those scripts are
  // correct precisely because they do not exist yet.
  expect(auditPlanFeasibility(plan({ verification: ['bun run typecheck'] }), '/nonexistent')).toEqual([])
})

test('a typographic hyphen does not smuggle a hardcoded secret past the check', () => {
  // Verbatim from a real plan: mercury writes "hard\u2011coded" with U+2011, and the
  // first version of this check only knew about the ASCII hyphen.
  const issues = auditPlanFeasibility(plan({ assumptions: ['JWT secret will be a hard\u2011coded string for the prototype.'] }), '/nonexistent')

  expect(issues).toHaveLength(1)
  expect(issues[0]!.detail).toContain('hardcode a credential')
  // The user sees what the plan actually said, not a normalised rewrite of it.
  expect(issues[0]!.detail).toContain('hard\u2011coded')
})
