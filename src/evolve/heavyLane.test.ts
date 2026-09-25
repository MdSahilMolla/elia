import { expect, test } from 'bun:test'

process.env.ANTHROPIC_API_KEY ??= 'test-key-for-heavy-lane-test'

const { attemptInLane, HeavyLane, isHeavy, providerPushedBack } = await import('./fitness.ts')

const heavy = { id: 'hist-43597e6', maxSteps: 80 }
const light: { id: string; maxSteps?: number } = { id: 'precise-edit' }

test('history tasks are heavy; the default budget is not', () => {
  expect(isHeavy(heavy)).toBe(true)
  expect(isHeavy(light)).toBe(false)
  expect(isHeavy({ maxSteps: 30 })).toBe(false)
})

test('a rate limit or a stall is push-back; a timeout or a wrong answer is not', () => {
  expect(providerPushedBack({ error: '429 Too Many Requests' })).toBe(true)
  expect(providerPushedBack({ error: 'provider stalled: the model sent nothing for 60s or more before the task was stopped at 800000ms' })).toBe(true)
  expect(providerPushedBack({ error: 'timed out after 800000ms' })).toBe(false)
  expect(providerPushedBack({})).toBe(false)
})

/** A task that reports when it starts and ends, and finishes when told to. */
function gate() {
  const log: string[] = []
  const releases = new Map<string, () => void>()
  const task = (name: string, error?: string) => () =>
    new Promise<{ error?: string }>((resolve) => {
      log.push(`start ${name}`)
      releases.set(name, () => {
        log.push(`end ${name}`)
        resolve(error ? { error } : {})
      })
    })
  const release = async (name: string) => {
    for (let spin = 0; spin < 50 && !releases.has(name); spin += 1) await Promise.resolve()
    releases.get(name)!()
    for (let spin = 0; spin < 50; spin += 1) await Promise.resolve()
  }
  return { log, task, release }
}

test('heavy tasks share the lane at full width until the provider pushes back, then run one at a time', async () => {
  const lane = new HeavyLane(2)
  const narrowed: string[] = []
  const { log, task, release } = gate()
  const onNarrow = (entry: { id: string }) => narrowed.push(entry.id)
  const a = attemptInLane({ id: 'a', maxSteps: 80 }, task('a', 'provider stalled: silent'), lane, onNarrow)
  const b = attemptInLane({ id: 'b', maxSteps: 80 }, task('b'), lane, onNarrow)
  await release('a')
  await a
  expect(log).toEqual(['start a', 'start b', 'end a'])
  expect(narrowed).toEqual(['a'])
  expect(lane.capacity).toBe(1)
  // b still holds the one slot, so the next heavy attempt waits for it.
  const c = attemptInLane({ id: 'c', maxSteps: 80 }, task('c'), lane, onNarrow)
  await Promise.resolve()
  expect(log).toEqual(['start a', 'start b', 'end a'])
  await release('b')
  await b
  await release('c')
  await c
  expect(log).toEqual(['start a', 'start b', 'end a', 'end b', 'start c', 'end c'])
})

test('light tasks never wait for the lane', async () => {
  const lane = new HeavyLane(1)
  const { log, task, release } = gate()
  const blocking = attemptInLane(heavy, task('heavy'), lane, () => {})
  const quick = attemptInLane(light, task('light'), lane, () => {})
  await release('light')
  await quick
  expect(log).toEqual(['start heavy', 'start light', 'end light'])
  await release('heavy')
  await blocking
})

test('a lane already at one does not report narrowing again', async () => {
  const lane = new HeavyLane(1)
  const narrowed: string[] = []
  const { task, release } = gate()
  const run = attemptInLane(heavy, task('x', '429 rate limit'), lane, (entry) => narrowed.push(entry.id))
  await release('x')
  await run
  expect(narrowed).toEqual([])
})
