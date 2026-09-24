import { expect, test } from 'bun:test'

process.env.ANTHROPIC_API_KEY ??= 'test-key-for-compounding-test'

const { benchStage } = await import('./status.ts')

const run = (overrides: Partial<import('./status.ts').BenchRecord> = {}) => ({ at: 0, set: 'all', tasks: 54, passRate: 0.6, unmeasured: 0, model: 'm', ...overrides })

test('no full run is no evidence, whatever partial runs say', () => {
  expect(benchStage([]).state).toBe('no evidence')
  expect(benchStage([run({ set: 'synthetic', passRate: 1 })]).state).toBe('no evidence')
})

test('the latest full run decides: blocked when incomplete, partial when saturated, working with headroom', () => {
  expect(benchStage([run({ unmeasured: 9 })]).state).toBe('blocked')
  expect(benchStage([run({ passRate: 1 })]).evidence).toContain('saturated')
  const working = benchStage([run({ passRate: 1 }), run({ passRate: 0.6 })])
  expect(working.state).toBe('working')
  expect(working.evidence).toContain('40 points of headroom')
})

const { focusTaskIds } = await import('./status.ts')

test('focus keeps every built-in task, every failed history task, and N passing ones from the last complete full run', () => {
  const runs = [
    run({ failed: ['hist-old'], passed: [] }),
    run({ failed: ['precise-edit', 'hist-a', 'hist-b'], passed: ['find-symbol', 'hist-c', 'hist-d', 'hist-e'] }),
    run({ unmeasured: 3, failed: ['hist-z'], passed: [] }),
  ]
  expect(focusTaskIds(['precise-edit', 'find-symbol'], 2, runs)).toEqual(['precise-edit', 'find-symbol', 'hist-a', 'hist-b', 'hist-c', 'hist-d'])
})

test('focus adds tasks harvested since the last full run, which nothing has measured yet', () => {
  const runs = [run({ failed: ['hist-a'], passed: ['hist-c', 'hist-d'] })]
  const all = ['precise-edit', 'hist-a', 'hist-c', 'hist-d', 'hist-new']
  expect(focusTaskIds(['precise-edit'], 1, runs, all)).toEqual(['precise-edit', 'hist-a', 'hist-new', 'hist-c'])
})

test('focus refuses without a complete full run that recorded its tasks', () => {
  expect(focusTaskIds(['x'], 2, [])).toBeUndefined()
  expect(focusTaskIds(['x'], 2, [run()])).toBeUndefined()
  expect(focusTaskIds(['x'], 2, [run({ unmeasured: 1, failed: [], passed: [] })])).toBeUndefined()
})

const { focusFromMeasured } = await import('./status.ts')

test('before a full sweep finishes, focus comes from the history tasks it has measured so far', () => {
  const measured = [
    { taskId: 'precise-edit', passed: true },
    { taskId: 'implement-to-spec', passed: false },
    { taskId: 'hist-a', passed: true },
    { taskId: 'hist-b', passed: false },
    { taskId: 'hist-c', passed: true },
    { taskId: 'hist-d', passed: true },
  ]
  expect(focusFromMeasured(['precise-edit', 'implement-to-spec'], 2, measured)).toEqual(['precise-edit', 'implement-to-spec', 'hist-b', 'hist-a', 'hist-c'])
  // Built-in failures are already in the set; they do not stand in for history evidence.
  expect(focusFromMeasured(['precise-edit', 'implement-to-spec'], 2, measured.slice(0, 2))).toBeUndefined()
  expect(focusFromMeasured(['x'], 2, [])).toBeUndefined()
})

const { lessonStoreEffect } = await import('./status.ts')

test('the lesson store effect pairs the latest complete runs of the same set', () => {
  const runs = [
    run({ passRate: 0.5, passed: ['a', 'b'], failed: ['c', 'd'] }),
    run({ set: 'all+lessons', unmeasured: 2, passed: ['a'], failed: [] }),
    run({ set: 'all+lessons', passRate: 0.75, passed: ['a', 'c', 'd'], failed: ['b'] }),
  ]
  expect(lessonStoreEffect(runs)).toEqual({ set: 'all', without: 0.5, with: 0.75, gained: ['c', 'd'], lost: ['b'] })
  expect(lessonStoreEffect(runs.slice(0, 1))).toBeUndefined()
})
