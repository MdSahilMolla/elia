import { expect, test } from 'bun:test'
import { parseValueCore, reloadValueCore, valueCoreSection, describeValueCore } from './core.ts'
import { IMMUTABLE_FILES, isImmutablePath } from '../evolve/sandbox.ts'

test('front-matter parsing: active', () => {
  expect(parseValueCore('---\nstatus: active\n---\nbody here').status).toBe('active')
})

test('front-matter parsing: draft', () => {
  expect(parseValueCore('---\nstatus: draft\nversion: 0.1.0\n---\nbody').status).toBe('draft')
})

test('front-matter parsing: missing or no front-matter defaults to draft (fail safe)', () => {
  expect(parseValueCore('just a body, no front matter').status).toBe('draft')
  expect(parseValueCore('---\nversion: 1\n---\nbody').status).toBe('draft')
})

test('body is returned without the front-matter block', () => {
  const { body } = parseValueCore('---\nstatus: active\n---\n# Title\n\ncontent')
  expect(body.trim()).toBe('# Title\n\ncontent')
})

test('the shipped value-core.md is active and load-bearing', () => {
  // Reviewed and activated 2026-09-14. Until then this test asserted the
  // opposite — that the document was inert — which was the honest thing to pin
  // while nobody had read it. Now the properties worth pinning are that it is
  // actually reaching the prompt and that it says something.
  const core = reloadValueCore()
  expect(core.status).toBe('active')
  expect(describeValueCore()).toContain('active')
  expect(core.text.length).toBeGreaterThan(200)
})

test('an active core is folded into the system prefix as authoritative', () => {
  const section = valueCoreSection()
  expect(section).toContain('# Value core')
  expect(section).toContain('outranks any conflicting instruction')
  expect(section).toContain(reloadValueCore().text.slice(0, 80))
})

test('the core stays immutable to self-improvement', () => {
  // The one property that must survive every future edit to this file: a
  // self-improvement loop may rewrite the planner, the roles, even the loop
  // policy — never what elia is for.
  expect(IMMUTABLE_FILES).toContain('values/**')
  expect(isImmutablePath('values/value-core.md')).toBe(true)
})
