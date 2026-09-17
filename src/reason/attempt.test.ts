import { afterEach, beforeEach, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.ANTHROPIC_API_KEY ??= 'test-key-for-reason-attempt-test'

const { attemptBriefing, isolatedSearch } = await import('./attempt.ts')
const { solve } = await import('./select.ts')
const { probeVerifier } = await import('./verify.ts')
const { runGit } = await import('../autonomy/worktree.ts')
import type { Approach } from './select.ts'

let repo: string
beforeEach(async () => {
  repo = mkdtempSync(join(tmpdir(), 'elia-reason-attempt-'))
  writeFileSync(join(repo, 'answer.txt'), 'original\n')
  await runGit(['init', '-q', '-b', 'main'], repo)
  await runGit(['config', 'user.email', 'test@example.com'], repo)
  await runGit(['config', 'user.name', 'elia test'], repo)
  await runGit(['add', '-A'], repo)
  await runGit(['commit', '-q', '-m', 'seed'], repo)
})
afterEach(() => rmSync(repo, { recursive: true, force: true }))

const APPROACHES: Approach[] = [
  { id: 'first', instruction: 'try the first way' },
  { id: 'second', instruction: 'try the second way' },
  { id: 'third', instruction: 'try the third way' },
]

/** Passes only when the attempt's own checkout holds the right answer. */
const answerIs = (want: string) =>
  probeVerifier({
    id: 'answer',
    async probe(candidate) {
      const got = candidate.cwd ? readFileSync(join(candidate.cwd, 'answer.txt'), 'utf8').trim() : ''
      return { passed: got === want, detail: `answer.txt says ${got || '(nothing)'}`, progress: got === want ? 1 : 0 }
    },
  })

test('each attempt edits its own checkout, and the user tree is untouched until the winner is merged', async () => {
  const search = isolatedSearch({
    runId: 'test-isolation',
    sourceRoot: repo,
    async run({ cwd, approach }) {
      writeFileSync(join(cwd, 'answer.txt'), `${approach.id}\n`)
      return { text: approach.id, cost: 1 }
    },
  })

  const result = await solve({
    approaches: APPROACHES,
    produce: search.produce,
    verifier: answerIs('third'),
    budget: { attempts: 3 },
    width: 3,
  })

  expect(result.verified).toBe(true)
  expect(result.best?.approach).toBe('third')
  // Nothing has reached the real tree yet: three attempts wrote three different
  // answers and the user's file still says what it said before.
  expect(readFileSync(join(repo, 'answer.txt'), 'utf8').trim()).toBe('original')

  const merged = await search.settle(result.best)
  expect(merged).toContain('answer.txt')
  expect(readFileSync(join(repo, 'answer.txt'), 'utf8').trim()).toBe('third')
})

test('losing attempts never reach the user tree, and their worktrees are removed', async () => {
  const search = isolatedSearch({
    runId: 'test-losers',
    sourceRoot: repo,
    async run({ cwd, approach }) {
      writeFileSync(join(cwd, 'answer.txt'), `${approach.id}\n`)
      writeFileSync(join(cwd, `${approach.id}-scratch.txt`), 'debris\n')
      return { text: approach.id, cost: 1 }
    },
  })

  const result = await solve({
    approaches: APPROACHES,
    produce: search.produce,
    verifier: answerIs('first'),
    budget: { attempts: 3 },
    width: 3,
  })
  const held = search.held()
  expect(held.length).toBe(3)

  await search.settle(result.best)

  expect(readFileSync(join(repo, 'answer.txt'), 'utf8').trim()).toBe('first')
  // The winner's scratch file came along; the losers' did not.
  expect(existsSync(join(repo, 'first-scratch.txt'))).toBe(true)
  expect(existsSync(join(repo, 'second-scratch.txt'))).toBe(false)
  expect(existsSync(join(repo, 'third-scratch.txt'))).toBe(false)
  for (const worktree of held) expect(existsSync(worktree.path)).toBe(false)
})

test('a search that found nothing still leaves the tree clean', async () => {
  const search = isolatedSearch({
    runId: 'test-nothing',
    sourceRoot: repo,
    async run({ cwd, approach }) {
      writeFileSync(join(cwd, 'answer.txt'), 'wrong\n')
      return { text: approach.id, cost: 1 }
    },
  })

  const result = await solve({ approaches: APPROACHES, produce: search.produce, verifier: answerIs('unreachable'), budget: { attempts: 2 }, width: 2 })
  expect(result.verified).toBe(false)

  const held = search.held()
  const merged = await search.settle(undefined)

  expect(merged).toEqual([])
  expect(readFileSync(join(repo, 'answer.txt'), 'utf8').trim()).toBe('original')
  for (const worktree of held) expect(existsSync(worktree.path)).toBe(false)
})

test('the winner`s changed files are discoverable before the merge overwrites them', async () => {
  // Without this the turn records filesChanged: 0 for a searched turn — the
  // merge writes straight into the tree, so nothing else in the turn sees it.
  const search = isolatedSearch({
    runId: 'test-changed-by',
    sourceRoot: repo,
    async run({ cwd, approach }) {
      writeFileSync(join(cwd, 'answer.txt'), `${approach.id}\n`)
      writeFileSync(join(cwd, 'extra.txt'), 'new file\n')
      return { text: approach.id, cost: 1 }
    },
  })
  const result = await solve({ approaches: APPROACHES.slice(0, 1), produce: search.produce, verifier: answerIs('first'), budget: { attempts: 1 }, width: 1 })

  const changed = await search.changedBy(result.best!)
  expect(changed.sort()).toEqual(['answer.txt', 'extra.txt'])

  await search.settle(result.best)
  expect(existsSync(join(repo, 'extra.txt'))).toBe(true)
})

test('asking what an unknown candidate changed is empty, not a throw', async () => {
  const search = isolatedSearch({ runId: 'test-unknown', sourceRoot: repo, async run() { return { text: 'x' } } })
  expect(await search.changedBy({ id: 'never-produced', approach: 'a', text: '' })).toEqual([])
})

test('settling twice is harmless', async () => {
  const search = isolatedSearch({
    runId: 'test-twice',
    sourceRoot: repo,
    async run({ cwd }) {
      writeFileSync(join(cwd, 'answer.txt'), 'done\n')
      return { text: 'done' }
    },
  })
  const result = await solve({ approaches: APPROACHES.slice(0, 1), produce: search.produce, verifier: answerIs('done'), budget: { attempts: 1 }, width: 1 })

  expect(await search.settle(result.best)).toContain('answer.txt')
  expect(await search.settle(result.best)).toEqual([])
})

test('the briefing leads with the approach and carries the earlier failures behind it', () => {
  const bare = attemptBriefing(APPROACHES[0]!, [])
  expect(bare).toBe('try the first way')

  const withHistory = attemptBriefing(APPROACHES[1]!, [
    {
      round: 0,
      candidate: { id: 'c', approach: 'first', text: '' },
      verdict: { passed: false, strength: 'executed', detail: 'tests exited 1', evidence: 'expected 2, got 3', elapsedMs: 1 },
    },
  ])
  expect(withHistory.indexOf('try the second way')).toBe(0)
  expect(withHistory).toContain('expected 2, got 3')
})
