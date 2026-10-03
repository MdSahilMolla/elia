import { expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.ANTHROPIC_API_KEY ??= 'test-key-for-sandbox-test'

const { LiveTreeConflict, changedFiles, createSandbox, isImmutablePath, promote, promoteToBranch, rollback, violatedImmutables } = await import('./sandbox.ts')
const { runGit } = await import('../autonomy/worktree.ts')

function write(path: string, content: string): void {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, content)
}

test('promotion and rollback restore edits, deletions, and newly introduced files', () => {
  const temp = mkdtempSync(join(tmpdir(), 'elia-sandbox-'))
  const live = join(temp, 'live')
  const candidate = join(temp, 'candidate')
  const backupDir = join(temp, 'backup')

  try {
    write(join(live, 'src/existing.ts'), 'old')
    write(join(live, 'src/deleted.ts'), 'restore me')
    write(join(live, 'package.json'), '{}')
    write(join(live, 'tsconfig.json'), '{}')
    write(join(candidate, 'src/existing.ts'), 'new')
    write(join(candidate, 'src/added.ts'), 'added')
    write(join(candidate, 'package.json'), '{}')
    write(join(candidate, 'tsconfig.json'), '{}')

    const sandbox = { generation: 1, root: candidate, backupDir }
    const changed = changedFiles(sandbox, live)
    expect(changed).toEqual(['src/added.ts', 'src/deleted.ts', 'src/existing.ts'])

    promote(sandbox, changed, live)
    expect(readFileSync(join(live, 'src/existing.ts'), 'utf8')).toBe('new')
    expect(existsSync(join(live, 'src/deleted.ts'))).toBe(false)
    expect(readFileSync(join(live, 'src/added.ts'), 'utf8')).toBe('added')

    rollback(sandbox, changed, live)
    expect(readFileSync(join(live, 'src/existing.ts'), 'utf8')).toBe('old')
    expect(readFileSync(join(live, 'src/deleted.ts'), 'utf8')).toBe('restore me')
    expect(existsSync(join(live, 'src/added.ts'))).toBe(false)
  } finally {
    rmSync(temp, { recursive: true, force: true })
  }
})

test('a builder edit to the gate\'s own config, preload or task list is seen by changedFiles and refused as immutable', () => {
  const temp = mkdtempSync(join(tmpdir(), 'elia-sandbox-'))
  const live = join(temp, 'live')
  const candidate = join(temp, 'candidate')
  try {
    for (const root of [live, candidate]) {
      write(join(root, 'src/a.ts'), 'a')
      write(join(root, 'package.json'), '{}')
      write(join(root, 'tsconfig.json'), '{}')
      write(join(root, 'bunfig.toml'), 'root = "src"')
      write(join(root, 'scripts/testPreload.ts'), 'export {}')
      write(join(root, 'values/value-core.md'), 'core')
      write(join(root, 'src/evolve/history/tasks.json'), '[]')
    }
    const sandbox = { generation: 1, root: candidate, backupDir: join(temp, 'backup') }
    expect(changedFiles(sandbox, live)).toEqual([])

    write(join(candidate, 'bunfig.toml'), 'root = "empty"')
    write(join(candidate, 'scripts/testPreload.ts'), 'process.exit(0)')
    write(join(candidate, 'values/value-core.md'), 'changed')
    write(join(candidate, 'src/evolve/history/tasks.json'), '[1]')
    const changed = changedFiles(sandbox, live)
    expect(changed).toEqual(['bunfig.toml', 'scripts/testPreload.ts', 'src/evolve/history/tasks.json', 'values/value-core.md'])
    expect(violatedImmutables(changed)).toEqual(changed)
  } finally {
    rmSync(temp, { recursive: true, force: true })
  }
})

test('gate configuration and tests are detected and immutable', () => {
  expect(violatedImmutables(['package.json', 'tsconfig.json', 'src/example.test.ts', 'src/agent.ts'])).toEqual([
    'package.json',
    'tsconfig.json',
    'src/example.test.ts',
  ])
})

test('the value core and the gap scoreboard are immutable to a candidate', () => {
  expect(violatedImmutables(['values/value-core.md', 'src/values/core.ts', 'src/gap/corpus.ts', 'src/agent.ts'])).toEqual([
    'values/value-core.md',
    'src/values/core.ts',
    'src/gap/corpus.ts',
  ])
})

test('the deterministic safety boundary is immutable to a candidate', () => {
  expect(violatedImmutables([
    'src/autonomy/governor.ts',
    'src/autonomy/actionContract.ts',
    'src/autonomy/context.ts',
    'src/autonomy/policy.ts',
    'src/autonomy/sensitivePaths.ts',
    'src/securePersistence.ts',
    'src/ui/redact.ts',
    'src/tools/browser.ts',
    'src/tools/communication.ts',
    'src/tools/codex.ts',
    'src/tools/deployment.ts',
    'src/tools/github.ts',
    'src/tools/runCommand.ts',
    'src/agent.ts',
  ])).toEqual([
    'src/autonomy/governor.ts',
    'src/autonomy/actionContract.ts',
    'src/autonomy/context.ts',
    'src/autonomy/policy.ts',
    'src/autonomy/sensitivePaths.ts',
    'src/securePersistence.ts',
    'src/ui/redact.ts',
    'src/tools/browser.ts',
    'src/tools/communication.ts',
    'src/tools/codex.ts',
    'src/tools/deployment.ts',
    'src/tools/github.ts',
    'src/tools/runCommand.ts',
  ])
})

test('root gate configuration changes are included in candidate change detection', () => {
  const temp = mkdtempSync(join(tmpdir(), 'elia-config-'))
  const live = join(temp, 'live')
  const candidate = join(temp, 'candidate')

  try {
    write(join(live, 'package.json'), '{"version":1}')
    write(join(live, 'tsconfig.json'), '{}')
    write(join(candidate, 'package.json'), '{"version":2}')
    write(join(candidate, 'tsconfig.json'), '{}')
    expect(changedFiles({ generation: 1, root: candidate, backupDir: join(temp, 'backup') }, live)).toEqual([
      'package.json',
    ])
  } finally {
    rmSync(temp, { recursive: true, force: true })
  }
})

test('the proposer’s view of its own behaviour cannot be edited by a candidate', () => {
  // Nothing in the promotion gate reads the field evidence, so a candidate that
  // made a real benchmark gain *and* quietly narrowed the evidence would pass
  // every check and leave the next generation unable to see the damage.
  expect(violatedImmutables(['src/evolve/fieldEvidence.ts', 'src/agent.ts'])).toEqual(['src/evolve/fieldEvidence.ts'])
})

test('the files that decide a verdict are off limits to the candidate that the verdict is about', () => {
  // sieve.ts chooses which tasks run and when to stop; reach.ts and its recorder
  // supply the evidence for "this task cannot be affected"; baselineCache.ts
  // supplies the side being compared against. A candidate able to edit any of
  // them could be promoted for a change that nothing ever ran.
  for (const file of ['src/evolve/sieve.ts', 'src/evolve/reach.ts', 'src/evolve/reachRecorder.ts', 'src/evolve/baselineCache.ts']) {
    expect(isImmutablePath(file)).toBe(true)
  }
})

test('a candidate cannot rewrite what its own history tasks ask for, or which tasks exist', () => {
  // The benchmark spawns the candidate's benchTask.ts, which reads the prompt
  // and the task list from the candidate's copy of these files.
  for (const file of ['src/evolve/history/suite.ts', 'src/evolve/history/tasks.json', 'src/evolve/history/harvest.ts', 'src/evolve/history/materialize.ts']) {
    expect(isImmutablePath(file)).toBe(true)
  }
  expect(violatedImmutables(['src/evolve/history/suite.ts', 'src/agent.ts'])).toEqual(['src/evolve/history/suite.ts'])
})

test('the sealed gate, the certified library, the resource governor and the maths they share stay out of reach', () => {
  // These once sat together under one immutable glob. Spread across elia's own
  // folders, each is named — and a new one missing from the list fails here.
  const governed = [
    'src/evolve/acceptance.ts', 'src/evolve/isolation.ts', 'src/evolve/archive.ts',
    'src/autonomy/certifiedLibrary.ts', 'src/autonomy/lessonCertificates.ts',
    'src/compounding/theory.ts', 'src/compounding/stats.ts', 'src/compounding/frontier.ts', 'src/compounding/growth.ts',
    'src/compounding/resourceGovernor.ts', 'src/compounding/round.ts', 'src/compounding/runners.ts', 'src/compounding/sim.ts', 'src/compounding/predictions.ts',
    'src/skills/audit.ts', 'src/skills/closure.ts', 'src/skills/toolLog.ts', 'src/reason/probe.ts',
  ]
  expect(governed.filter((file) => !isImmutablePath(file))).toEqual([])
  // Their neighbours are still ordinary implementation a candidate may improve.
  for (const file of ['src/compounding/status.ts', 'src/skills/synthesize.ts', 'src/autonomy/lessons.ts', 'src/reason/reason.ts']) {
    expect(isImmutablePath(file)).toBe(false)
  }
})

test("edits made to the live tree while a generation runs are not the candidate's, and are never overwritten", () => {
  const temp = mkdtempSync(join(tmpdir(), 'elia-sandbox-race-'))
  const live = join(temp, 'live')
  try {
    write(join(live, 'src/agent.ts'), 'v1')
    write(join(live, 'src/planner.ts'), 'plan v1')
    write(join(live, 'package.json'), '{}')
    write(join(live, 'tsconfig.json'), '{}')
    const sandbox = createSandbox(1, live, join(temp, 'evolution'))

    // The candidate changes the planner. Meanwhile someone edits agent.ts and
    // adds a file of their own in the live tree.
    write(join(sandbox.root, 'src/planner.ts'), 'plan v2')
    write(join(live, 'src/agent.ts'), 'v1 + my edit')
    write(join(live, 'src/mine.ts'), 'new work')

    const changed = changedFiles(sandbox, live)
    expect(changed).toEqual(['src/planner.ts'])
    promote(sandbox, changed, live)
    expect(readFileSync(join(live, 'src/agent.ts'), 'utf8')).toBe('v1 + my edit')
    expect(readFileSync(join(live, 'src/mine.ts'), 'utf8')).toBe('new work')
    expect(readFileSync(join(live, 'src/planner.ts'), 'utf8')).toBe('plan v2')

    // Both sides changed the same file: refuse rather than pick a winner.
    write(join(sandbox.root, 'src/agent.ts'), 'candidate edit')
    expect(() => promote(sandbox, changedFiles(sandbox, live), live)).toThrow(LiveTreeConflict)
    expect(readFileSync(join(live, 'src/agent.ts'), 'utf8')).toBe('v1 + my edit')
  } finally {
    rmSync(temp, { recursive: true, force: true })
  }
})

test('sandbox pruning is generation-scoped and never removes a sibling in-flight copy', () => {
  const temp = mkdtempSync(join(tmpdir(), 'elia-sandbox-generationscope-'))
  const live = join(temp, 'live')
  const evolution = join(temp, 'evolution')
  try {
    // gen-1..8 exist. gen-8 is a sibling that is still being *measured*, so its
    // copy was touched long ago and has the oldest mtime of the set — exactly
    // the shape that made the old mtime-based prune delete it.
    for (let generation = 1; generation <= 8; generation++) {
      const dir = join(evolution, `gen-${generation}`)
      mkdirSync(join(dir, 'src'), { recursive: true })
      const at = new Date(Date.now() - generation * 60_000)
      utimesSync(dir, at, at)
    }
    write(join(live, 'package.json'), '{}')
    write(join(live, 'tsconfig.json'), '{}')

    const sandbox = createSandbox(9, live, evolution) // O(1) -> gen-9 + keep 4 of <9

    // The four newest claimed copies survive even though their mtimes are the
    // oldest (gen-8 least-recently touched); only gen-1..4 are pruned.
    for (const kept of [5, 6, 7, 8]) expect(existsSync(join(evolution, `gen-${kept}`))).toBe(true)
    expect(existsSync(sandbox.root)).toBe(true)
    for (const pruned of [1, 2, 3, 4]) expect(existsSync(join(evolution, `gen-${pruned}`))).toBe(false)
  } finally {
    rmSync(temp, { recursive: true, force: true })
  }
})

test('an unattended promotion lands on its own branch and leaves the checkout untouched', async () => {
  const temp = mkdtempSync(join(tmpdir(), 'elia-sandbox-branch-'))
  const live = join(temp, 'live')
  const git = (...args: string[]) => runGit(['-C', live, '-c', 'user.email=t@t', '-c', 'user.name=t', '-c', 'core.autocrlf=false', ...args])
  try {
    write(join(live, 'src/planner.ts'), 'plan v1\n')
    write(join(live, 'src/old.ts'), 'remove me\n')
    write(join(live, 'package.json'), '{}\n')
    write(join(live, 'tsconfig.json'), '{}\n')
    await runGit(['init', '-q', '-b', 'main', live])
    await git('config', 'user.email', 't@t')
    await git('config', 'user.name', 't')
    await git('add', '-A')
    await git('commit', '-qm', 'base')
    const sandbox = createSandbox(2, live, join(temp, 'evolution'))
    write(join(sandbox.root, 'src/planner.ts'), 'plan v2\n')
    rmSync(join(sandbox.root, 'src/old.ts'))

    const changed = changedFiles(sandbox, live)
    await promoteToBranch(sandbox, changed, 'evolve/gen-2', 'evolve: better planner', live)

    // The working tree, the index and the current branch did not move.
    expect(readFileSync(join(live, 'src/planner.ts'), 'utf8')).toBe('plan v1\n')
    expect(existsSync(join(live, 'src/old.ts'))).toBe(true)
    expect((await git('status', '--porcelain')).stdout.trim()).toBe('')
    expect((await git('branch', '--show-current')).stdout.trim()).toBe('main')
    // The branch holds exactly the candidate's change.
    expect((await git('show', 'evolve/gen-2:src/planner.ts')).stdout).toBe('plan v2\n')
    expect((await git('diff', '--name-status', 'main', 'evolve/gen-2')).stdout.trim().split('\n').sort()).toEqual(['D\tsrc/old.ts', 'M\tsrc/planner.ts'])
  } finally {
    rmSync(temp, { recursive: true, force: true })
  }
})

test('an unattended promotion refuses a file with uncommitted local edits rather than smuggle them onto the branch', async () => {
  const temp = mkdtempSync(join(tmpdir(), 'elia-sandbox-dirty-'))
  const live = join(temp, 'live')
  const git = (...args: string[]) => runGit(['-C', live, '-c', 'core.autocrlf=false', ...args])
  try {
    write(join(live, 'src/planner.ts'), 'plan v1\n')
    write(join(live, 'package.json'), '{}\n')
    write(join(live, 'tsconfig.json'), '{}\n')
    await runGit(['init', '-q', '-b', 'main', live])
    await git('config', 'user.email', 't@t')
    await git('config', 'user.name', 't')
    await git('add', '-A')
    await git('commit', '-qm', 'base')
    // Uncommitted before the run started, so it is in the candidate's base too.
    write(join(live, 'src/planner.ts'), 'plan v1 + local edit\n')
    const sandbox = createSandbox(3, live, join(temp, 'evolution'))
    write(join(sandbox.root, 'src/planner.ts'), 'plan v1 + local edit + candidate\n')

    await expect(promoteToBranch(sandbox, changedFiles(sandbox, live), 'evolve/gen-3', 'x', live)).rejects.toThrow(LiveTreeConflict)
    expect((await git('branch', '--list', 'evolve/*')).stdout.trim()).toBe('')
  } finally {
    rmSync(temp, { recursive: true, force: true })
  }
})
