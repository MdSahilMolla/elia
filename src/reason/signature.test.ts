import { expect, test } from 'bun:test'

process.env.ANTHROPIC_API_KEY ??= 'test-key-for-reason-signature-test'

const { classify, extractFeatures, signatureKey, taskSignature, worthSearching } = await import('./signature.ts')
const { harnessById, harnessesFor } = await import('./harness.ts')

const checked = { hasExecutableCheck: true }
const unchecked = { hasExecutableCheck: false }

test('a work order about a failure is repair', () => {
  expect(classify('fix the failing test in src/foo.ts')).toBe('repair')
  expect(classify('the preview server crashes on startup, sort it out')).toBe('repair')
})

test('a question about a failure asks for the cause, not a fix', () => {
  // The distinction that keeps elia from editing when it was asked to explain.
  expect(classify('why does the build fail on Windows?')).toBe('locate')
  expect(classify('what is breaking the release job?')).toBe('locate')
})

test('a plain question is explain, and explain never buys a search', () => {
  expect(classify('what does this module do?')).toBe('explain')
  expect(classify('how does the provider fallback work?')).toBe('explain')
  expect(worthSearching(taskSignature('what does this module do?', checked))).toBe(false)
})

test('the usual work orders land in the classes they imply', () => {
  expect(classify('add a dark mode toggle to the settings page')).toBe('implement')
  expect(classify('rename computeTotal to sumItems')).toBe('refactor')
  expect(classify('where is the retry logic?')).toBe('locate')
  expect(classify('migrate the whole codebase off the old client')).toBe('plan')
})

test('features read what the request actually offers the search', () => {
  const features = extractFeatures('update src/app.tsx so the tests pass across every call site', checked)
  expect(features).toEqual({ hasExecutableCheck: true, namesTargets: true, multiFile: true, statesAcceptance: true })

  const bare = extractFeatures('make it nicer', unchecked)
  expect(bare).toEqual({ hasExecutableCheck: false, namesTargets: false, multiFile: false, statesAcceptance: false })
})

test('the key stays coarse, so cells fill up instead of every task being unique', () => {
  const one = taskSignature('fix the failing test in src/a.ts', checked)
  const two = taskSignature('fix the crash reported in src/b.ts', checked)
  expect(one.key).toBe(two.key)
  expect(one.key).toBe('repair/checked/single')

  expect(signatureKey('implement', { hasExecutableCheck: false, namesTargets: true, multiFile: true, statesAcceptance: false })).toBe(
    'implement/unchecked/multi',
  )
})

test('work with nothing executable to check against is not searched, except a repair', () => {
  expect(worthSearching(taskSignature('add a helper that formats dates', unchecked))).toBe(false)
  expect(worthSearching(taskSignature('add a helper that formats dates', checked))).toBe(true)
  // A repair has a failure to reproduce even when the project has no suite.
  expect(worthSearching(taskSignature('fix the crash on startup', unchecked))).toBe(true)
})

test('every searchable class offers more than one harness to compare', () => {
  for (const request of ['fix the failing test', 'add a toggle', 'rename the helper', 'where is the parser', 'migrate the whole repo and add the new client']) {
    const signature = taskSignature(request, checked)
    const harnesses = harnessesFor(signature)
    expect(harnesses.map((harness) => harness.id)).toEqual(['single', 'wide', 'deep'])
    // `single` is the null hypothesis: searching has to beat not searching.
    expect(harnesses[0]!.maxAttempts).toBe(1)
  }
})

test('a harness has distinct approaches, not the same instruction repeated', () => {
  const wide = harnessById(taskSignature('fix the failing test', checked), 'wide')!
  const instructions = new Set(wide.approaches.map((approach) => approach.instruction))
  expect(instructions.size).toBe(wide.approaches.length)
  expect(wide.approaches.length).toBeGreaterThan(1)
})

test('multi-file work gets a larger ceiling than a one-file change', () => {
  const single = harnessById(taskSignature('fix the failing test in src/a.ts', checked), 'wide')!
  const multi = harnessById(taskSignature('fix the failing tests across every call site', checked), 'wide')!
  expect(multi.maxAttempts).toBeGreaterThan(single.maxAttempts)
})

test('only work with nothing to run may stop on an unverified pass', () => {
  const runnable = harnessById(taskSignature('fix the failing test', checked), 'wide')!
  expect(runnable.verifier).toBe('project-tests')
  expect(runnable.allowUnverifiedStop).toBe(false)

  const unrunnable = harnessById(taskSignature('where is the retry logic', unchecked), 'wide')!
  expect(unrunnable.verifier).toBe('consensus')
  expect(unrunnable.allowUnverifiedStop).toBe(true)
})

test('new work with no suite has elia write the check rather than fall back to agreement', () => {
  const harness = harnessById(taskSignature('add a helper that formats dates', unchecked), 'wide')!
  expect(harness.verifier).toBe('synthesized-probe')
  expect(harness.allowUnverifiedStop).toBe(false)
})

test('an unknown harness id falls back to the first rather than throwing', () => {
  expect(harnessById(taskSignature('fix the failing test', checked), 'nonexistent')!.id).toBe('single')
  expect(harnessesFor(taskSignature('what does this do?', checked))).toEqual([])
})
