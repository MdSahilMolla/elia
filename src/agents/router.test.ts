import { expect, test } from 'bun:test'
import { parseOverride, keywordHint } from './router.ts'

test('parseOverride recognises "as the X agent"', () => {
  expect(parseOverride('as the Tech agent, explain this stack trace')).toBe('tech')
  expect(parseOverride('As the Marketing agent, write some captions')).toBe('marketing')
  expect(parseOverride('as the finance agent what is our CAC')).toBe('finance')
})

test('parseOverride recognises "give me the X take"', () => {
  expect(parseOverride('give me the marketing take on this')).toBe('marketing')
  expect(parseOverride('what is the finance take here')).toBe('finance')
  expect(parseOverride('give me the data analyst take here')).toBe('data')
  expect(parseOverride('as the cybersecurity agent, review this scope')).toBe('cyber')
  expect(parseOverride('as the communications agent, prepare an email')).toBe('communications')
})

test('parseOverride returns undefined for an unmarked request', () => {
  expect(parseOverride('write 3 instagram captions for our new product')).toBeUndefined()
})

test('keywordHint matches marketing signals', () => {
  expect(keywordHint('write ad copy for our brand campaign')).toEqual(['marketing'])
})

test('keywordHint matches finance signals', () => {
  expect(keywordHint('what is our monthly cash flow and runway')).toEqual(['finance'])
})

test('keywordHint matches tech signals', () => {
  expect(keywordHint('our checkout page is throwing a 500 error')).toContain('tech')
})

test('keywordHint can return multiple personas for a request spanning domains', () => {
  const hint = keywordHint('should we build an in-house CRM or buy one, our budget is tight')
  expect(hint).toContain('tech')
  expect(hint).toContain('finance')
})

test('keywordHint matches the expanded specialist signals', () => {
  const hint = keywordHint('automate an email workflow, profile the dataset, and evaluate an LLM')
  expect(hint).toContain('automation')
  expect(hint).toContain('communications')
  expect(hint).toContain('data')
  expect(hint).toContain('ai')
})

test('keywordHint returns an empty array when nothing matches', () => {
  expect(keywordHint('tell me a joke')).toEqual([])
})
