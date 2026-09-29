import { expect, test } from 'bun:test'

process.env.ANTHROPIC_API_KEY ??= 'test-key-for-metasim-test'

const { compare, makeStream, renderComparison, runPolicy } = await import('./metaSim.ts')

test('the same seed is the same stream, and every policy meets the same luck', () => {
  const a = makeStream('structured', 7, 60)
  const b = makeStream('structured', 7, 60)
  expect(a.stream).toEqual(b.stream)
  expect(makeStream('structured', 8, 60).stream).not.toEqual(a.stream)
  // A comparison run twice is the same comparison.
  const first = compare({ world: 'structured', seeds: 3, tasks: 50, policies: ['library', 'planner'] })
  const second = compare({ world: 'structured', seeds: 3, tasks: 50, policies: ['library', 'planner'] })
  expect(second).toEqual(first)
})

test('a fixed policy is the single harness, and the accounting adds up', () => {
  const { cells, stream } = makeStream('structured', 3, 80)
  const wide = runPolicy('wide', 'structured', cells, stream)
  const tasks = wide.windows.reduce((total, window) => total + window.tasks, 0)
  expect(tasks).toBe(80)
  // Windows are the first 50, the next 100, and the rest: with 80 tasks the last is 30 and the third is empty.
  expect(wide.windows.map((window) => window.tasks)).toEqual([50, 30, 0])
})

test('over the first hundred searches the planner verifies more than the library, at about the same tokens per verified fix, in a world with structure', () => {
  const result = compare({ world: 'structured', seeds: 30, tasks: 100, policies: ['library', 'planner'] })
  expect(result.planner.verifiedChange).toBeGreaterThan(0.04)
  expect(result.planner.earlyVerifiedChange).toBeGreaterThan(0.03)
  // More verification is not bought with a worse price per verified fix.
  expect(result.planner.meanChange).toBeLessThan(0.08)
})

test('and in the control world, where there is no structure to exploit, it does no worse', () => {
  const result = compare({ world: 'null', seeds: 30, tasks: 100, policies: ['library', 'planner'] })
  // The gain is the cold start and the smaller waste on exploring, not anything the world's structure provides, so it does not depend on it.
  expect(result.planner.verifiedChange).toBeGreaterThan(0.04)
  expect(result.planner.meanChange).toBeLessThan(0.08)
})

test('the lead is honest about what it is: learning speed, so it narrows as the library catches up', () => {
  const short = compare({ world: 'structured', seeds: 20, tasks: 100, policies: ['library', 'planner'] })
  const long = compare({ world: 'structured', seeds: 20, tasks: 1000, policies: ['library', 'planner'] })
  expect(long.planner.verifiedChange).toBeLessThan(short.planner.verifiedChange)
  // It does not turn into a loss once the library has learned.
  expect(long.planner.verifiedChange).toBeGreaterThanOrEqual(0)
})

test('it never gives up verification for tokens: no world has it verifying less than the library', () => {
  for (const world of ['structured', 'null', 'dead-tail'] as const) {
    const result = compare({ world, seeds: 20, tasks: 150, policies: ['library', 'planner'] })
    expect(result.planner.verifiedChange).toBeGreaterThanOrEqual(0)
  }
})

test('nothing verifies more often than the oracle that knows the true odds, and the planner is between the library and it', () => {
  const result = compare({ world: 'structured', seeds: 20, tasks: 200, policies: ['library', 'planner', 'oracle'] })
  const [library, planner, oracle] = result.summaries
  expect(planner!.verifiedRate).toBeGreaterThan(library!.verifiedRate)
  expect(planner!.verifiedRate).toBeLessThanOrEqual(oracle!.verifiedRate + 0.01)
})

test('the attempt cap saves tokens where the tail is dead, for almost no verification, and does nothing where it is alive', () => {
  const dead = compare({ world: 'dead-tail', seeds: 24, tasks: 1500, policies: ['planner', 'planner-nocap'] })
  const [capped, uncapped] = dead.summaries
  expect(capped!.costPerTask).toBeLessThan(uncapped!.costPerTask * 0.98)
  expect(uncapped!.verifiedRate - capped!.verifiedRate).toBeLessThan(0.006)

  const alive = compare({ world: 'structured', seeds: 24, tasks: 300, policies: ['planner', 'planner-nocap'] })
  const [a, b] = alive.summaries
  // No evidence of a dead tail, so no cut: the two are the same to within noise.
  expect(Math.abs(a!.costPerTask / b!.costPerTask - 1)).toBeLessThan(0.01)
})

test('the world\'s flags do not change what it does where they change nothing', () => {
  const result = compare({ world: 'structured', seeds: 20, tasks: 300, policies: ['planner', 'planner-noflags'] })
  const [withFlags, without] = result.summaries
  expect(Math.abs(withFlags!.verifiedRate - without!.verifiedRate)).toBeLessThan(0.01)
})

test('its predictions of whether a search will verify are better than the independent cells\', in both worlds', () => {
  for (const world of ['structured', 'null'] as const) {
    const planner = compare({ world, seeds: 30, tasks: 200, policies: ['planner'] }).summaries[0]!
    expect(planner.prediction).toBeDefined()
    expect(planner.prediction!.planner).toBeLessThan(planner.prediction!.independent)
  }
})

test('the report says what each world is and what the planner did', () => {
  const text = renderComparison(compare({ world: 'null', seeds: 3, tasks: 60, policies: ['library', 'planner', 'oracle'] }))
  expect(text).toContain('null world')
  expect(text).toContain('the control')
  expect(text).toContain('planner vs library on the same tasks')
  expect(renderComparison(compare({ world: 'dead-tail', seeds: 2, tasks: 40, policies: ['library', 'planner'] }))).toContain('dead-tail world')
})
