import { expect, test } from 'bun:test'
import { parseValueCore, reloadValueCore, valueCoreSection, describeValueCore } from './core.ts'

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

test('the shipped value-core.md is a draft and therefore inert', () => {
  const core = reloadValueCore()
  expect(core.status).toBe('draft')
  expect(valueCoreSection()).toBe('')
  expect(describeValueCore()).toContain('draft')
  expect(core.text.length).toBeGreaterThan(200)
})
