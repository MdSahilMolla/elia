import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { classifyDomain, competenceReport, domainsInPlay, domainsOf, recordOutcome, regretNudge, renderCompetence, touchedWeakDomain, weakDomainCaution } from './outcomes.ts'
import type { TurnOutcome } from './outcomes.ts'

let path: string
beforeEach(() => {
  path = join(mkdtempSync(join(tmpdir(), 'elia-out-')), 'outcomes.jsonl')
})
afterEach(() => rmSync(join(path, '..'), { recursive: true, force: true }))

const turn = (over: Partial<Omit<TurnOutcome, 'at'>> = {}): Omit<TurnOutcome, 'at'> => ({
  prompt: 'do a thing',
  filesChanged: 1,
  domains: ['code'],
  editRetries: 0,
  toolErrors: 0,
  verify: 'pass',
  repairAttempts: 0,
  aborted: false,
  ...over,
})

test('classifyDomain buckets by path and extension', () => {
  expect(classifyDomain('src/components/Button.tsx')).toBe('frontend')
  expect(classifyDomain('src/routes/auth.ts')).toBe('backend')
  expect(classifyDomain('src/foo.test.ts')).toBe('tests')
  expect(classifyDomain('README.md')).toBe('docs')
  expect(classifyDomain('tsconfig.json')).toBe('config')
  expect(classifyDomain('src/logic.ts')).toBe('code')
  expect(domainsOf(['a.tsx', 'b.tsx', 'c.md'])).toEqual(['frontend', 'docs'])
})

test('competenceReport separates clean from rough turns', () => {
  recordOutcome(turn({ domains: ['backend'] }), path)
  recordOutcome(turn({ domains: ['backend'] }), path)
  recordOutcome(turn({ domains: ['frontend'], editRetries: 3, verify: 'fail' }), path)
  recordOutcome(turn({ domains: ['frontend'], toolErrors: 4 }), path)
  const r = competenceReport(path)
  expect(r.changingTurns).toBe(4)
  expect(r.cleanTurns).toBe(2)
  const frontend = r.byDomain.find((d) => d.domain === 'frontend')
  expect(frontend?.cleanRate).toBe(0)
  expect(r.weakest).toContain('frontend')
})

test('aborted turns are excluded', () => {
  recordOutcome(turn({ aborted: true, toolErrors: 5 }), path)
  expect(competenceReport(path).changingTurns).toBe(0)
})

test('renderCompetence is human-readable', () => {
  recordOutcome(turn({ domains: ['backend'] }), path)
  recordOutcome(turn({ domains: ['backend'], editRetries: 2 }), path)
  const out = renderCompetence(path)
  expect(out).toContain('code-changing turn')
  expect(out).toContain('landed clean')
})

test('regretNudge fires only after a rough turn', () => {
  recordOutcome(turn(), path)
  expect(regretNudge(path)).toBe('')
  recordOutcome(turn({ editRetries: 3, verify: 'fail' }), path)
  const nudge = regretNudge(path)
  expect(nudge).toContain('friction')
  expect(nudge).toContain('note_lesson')
})

test('domainsInPlay reads the prompt and the paths', () => {
  expect(domainsInPlay('fix the CSS on the landing page', [])).toContain('frontend')
  expect(domainsInPlay('add a rate-limit to the API', ['src/routes/x.ts'])).toEqual(expect.arrayContaining(['backend']))
})

test('weakDomainCaution only fires for a weak domain the turn actually touches', () => {
  for (let i = 0; i < 3; i += 1) recordOutcome(turn({ domains: ['frontend'], toolErrors: 3 }), path) // frontend is now weak
  for (let i = 0; i < 3; i += 1) recordOutcome(turn({ domains: ['backend'] }), path)
  expect(weakDomainCaution('rework the API handler', [], path)).toBe('') // backend is fine
  const caution = weakDomainCaution('restyle the component', ['src/ui/Card.tsx'], path)
  expect(caution).toContain('weak area')
  expect(caution).toContain('critic')
})

test('touchedWeakDomain flags a changed file in a weak area', () => {
  for (let i = 0; i < 3; i += 1) recordOutcome(turn({ domains: ['frontend'], toolErrors: 3 }), path)
  expect(touchedWeakDomain(['src/components/Nav.tsx'], path)).toContain('frontend')
  expect(touchedWeakDomain(['src/lib/math.ts'], path)).toEqual([])
})
