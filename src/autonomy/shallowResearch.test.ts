import { expect, test } from 'bun:test'
import { SHALLOW_RESEARCH_NOTE, createShallowResearchGuard, isResearchRequest } from './shallowResearch.ts'

test('research requests are recognised in the wording people used', () => {
  expect(isResearchRequest('do a research about gemini new model')).toBe(true)
  expect(isResearchRequest('do a resarch on meat us india and tell me what you get')).toBe(true)
  expect(isResearchRequest('reserch this company')).toBe(true)
  expect(isResearchRequest('deep dive into the EU AI act')).toBe(true)
  expect(isResearchRequest('find out whether the API supports streaming')).toBe(true)
  expect(isResearchRequest('investigate why the test fails')).toBe(false)
  expect(isResearchRequest('fix the css')).toBe(false)
})

test('a research answer from search snippets alone is sent back once to open its sources', () => {
  const guard = createShallowResearchGuard('do a research about gemini new model', true)
  guard.observe(['web_search'])
  expect(guard.beforeFinish()).toBe(SHALLOW_RESEARCH_NOTE)
  expect(guard.beforeFinish()).toBeUndefined()
})

test('a research answer that opened a source finishes normally', () => {
  const guard = createShallowResearchGuard('research the new gemini model', true)
  guard.observe(['web_search', 'todo_write'])
  guard.observe(['web_fetch'])
  expect(guard.beforeFinish()).toBeUndefined()
})

test('no search, local work, no web_fetch, or a non-research request: left alone', () => {
  const noTools = createShallowResearchGuard('help me with my research paper intro', true)
  expect(noTools.beforeFinish()).toBeUndefined()

  const local = createShallowResearchGuard('research how this repo handles auth', true)
  local.observe(['web_search', 'grep', 'read_file'])
  expect(local.beforeFinish()).toBeUndefined()

  const cannotFetch = createShallowResearchGuard('research the new gemini model', false)
  cannotFetch.observe(['web_search'])
  expect(cannotFetch.beforeFinish()).toBeUndefined()

  const chat = createShallowResearchGuard('what is the weather in agra', true)
  chat.observe(['web_search'])
  expect(chat.beforeFinish()).toBeUndefined()
})
