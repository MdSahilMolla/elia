import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { land, landingEnabled } from './landing.ts'

let root: string
const git = (...args: string[]) => {
  const r = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8' })
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`)
  return (r.stdout ?? '').trim()
}
/** A commit on top of HEAD that changes `file`, held on a side ref the way promoteToBranch holds it. */
function candidate(file: string, body: string): string {
  const head = git('rev-parse', 'HEAD')
  const blob = spawnSync('git', ['-C', root, 'hash-object', '-w', '--stdin'], { input: body, encoding: 'utf8' }).stdout.trim()
  const index = join(root, '.git', 'tmp-index')
  const env = { ...process.env, GIT_INDEX_FILE: index }
  spawnSync('git', ['-C', root, 'read-tree', head], { env })
  spawnSync('git', ['-C', root, 'update-index', '--add', '--cacheinfo', `100644,${blob},${file}`], { env })
  const tree = spawnSync('git', ['-C', root, 'write-tree'], { env, encoding: 'utf8' }).stdout.trim()
  const commit = git('commit-tree', tree, '-p', head, '-m', 'evolve(gen 1): a change')
  git('update-ref', 'refs/heads/evolve/gen-1', commit)
  return commit
}
const BOXED = { boxed: 3, cutShort: 0 }

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'landing-'))
  git('init', '-q', '-b', 'main')
  git('config', 'user.email', 't@example.com')
  git('config', 'user.name', 't')
  writeFileSync(join(root, 'a.ts'), 'old\n')
  writeFileSync(join(root, 'b.ts'), 'other\n')
  git('add', '.')
  git('commit', '-q', '-m', 'base')
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

test('the switch is off unless asked for', () => {
  expect(landingEnabled({})).toBe(false)
  expect(landingEnabled({ ELIA_COMPOUND_LAND: 'on' })).toBe(true)
  expect(landingEnabled({ ELIA_COMPOUND_LAND: 'nope' })).toBe(false)
})

test('a change proven in the box, on an untouched checkout, is fast-forwarded in', async () => {
  const previous = git('rev-parse', 'HEAD')
  const commit = candidate('a.ts', 'new\n')
  const result = await land({ liveRoot: root, commit, attestation: BOXED, verify: async () => true })
  expect(result).toEqual({ landed: true, previousHead: previous })
  expect(git('rev-parse', 'HEAD')).toBe(commit)
})

test('a change proven on the bare host is not landed', async () => {
  const commit = candidate('a.ts', 'new\n')
  const before = git('rev-parse', 'HEAD')
  for (const attestation of [undefined, { boxed: 0, cutShort: 0 }]) {
    const result = await land({ liveRoot: root, commit, attestation, verify: async () => true })
    expect(result.landed).toBe(false)
    expect(!result.landed && result.reason).toContain('not in elia-box')
  }
  const cut = await land({ liveRoot: root, commit, attestation: { boxed: 3, cutShort: 1 }, verify: async () => true })
  expect(!cut.landed && cut.reason).toContain('cut short')
  expect(git('rev-parse', 'HEAD')).toBe(before)
})

test('it does not land onto a checkout that has moved on since the candidate was cut', async () => {
  const commit = candidate('a.ts', 'new\n')
  writeFileSync(join(root, 'b.ts'), 'someone else\n')
  git('commit', '-q', '-am', 'someone else got there first')
  const result = await land({ liveRoot: root, commit, attestation: BOXED, verify: async () => true })
  expect(!result.landed && result.reason).toContain('moved on')
})

test('uncommitted work on the same files stops it, uncommitted work elsewhere does not', async () => {
  const commit = candidate('a.ts', 'new\n')
  writeFileSync(join(root, 'a.ts'), 'my local edit\n')
  const blocked = await land({ liveRoot: root, commit, attestation: BOXED, verify: async () => true })
  expect(!blocked.landed && blocked.reason).toContain('uncommitted work touches')
  git('checkout', '--', 'a.ts')
  writeFileSync(join(root, 'b.ts'), 'my local edit elsewhere\n')
  const fine = await land({ liveRoot: root, commit, attestation: BOXED, verify: async () => true })
  expect(fine.landed).toBe(true)
})

test('a landing that breaks the tree is reverted with a new commit, and local work survives', async () => {
  const previous = git('rev-parse', 'HEAD')
  const commit = candidate('a.ts', 'new\n')
  writeFileSync(join(root, 'b.ts'), 'uncommitted elsewhere\n')
  const result = await land({ liveRoot: root, commit, attestation: BOXED, verify: async () => false })
  expect(result).toMatchObject({ landed: false, reverted: true })
  expect(git('show', 'HEAD:a.ts')).toBe('old')
  // History records that it happened; the previous tip is still an ancestor, and nothing was reset.
  expect(git('merge-base', '--is-ancestor', previous, 'HEAD') || 'ok').toBe('ok')
  expect(git('log', '--format=%s', '-3')).toContain('Revert')
  expect(git('status', '--porcelain')).toContain('b.ts')
})

test('a commit that changes nothing, or that does not exist, is refused rather than crashing', async () => {
  const none = await land({ liveRoot: root, commit: 'deadbeef', attestation: BOXED, verify: async () => true })
  expect(none.landed).toBe(false)
})
