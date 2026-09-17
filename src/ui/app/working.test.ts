import { expect, test } from 'bun:test'
import { formatElapsed, formatTokens, gerund, reducedMotion, streamedTokens, tipFor, TIPS, tipsEnabled, turnReceipt, turnVerb, TURN_VERBS, workingLabel } from './working.ts'

test('elapsed time reads precisely while it is short and coarsely once it is long', () => {
  expect(formatElapsed(0)).toBe('0s')
  expect(formatElapsed(12.9)).toBe('12s')
  expect(formatElapsed(65)).toBe('1m 5s')
  expect(formatElapsed(3_599)).toBe('59m 59s')
  expect(formatElapsed(3_720)).toBe('1h 2m')
  expect(formatElapsed(-4)).toBe('0s')
})

test('token counts shorten the way a person would say them', () => {
  expect(formatTokens(817)).toBe('817')
  expect(formatTokens(1_000)).toBe('1k')
  expect(formatTokens(1_234)).toBe('1.2k')
  expect(formatTokens(12_345)).toBe('12k')
  expect(formatTokens(1_400_000)).toBe('1.4M')
  expect(streamedTokens('abcdefgh')).toBe(2)
})

test('a plan step reads as what is happening now', () => {
  expect(gerund('Fix the failing tests')).toBe('Fixing the failing tests')
  expect(gerund('Run bun test to verify.')).toBe('Running bun test to verify')
  expect(gerund('Write index.html')).toBe('Writing index.html')
  expect(gerund('Set up the project')).toBe('Setting up the project')
  expect(gerund('Tie the loose ends')).toBe('Tying the loose ends')
  expect(gerund('See what broke')).toBe('Seeing what broke')
  expect(gerund('Read src/stats.ts')).toBe('Reading src/stats.ts')
  expect(gerund('add the styles')).toBe('adding the styles')
  // Not a plain verb: left alone rather than mangled.
  expect(gerund('The README needs a section')).toBe('The README needs a section')
  expect(gerund('Building the page')).toBe('Building the page')
  expect(gerund('`bun test` passes')).toBe('`bun test` passes')
})

test('the label names the most specific thing that is known', () => {
  const base = { runningTools: [], verb: 'Weaving' }
  expect(workingLabel(base)).toBe('Weaving')
  expect(workingLabel({ ...base, writing: true })).toBe('Writing')
  expect(workingLabel({ ...base, writing: true, planStep: 'Fix the bug' })).toBe('Fixing the bug')
  expect(workingLabel({ ...base, planStep: 'Fix the bug', thinking: true })).toBe('Thinking')
  expect(workingLabel({ ...base, thinking: true, activity: 'Checking the result — tests' })).toBe('Checking the result — tests')
  expect(workingLabel({ ...base, activity: 'Checking…', runningTools: ['Reading app.ts'] })).toBe('Reading app.ts')
  expect(workingLabel({ ...base, runningTools: ['Reading app.ts', 'Running bun test…'] })).toBe('Running bun test · 1 more running')
})

test('a turn keeps one verb, and every verb is a real phrase', () => {
  expect(turnVerb(12)).toBe(turnVerb(12))
  expect(TURN_VERBS).toContain(turnVerb(-7))
  // "Sparking…" is how the old line-mode spinner is recognised in raw terminal logs.
  expect(TURN_VERBS).not.toContain('Sparking')
  for (const verb of TURN_VERBS) expect(verb).toMatch(/^[A-Z][a-z]+(?: [a-z]+)*$/)
})

test('the closing line says how long, what changed and how much was written', () => {
  expect(turnReceipt({ elapsedMs: 23_400, rollup: 'Edited 1 file, ran 3 commands · +2 −2', tokens: 2_900 })).toBe(
    'Worked for 23s · edited 1 file, ran 3 commands · +2 −2 · ↓ 2.9k tokens',
  )
  expect(turnReceipt({ elapsedMs: 75_000, rollup: '', tokens: 0 })).toBe('Worked for 1m 15s')
})

test('tips rotate per turn and can be switched off; motion can be reduced', () => {
  expect(tipFor(0)).toBe(TIPS[0]!)
  expect(tipFor(TIPS.length + 1)).toBe(TIPS[1]!)
  expect(tipsEnabled({})).toBe(true)
  expect(tipsEnabled({ ELIA_TIPS: 'off' })).toBe(false)
  expect(tipsEnabled({ ELIA_TIPS: '0' })).toBe(false)
  expect(reducedMotion({})).toBe(false)
  expect(reducedMotion({ ELIA_REDUCED_MOTION: '1' })).toBe(true)
})
