import { expect, test } from 'bun:test'

process.env.ANTHROPIC_API_KEY ??= 'test-key-for-reason-route-test'

const { reasoningRoute, searchUnavailable } = await import('./route.ts')
const { decideSearch } = await import('./decide.ts')

const base = { reasonSearch: true, selfEditClosed: false, mode: 'dev', planMode: false, escalate: false }

test('every reason a prompt cannot be searched is named, and a plain dev prompt can be', () => {
  expect(searchUnavailable(base)).toBeUndefined()
  expect(searchUnavailable({ ...base, escalate: true })).toContain('autonomous pipeline')
  expect(searchUnavailable({ ...base, reasonSearch: false })).toContain('/search on')
  expect(searchUnavailable({ ...base, planMode: true })).toContain('plan mode')
  expect(searchUnavailable({ ...base, persona: 'marketing' })).toContain('marketing persona')
  expect(searchUnavailable({ ...base, mode: 'datascience' })).toContain('datascience mode')
  expect(searchUnavailable({ ...base, selfEditClosed: true })).toContain('own source')
})

test('each prompt gets exactly one route, with the reason in words', () => {
  const searched = reasoningRoute({ search: decideSearch('fix the failing test in src/parser.ts', ['bun run test']), escalate: false, audited: true })
  expect(searched.route).toBe('search')
  expect(searched.line).toContain('checked by: bun run test')
  expect(searched.line).toContain('citations and arithmetic are checked')

  const question = reasoningRoute({ search: decideSearch('what does the retry do?', ['bun run test']), answerCheck: { check: true, why: 'a question' }, escalate: false, audited: true })
  expect(question.route).toBe('answer-check')

  const declined = reasoningRoute({ search: decideSearch('what does the retry do?', ['bun run test']), answerCheck: { check: false, why: 'x' }, escalate: false, audited: false })
  expect(declined.route).toBe('single')
  expect(declined.line).toContain('not searched because this reads as a question')
  expect(declined.line).toContain('reply checks are off')

  const persona = reasoningRoute({ unavailable: searchUnavailable({ ...base, persona: 'finance' }), escalate: false, audited: true })
  expect(persona.line).toContain('finance persona')

  expect(reasoningRoute({ unavailable: 'x', escalate: true, audited: true }).route).toBe('pipeline')
})
