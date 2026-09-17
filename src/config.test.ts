import { afterEach, expect, test } from 'bun:test'

const { resolveThinking, describeThinking, describeReviewers, resolveReviewerRoute, config, getThinking, switchModel, switchThinking, turnContextPrompt, looksHighDifficulty, routeForAssignment, tierConfig } = await import('./config.ts')

afterEach(() => {
  delete process.env.ELIA_THINKING
  delete process.env.ELIA_THINKING_BUDGET
})

// Snapshot once at import time — whatever this test run's real .env actually
// resolved — so every switch test can restore it afterward and never leak
// mutated state into other test files sharing this module instance.
const originalProviderName = config.providerName
const originalModel = config.model
const originalThinking = getThinking()

afterEach(() => {
  switchModel({ providerName: originalProviderName, model: originalModel })
  switchThinking(originalThinking)
})

test('turnContextPrompt states the given wall-clock date as authoritative over training data', () => {
  const prompt = turnContextPrompt(new Date('2026-09-04T12:00:00Z'))
  expect(prompt).toContain("Today's date is 2026-09-04")
  expect(prompt.toLowerCase()).toContain('never from your training data')
})

// Seen live: a worker told (via the cached, load-time-frozen system prompt)
// that its cwd was elia's own root, while `withAgentIdentity` had actually
// bound it to an isolated per-run workspace, wrote its deliverable one
// directory level too deep looking for a `workspace/` subfolder that didn't
// need to exist. Passing the real cwd here corrects that per turn.
test('turnContextPrompt names the real per-agent cwd as authoritative when given one', () => {
  const prompt = turnContextPrompt(new Date('2026-09-04T12:00:00Z'), 'D:\\elia\\workspace\\run-1-mountain-car')
  expect(prompt).toContain('D:\\elia\\workspace\\run-1-mountain-car')
  expect(prompt).toContain('authoritative')
  expect(prompt.toLowerCase()).toContain('nesting another')
})

test('turnContextPrompt omits the cwd correction when no cwd is given', () => {
  const prompt = turnContextPrompt(new Date('2026-09-04T12:00:00Z'))
  expect(prompt).not.toContain('working directory')
})

test('resolveThinking defaults to enabled with the default budget', () => {
  expect(resolveThinking()).toEqual({ enabled: true, budgetTokens: 4096 })
})

test('ELIA_THINKING=off disables thinking', () => {
  process.env.ELIA_THINKING = 'off'
  expect(resolveThinking()).toEqual({ enabled: false, budgetTokens: 0 })
})

test('ELIA_THINKING_BUDGET overrides the default when valid', () => {
  process.env.ELIA_THINKING_BUDGET = '8000'
  expect(resolveThinking()).toEqual({ enabled: true, budgetTokens: 8000 })
})

test('an invalid or below-minimum ELIA_THINKING_BUDGET falls back to the default', () => {
  process.env.ELIA_THINKING_BUDGET = '100'
  expect(resolveThinking()).toEqual({ enabled: true, budgetTokens: 4096 })
})

test('reviewer route: default (ELIA_INDEPENDENT_CRITICS unset) keeps critics on the deep tier', () => {
  delete process.env.ELIA_INDEPENDENT_CRITICS
  delete process.env.ELIA_REVIEWER_PROVIDER
  delete process.env.ELIA_REVIEWER_MODEL
  const tier = { provider: config.provider, providerName: config.providerName, model: config.model, label: config.providerLabel }
  expect(resolveReviewerRoute(tier, tier)).toBeUndefined()
})

test('reviewer route: ELIA_INDEPENDENT_CRITICS=off is explicit no', () => {
  process.env.ELIA_INDEPENDENT_CRITICS = 'off'
  const tier = { provider: config.provider, providerName: config.providerName, model: config.model, label: config.providerLabel }
  expect(resolveReviewerRoute(tier, tier)).toBeUndefined()
  delete process.env.ELIA_INDEPENDENT_CRITICS
})

test('describeReviewers reports whether review is model-independent', () => {
  expect(describeReviewers()).toContain('review:')
  expect(typeof config.independentReviewers).toBe('boolean')
})

test('describeThinking reports the capability honestly rather than staying silent', () => {
  // Reflects whatever provider this test run's .env actually resolved (not
  // re-evaluated per test — it is a startup-time snapshot by design), so this
  // only pins the shape of the message, not a specific provider branch.
  expect(describeThinking()).toContain('reasoning:')
})

test('switchModel re-resolving the current provider/model succeeds and updates config live', () => {
  const result = switchModel({ providerName: originalProviderName, model: originalModel })
  expect(result.ok).toBe(true)
  expect(config.providerName).toBe(originalProviderName)
  expect(config.model).toBe(originalModel)
})

test('built-in model switching ignores a stale custom endpoint', () => {
  if (originalProviderName === 'custom') return
  const previousBaseURL = process.env.ELIA_BASE_URL
  process.env.ELIA_BASE_URL = 'http://127.0.0.1:9/v1'
  try {
    const result = switchModel({ providerName: originalProviderName, model: originalModel })
    expect(result.ok).toBe(true)
    expect(config.providerName).toBe(originalProviderName)
    expect(config.model).toBe(originalModel)
  } finally {
    if (previousBaseURL === undefined) delete process.env.ELIA_BASE_URL
    else process.env.ELIA_BASE_URL = previousBaseURL
  }
})

test('switchModel to an unresolvable provider fails without mutating the live config', () => {
  const result = switchModel({ providerName: 'not-a-real-preset-xyz' })
  expect(result.ok).toBe(false)
  expect(config.providerName).toBe(originalProviderName)
  expect(config.model).toBe(originalModel)
})

test('switchModel auto enables fallback without changing the selected provider or model', () => {
  const providerName = config.providerName
  const model = config.model
  const result = switchModel({ providerName: 'auto' })

  expect(result.ok).toBe(true)
  expect(config.routingMode).toBe('auto')
  expect(config.providerName).toBe(providerName)
  expect(config.model).toBe(model)

  const restored = switchModel({ providerName, model })
  expect(restored.ok).toBe(true)
  expect(config.routingMode).toBe('selected')
})

test('switchThinking off is reflected in getThinking and describeThinking', () => {
  const result = switchThinking({ enabled: false, budgetTokens: 0 })
  expect(result.ok).toBe(true)
  expect(getThinking()).toEqual({ enabled: false, budgetTokens: 0 })
  expect(describeThinking()).toContain('off')
})

test('switchThinking on with an explicit budget is reflected in getThinking', () => {
  const result = switchThinking({ enabled: true, budgetTokens: 16000 })
  expect(result.ok).toBe(true)
  expect(getThinking()).toEqual({ enabled: true, budgetTokens: 16000 })
})

test('looksHighDifficulty matches on non-routine keywords but not on ordinary work', () => {
  expect(looksHighDifficulty('Fix the race condition in the connection pool')).toBe(true)
  expect(looksHighDifficulty('Migrate the auth tokens to the new encryption scheme')).toBe(true)
  expect(looksHighDifficulty('Rename the getUser function to fetchUser')).toBe(false)
  expect(looksHighDifficulty('Fix the typo in the README')).toBe(false)
})

test('looksHighDifficulty treats a very long brief as a weak difficulty signal on its own', () => {
  expect(looksHighDifficulty('word '.repeat(300))).toBe(true)
  expect(looksHighDifficulty('word '.repeat(50))).toBe(false)
})

test('routeForAssignment escalates a fast-tier role to deep only when the assignment looks hard', () => {
  expect(config.roleOverrides.scout).toBeUndefined() // test env has no ELIA_SCOUT_PROVIDER/_MODEL set
  const routine = routeForAssignment('scout', 'fast', 'List every file under src/ui')
  expect(routine.label).toBe(tierConfig('fast').label)

  const hard = routeForAssignment('scout', 'fast', 'Investigate the race condition causing intermittent data loss')
  expect(hard.label).toBe(tierConfig('deep').label)
})

test('routeForAssignment never downgrades a deep-tier role, even for a trivial-looking assignment', () => {
  const route = routeForAssignment('builder', 'deep', 'fix a typo')
  expect(route.label).toBe(tierConfig('deep').label)
})

test('routeForAssignment defers entirely to an explicit per-role override, never second-guessing it with difficulty', () => {
  const pinned = tierConfig('deep')
  const previous = config.roleOverrides.scout
  config.roleOverrides.scout = pinned
  try {
    const hard = routeForAssignment('scout', 'fast', 'Fix the race condition causing data loss')
    expect(hard).toBe(pinned) // the exact pinned route, not a re-derived "deep" tierConfig
  } finally {
    config.roleOverrides.scout = previous
  }
})

test('elia is told, accurately, that it can change its own source', () => {
  // elia described itself as unable to modify its own architecture. `elia evolve`
  // does exactly that, under a benchmark gate. Nothing in the repo denied it —
  // the model simply fell back to its default prior because the one place it is
  // told what it is with respect to this codebase never mentioned the loop.
  //
  // config.ts is deliberately NOT immutable to evolve: the system prompt is the
  // highest-value target the loop has, and locking it would gut the loop. This
  // test is the pin instead — src/**/*.test.ts IS immutable, so a candidate may
  // reword the sentence but cannot make it stop being true or delete it.
  const { SHARED_CONTEXT } = require('./config.ts') as { SHARED_CONTEXT: string }

  expect(SHARED_CONTEXT).toContain('elia evolve')
  expect(SHARED_CONTEXT.toLowerCase()).toContain('benchmark')
  // And it must not overclaim: weights are explicitly out of scope.
  expect(SHARED_CONTEXT.toLowerCase()).toContain('weights')
})
