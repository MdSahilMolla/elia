import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { World, classifyCommand, createWorld, emptyPriors, failureSummary, pFailFrom, readPriors, renderRuntime, runtimeStatus, MIN_SCORED, type Call, type Priors } from './runtime.ts'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'world-runtime-'))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

const run = (command: string, observation = false): Call => ({ name: 'run_command', input: { command }, observation })
const read = (path: string): Call => ({ name: 'read_file', input: { path }, observation: true })
const edit = (path: string): Call => ({ name: 'edit_file', input: { path, old_string: 'a', new_string: 'b' }, observation: false })
const ok = { isError: false, result: 'fine' }
const fail = (result = 'FAIL src/a.test.ts\nexpected 2, got 3') => ({ isError: true, result })

/** One batch of one call, the way most turns go. */
function turn(world: World, call: Call, outcome: { isError: boolean; result: string }): string | undefined {
  world.beforeBatch([call])
  return world.afterBatch([call], [outcome])
}

test('commands are classified by what they are for, and a compound takes the strongest kind', () => {
  const cases: Array<[string, string]> = [
    ['bun test', 'test'], ['bun test src/a.test.ts', 'test'], ['npm run test', 'test'], ['pytest -x', 'test'], ['cargo test --lib', 'test'], ['go test ./...', 'test'],
    ['bun run typecheck', 'typecheck'], ['tsc --noEmit', 'typecheck'], ['mypy src', 'typecheck'],
    ['bun run build', 'build'], ['cargo build --release', 'build'], ['tsc -b', 'build'], ['make', 'build'], ['make test', 'test'], ['make deploy', 'other'],
    ['oxlint src/', 'lint'], ['bun run lint', 'lint'], ['ruff check .', 'lint'],
    ['bun install', 'install'], ['pip install requests', 'install'],
    ['git status', 'git-read'], ['git diff HEAD', 'git-read'], ['git commit -m x', 'git-write'], ['git push', 'git-write'],
    ['ls -la', 'other'], ['echo hi', 'other'],
    ['bun run typecheck && bun test', 'test'],
  ]
  for (const [command, kind] of cases) expect([command, classifyCommand(command)]).toEqual([command, kind])
})

test('before it has history it predicts from defaults, and a project with a record predicts from that', () => {
  const world = new World()
  expect(world.predict(run('bun test')).basis).toBe('default')
  expect(world.predict(run('bun test')).pFail).toBe(0.5)
  expect(world.predict(read('a.ts')).pFail).toBe(0.08)

  const priors: Priors = { ...emptyPriors(), keys: { 'run_command:test': { ok: 1, fail: 19 }, read_file: { ok: 100, fail: 0 } } }
  const known = new World({ priors })
  const test_ = known.predict(run('bun test'))
  expect(test_.basis).toBe('history')
  // 19 failures of 20 outweighs a default of 0.5: (19 + 0.5*4) / (20 + 4).
  expect(test_.pFail).toBeCloseTo(21 / 24, 9)
  expect(known.predict(read('a.ts')).pFail).toBeLessThan(0.03)
})

test('editing a file that has not been looked at is predicted riskier than one that has', () => {
  const world = new World({ cwd: '/repo' })
  expect(world.predict(edit('src/a.ts')).basis).toBe('file')
  expect(world.predict(edit('src/a.ts')).pFail).toBeGreaterThanOrEqual(0.4)
  turn(world, read('src/a.ts'), ok)
  expect(world.predict(edit('src/a.ts')).basis).toBe('default')
  expect(world.predict(edit('src/a.ts')).pFail).toBe(0.2)
})

test('an identical failing check against an unchanged tree is called out, and only then', () => {
  const world = new World()
  expect(turn(world, run('bun test'), fail())).toBeUndefined()
  // Nothing changed; the same command fails the same way.
  const note = turn(world, run('bun test'), fail())
  expect(note).toContain('ran at step 1 with nothing in the tree changed since')
  expect(note).toContain('FAIL src/a.test.ts')
  expect(note).toContain('Change the code')
  // The third time is counted.
  expect(turn(world, run('bun test'), fail())).toContain('identical run 3')
})

test('a repeat is not claimed once anything has changed, or when the check passes', () => {
  const world = new World({ cwd: '/repo' })
  turn(world, run('bun test'), fail())
  turn(world, read('src/a.ts'), ok)
  turn(world, edit('src/a.ts'), ok)
  // The edit changed the tree: running the tests again is the right thing to do.
  expect(turn(world, run('bun test'), fail())).toBeUndefined()

  const passing = new World()
  turn(passing, run('bun test'), ok)
  expect(turn(passing, run('bun test'), ok)).toBeUndefined()
  // A pass that then fails on an unchanged tree is a flake, not a loop, and is not scolded either.
  expect(turn(passing, run('bun test'), fail())).toBeUndefined()
})

test('a batch that changes the tree cannot carry a repeat claim: its calls run at once', () => {
  const world = new World({ cwd: '/repo' })
  turn(world, run('bun test'), fail())
  const batch = [edit('src/a.ts'), run('bun test')]
  world.beforeBatch(batch)
  expect(world.afterBatch(batch, [ok, fail()])).toBeUndefined()
})

test('a failed edit does not change the tree, a failed shell command might have', () => {
  const world = new World({ cwd: '/repo' })
  turn(world, edit('src/a.ts'), fail('old_string not found'))
  expect(world.version).toBe(0)
  turn(world, run('make something'), fail('half done'))
  expect(world.version).toBe(1)
  turn(world, read('src/a.ts'), ok)
  expect(world.version).toBe(1)
})

test('reading and looking never change the tree', () => {
  const world = new World()
  for (const call of [read('a.ts'), run('git status', true), run('ls', true)]) turn(world, call, ok)
  expect(world.version).toBe(0)
})

test('every outcome is scored against what was predicted before it, and the sums are what accuracy is read from', () => {
  const world = new World({ priors: { ...emptyPriors(), keys: { read_file: { ok: 200, fail: 0 } } } })
  const p = world.predict(read('a.ts')).pFail
  turn(world, read('a.ts'), fail('ENOENT'))
  expect(world.surprises).toHaveLength(1)
  // Failing an action that was predicted to work is expensive in bits.
  expect(world.surprises[0]!.bits).toBeCloseTo(-Math.log2(p), 6)
  expect(world.surprises[0]!.bits).toBeGreaterThan(5)
})

test('a run of failures the record did not expect is said once, and then left alone for a while', () => {
  const priors: Priors = { ...emptyPriors(), keys: { read_file: { ok: 200, fail: 0 } } }
  const world = new World({ priors })
  const said: number[] = []
  let text = ''
  for (let i = 1; i <= 20; i++) {
    const note = turn(world, read(`missing${i}.ts`), fail('ENOENT'))
    if (note) {
      said.push(i)
      text = note
    }
  }
  // At the third surprise, then not again until the cooldown has passed.
  expect(said[0]).toBe(3)
  expect(said.slice(1).every((step, index) => step - said[index]! >= 8)).toBe(true)
  expect(said.length).toBeLessThanOrEqual(3)
  expect(text).toContain("3 of your last 6 actions failed that this project's record says usually work")
  expect(text).toContain('out of date')
})

test('actions that go as expected say nothing at all', () => {
  const world = new World({ cwd: '/repo' })
  const notes = [turn(world, read('a.ts'), ok), turn(world, edit('a.ts'), ok), turn(world, run('bun test'), ok), turn(world, run('git status', true), ok)]
  expect(notes.filter(Boolean)).toEqual([])
})

test('the snapshot is what the runtime holds: nothing until there is something, then changes and how stale each check is', () => {
  const world = new World({ cwd: '/repo' })
  expect(world.snapshot()).toBeUndefined()
  turn(world, read('/repo/src/a.ts'), ok)
  expect(world.snapshot()).toBeUndefined()
  turn(world, run('bun test'), fail('FAIL src/a.test.ts\nexpected 2, got 3'))
  turn(world, edit('/repo/src/a.ts'), ok)
  turn(world, run('bun run typecheck'), ok)
  const snapshot = world.snapshot()!
  expect(snapshot).toContain('changed this run: src/a.ts')
  expect(snapshot).toContain('test: FAILED at step 2')
  expect(snapshot).toContain('FAIL src/a.test.ts')
  expect(snapshot).toContain('1 change since, so this may no longer hold')
  expect(snapshot).toContain('typecheck: passed at step 4')
  expect(snapshot).toContain('nothing has changed since')
})

test('failure summaries pick the line that says what failed', () => {
  expect(failureSummary('running...\nFAIL src/a.test.ts\nexpected 2, got 3')).toBe('FAIL src/a.test.ts')
  expect(failureSummary('a very long line that says error '.repeat(10)).length).toBeLessThanOrEqual(110)
  expect(failureSummary('')).toBe('')
})

test('what a run learns is added to what is on disk, so concurrent runs do not overwrite each other', () => {
  const path = join(dir, 'runtime.json')
  const first = new World({ savePath: path, priors: readPriors(path) })
  const second = new World({ savePath: path, priors: readPriors(path) })
  turn(first, run('bun test'), fail())
  turn(first, run('bun test'), ok)
  turn(second, run('bun test'), fail())
  first.save()
  second.save()
  const disk = readPriors(path)
  // Fail then pass on the identical command against an unchanged tree is one repeat and one flip.
  expect(disk.keys['run_command:test']).toEqual({ ok: 1, fail: 2, repeats: 1, flips: 1 })
  expect(disk.calibration.n).toBe(3)
  // The next run starts from it.
  expect(pFailFrom('run_command:test', 'run_command', disk)).toBeGreaterThan(0.5)
})

test('counts are halved past the ceiling so a project that changed is learned afresh', () => {
  const path = join(dir, 'runtime.json')
  writeFileSync(path, JSON.stringify({ ...emptyPriors(), keys: { read_file: { ok: 60, fail: 0 } } }))
  const world = new World({ savePath: path, priors: readPriors(path) })
  turn(world, read('a.ts'), ok)
  world.save()
  expect(readPriors(path).keys.read_file).toEqual({ ok: 31, fail: 0 })
})

test('with nowhere to save, or nothing learned, nothing is written; a corrupt record is an empty one', () => {
  new World().save()
  const path = join(dir, 'runtime.json')
  new World({ savePath: path }).save()
  expect(() => readFileSync(path)).toThrow()
  writeFileSync(path, 'not json')
  expect(readPriors(path)).toEqual(emptyPriors())
  writeFileSync(path, JSON.stringify({ version: 2, keys: {} }))
  expect(readPriors(path)).toEqual(emptyPriors())
})

test('accuracy is reported against the best a model with no information could do, and only once there is enough to say', () => {
  expect(runtimeStatus(emptyPriors()).skill).toBeUndefined()
  expect(renderRuntime(runtimeStatus(emptyPriors()))).toContain('no run has been modelled in this project yet')

  const early: Priors = { ...emptyPriors(), calibration: { n: 10, brier: 1, failures: 3, bits: 10 } }
  expect(runtimeStatus(early).skill).toBeUndefined()
  expect(renderRuntime(runtimeStatus(early))).toContain(`needs ${MIN_SCORED} scored predictions, has 10`)

  // 100 predictions, 20 failures: always guessing 0.2 scores 0.16. A model that scored 0.08 is 50% better.
  const informed: Priors = { ...emptyPriors(), keys: { 'run_command:test': { ok: 10, fail: 12 }, read_file: { ok: 70, fail: 1 } }, calibration: { n: 100, brier: 8, failures: 20, bits: 150 } }
  const status = runtimeStatus(informed)
  expect(status.baseline).toBeCloseTo(0.16, 9)
  expect(status.skill).toBeCloseTo(0.5, 9)
  const text = renderRuntime(status)
  expect(text).toContain('50% better')
  expect(text).toContain('test fails 55% of 22')

  // A model no better than the base rate says so instead of flattering itself.
  const useless: Priors = { ...emptyPriors(), calibration: { n: 100, brier: 20, failures: 20, bits: 150 } }
  expect(renderRuntime(runtimeStatus(useless))).toContain('WORSE')
})

test('the model is on by default, off with ELIA_WORLD=off, and stays out of the way of benchmark tasks with ELIA_WORLD_PERSIST=off', () => {
  expect(createWorld(dir, {})).toBeInstanceOf(World)
  expect(createWorld(dir, { ELIA_WORLD: 'off' })).toBeUndefined()
  const local = createWorld(dir, { ELIA_WORLD_PERSIST: 'off' })!
  turn(local, run('bun test'), ok)
  local.save()
})

test('what a command costs here, and whether it answers the same way twice, are measured', () => {
  const world = new World()
  const timed = (call: Call, outcome: { isError: boolean; result: string }, ms: number) => {
    world.beforeBatch([call])
    return world.afterBatch([call], [outcome], [ms])
  }
  timed(run('bun test'), ok, 4_000)
  timed(run('bun test'), ok, 6_000)
  // Same command, same tree, a different answer: a flake.
  timed(run('bun test'), fail(), 5_000)
  timed(run('bun test'), fail(), 5_000)
  const path = join(dir, 'runtime.json')
  const saving = new World({ savePath: path })
  saving.beforeBatch([run('bun test')])
  saving.afterBatch([run('bun test')], [ok], [4_000])
  saving.beforeBatch([run('bun test')])
  saving.afterBatch([run('bun test')], [fail()], [6_000])
  saving.save()
  const test_ = readPriors(path).keys['run_command:test']!
  expect(test_.ms).toBe(10_000)
  expect(test_.repeats).toBe(1)
  expect(test_.flips).toBe(1)
})

test('a cached call costs nothing to measure, and a run with no durations still works', () => {
  const world = new World()
  world.beforeBatch([run('bun test')])
  expect(() => world.afterBatch([run('bun test')], [ok])).not.toThrow()
})
