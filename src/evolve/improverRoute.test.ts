import { afterEach, expect, test } from 'bun:test'

process.env.ANTHROPIC_API_KEY ??= 'test-key-for-improver-route-test'

const { config } = await import('../config.ts')
const { improverLoopRoute, improverRoute, withImproverBuilder } = await import('./improverRoute.ts')

const KEYS = ['ELIA_EVOLVE_PROVIDER', 'ELIA_EVOLVE_MODEL', 'ELIA_EVOLVE_BASE_URL', 'ELIA_EVOLVE_API_KEY'] as const
const saved = Object.fromEntries(KEYS.map((key) => [key, process.env[key]]))
afterEach(() => {
  for (const key of KEYS) {
    if (saved[key] === undefined) delete process.env[key]
    else process.env[key] = saved[key]
  }
})

test('with nothing set, the improver runs on the model under test', () => {
  for (const key of KEYS) delete process.env[key]
  expect(improverRoute()).toBeUndefined()
  expect(improverLoopRoute(undefined)).toEqual({})
})

test('a named provider and model become the improver route', () => {
  process.env.ELIA_EVOLVE_PROVIDER = 'anthropic'
  process.env.ELIA_EVOLVE_MODEL = 'claude-sonnet-5'
  const route = improverRoute()
  expect(route?.providerName).toBe('anthropic')
  expect(route?.model).toBe('claude-sonnet-5')
  expect(route?.label).toBe('anthropic (claude-sonnet-5)')
  expect(improverLoopRoute(route)).toMatchObject({ providerName: 'anthropic', model: 'claude-sonnet-5' })
})

test('a route that was asked for and cannot be stood up stops the run instead of falling back', () => {
  process.env.ELIA_EVOLVE_PROVIDER = 'no-such-provider'
  expect(() => improverRoute()).toThrow('ELIA_EVOLVE_PROVIDER/ELIA_EVOLVE_MODEL could not be used')
})

test('the builder runs on the route only for the duration, and an existing override comes back', async () => {
  process.env.ELIA_EVOLVE_PROVIDER = 'anthropic'
  process.env.ELIA_EVOLVE_MODEL = 'claude-sonnet-5'
  const route = improverRoute()!
  const before = config.roleOverrides.builder

  const seen = await withImproverBuilder(route, async () => config.roleOverrides.builder?.label)
  expect(seen).toBe('anthropic (claude-sonnet-5)')
  expect(config.roleOverrides.builder).toBe(before)

  await expect(
    withImproverBuilder(route, async () => {
      throw new Error('builder failed')
    }),
  ).rejects.toThrow('builder failed')
  expect(config.roleOverrides.builder).toBe(before)
})

test('without a route the builder is left alone', async () => {
  const before = config.roleOverrides.builder
  expect(await withImproverBuilder(undefined, async () => config.roleOverrides.builder)).toBe(before)
})
