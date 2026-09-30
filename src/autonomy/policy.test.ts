import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { applyPolicy, loadPolicy, type EliaPolicy } from './policy.ts'
import { assessAction, createActionGovernor } from './governor.ts'

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function projectWith(policy: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), 'elia-policy-'))
  dirs.push(dir)
  mkdirSync(join(dir, '.elia'), { recursive: true })
  writeFileSync(join(dir, '.elia', 'policy.json'), typeof policy === 'string' ? policy : JSON.stringify(policy))
  return dir
}

const base: EliaPolicy = { denyTools: [], denyIntents: [], denyCommandPatterns: [], requireApprovalAtOrAbove: 'critical' }

test('loadPolicy returns null when no policy file exists', () => {
  const dir = mkdtempSync(join(tmpdir(), 'elia-policy-'))
  dirs.push(dir)
  expect(loadPolicy(dir)).toBeNull()
})

test('loadPolicy parses and normalises a valid policy', () => {
  const dir = projectWith({ denyTools: ['codex_delegate', 'codex_delegate'], denyCommandPatterns: ['rm\\s+-rf'] })
  const policy = loadPolicy(dir)
  expect(policy?.denyTools).toEqual(['codex_delegate'])
  expect(policy?.requireApprovalAtOrAbove).toBe('critical')
})

test('loadPolicy throws on malformed JSON and on a bad regex', () => {
  expect(() => loadPolicy(projectWith('{ not json'))).toThrow('expected JSON')
  expect(() => loadPolicy(projectWith({ denyCommandPatterns: ['('] }))).toThrow('not a valid regular expression')
  expect(() => loadPolicy(projectWith({ requireApprovalAtOrAbove: 'sometimes' }))).toThrow('requireApprovalAtOrAbove')
})

test('applyPolicy passes assessments through untouched when there is no policy', () => {
  const assessment = assessAction({ name: 'read_file', input: { path: 'a.ts' } }, '/repo')
  const outcome = applyPolicy(assessment, { name: 'read_file', input: { path: 'a.ts' } }, '/repo', null)
  expect(outcome.blocked).toBe(false)
  expect(outcome.assessment).toBe(assessment)
})

test('applyPolicy blocks a denied tool outright', () => {
  const req = { name: 'codex_delegate', input: {} }
  const outcome = applyPolicy(assessAction(req, '/repo'), req, '/repo', { ...base, denyTools: ['codex_delegate'] })
  expect(outcome.blocked).toBe(true)
  expect(outcome.assessment.decision).toBe('block')
  expect(outcome.message).toContain('deny list')
})

test('applyPolicy blocks a denied intent while leaving siblings alone', () => {
  const push = { name: 'github', input: { action: 'push' } }
  const commit = { name: 'github', input: { action: 'commit' } }
  const policy: EliaPolicy = { ...base, denyIntents: ['github.push'] }
  expect(applyPolicy(assessAction(push, '/repo'), push, '/repo', policy).blocked).toBe(true)
  expect(applyPolicy(assessAction(commit, '/repo'), commit, '/repo', policy).blocked).toBe(false)
})

test('applyPolicy blocks a run_command matching a forbidden pattern', () => {
  const req = { name: 'run_command', input: { command: 'npx playwright install' } }
  const outcome = applyPolicy(assessAction(req, '/repo'), req, '/repo', { ...base, denyCommandPatterns: ['playwright\\s+install'] })
  expect(outcome.blocked).toBe(true)
  expect(outcome.message).toContain('forbidden pattern')
})

test('applyPolicy applies command patterns to direct program arguments too', () => {
  const req = { name: 'run_program', input: { program: 'npx', args: ['playwright', 'install'] } }
  const outcome = applyPolicy(assessAction(req, '/repo'), req, '/repo', { ...base, denyCommandPatterns: ['playwright\\s+install'] })
  expect(outcome.blocked).toBe(true)
})

test('applyPolicy applies command patterns to `process start`, which runs a shell command too', () => {
  const policy: EliaPolicy = { ...base, denyCommandPatterns: ['playwright\\s+install'] }
  const start = { name: 'process', input: { action: 'start', command: 'npx playwright install' } }
  expect(applyPolicy(assessAction(start, '/repo'), start, '/repo', policy).blocked).toBe(true)
  const logs = { name: 'process', input: { action: 'logs', id: 'proc_1', filter: 'playwright install' } }
  expect(applyPolicy(assessAction(logs, '/repo'), logs, '/repo', policy).blocked).toBe(false)
})

test('applyPolicy applies command patterns to run_security_tool, which executes a shell command for cyber mode', () => {
  const policy: EliaPolicy = { ...base, denyCommandPatterns: ['nmap\\s+-sS'] }
  const scan = { name: 'run_security_tool', input: { engagement: 'acme', label: 'sweep', command: 'nmap -sS 10.0.0.0/24' } }
  const outcome = applyPolicy(assessAction(scan, '/repo'), scan, '/repo', policy)
  expect(outcome.blocked).toBe(true)
  expect(outcome.message).toContain('forbidden pattern')
  // A permitted scanner command still runs — the pattern, not the tool, is the gate.
  const allowed = { name: 'run_security_tool', input: { engagement: 'acme', label: 'sweep', command: 'nmap -sV -oX out.xml 10.0.0.1' } }
  expect(applyPolicy(assessAction(allowed, '/repo'), allowed, '/repo', policy).blocked).toBe(false)
})

test('applyPolicy raises a safe allow to approve when the risk bar is lowered', () => {
  const safe = { name: 'web_search', input: { query: 'tls best practice' } }
  const assessment = assessAction(safe, process.cwd())
  expect(assessment.decision).toBe('allow')
  expect(assessment.risk).toBe('safe')
  const outcome = applyPolicy(assessment, safe, process.cwd(), { ...base, requireApprovalAtOrAbove: 'safe' })
  expect(outcome.assessment.decision).toBe('approve')
  expect(outcome.assessment.risk).toBe('critical')
  expect(outcome.assessment.reason).toContain('policy.json requires approval')
  expect(outcome.blocked).toBe(false)
})

test('review-band actions with requireApprovalAtOrAbove "review" are escalated out of the unattended auto-allow bucket', () => {
  const review = { name: 'run_command', input: { command: 'git commit -m wip' } }
  const assessment = assessAction(review, process.cwd())
  expect(assessment.risk).toBe('review')
  expect(assessment.decision).toBe('approve')
  const outcome = applyPolicy(assessment, review, process.cwd(), { ...base, requireApprovalAtOrAbove: 'review' })
  // Risk is raised to critical so the governor's `risk === review` auto-allow
  // (line 635) no longer fires and the action must be explicitly approved.
  expect(outcome.assessment.risk).toBe('critical')
  expect(outcome.assessment.decision).toBe('approve')
  expect(outcome.assessment.reason).toContain('policy.json requires approval')
})

test('safe-band actions stay untouched when requireApprovalAtOrAbove is "review" (they are below the bar)', () => {
  const safe = { name: 'read_file', input: { path: 'src/index.ts' } }
  const assessment = assessAction(safe, process.cwd())
  const outcome = applyPolicy(assessment, safe, process.cwd(), { ...base, requireApprovalAtOrAbove: 'review' })
  expect(outcome.assessment).toBe(assessment)
  expect(outcome.blocked).toBe(false)
})

test('requireApprovalAtOrAbove "critical" does not touch review-band actions (the built-in default)', () => {
  const review = { name: 'run_command', input: { command: 'git commit -m wip' } }
  const assessment = assessAction(review, process.cwd())
  const outcome = applyPolicy(assessment, review, process.cwd(), { ...base, requireApprovalAtOrAbove: 'critical' })
  expect(outcome.assessment).toBe(assessment)
})

test('governor blocks a policy-denied tool before consuming action budget', async () => {
  const dir = projectWith({ denyTools: ['run_security_tool'] })
  const governor = createActionGovernor({ mode: 'supervised', cwd: dir, maxActions: 5, approve: async () => true })
  const result = await governor.check({ name: 'run_security_tool', input: { engagement: 'x', label: 'y', command: 'nmap' } })
  expect(result.allowed).toBe(false)
  expect(result.message).toContain('.elia/policy.json')
  expect(governor.stats().consumed).toBe(0)
})
