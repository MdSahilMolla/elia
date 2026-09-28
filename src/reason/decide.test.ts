import { expect, test } from 'bun:test'

process.env.ANTHROPIC_API_KEY ??= 'test-key-for-reason-decide-test'

const { decideAnswerCheck, decideSearch, splitChecks } = await import('./decide.ts')

/** What `detectChecks` actually returns for this repo. */
const ELIA_CHECKS = ['bun run typecheck', 'bun run test']

test('the cheap structural check and the one that runs the code are told apart', () => {
  expect(splitChecks(ELIA_CHECKS)).toEqual({ build: 'bun run typecheck', test: 'bun run test' })
  expect(splitChecks(['npm run build', 'npm run test:unit'])).toEqual({ build: 'npm run build', test: 'npm run test:unit' })
})

test('a typecheck script is never mistaken for the test command', () => {
  // "typecheck" contains no "test", but a script named `test:types` does — and
  // treating a compiler as executed proof is the exact confusion this avoids.
  const split = splitChecks(['bun run typecheck'])
  expect(split.build).toBe('bun run typecheck')
  expect(split.test).toBeUndefined()
})

test('a question is never searched', () => {
  const decision = decideSearch('what does the provider fallback do?', ELIA_CHECKS)
  expect(decision.plan).toBeUndefined()
  expect(decision.why).toContain('reads as a question')
})

test('a repair in this repo is searched, and says what will judge it', () => {
  const decision = decideSearch('fix the failing test in src/parser.ts', ELIA_CHECKS)

  expect(decision.plan).toBeDefined()
  expect(decision.plan!.signature.key).toBe('repair/checked/single')
  expect(decision.plan!.checks.test).toBe('bun run test')
  expect(decision.why).toContain('bun run test')
})

test('a feature request in a project with checks is searched', () => {
  const decision = decideSearch('add a retry to the provider client', ELIA_CHECKS)
  expect(decision.plan?.signature.taskClass).toBe('implement')
})

test('a project with no checks at all declines rather than searching on agreement', () => {
  const decision = decideSearch('add a retry to the provider client', [])
  expect(decision.plan).toBeUndefined()
  expect(decision.why).toContain('nothing executable to check')
})

test('finding where something lives is never searched, even in a repo full of checks', () => {
  // The trap this closes: `bun run test` passes for every attempt at a `locate`
  // task because none of them changed anything the suite touches. That is an
  // `executed` pass by the letter of it, and it would have stopped the search on
  // attempt one having proved nothing.
  const decision = decideSearch('where is the retry logic?', ELIA_CHECKS)
  expect(decision.plan).toBeUndefined()
  expect(decision.why).toContain('prove nothing')

  expect(decideSearch('plan the migration off the old client and build it', ELIA_CHECKS).plan).toBeUndefined()
})

test('a repair with no project checks still searches — elia writes the check first', () => {
  const decision = decideSearch('fix the crash on startup', [])
  expect(decision.plan).toBeDefined()
  expect(decision.why).toContain('write the check before attempting it')
})

test('the decision for this very repo, with its real commands', () => {
  // The turn that matters: a work order in elia itself must come back searchable
  // and judged by bun test, or the wiring in index.ts does nothing in practice.
  const decision = decideSearch('fix the broken worktree cleanup in src/reason/attempt.ts', ELIA_CHECKS)
  expect(decision.plan?.checks).toEqual({ build: 'bun run typecheck', test: 'bun run test' })
})

test('a standalone artifact declines, because the project checks cannot tell the attempts apart', () => {
  // The real one, typos and all. It routed into a search whose verifier was
  // elia's own `bun run typecheck` + `bun run test` — a suite that never looks
  // at workspace/, passes identically for every candidate, and costs ~200s a
  // run. Declining sends it back to the ordinary planned turn.
  const decision = decideSearch('create a simple sticky man gamme in htm', ELIA_CHECKS)
  expect(decision.plan).toBeUndefined()
  expect(decision.why).toContain('do not exercise')

  for (const request of ['create a website for viso.ai', 'build a landing page for the product', 'make a portfolio page']) {
    expect(decideSearch(request, ELIA_CHECKS).plan).toBeUndefined()
  }
})

test('ordinary work inside the checked project still searches', () => {
  // The guard has to be narrow or it silently disables the whole feature, which
  // is the failure mode nothing else here would catch.
  for (const request of [
    'add a retry with backoff to src/tools/webFetch.ts',
    'implement rate limiting on the provider client',
    'refactor the governor to share one assessment helper',
  ]) {
    expect(decideSearch(request, ELIA_CHECKS).plan).toBeDefined()
  }
})

test('naming a file in the project keeps a search even when the request mentions html', () => {
  // "html" alone must not disqualify a repo task — the guard needs the absence
  // of a named target too.
  const decision = decideSearch('fix the html escaping in src/ui/render.ts', ELIA_CHECKS)
  expect(decision.plan).toBeDefined()
})

test('questions get the answer check; tasks, small talk and polite requests do not', () => {
  expect(decideAnswerCheck('which file defines MIN_OBSERVATIONS?').check).toBe(true)
  expect(decideAnswerCheck('How many retries does the provider make before giving up?').check).toBe(true)
  expect(decideAnswerCheck('where is the fallback route resolved').check).toBe(true)
  expect(decideAnswerCheck('the build is slow, is caching on?').check).toBe(true)
  expect(decideAnswerCheck('can you add a retry to the fetch helper?').check).toBe(false)
  expect(decideAnswerCheck('fix the failing test in src/parser.ts').check).toBe(false)
  expect(decideAnswerCheck('add a --json flag to elia bench').check).toBe(false)
  expect(decideAnswerCheck('thanks, that works?').check).toBe(false)
  expect(decideAnswerCheck('why?').check).toBe(false)
  expect(decideAnswerCheck('fix the broken parser?').check).toBe(false)
})

test('a question about elia itself is answered once, never checked', () => {
  for (const meta of ['what can you do', 'What can you do?', 'hey, what can you do for me here?', 'who are you exactly?', 'how do you work?', "what's your name?", 'what model are you running?', 'are you there?', 'help me understand what you can do', 'what are you working on right now?']) {
    expect({ meta, check: decideAnswerCheck(meta).check }).toEqual({ meta, check: false })
  }
  // A real question that merely mentions "you" is still checked.
  for (const real of ['what do you think causes the flaky date test?', 'how do you run the tests in this repo?', 'which file defines MIN_OBSERVATIONS?']) {
    expect({ real, check: decideAnswerCheck(real).check }).toEqual({ real, check: true })
  }
})

test('design and architecture requests are reasoned from first principles; fixes inside a design are not', async () => {
  const { decideFirstPrinciples, FIRST_PRINCIPLES_GUIDANCE } = await import('./decide.ts')
  for (const request of [
    'design the architecture for a multi-tenant job queue',
    'how should we structure the sync engine?',
    'what are the trade-offs between polling and webhooks here',
    'redesign the plugin system',
    'think about this from first principles',
    'propose a data model for invoices',
  ]) expect(decideFirstPrinciples(request).apply).toBe(true)
  for (const request of ['fix the typo in the design doc', 'add a test for parseArgs', 'what does the retry do?', 'rename the design tokens in theme.ts']) {
    expect(decideFirstPrinciples(request).apply).toBe(false)
  }
  // Constraints before patterns: the order is the instruction.
  expect(FIRST_PRINCIPLES_GUIDANCE.indexOf('hard constraints')).toBeLessThan(FIRST_PRINCIPLES_GUIDANCE.indexOf('usual patterns'))
})
