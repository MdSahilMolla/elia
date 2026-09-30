import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { surveyRepository, renderSurvey } from './survey.ts'
import { compareHealth, failingTests, measureHealth, type CheckRunner } from './health.ts'
import { extractJsonObject, isRealCitation, parseUnderstanding } from './understand.ts'
import { addUserGoal, goalScore, isSameGoal, nextGoal, refreshBacklog, verificationFor } from './backlog.ts'
import { activePilot, goalPrompt, runPilot, PilotError, type GoalRunner } from './pilot.ts'
import { renderReport, statusText, pilotSnapshot } from './report.ts'
import { loadPilotState } from './store.ts'
import { isTestPath } from './git.ts'
import type { HealthReport, RepoSurvey } from './types.ts'

function sh(root: string, ...args: string[]): string {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' })
  if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`)
  return result.stdout.trim()
}

/** A small repository with a README, two checks, a TODO and some history. */
function fixtureRepo(): string {
  const root = mkdtempSync(join(tmpdir(), 'autopilot-'))
  sh(root, 'init', '-q', '-b', 'main')
  sh(root, 'config', 'user.email', 'dev@example.com')
  sh(root, 'config', 'user.name', 'Dev')
  sh(root, 'config', 'commit.gpgsign', 'false')
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'tiny-notes', description: 'A tiny note-taking API', scripts: { typecheck: 'tsc --noEmit', test: 'bun test' } }, null, 2))
  writeFileSync(join(root, 'bun.lock'), '')
  writeFileSync(join(root, '.gitignore'), 'node_modules/\n.env\n')
  for (const dep of ['typescript', 'zod', 'hono', 'kleur']) mkdirSync(join(root, 'node_modules', dep), { recursive: true })
  writeFileSync(join(root, 'README.md'), '# tiny-notes\n\nA tiny HTTP API for notes. Roadmap: tags, search.\n')
  mkdirSync(join(root, 'src'))
  writeFileSync(join(root, 'src', 'notes.ts'), 'export function add(a: number, b: number) {\n  // TODO: validate input\n  return a + b\n}\n')
  writeFileSync(join(root, 'src', 'notes.test.ts'), 'test("x", () => {})\n')
  sh(root, 'add', '-A')
  sh(root, 'commit', '-q', '-m', 'initial notes api')
  return root
}

/** Checks are decided by files in the tree: `test` passes once FIXED exists; `typecheck` fails while BROKEN exists. */
const fileRunner: CheckRunner = async (command, root) => {
  const pass = command.includes('typecheck') ? !existsSync(join(root, 'BROKEN')) : existsSync(join(root, 'FIXED'))
  return { exitCode: pass ? 0 : 1, stdout: pass ? 'ok' : 'error: expected 3, got 4', stderr: '', elapsedMs: 5, timedOut: false }
}

let root: string
beforeEach(() => {
  root = fixtureRepo()
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

describe('survey', () => {
  test('reads identity, readme, checks, markers and history into numbered evidence', () => {
    const survey = surveyRepository(root, { env: {}, has: () => true })
    expect(survey.name).toBe('tiny-notes')
    expect(survey.description).toBe('A tiny note-taking API')
    expect(survey.checks.some((command) => command.includes('typecheck'))).toBe(true)
    expect(survey.markerCount).toBe(1)
    expect(survey.git?.commits).toBe(1)
    expect(survey.files.tests).toBe(1)
    expect(survey.evidence.map((item) => item.id)).toEqual(survey.evidence.map((_, index) => `E${index + 1}`))
    const rendered = renderSurvey(survey)
    expect(rendered).toContain('[E1]')
    expect(rendered).toContain('TODO: validate input')
    expect(renderSurvey(survey, 200)).toContain('omitted for length')
  })
})

describe('health', () => {
  test('every check runs, and the delta finds regressions and fixes', async () => {
    const before = await measureHealth(root, ['bun run typecheck', 'bun test'], { runner: fileRunner })
    expect(before.checks.map((check) => check.status)).toEqual(['pass', 'fail'])
    writeFileSync(join(root, 'FIXED'), '')
    writeFileSync(join(root, 'BROKEN'), '')
    const after = await measureHealth(root, ['bun run typecheck', 'bun test'], { runner: fileRunner })
    expect(compareHealth(before, after)).toEqual({ regressions: ['bun run typecheck'], fixed: ['bun test'], stillFailing: [], worsened: [], improved: [] })
  })

  test('failing tests are read from the common runners, and a red check is compared test by test', () => {
    expect(failingTests('(pass) ok\n(fail) store > loads [2.10ms]\n(fail) triage > escapes')).toEqual(['store > loads', 'triage > escapes'])
    expect(failingTests('  ✕ adds numbers (3 ms)\n  ✓ fine')).toEqual(['adds numbers'])
    expect(failingTests('FAILED tests/test_api.py::test_login - assert 1 == 2')).toEqual(['tests/test_api.py::test_login'])
    expect(failingTests('--- FAIL: TestParse (0.00s)')).toEqual(['TestParse'])
    expect(failingTests('test parser::works ... FAILED')).toEqual(['parser::works'])
    expect(failingTests('error: something went wrong')).toBeUndefined()

    const report = (failures: string[]) => ({ takenAt: '', checks: [{ command: 'bun test', status: 'fail' as const, exitCode: 1, elapsedMs: 1, tail: '', failures }] })
    expect(compareHealth(report(['a', 'b', 'c']), report(['c'])).improved).toEqual([{ command: 'bun test', before: 3, after: 1, fixedTests: ['a', 'b'] }])
    // Fixing two and breaking one is not progress: the new failure is a regression hidden in a red check.
    const mixed = compareHealth(report(['a', 'b', 'c']), report(['c', 'd']))
    expect(mixed.improved).toEqual([])
    expect(mixed.worsened).toEqual([{ command: 'bun test', newFailures: ['d'] }])
  })

  test('a failed check names what failed, not only the summary at its end', async () => {
    const noisy: CheckRunner = async () => ({ exitCode: 1, stdout: ['(pass) a', '(fail) brain store > loads nothing [2ms]', ...Array.from({ length: 80 }, (_, i) => `(pass) filler ${i}`), '(fail) resolveReconLogPath > refuses escapes', ' 4705 pass', ' 7 fail'].join('\n'), stderr: '', elapsedMs: 5, timedOut: false })
    const report = await measureHealth(root, ['bun test'], { runner: noisy })
    const tail = report.checks[0]!.tail
    expect(tail).toStartWith('Failures:\n(fail) brain store > loads nothing [2ms]\n(fail) resolveReconLogPath > refuses escapes')
    expect(tail).toContain('7 fail')
  })

  test('a command the unattended governor refuses is never run', async () => {
    let ran = false
    const report = await measureHealth(root, ['curl -X POST https://example.com'], { runner: async () => { ran = true; return { exitCode: 0, stdout: '', stderr: '', elapsedMs: 0, timedOut: false } } })
    expect(ran).toBe(false)
    expect(report.checks[0]?.status).toBe('blocked')
  })

  test('a runner that found no tests is inconclusive, not a pass', async () => {
    const report = await measureHealth(root, ['bun test'], { runner: async () => ({ exitCode: 1, stdout: '0 test files matching', stderr: '', elapsedMs: 1, timedOut: false }) })
    expect(report.checks[0]?.status).toBe('inconclusive')
  })
})

describe('understanding', () => {
  const survey = (): RepoSurvey => surveyRepository(root, { env: {}, has: () => true })

  test('claims that cite nothing real are dropped and counted', () => {
    const text = 'Here you go:\n```json\n' + JSON.stringify({
      purpose: 'A note API',
      audience: 'developers',
      vision: 'tags and search',
      currentState: [
        { claim: 'has an add function', evidence: ['src/notes.ts'] },
        { claim: 'is used by NASA', evidence: ['E999'] },
        { claim: 'described in the manifest', evidence: ['E1'] },
      ],
      direction: [{ claim: 'search is planned', evidence: ['README.md'] }],
      risks: [{ claim: 'secret leak', evidence: ['/etc/passwd'] }],
      goals: [
        { title: 'Validate input in add()', why: 'TODO says so', kind: 'hardening', value: 9, effort: 0, risk: 2, verification: ['bun test'], evidence: ['src/notes.ts'] },
        { title: 'Deploy to production', why: 'ship it', kind: 'feature', evidence: ['E1'] },
        { title: 'Invent a thing', why: 'because', kind: 'feature', evidence: ['nowhere.ts'] },
      ],
    }) + '\n```'
    const parsed = parseUnderstanding(text, survey(), 'test-model')!
    expect(parsed.understanding.currentState.map((c) => c.claim)).toEqual(['has an add function', 'described in the manifest'])
    expect(parsed.understanding.droppedClaims).toBe(2)
    expect(parsed.goals).toHaveLength(1)
    expect(parsed.goals[0]).toMatchObject({ title: 'Validate input in add()', value: 5, effort: 1 })
    expect(parsed.droppedGoals).toBe(2)
  })

  test('json is found bare, fenced, or with trailing commas; garbage is undefined', () => {
    expect(extractJsonObject('{"a":1}')).toEqual({ a: 1 })
    expect(extractJsonObject('noise {"a":[1,2,],} tail')).toEqual({ a: [1, 2] })
    expect(extractJsonObject('no json here')).toBeUndefined()
  })

  test('citations must name a survey id or an existing path inside the repo', () => {
    const s = survey()
    expect(isRealCitation('E1', s)).toBe(true)
    expect(isRealCitation('[E1]', s)).toBe(true)
    expect(isRealCitation('src/notes.ts:2', s)).toBe(true)
    expect(isRealCitation('../outside', s)).toBe(false)
    expect(isRealCitation('src/missing.ts', s)).toBe(false)
  })
})

describe('backlog', () => {
  const health: HealthReport = { takenAt: '', checks: [{ command: 'bun run typecheck', status: 'pass', exitCode: 0, elapsedMs: 1, tail: '' }, { command: 'bun test', status: 'fail', exitCode: 1, elapsedMs: 1, tail: 'boom' }] }

  test('failing checks become repair goals that outrank every idea; repeats are dropped', () => {
    const survey = surveyRepository(root, { env: {}, has: () => true })
    const backlog = refreshBacklog([], {
      survey,
      health,
      proposed: [
        { title: 'Add tag support to notes', why: 'roadmap', kind: 'feature', value: 5, effort: 2, risk: 1, verification: ['bun test'], evidence: ['README.md'] },
        { title: 'Add tags support for notes', why: 'dup', kind: 'feature', value: 5, effort: 2, risk: 1, verification: [], evidence: ['README.md'] },
      ],
    })
    expect(backlog.map((goal) => goal.kind)).toEqual(['repair', 'feature'])
    expect(nextGoal(backlog)?.kind).toBe('repair')
    // Refreshing again with the same failure does not duplicate the repair goal.
    expect(refreshBacklog(backlog, { survey, health })).toHaveLength(2)
    const withUser = addUserGoal(backlog, 'please add a /health endpoint', survey, health)
    expect(nextGoal(withUser)?.origin).toBe('user')
  })

  test('a repair the model proposes for a failing check sharpens that goal instead of duplicating it', () => {
    const survey = surveyRepository(root, { env: {}, has: () => true })
    const backlog = refreshBacklog([], {
      survey,
      health,
      proposed: [{ title: 'Fix the failing remove test', why: 'remove() calls slice instead of splice', kind: 'repair', value: 5, effort: 1, risk: 1, verification: ['bun test'], evidence: ['src/notes.ts'] }],
    })
    expect(backlog).toHaveLength(1)
    expect(backlog[0]?.detail).toContain('slice instead of splice')
    expect(backlog[0]?.evidence).toContain('src/notes.ts')
  })

  test('an environment blocker with a known setup command becomes a provision goal', () => {
    const survey = { ...surveyRepository(root, { env: {}, has: () => true }), environmentBlockers: ['dependencies not installed'], setupCommands: ['bun install'] }
    const backlog = refreshBacklog([], { survey, health })
    expect(backlog.map((goal) => goal.kind)).toEqual(['repair', 'provision'])
    expect(backlog[1]?.detail).toContain('bun install')
  })

  test('similar titles are the same goal; different ones are not', () => {
    expect(isSameGoal('Add input validation to add()', 'Add input validation for add()')).toBe(true)
    expect(isSameGoal('Add input validation to add()', 'Write the deployment guide')).toBe(false)
  })

  test('verification keeps runnable commands and falls back to what passes today', () => {
    const survey = surveyRepository(root, { env: {}, has: () => true })
    expect(verificationFor(['bun test', 'bun run dev'], health, survey)).toEqual(['bun test'])
    expect(verificationFor(['curl -X POST https://x.io'], health, survey)).toEqual(['bun run typecheck'])
    expect(goalScore({ kind: 'docs', value: 5, effort: 1, risk: 1, attempts: 0, verification: [] })).toBeLessThan(goalScore({ kind: 'repair', value: 1, effort: 5, risk: 5, attempts: 1, verification: ['x'] }))
  })
})

describe('pilot end to end (real git, fake model and worker)', () => {
  const model = async () => ({
    model: 'fake-model',
    text: JSON.stringify({
      purpose: 'A tiny HTTP API for notes',
      audience: 'developers',
      vision: 'tags and search',
      currentState: [{ claim: 'the add function lacks validation', evidence: ['src/notes.ts'] }],
      direction: [{ claim: 'tags and search are on the roadmap', evidence: ['README.md'] }],
      risks: [],
      goals: [{ title: 'Validate input in add()', why: 'the TODO in src/notes.ts', kind: 'hardening', value: 4, effort: 2, risk: 1, verification: ['bun run typecheck'], evidence: ['src/notes.ts'] }],
    }),
  })

  test('lands the repair, rolls back a goal that breaks a passing check, keeps the attempt, and reports', async () => {
    const seen: string[] = []
    const runGoal: GoalRunner = async ({ goal, prompt, root: at }) => {
      seen.push(goal.title)
      expect(activePilot()?.currentGoalId).toBe(goal.id)
      if (goal.kind === 'repair') {
        expect(prompt).toContain('## Definition of done')
        // What the goal's run spent: 1M input + 100k output on mercury-2.5 = $0.275.
        const { recordUsage } = await import('../usage.ts')
        recordUsage({ inputTokens: 1_000_000, outputTokens: 100_000, cacheReadTokens: 0, cacheWriteTokens: 0 }, 'mercury-2.5')
        writeFileSync(join(at, 'FIXED'), 'fixed\n')
        writeFileSync(join(at, '.env'), 'SECRET=1\n')
        return { outcome: 'completed', blockers: ['refused: git push (github.push) — needs a person'] }
      }
      // The hardening goal "works" but breaks the typecheck.
      writeFileSync(join(at, 'BROKEN'), 'oops\n')
      writeFileSync(join(at, 'src', 'notes.ts'), 'export const broken = true\n')
      return { outcome: 'completed', blockers: [] }
    }
    const lines: string[] = []
    const result = await runPilot({ root, maxGoals: 4, understandingModel: model, runGoal, checkRunner: fileRunner, has: () => true, env: {}, spendExceeded: () => false, maxReplans: 0, log: (line) => lines.push(line) })
    const state = result.state
    // The goal's spend is on its outcome now; leave no session spend behind for other suites.
    ;(await import('../usage.ts')).resetSessionUsageForTests()

    expect(state.branch?.startsWith('elia/autopilot-')).toBe(true)
    expect(sh(root, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe(state.branch!)
    expect(sh(root, 'rev-parse', 'main')).toBe(state.baseSha!)

    const repair = state.backlog.find((goal) => goal.kind === 'repair')!
    expect(repair.status).toBe('done')
    expect(repair.outcomes[0]?.accepted).toBe(true)
    expect(repair.outcomes[0]?.fixed).toEqual([state.survey!.checks.find((c) => c.includes('test'))!])
    // Each goal says what it cost; one that spent nothing says so.
    expect(repair.outcomes[0]?.costUsd).toBeCloseTo(0.275, 6)
    expect(lines.some((line) => line.includes('✓ landed') && line.endsWith('· $0.28'))).toBe(true)
    // Landed as a commit; the secret was left out of it.
    expect(sh(root, 'log', '--format=%s', '-n', '1')).toBe('autopilot: ' + repair.title)
    expect(sh(root, 'ls-files')).toContain('FIXED')
    expect(sh(root, 'ls-files')).not.toContain('.env')

    const hardening = state.backlog.find((goal) => goal.kind === 'hardening')!
    expect(hardening.attempts).toBe(2)
    expect(hardening.status).toBe('parked')
    expect(hardening.outcomes.every((outcome) => !outcome.accepted && outcome.regressions.length === 1)).toBe(true)
    // Rolled back: the tree is as the repair left it, and the attempt survives on a ref.
    expect(existsSync(join(root, 'BROKEN'))).toBe(false)
    expect(readFileSync(join(root, 'src', 'notes.ts'), 'utf8')).toContain('TODO: validate input')
    const kept = hardening.outcomes[0]!.keptAt!
    expect(sh(root, 'show', `${kept}:src/notes.ts`)).toContain('broken')

    expect(seen).toEqual([repair.title, hardening.title, hardening.title])
    expect(state.needsHuman.some((item) => item.includes('git push'))).toBe(true)
    expect(state.stopReason).toContain('nothing left worth doing')
    expect(activePilot()).toBeUndefined()

    const report = readFileSync(result.reportPath, 'utf8')
    expect(report).toContain('## What this project is')
    expect(report).toContain('Rolled back (kept for inspection)')
    expect(report).toContain('## Needs a person')
    expect(report).toContain('Spent on goals: about $0.28 across 3 attempt(s).')
    expect(statusText(state)).toContain('1 landed, 1 parked')
    expect(pilotSnapshot(state)).toContain('purpose: A tiny HTTP API for notes')
    expect(renderReport(state)).toContain('| at start | now |')
    // .elia/ never shows up as the operator's work.
    expect(sh(root, 'status', '--porcelain')).toBe('')
  })

  test('plan-only changes nothing and resume picks the plan back up', async () => {
    const plan = await runPilot({ root, planOnly: true, understandingModel: model, checkRunner: fileRunner, has: () => true, env: {}, log: () => {} })
    expect(plan.state.branch).toBeUndefined()
    expect(sh(root, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('main')
    expect(plan.state.backlog.length).toBeGreaterThan(0)
    expect(loadPilotState(root)?.id).toBe(plan.state.id)

    let calls = 0
    const resumed = await runPilot({ root, resume: true, maxGoals: 1, understandingModel: async () => { calls += 1; return model() }, runGoal: async ({ root: at }) => { writeFileSync(join(at, 'FIXED'), ''); return { outcome: 'completed', blockers: [] } }, checkRunner: fileRunner, has: () => true, env: {}, spendExceeded: () => false, log: () => {} })
    expect(resumed.state.id).toBe(plan.state.id)
    expect(calls).toBe(0)
    expect(resumed.state.stopReason).toContain('goal budget reached')
  })

  test('an understanding cut short by Esc is not kept, so a resume reads the project again', async () => {
    const controller = new AbortController()
    const stopped = await runPilot({ root, signal: controller.signal, understandingModel: async () => { controller.abort(); return { model: 'fake-model', text: '' } }, checkRunner: fileRunner, has: () => true, env: {}, spendExceeded: () => false, log: () => {} })
    expect(stopped.state.understanding).toBeUndefined()
    expect(stopped.state.stopReason).toBe('stopped by the operator')
    let calls = 0
    const resumed = await runPilot({ root, resume: true, planOnly: true, understandingModel: async () => { calls += 1; return model() }, checkRunner: fileRunner, has: () => true, env: {}, log: () => {} })
    expect(calls).toBe(1)
    expect(resumed.state.understanding?.purpose).toBe('A tiny HTTP API for notes')
  })

  test('operator directions jump the queue', async () => {
    const titles: string[] = []
    let directions = ['add a /health endpoint']
    await runPilot({ root, maxGoals: 1, understandingModel: model, runGoal: async ({ goal }) => { titles.push(goal.title); return { outcome: 'completed', blockers: [] } }, checkRunner: fileRunner, has: () => true, env: {}, spendExceeded: () => false, drainDirections: () => { const d = directions; directions = []; return d }, log: () => {} })
    expect(titles).toEqual(['add a /health endpoint'])
  })

  test('refuses a dirty tree and a non-repository, without touching either', async () => {
    writeFileSync(join(root, 'wip.txt'), 'mine')
    await expect(runPilot({ root, understandingModel: model, checkRunner: fileRunner, has: () => true, env: {}, log: () => {} })).rejects.toThrow(PilotError)
    expect(readFileSync(join(root, 'wip.txt'), 'utf8')).toBe('mine')
    expect(sh(root, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('main')
    unlinkSync(join(root, 'wip.txt'))
    const plain = mkdtempSync(join(tmpdir(), 'autopilot-plain-'))
    try {
      await expect(runPilot({ root: plain, log: () => {} })).rejects.toThrow('git repository')
    } finally {
      rmSync(plain, { recursive: true, force: true })
    }
  })

  test('a watching pilot turns what its watchers see into goals, and waits instead of stopping when there is nothing to do', async () => {
    const inbox = mkdtempSync(join(tmpdir(), 'autopilot-inbox-'))
    try {
      const { addWatcher, parseTrigger } = await import('./watch.ts')
      const { autopilotDir } = await import('./store.ts')
      addWatcher(root, parseTrigger(`file ${inbox}`))
      const dueNow = () => {
        const file = join(autopilotDir(root), 'watch.json')
        const saved = JSON.parse(readFileSync(file, 'utf8')) as { watchers: Array<{ nextCheckAt: number }> }
        for (const watcher of saved.watchers) watcher.nextCheckAt = 0
        writeFileSync(file, JSON.stringify(saved))
      }
      const controller = new AbortController()
      const titles: string[] = []
      const scopesSeen: unknown[] = []
      let idles = 0
      const lines: string[] = []
      const result = await runPilot({
        root, watch: true, idlePollMs: 1, maxReplans: 0, understandingModel: model, checkRunner: fileRunner, has: () => true, env: {}, spendExceeded: () => false,
        signal: controller.signal, scopes: ['workspace-read', 'workspace-write'], log: (line) => lines.push(line),
        runGoal: async ({ goal, scopes }) => {
          titles.push(goal.title)
          scopesSeen.push(scopes)
          return { outcome: 'completed', blockers: [] }
        },
        sleep: async () => {
          idles += 1
          if (idles === 1) {
            // Something happens while it waits.
            writeFileSync(join(inbox, 'note.txt'), 'the export button does nothing')
            dueNow()
          } else controller.abort()
        },
      })
      const event = result.state.backlog.find((goal) => goal.origin === 'event')
      expect(event?.title).toContain('Files changed')
      expect(titles).toContain(event!.title)
      // No goal budget stopped it: the operator did.
      expect(result.state.stopReason).toBe('stopped by the operator')
      expect(lines.filter((line) => line.includes('watching for what happens next'))).toHaveLength(2)
      expect(scopesSeen.every((scopes) => JSON.stringify(scopes) === JSON.stringify(['workspace-read', 'workspace-write']))).toBe(true)
    } finally {
      rmSync(inbox, { recursive: true, force: true })
    }
  })

  test('a repair that fixes some failing tests lands that progress and keeps the goal open; one that breaks a test is rolled back', async () => {
    // `bun test` fails one test per file named BUG-*; FIXED-less, so the check stays red until all are gone.
    const bugs = ['BUG-a', 'BUG-b', 'BUG-c']
    for (const bug of bugs) writeFileSync(join(root, bug), '')
    sh(root, 'add', '-A')
    sh(root, 'commit', '-q', '-m', 'three known bugs')
    const perTest: CheckRunner = async (command, at) => {
      if (command.includes('typecheck')) return { exitCode: 0, stdout: 'ok', stderr: '', elapsedMs: 1, timedOut: false }
      const failing = ['a', 'b', 'c', 'd'].filter((name) => existsSync(join(at, `BUG-${name}`)))
      return { exitCode: failing.length > 0 ? 1 : 0, stdout: [...failing.map((name) => `(fail) suite > ${name} [1ms]`), ` ${failing.length} fail`].join('\n'), stderr: '', elapsedMs: 1, timedOut: false }
    }
    let call = 0
    const lines: string[] = []
    const result = await runPilot({
      root, maxGoals: 3, maxReplans: 0, understandingModel: model, checkRunner: perTest, has: () => true, env: {}, spendExceeded: () => false, log: (line) => lines.push(line),
      runGoal: async ({ goal, root: at }) => {
        if (goal.kind !== 'repair') return { outcome: 'completed', blockers: [] }
        call += 1
        if (call === 1) unlinkSync(join(at, 'BUG-a')) // real progress: 3 → 2
        else if (call === 2) {
          unlinkSync(join(at, 'BUG-b'))
          writeFileSync(join(at, 'BUG-d'), '') // fixes one, breaks another
        }
        return { outcome: 'needs-attention', blockers: [] }
      },
    })
    const repair = result.state.backlog.find((goal) => goal.kind === 'repair')!
    expect(repair.outcomes[0]).toMatchObject({ accepted: true })
    expect(repair.outcomes[0]!.reason).toContain('3 → 2 failing test(s), none new')
    expect(repair.outcomes[1]).toMatchObject({ accepted: false })
    expect(repair.outcomes[1]!.reason).toContain('broke tests that passed before: suite > d')
    // The landed progress stays; the bad attempt is gone.
    expect(existsSync(join(root, 'BUG-a'))).toBe(false)
    expect(existsSync(join(root, 'BUG-b'))).toBe(true)
    expect(existsSync(join(root, 'BUG-d'))).toBe(false)
    expect(lines.some((line) => line.includes('◐ landed progress'))).toBe(true)
    // It changed no test files, so nothing is flagged.
    expect(result.state.needsHuman.some((line) => line.includes('changed test file'))).toBe(false)
    ;(await import('../usage.ts')).resetSessionUsageForTests()
  })

  test('a landed goal that changed a test file is flagged for a person', async () => {
    expect(['src/a.test.ts', 'src/a.spec.tsx', 'pkg/a_test.go', 'tests/test_api.py', 'src/__tests__/x.ts'].every(isTestPath)).toBe(true)
    expect(['src/testing.ts', 'src/contest.ts', 'README.md'].some(isTestPath)).toBe(false)
    const result = await runPilot({
      root, maxGoals: 1, maxReplans: 0, understandingModel: model, checkRunner: fileRunner, has: () => true, env: {}, spendExceeded: () => false, log: () => {},
      runGoal: async ({ root: at }) => {
        writeFileSync(join(at, 'FIXED'), '')
        writeFileSync(join(at, 'src', 'notes.test.ts'), 'test("x", () => { /* made easier */ })\n')
        return { outcome: 'completed', blockers: [] }
      },
    })
    expect(result.state.needsHuman.some((line) => line.includes('changed test file(s)') && line.includes('src/notes.test.ts'))).toBe(true)
    ;(await import('../usage.ts')).resetSessionUsageForTests()
  })

  test('a watching pilot stops spending at its daily budget, and a restart cannot reset it', async () => {
    const inbox = mkdtempSync(join(tmpdir(), 'autopilot-budget-'))
    try {
      const { addWatcher, parseTrigger } = await import('./watch.ts')
      addWatcher(root, parseTrigger(`file ${inbox}`))
      const ran: string[] = []
      const lines: string[] = []
      const controller = new AbortController()
      const runGoal: GoalRunner = async ({ goal }) => {
        ran.push(goal.title)
        const { recordUsage } = await import('../usage.ts')
        recordUsage({ inputTokens: 1_000_000, outputTokens: 100_000, cacheReadTokens: 0, cacheWriteTokens: 0 }, 'mercury-2.5') // $0.275
        return { outcome: 'completed', blockers: [] }
      }
      const options = { root, watch: true, idlePollMs: 1, maxReplans: 0, dailyBudgetUsd: 0.2, understandingModel: model, checkRunner: fileRunner, has: () => true, env: {}, spendExceeded: () => false, runGoal, log: (line: string) => lines.push(line), signal: controller.signal, sleep: async () => controller.abort() }
      const first = await runPilot(options)
      expect(ran).toHaveLength(1)
      expect(lines.some((line) => line.includes("today's spending limit is reached"))).toBe(true)
      expect(Object.values(first.state.spentByDay ?? {})[0]).toBeCloseTo(0.275, 6)
      // Restarted (as the service manager would): the budget is in the state, so it still waits.
      const again = new AbortController()
      await runPilot({ ...options, resume: true, signal: again.signal, sleep: async () => again.abort() })
      expect(ran).toHaveLength(1)
    } finally {
      rmSync(inbox, { recursive: true, force: true })
      ;(await import('../usage.ts')).resetSessionUsageForTests()
    }
  })

  test('watching needs something to watch', async () => {
    await expect(runPilot({ root, watch: true, understandingModel: model, checkRunner: fileRunner, has: () => true, env: {}, log: () => {} })).rejects.toThrow('nothing to watch yet')
  })

  test('the goal prompt carries the definition of done and the outside-world constraint', () => {
    const state = { ...loadPilotState(root), backlog: [] } as never
    const prompt = goalPrompt({ id: 'g1', title: 'Fix it', detail: 'because', kind: 'repair', origin: 'health', value: 5, effort: 1, risk: 1, verification: ['bun test'], evidence: [], status: 'open', attempts: 0, outcomes: [], createdAt: '' }, state)
    expect(prompt).toContain('`bun test`')
    expect(prompt).toContain('Do not push, publish, deploy')
  })
})
