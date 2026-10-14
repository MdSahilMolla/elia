import { afterEach, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { withAgentIdentity } from '../autonomy/context.ts'
import { createActionGovernor, withActionGovernor } from '../autonomy/governor.ts'
import type { RoleName } from '../autonomy/types.ts'
import { renderTemplate, validateArtifact } from './artifacts.ts'
import { operatorContext, recordSignoff, runAction } from './engine.ts'
import { SysintelStore } from './store.ts'
import { treeFingerprint } from './tree.ts'
import { triage } from './triage.ts'

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const GIT_ENV = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com' }
function git(cwd: string, ...args: string[]): string {
  const result = spawnSync('git', args, { cwd, env: GIT_ENV, encoding: 'utf8' })
  if (result.status !== 0) throw new Error(result.stderr)
  return result.stdout.trim()
}

function repo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'elia-si-test-'))
  dirs.push(dir)
  git(dir, 'init', '-q', '-b', 'main')
  writeFileSync(join(dir, 'app.js'), 'export const add = (a, b) => a + b\n')
  writeFileSync(join(dir, '.gitignore'), '.elia/\n')
  git(dir, 'add', '-A')
  git(dir, 'commit', '-q', '-m', 'init')
  return dir
}

// A person who approves every command, so checks actually run (the default test governor has nobody to ask).
const approving = createActionGovernor({ mode: 'supervised', approve: async () => true })
const lead = (dir: string) => (tool: 'si_org' | 'si_work' | 'si_artifact' | 'si_record', input: Record<string, unknown>) =>
  withActionGovernor(approving, () => runAction(tool, input, { cwd: dir }))
const as = (role: RoleName, dir: string) => (tool: 'si_org' | 'si_work' | 'si_artifact' | 'si_record', input: Record<string, unknown>) =>
  withActionGovernor(approving, () => withAgentIdentity({ name: `${role}#1`, role, cwd: dir }, () => runAction(tool, input, { cwd: dir })))

const PASS = 'git --version'
const FAIL = 'git rev-parse --verify refs/heads/does-not-exist'

test('triage scales the process to the work and never lowers rigor', () => {
  expect(triage({ origin: 'engineering', title: 'fix typo', problem: 'a typo in the help text', signals: { files: 1 } }).scale).toBe('trivial')
  const auth = triage({ origin: 'product', title: 'login rate limit', problem: 'brute-force attempts on the login endpoint', signals: { files: 1 } })
  expect(auth.flags).toContain('security')
  expect(auth.scale).toBe('small')
  const migration = triage({ origin: 'engineering', lifecycle: 'feature', title: 'drop legacy table', problem: 'remove the old sessions store', signals: { files: 3, flags: ['irreversible'] } })
  expect(migration.scale).toBe('large')
  const design = migration.stages.find((stage) => stage.id === 'design')!
  expect(design.requirements.map((requirement) => requirement.artifact).filter(Boolean)).toContain('rfc')
  expect(design.requirements.some((requirement) => requirement.review === 'architecture-review')).toBe(true)
  const lowered = triage({ origin: 'engineering', title: 'drop column', problem: 'drop column legacy_id', signals: { files: 1, scale: 'trivial' } })
  expect(lowered.scale).toBe('large')
  expect(lowered.reasons.join(' ')).toContain('never lowers rigor')
  const strategic = triage({ origin: 'business', title: 'new platform', problem: 'move every product onto one agent platform', signals: { strategic: true } })
  expect(strategic.stages.find((stage) => stage.id === 'design')!.requirements.some((requirement) => requirement.gate === 'direction')).toBe(true)
  const tiny = triage({ origin: 'engineering', title: 'rename var', problem: 'rename a local variable', signals: { files: 1 } })
  expect(tiny.stages.map((stage) => stage.id)).toEqual(['code', 'local-tests', 'merge'])
  expect(tiny.stages.find((stage) => stage.id === 'merge')!.requirements.some((requirement) => requirement.type === 'signoff')).toBe(false)
})

test('artifacts must really fill their sections', () => {
  const skeleton = validateArtifact('rfc', renderTemplate('rfc'))
  expect(skeleton.valid).toBe(false)
  expect(skeleton.errors.some((error) => error.includes('Rollback Plan'))).toBe(true)
  const placeholder = validateArtifact('adr', '# ADR\n## Status\naccepted\n## Context\nTBD\n## Decision\nUse Postgres for the event store.\n## Alternatives\n- DynamoDB, rejected for cost\n## Consequences\nWe run our own backups and failover.')
  expect(placeholder.valid).toBe(false)
  expect(placeholder.errors.join(' ')).toContain('Context')
  const results = validateArtifact('experiment-results', '# R\n## Setup\ncommit abc, 5 seeds, same data\n## Results\naccuracy 0.81 ± 0.02 vs 0.78\n## Baseline Comparison\n+3 points over the tuned baseline\n## Statistical Significance\npaired t-test p=0.01 across seeds\n## Ablations\nremoving the reranker loses 2 points\n## Failure Cases\nlong documents over 50 pages degrade\n## Conclusion\nIt looks promising overall and worth more work.\n## Reproduction\nbun run eval --seeds 5')
  expect(results.valid).toBe(false)
  expect(results.errors.join(' ')).toContain('supported, refuted, or inconclusive')
  const postmortem = validateArtifact('postmortem', '# PM\n## Summary\nThe API was down for 20 minutes.\n## Impact\nAll write requests failed for 20 minutes.\n## Timeline\n- 10:00 alert fired\n- 10:20 recovered\n## Root Cause\nThe primary database ran out of disk space.\n## Why It Was Possible\nA single database with no disk alerting was a single point of failure.\n## What Went Well\nThe alert fired within a minute of the outage.\n## What Went Wrong\nIt was Sam\'s fault for not checking the disk.\n## Action Items\n- add disk alerts (SRE)')
  expect(postmortem.valid).toBe(true)
  expect(postmortem.warnings.join(' ')).toContain('blameless')
})

test('the working-tree fingerprint follows content, not commits, and ignores the record', () => {
  const dir = repo()
  const before = treeFingerprint(dir)!
  writeFileSync(join(dir, 'app.js'), 'export const add = (a, b) => a + b + 0\n')
  const edited = treeFingerprint(dir)!
  expect(edited).not.toBe(before)
  git(dir, 'commit', '-qam', 'edit')
  expect(treeFingerprint(dir)).toBe(edited)
  mkdirSync(join(dir, '.elia', 'sysintel'), { recursive: true })
  writeFileSync(join(dir, '.elia', 'sysintel', 'x.json'), '{}')
  writeFileSync(join(dir, 'untracked.js'), 'new file')
  const withUntracked = treeFingerprint(dir)!
  expect(withUntracked).not.toBe(edited)
  rmSync(join(dir, 'untracked.js'))
  expect(treeFingerprint(dir)).toBe(edited)
})

test('a trivial change moves through its gates only on engine-verified evidence', async () => {
  const dir = repo()
  const run = lead(dir)
  const opened = await run('si_work', { action: 'intake', title: 'Fix add rounding', problem: 'add() should coerce to numbers', origin: 'engineering', files: 1 })
  expect(opened).toContain('Opened SI-1')
  expect(opened).toContain('lifecycle change · scale trivial')
  // Nothing changed yet: the code stage cannot pass on a claim, nor on a commit that already existed.
  await run('si_record', { action: 'note', id: 'SI-1', summary: 'I fixed it' })
  expect(await run('si_record', { action: 'commit', id: 'SI-1' })).toContain('already in the history')
  expect(await run('si_work', { action: 'advance', id: 'SI-1' })).toContain('Not advanced')
  writeFileSync(join(dir, 'app.js'), 'export const add = (a, b) => Number(a) + Number(b)\n')
  expect(await run('si_work', { action: 'advance', id: 'SI-1' })).toContain('now in "local-tests"')
  // A failing check is recorded as a failure and does not pass the gate.
  expect(await run('si_record', { action: 'check', id: 'SI-1', command: FAIL })).toContain('FAIL')
  expect(await run('si_work', { action: 'advance', id: 'SI-1' })).toContain('Not advanced')
  expect(await run('si_record', { action: 'check', id: 'SI-1', command: PASS })).toContain('PASS')
  expect(await run('si_work', { action: 'advance', id: 'SI-1' })).toContain('now in "merge"')
  // An edit after the check makes it stale: merge wants a pass on the current code.
  writeFileSync(join(dir, 'app.js'), 'export const add = (a, b) => Number(a) + Number(b) // coerced\n')
  const stale = await run('si_work', { action: 'gate', id: 'SI-1' })
  expect(stale).toContain('earlier version of the code')
  await run('si_record', { action: 'check', id: 'SI-1', command: PASS })
  expect(await run('si_work', { action: 'advance', id: 'SI-1' })).toContain('is done')
  const store = new SysintelStore(dir)
  expect(store.read('SI-1').status).toBe('done')
  expect(store.journal().map((entry) => entry.event)).toContain('check-fail')
}, 60_000)

test('work done before intake still counts once, and a new commit is evidence of it', async () => {
  const dir = repo()
  const run = lead(dir)
  // Fixed first, opened second (a live run did exactly this).
  writeFileSync(join(dir, 'app.js'), 'export const add = (a, b) => Number(a) + Number(b)\n')
  const opened = await run('si_work', { action: 'intake', title: 'Coerce add inputs', problem: 'add() concatenates strings', origin: 'engineering', files: 1 })
  expect(opened).toContain('Uncommitted changes already in the working tree count')
  expect(await run('si_work', { action: 'gate', id: 'SI-1' })).toContain('✓ change')
  git(dir, 'commit', '-qam', 'coerce add inputs')
  const recorded = await run('si_record', { action: 'commit', id: 'SI-1' })
  expect(recorded).not.toContain('already in the history')
  expect(new SysintelStore(dir).read('SI-1').evidence.find((item) => item.kind === 'commit')!.newCommit).toBe(true)
})

test('only an independent, current review passes a review gate', async () => {
  const dir = repo()
  const run = lead(dir)
  await run('si_work', { action: 'intake', title: 'Add subtract', problem: 'callers need subtract()', origin: 'product', lifecycle: 'change', files: 4 })
  git(dir, 'checkout', '-q', '-b', 'feat/subtract')
  await run('si_record', { action: 'branch', id: 'SI-1' })
  await run('si_work', { action: 'advance', id: 'SI-1' })
  writeFileSync(join(dir, 'app.js'), 'export const add = (a, b) => a + b\nexport const sub = (a, b) => a - b\n')
  await run('si_work', { action: 'advance', id: 'SI-1' })
  await run('si_record', { action: 'check', id: 'SI-1', command: PASS })
  await run('si_work', { action: 'advance', id: 'SI-1' })
  await run('si_record', { action: 'note', id: 'SI-1', summary: 'reviewed locally, no remote' })
  await run('si_work', { action: 'advance', id: 'SI-1' })
  await run('si_record', { action: 'check', id: 'SI-1', command: PASS })
  expect(await run('si_work', { action: 'advance', id: 'SI-1' })).toContain('now in "code-review"')
  // The lead approving its own work does not count.
  const self = await run('si_record', { action: 'review', id: 'SI-1', kind: 'code-review', verdict: 'approve', summary: 'looks good' })
  expect(self).toContain('self-review')
  expect(await run('si_work', { action: 'advance', id: 'SI-1' })).toContain('only self-review')
  // A builder is not an independent code reviewer either.
  await as('builder', dir)('si_record', { action: 'review', id: 'SI-1', kind: 'code-review', verdict: 'approve', summary: 'mine, fine' })
  expect(await run('si_work', { action: 'gate', id: 'SI-1' })).toContain('only self-review')
  // A critic's changes-requested blocks; its approval passes — until the code changes.
  await expect(as('critic', dir)('si_record', { action: 'review', id: 'SI-1', kind: 'code-review', verdict: 'changes-requested', summary: 'no tests' })).rejects.toThrow('must list its findings')
  await as('critic', dir)('si_record', { action: 'review', id: 'SI-1', kind: 'code-review', verdict: 'changes-requested', summary: 'missing tests', findings: ['sub() has no test'] })
  expect(await run('si_work', { action: 'gate', id: 'SI-1' })).toContain('sub() has no test')
  await as('critic', dir)('si_record', { action: 'review', id: 'SI-1', kind: 'code-review', verdict: 'approve', summary: 'verified' })
  writeFileSync(join(dir, 'app.js'), 'export const add = (a, b) => a + b\nexport const sub = (a, b) => a - b // edited after review\n')
  expect(await run('si_work', { action: 'gate', id: 'SI-1' })).toContain('earlier version')
  await as('critic', dir)('si_record', { action: 'review', id: 'SI-1', kind: 'code-review', verdict: 'approve', summary: 're-verified' })
  expect(await run('si_work', { action: 'advance', id: 'SI-1' })).toContain('now in "merge"')
  // The release sign-off is refused until the rest of the stage is met, then recorded for this exact code.
  const operator = operatorContext(dir)
  expect(() => recordSignoff(operator, 'SI-1', 'release', 'ship it', 'operator-cli')).toThrow('not ready for the release sign-off')
  await run('si_record', { action: 'check', id: 'SI-1', command: PASS })
  expect(() => recordSignoff(operator, 'SI-1', 'production', 'deploy', 'operator-cli')).toThrow('does not call for a production sign-off')
  expect(recordSignoff(operator, 'SI-1', 'release', 'ship it', 'operator-cli')).toContain('release sign-off recorded')
  expect(await run('si_work', { action: 'advance', id: 'SI-1' })).toContain('is done')
}, 60_000)

test('research loops on a refuted hypothesis and hands off only a validated, feasible result', async () => {
  const dir = repo()
  const run = lead(dir)
  await run('si_work', { action: 'intake', title: 'Reranking for retrieval', problem: 'Can a cross-encoder reranker cut wrong answers?', origin: 'research', files: 2 })
  const proposal = '# P\n## Question\nDoes reranking reduce wrong answers?\n## Motivation\nSupport answers cite the wrong document too often.\n## Prior Work\nCross-encoders beat bi-encoders on MS MARCO.\n## Hypothesis\nReranking the top 20 improves exact-match accuracy by 3 points.\n## Falsification\nLess than 1 point gain across 5 seeds refutes it.\n## Method\nA/B on the frozen eval set, 5 seeds each.\n## Success Criteria\nAt least +3 points exact match, p < 0.05.'
  await run('si_record', { action: 'note', id: 'SI-1', summary: 'reviewed three reranking papers' })
  await run('si_work', { action: 'advance', id: 'SI-1' })
  await run('si_artifact', { action: 'write', id: 'SI-1', artifact: 'research-proposal', content: proposal })
  expect(await run('si_work', { action: 'advance', id: 'SI-1' })).toContain('now in "experiment-design"')
  // Looping forward is refused; looping back needs a reason and counts an iteration.
  await expect(run('si_work', { action: 'advance', id: 'SI-1', to: 'outcome', reason: 'skip' })).rejects.toThrow('passed in order')
  expect(await run('si_work', { action: 'advance', id: 'SI-1', to: 'hypothesis', reason: 'refuted on a pilot' })).toContain('iteration 1')
  // A handoff before validation is refused.
  await expect(run('si_work', { action: 'handoff', id: 'SI-1', title: 'Ship reranker', problem: 'productionize it' })).rejects.toThrow('has not passed validation')
})

test('plans are owned, acyclic, and gate implementation', async () => {
  const dir = repo()
  const run = lead(dir)
  await run('si_work', { action: 'intake', title: 'Usage dashboard', problem: 'customers want usage graphs in the dashboard', origin: 'product', files: 20, systems: 3 })
  await expect(run('si_work', { action: 'plan', id: 'SI-1', items: [{ title: 'api', owner: 'nobody', acceptance: ['x'] }] })).rejects.toThrow('owner must be a hat id')
  await expect(run('si_work', { action: 'plan', id: 'SI-1', items: [{ id: 'T1', title: 'a', owner: 'backend-engineer', acceptance: ['x'], dependsOn: ['T2'] }, { title: 'b', owner: 'frontend-engineer', acceptance: ['y'], dependsOn: ['T1'] }] })).rejects.toThrow()
  const plan = await run('si_work', { action: 'plan', id: 'SI-1', items: [{ title: 'usage API', owner: 'backend-engineer', priority: 'P1', acceptance: ['GET /usage returns daily totals'] }, { title: 'usage chart', owner: 'frontend-engineer', dependsOn: ['T1'], acceptance: ['chart renders totals'] }] })
  expect(plan).toContain('T2')
  await expect(run('si_work', { action: 'item', id: 'SI-1', item: 'T2', status: 'done' })).rejects.toThrow('cannot be done before T1')
  const brief = await run('si_work', { action: 'brief', id: 'SI-1', item: 'T1' })
  expect(brief).toContain('"role": "backend"')
  expect(brief).toContain('Backend Engineer')
  expect(brief).toContain('GET /usage returns daily totals')
})

test('re-triage raises rigor and carries new gates into the current stage', async () => {
  const dir = repo()
  const run = lead(dir)
  await run('si_work', { action: 'intake', title: 'Tweak copy', problem: 'shorten the empty-state message', origin: 'product', lifecycle: 'change', files: 1 })
  writeFileSync(join(dir, 'app.js'), 'export const add = (a, b) => a + b // v2\n')
  await run('si_work', { action: 'advance', id: 'SI-1' })
  const result = await run('si_work', { action: 'retriage', id: 'SI-1', flags: ['security'], reason: 'the message leaks the account email' })
  expect(result).toContain('trivial → small')
  const store = new SysintelStore(dir)
  const initiative = store.read('SI-1')
  expect(initiative.stages.map((stage) => stage.id)).toContain('code-review')
  expect(initiative.stages.some((stage) => stage.requirements.some((requirement) => requirement.review === 'security-review'))).toBe(true)
  // The branch stage now exists but was already behind us — its gate moved into the current stage.
  const current = initiative.stages.find((stage) => stage.id === initiative.current)!
  expect(current.requirements.some((requirement) => requirement.type === 'branch')).toBe(true)
})

test('an incident ends with follow-ups that change the system, and reports count from the record', async () => {
  const dir = repo()
  const run = lead(dir)
  await run('si_work', { action: 'intake', title: 'API latency spike', problem: 'p99 latency rose from 200ms to 4s', origin: 'operations', severity: 2 })
  const report = '# I\n## Summary\np99 latency is 4s on /orders.\n## Severity\nSEV2 — degraded, not down\n## Impact\nCheckout is slow for every user.\n## Timeline\n- 10:02 alert fired\n## Detection\nLatency SLO burn-rate alert.\n## Current Status\nInvestigating the database connection pool.'
  await run('si_artifact', { action: 'write', id: 'SI-1', artifact: 'incident-report', content: report })
  await run('si_work', { action: 'advance', id: 'SI-1' })
  const board = await run('si_work', { action: 'report', view: 'board' })
  expect(board).toContain('SI-1')
  const follow = await run('si_work', { action: 'intake', title: 'Pool exhaustion guard', problem: 'the pool can be exhausted by one slow query', origin: 'engineering', parent: 'SI-1', files: 3 })
  expect(follow).toContain('followup of SI-1')
  expect(await run('si_work', { action: 'report', view: 'flywheel' })).toContain('SI-2')
  const quarter = await run('si_work', { action: 'report', view: 'quarter' })
  expect(quarter).toContain('incidents 1')
})

test('wrong calls return the usage, and the operator\'s CLI actions carry the operator identity', async () => {
  const dir = repo()
  const run = lead(dir)
  await expect(run('si_work', { action: 'intake', title: 'x', problem: 'y', origin: 'product', severety: 2 })).rejects.toThrow('unknown parameter(s) "severety"')
  await expect(run('si_work', { action: 'intake', title: 'x', problem: 'y', origin: 'marketing' })).rejects.toThrow('must be one of')
  await expect(run('si_work', { action: 'nope' })).rejects.toThrow('Actions:')
  await run('si_work', { action: 'intake', title: 'Docs', problem: 'document the add() contract', origin: 'engineering', files: 1 })
  writeFileSync(join(dir, 'app.js'), 'export const add = (a, b) => a + b // docs\n')
  await runAction('si_record', { action: 'review', id: 'SI-1', kind: 'code-review', verdict: 'approve', summary: 'operator looked' }, { cwd: dir, by: { name: 'operator', role: 'operator' } })
  const store = new SysintelStore(dir)
  expect(store.read('SI-1').reviews[0]!.independent).toBe(true)
  // Direct file edits are what the governor refuses; the record itself stays parseable JSON.
  expect(() => JSON.parse(readFileSync(join(dir, '.elia', 'sysintel', 'initiatives', 'SI-1.json'), 'utf8'))).not.toThrow()
})

test('the org chart has its teams, and quarterly planning cannot move on until every project has one', async () => {
  const dir = repo()
  const run = lead(dir)
  const chart = await run('si_org', { action: 'structure' })
  for (const name of ['CTO / Chief Scientist', 'Research', 'Engineering', 'Data / ML / AI', 'Reliability / Security / QA', 'Agent runtime', 'Evaluation', 'Automated experimentation', 'Research knowledge management']) expect(chart).toContain(name)
  const strategy = '# S\n## Context\nWe sell an agent platform to support teams.\n## Direction\nOne runtime for every agent product within two years.\n## Bets\n- a shared evaluation service\n## Not Doing\nWe will not train our own foundation model.\n## Risks\n- vendor model pricing changes'
  const okrs = '# O\n## Objectives\n- make agents measurably better every week\n## Key Results\n- eval pass rate from 62% to 75%\n## Projects\n- a shared evaluation service for every agent team'
  await run('si_work', { action: 'intake', title: 'Q4 plan', problem: 'plan the quarter', origin: 'business', lifecycle: 'planning' })
  await run('si_artifact', { action: 'write', id: 'SI-1', artifact: 'strategy', content: strategy })
  await run('si_work', { action: 'advance', id: 'SI-1' })
  await run('si_artifact', { action: 'write', id: 'SI-1', artifact: 'okrs', content: okrs })
  await run('si_work', { action: 'advance', id: 'SI-1' })
  await run('si_work', { action: 'intake', title: 'Shared eval service', problem: 'every team rebuilds evals', origin: 'engineering', parent: 'SI-1', files: 30, systems: 4 })
  expect(await run('si_work', { action: 'advance', id: 'SI-1' })).toContain('now in "teams"')
  expect(await run('si_work', { action: 'advance', id: 'SI-1' })).toContain('no team yet: SI-2')
  await expect(run('si_work', { action: 'assign', id: 'SI-2', team: 'marketing' })).rejects.toThrow('must be one of')
  expect(await run('si_work', { action: 'assign', id: 'SI-2', team: 'evaluation' })).toContain('Evaluation')
  expect(await run('si_work', { action: 'advance', id: 'SI-1' })).toContain('now in "execution"')
  expect(await run('si_work', { action: 'report', view: 'priorities' })).toContain('SI-2')
})

test('the architecture review chain needs the right hats, on the document, from independent reviewers', async () => {
  const dir = repo()
  const run = lead(dir)
  const rfc = '# RFC\n## Problem\nSessions live in one Postgres node.\n## Background\nTraffic tripled this year.\n## Current System\nA single primary with one replica.\n## Proposed Solution\nMove sessions to a replicated Redis cluster.\n## Alternatives\nShard Postgres; rejected for operational cost.\n## Trade-offs\nFaster reads, but a second datastore to run.\n## Costs\nTwo engineer-weeks and three small nodes.\n## Risks\n- cache stampede on failover\n## Migration Plan\nDual-write for a week, then cut reads over.\n## Rollback Plan\nFlip reads back to Postgres; dual-write keeps it current.'
  await run('si_work', { action: 'intake', title: 'Session store RFC', problem: 'move sessions off the single Postgres node', origin: 'engineering', lifecycle: 'rfc', files: 12, systems: 3 })
  await run('si_artifact', { action: 'write', id: 'SI-1', artifact: 'rfc', content: rfc })
  expect(await run('si_work', { action: 'advance', id: 'SI-1' })).toContain('now in "staff-review"')
  // A principal-hat approval is not the staff review; a code review of the tree is not a document review.
  await as('critic', dir)('si_record', { action: 'review', id: 'SI-1', kind: 'architecture-review', hat: 'principal-engineer', artifact: 'rfc', verdict: 'approve', summary: 'fine' })
  expect(await run('si_work', { action: 'gate', id: 'SI-1' })).toContain('no staff-engineer design review yet')
  const brief = await run('si_work', { action: 'brief', id: 'SI-1', review: 'architecture-review' })
  expect(brief).toContain('"role": "critic"')
  expect(brief).toContain('Staff Engineer hat')
  expect(brief).toContain('rfc →')
  await as('critic', dir)('si_record', { action: 'review', id: 'SI-1', kind: 'architecture-review', hat: 'staff-engineer', artifact: 'rfc', verdict: 'approve', summary: 'cross-team impact checked' })
  expect(await run('si_work', { action: 'advance', id: 'SI-1' })).toContain('now in "architecture-review"')
  // The principal approval above was of this same rfc version, so it still stands.
  expect(await run('si_work', { action: 'advance', id: 'SI-1' })).toContain('now in "decision"')
})

test('security reviews the design at design time, and that does not stand in for reviewing the code', async () => {
  const result = triage({ origin: 'product', title: 'SSO login', problem: 'add SAML single sign-on', signals: { files: 25, systems: 3, flags: ['security'] } })
  const design = result.stages.find((stage) => stage.id === 'design')!
  expect(design.requirements.some((requirement) => requirement.review === 'security-review' && requirement.subject === 'artifact')).toBe(true)
  const reviewStage = result.stages.find((stage) => stage.id === 'review')!
  expect(reviewStage.requirements.some((requirement) => requirement.review === 'security-review' && requirement.subject === undefined)).toBe(true)
  const dir = repo()
  const run = lead(dir)
  await run('si_work', { action: 'intake', title: 'Token check', problem: 'validate the session token on every request', origin: 'security', lifecycle: 'vulnerability', severity: 3 })
  const report = '# V\n## Summary\nSession tokens are not validated on /export.\n## Severity\nhigh — data exposure\n## Affected\nsrc/export.js, all versions\n## Reproduction\nCall /export with an expired token; it succeeds.\n## Impact\nAny expired session can export data.\n## Remediation\nValidate the token in the export handler; add a test.'
  await run('si_artifact', { action: 'write', id: 'SI-1', artifact: 'vulnerability-report', content: report })
  await as('security', dir)('si_record', { action: 'review', id: 'SI-1', kind: 'security-review', artifact: 'vulnerability-report', verdict: 'approve', summary: 'report is accurate' })
  const store = new SysintelStore(dir)
  expect(store.read('SI-1').reviews[0]!.subject.type).toBe('artifact')
})

test('a paper must be complete, and unattended runs are told plainly that a sign-off needs a person', async () => {
  expect(validateArtifact('paper', renderTemplate('paper')).valid).toBe(false)
  const { createActionGovernor } = await import('../autonomy/governor.ts')
  const governor = createActionGovernor({ mode: 'unattended', approve: async () => true })
  const gate = await governor.check({ name: 'si_record', input: { action: 'signoff', id: 'SI-7', gate: 'release', summary: 'ship' } })
  expect(gate.allowed).toBe(false)
  expect(gate.message).toContain('cannot give a person\'s sign-off')
  expect(gate.message).toContain('elia si signoff SI-7 release')
})

test('follow-ups opened before they were linked can be linked, and the gate points at them', async () => {
  const dir = repo()
  const run = lead(dir)
  await run('si_work', { action: 'intake', title: 'Orders accepted over the limit', problem: 'a config typo disabled the order limit', origin: 'operations', severity: 3 })
  // What a live run did: open the action items first, without a parent.
  await run('si_work', { action: 'intake', title: 'Schema-validate config', problem: 'config typos go unnoticed', origin: 'engineering', files: 3 })
  await run('si_work', { action: 'intake', title: 'Alert on oversized orders', problem: 'nothing alerts on limit breaches', origin: 'operations', lifecycle: 'change', files: 3 })
  const store = new SysintelStore(dir)
  store.update('SI-1', (initiative) => {
    for (const stage of initiative.stages) stage.status = stage.id === 'prevent-recurrence' ? 'active' : stage.status === 'pending' ? 'done' : stage.status
    initiative.current = 'prevent-recurrence'
  })
  const gate = await run('si_work', { action: 'gate', id: 'SI-1' })
  expect(gate).toContain('SI-2, SI-3 were opened after this without a parent')
  expect(gate).toContain('si_work link id:"SI-1"')
  await expect(run('si_work', { action: 'link', id: 'SI-1', children: ['SI-1'] })).rejects.toThrow('cycle')
  expect(await run('si_work', { action: 'link', id: 'SI-1', children: ['SI-2', 'SI-3'] })).toContain('follow-ups: SI-2, SI-3')
  expect(store.read('SI-2').parent).toBe('SI-1')
  await expect(run('si_work', { action: 'link', id: 'SI-2', children: ['SI-1'] })).rejects.toThrow('cycle')
  expect(await run('si_work', { action: 'gate', id: 'SI-1' })).toContain('✓ followups')
})
