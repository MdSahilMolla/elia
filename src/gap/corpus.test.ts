import { expect, test } from 'bun:test'
import { CORPUS } from './corpus.ts'

test('every defect has matching clean and defective file sets, and they differ', () => {
  for (const defect of CORPUS) {
    expect(Object.keys(defect.defective).sort()).toEqual(Object.keys(defect.clean).sort())
    expect(JSON.stringify(defect.clean)).not.toEqual(JSON.stringify(defect.defective))
  }
})

test('defect ids are unique', () => {
  const ids = CORPUS.map((d) => d.id)
  expect(new Set(ids).size).toBe(ids.length)
})

test('test-rung defects ship a test; judgment defects do not claim a cheap rung', () => {
  for (const defect of CORPUS) {
    if (defect.expectedCatch === 'test') expect(defect.test).toBeDefined()
    if (defect.regime === 'judgment') expect(defect.expectedCatch).toBe('critic')
  }
})

test('the corpus covers every deterministic rung and includes judgment controls', () => {
  const rungs = new Set(CORPUS.map((d) => d.expectedCatch))
  expect(rungs).toContain('structural')
  expect(rungs).toContain('typecheck')
  expect(rungs).toContain('test')
  expect(rungs).toContain('hygiene')
  expect(CORPUS.some((d) => d.regime === 'judgment')).toBe(true)
})
