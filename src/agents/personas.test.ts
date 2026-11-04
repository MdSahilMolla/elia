import { expect, test } from 'bun:test'
import { personaPrompt, personaTools } from './personas.ts'
import { AGENT_PERSONAS } from './types.ts'

test('every registered specialist has a non-empty prompt', () => {
  for (const persona of AGENT_PERSONAS) expect(personaPrompt(persona).length).toBeGreaterThan(100)
})

test('data and AI specialists can run reproducible computation', () => {
  expect(personaTools('data').map((tool) => tool.name)).toContain('run_command')
  expect(personaTools('data').map((tool) => tool.name)).toContain('run_program')
  expect(personaTools('ai').map((tool) => tool.name)).toContain('run_command')
  expect(personaTools('ai').map((tool) => tool.name)).toContain('run_program')
  expect(personaTools('data').map((tool) => tool.name)).toContain('read_spreadsheet')
})

test('cyber persona directs its own work instead of deferring to the user', () => {
  const prompt = personaPrompt('cyber')
  // The loop has to be named so the agent knows what "done" is, and the
  // no-question rule is what stops a one-shot run from stalling on a
  // methodology check-in. Both are the whole point of the mode, so pin them.
  expect(prompt).toContain('iterate past dead ends')
  expect(prompt).toContain('Never end a turn by asking')
  // Scope is retained as a boundary even though the prompting is autonomous.
  expect(prompt).toContain('engagement')
  expect(prompt).toContain('evidence')
})

test('cyber persona drops its own refusal list', () => {
  // The persona's hardcoded guardrail list ("Refuse destructive, stealth,
  // denial-of-service, credential theft, mass scanning, or persistence
  // activity") is what used to stop a legitimate solve on a self-check, so it
  // is gone. These are persona-specific phrases; the same concepts still reach
  // the prompt through AGENTS.md in SHARED_CONTEXT, which is repository
  // guidance for every mode and deliberately not duplicated or removed here.
  const prompt = personaPrompt('cyber')
  expect(prompt).not.toContain('Guardrails:')
  expect(prompt).not.toContain('credential theft')
  expect(prompt).not.toContain('denial-of-service, credential theft')
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

test('automation specialist can coordinate browser, communication, and deployment workflows', () => {
  const names = personaTools('automation').map((tool) => tool.name)
  expect(names).toContain('browser')
  expect(names).toContain('communication')
  expect(names).toContain('deployment')
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
  expect(productionNames).toContain('deployment')
})

test('sports specialist receives evidence and analysis tools', () => {
  const names = personaTools('sports').map((tool) => tool.name)
  expect(names).toContain('data_science')
  expect(names).toContain('read_spreadsheet')
  expect(names).toContain('browser')
  expect(personaPrompt('sports')).toContain('never fabricate scores')
})

test('fitness specialist receives tracking tools and conservative safety guidance', () => {
  const names = personaTools('fitness').map((tool) => tool.name)
  expect(names).toContain('data_science')
  expect(names).toContain('read_spreadsheet')
  expect(names).not.toContain('run_command')
  expect(personaPrompt('fitness')).toContain('not a doctor')
})
