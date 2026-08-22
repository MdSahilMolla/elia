import { expect, test } from 'bun:test'
import { personaPrompt, personaTools } from './personas.ts'
import { AGENT_PERSONAS } from './types.ts'

test('every registered specialist has a non-empty prompt', () => {
  for (const persona of AGENT_PERSONAS) expect(personaPrompt(persona).length).toBeGreaterThan(100)
})

test('data and AI specialists can run reproducible computation', () => {
  expect(personaTools('data').map((tool) => tool.name)).toContain('run_command')
  expect(personaTools('ai').map((tool) => tool.name)).toContain('run_command')
  expect(personaTools('data').map((tool) => tool.name)).toContain('read_spreadsheet')
})

test('cyber specialist receives scoped security tools and browser access', () => {
  const names = personaTools('cyber').map((tool) => tool.name)
  expect(names).toContain('new_engagement')
  expect(names).toContain('run_security_tool')
  expect(names).toContain('browser')
})

test('communications specialist can use the browser but has no shell tool', () => {
  const names = personaTools('communications').map((tool) => tool.name)
  expect(names).toContain('browser')
  expect(names).toContain('communication')
  expect(names).not.toContain('run_command')
})

test('automation specialist can coordinate browser and communication workflows', () => {
  const names = personaTools('automation').map((tool) => tool.name)
  expect(names).toContain('browser')
  expect(names).toContain('communication')
})

test('office specialists receive spreadsheet and presentation tools', () => {
  for (const persona of ['finance', 'business', 'data', 'research', 'automation'] as const) {
    const names = personaTools(persona).map((tool) => tool.name)
    expect(names).toContain('spreadsheet')
    expect(names).toContain('presentation')
  }
})

test('finance, data, and production specialists receive domain workflows', () => {
  expect(personaTools('finance').map((tool) => tool.name)).toContain('finance')
  expect(personaTools('data').map((tool) => tool.name)).toContain('data_science')
  const productionNames = personaTools('production').map((tool) => tool.name)
  expect(productionNames).toContain('production_readiness')
  expect(productionNames).toContain('project_profile')
})
