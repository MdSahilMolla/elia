import { afterAll, beforeAll, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { countBlame, gitIn, loadHistory, parseLog, parseNameStatus, parseRemovedLines, resolveNumstatPath } from './git.ts'
import { measureOutcomes, revertsOf } from './outcomes.ts'
import type { Measured } from './outcomes.ts'

const BASE = Date.UTC(2026, 0, 1) / 1000
const DAY = 86_400

let repo: string
let measured: Measured
const shas: Record<string, string> = {}

function git(args: string[], day: number): string {
  const stamp = `${BASE + day * DAY} +0000`
  const run = spawnSync('git', args, {
    cwd: repo,
    encoding: 'utf8',
    env: { ...process.env, GIT_AUTHOR_DATE: stamp, GIT_COMMITTER_DATE: stamp, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' },
  })
  if (run.status !== 0) throw new Error(`git ${args.join(' ')}: ${run.stderr}`)
  return run.stdout.trim()
}

function commit(name: string, day: number, message: string): void {
  git(['add', '-A'], day)
  git(['commit', '-q', '-m', message], day)
  shas[name] = git(['rev-parse', 'HEAD'], day)
}

const lines = (prefix: string, count: number): string => `${Array.from({ length: count }, (_, i) => `${prefix}${i + 1}`).join('\n')}\n`

beforeAll(async () => {
  repo = mkdtempSync(join(tmpdir(), 'elia-trials-'))
  git(['init', '-q', '-b', 'main'], 0)
  // A adds ten lines; B (a refactor) rewrites the first five; C (a fix) rewrites the sixth.
  writeFileSync(join(repo, 'a.txt'), lines('L', 10))
  commit('A', 0, 'feat: a\n\nCo-Authored-By: Claude <noreply@anthropic.com>')
  writeFileSync(join(repo, 'a.txt'), `${lines('N', 5)}${lines('L', 10).split('\n').slice(5).join('\n')}`)
  commit('B', 1, 'refactor: tidy a')
  writeFileSync(join(repo, 'a.txt'), (await Bun.file(join(repo, 'a.txt')).text()).replace('L6', 'FIXED6'))
  commit('C', 2, 'fix: repair line six')
  // D adds a file that E reverts.
  writeFileSync(join(repo, 'b.txt'), lines('B', 4))
  commit('D', 3, 'feat: b\n\nCo-Authored-By: Claude <noreply@anthropic.com>')
  git(['revert', '--no-edit', shas.D!], 4)
  shas.E = git(['rev-parse', 'HEAD'], 4)
  // G lives on a branch from day 5 and only reaches main on day 20.
  git(['checkout', '-q', '-b', 'feature'], 5)
  writeFileSync(join(repo, 'g.txt'), lines('G', 3))
  commit('G', 5, 'feat: g')
  git(['checkout', '-q', 'main'], 6)
  writeFileSync(join(repo, 'r.txt'), lines('R', 6))
  commit('R1', 6, 'feat: r')
  mkdirSync(join(repo, 'sub'))
  renameSync(join(repo, 'r.txt'), join(repo, 'sub', 'r2.txt'))
  commit('R2', 8, 'refactor: move r')
  writeFileSync(join(repo, 'h.txt'), lines('H', 2))
  commit('H', 10, 'feat: h')
  git(['merge', '--no-ff', '-q', 'feature', '-m', 'merge feature'], 20)
  writeFileSync(join(repo, 'README.md'), 'late\n')
  commit('F', 40, 'docs: late')
  measured = await measureOutcomes(gitIn(repo), await loadHistory(gitIn(repo), 'main'), { horizonDays: 14, jobs: 4 })
})

afterAll(() => rmSync(repo, { recursive: true, force: true }))

const outcome = (name: string) => {
  const found = measured.outcomes.find((o) => o.sha === shas[name])
  if (!found) throw new Error(`no outcome for ${name}`)
  return found
}

test('line survival counts what git blame still attributes to the commit at the horizon', () => {
  const a = outcome('A')
  expect(a.added).toBe(10)
  expect(a.lineSurvival).toBeCloseTo(0.4, 9) // B rewrote five, C rewrote one
  expect(a.died).toBe(6)
})

test('a fix is implicated only for the lines it removed, and a refactor is not a fix', () => {
  expect(outcome('A').fixKilled).toBe(1)
  expect(outcome('A').fixedAfter).toBe(true)
  expect(outcome('B').fixedAfter).toBe(false)
  expect(outcome('B').lineSurvival).toBe(1)
})

test('a reverted commit is dead, reverted, and blamed on its revert', () => {
  const d = outcome('D')
  expect(d.lineSurvival).toBe(0)
  expect(d.reverted).toBe(true)
  expect(d.fixKilled).toBe(4)
})

test('a commit is timed from when it reached the mainline, not from when it was written', () => {
  // G was written on day 5 and merged on day 20; measured from day 5 its file would not exist at the snapshot.
  const g = outcome('G')
  expect(g.landedAt).toBe(BASE + 20 * DAY)
  expect(g.lineSurvival).toBe(1)
})

test('lines survive a rename of their file', () => {
  expect(outcome('R1').lineSurvival).toBe(1)
  expect(outcome('R2').added).toBe(0)
  expect(outcome('R2').lineSurvival).toBeUndefined()
})

test('a commit too recent for the full horizon is set aside, not scored', () => {
  expect(measured.outcomes.some((o) => o.sha === shas.F)).toBe(false)
  expect(measured.censored).toBeGreaterThanOrEqual(1)
})

test('history: chain, integration and reverts', async () => {
  const history = await loadHistory(gitIn(repo), 'main')
  expect(history.integratedBy.get(shas.G!)).toBe(git(['rev-parse', 'main~1'], 40))
  expect(history.integratedBy.get(shas.A!)).toBe(shas.A!)
  expect(revertsOf(history.commits.values()).get(shas.D!)).toBe(BASE + 4 * DAY)
})

test('parsers', () => {
  expect(resolveNumstatPath('src/{old => new}/file.ts')).toBe('src/new/file.ts')
  expect(resolveNumstatPath('{ => sub}/r.txt')).toBe('sub/r.txt')
  expect(resolveNumstatPath('a.txt => b.txt')).toBe('b.txt')
  expect(resolveNumstatPath('plain.txt')).toBe('plain.txt')
  const fate = parseNameStatus('R100\0old.ts\0new.ts\0D\0gone.ts\0M\0kept.ts\0')
  expect(fate.renamed.get('old.ts')).toBe('new.ts')
  expect([...fate.deleted]).toEqual(['gone.ts'])
  const sha = 'a'.repeat(40)
  expect(countBlame(`${sha} 1 1 2\nauthor x\n\tline\n${sha} 2 2\n\tline\n${'b'.repeat(40)} 3 3 1\n\tx\n`)).toEqual(new Map([[sha, 2], ['b'.repeat(40), 1]]))
  const removed = parseRemovedLines('--- a/x.ts\n+++ b/x.ts\n@@ -3,2 +3,4 @@\n@@ -10 +12 @@\n@@ -20,0 +23,3 @@\n--- /dev/null\n+++ b/new.ts\n@@ -0,0 +1,5 @@\n')
  expect(removed).toEqual([{ path: 'x.ts', ranges: [[3, 2], [10, 1]] }])
  const [first] = parseLog('\x1eabc\x1f\x1f100\x1fsubject\n\nbody\x1f\n\n3\t1\tsrc/a.ts\n-\t-\timg.png\n')
  expect(first?.subject).toBe('subject')
  expect(first?.changes).toEqual([
    { path: 'src/a.ts', added: 3, deleted: 1, binary: false },
    { path: 'img.png', added: 0, deleted: 0, binary: true },
  ])
})
