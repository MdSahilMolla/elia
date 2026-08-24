import { expect, test } from 'bun:test'
import { BATTMANN_SUBAGENT_SYSTEM_PROMPT, BATTMANN_SYSTEM_PROMPT } from './config.ts'
import { activeMode, setActiveMode, type AgentMode } from './autonomy/mode.ts'
import { allWorkerTools, businessTools } from './tools/registry.ts'
import { assessAction } from './autonomy/governor.ts'

test('battmann is a selectable agent mode', () => {
  const previous = activeMode()
  const mode: AgentMode = 'battmann'
  setActiveMode(mode)
  expect(activeMode()).toBe('battmann')
  setActiveMode(previous)
})

test('the battmann prompt covers all six intelligence domains', () => {
  const prompt = BATTMANN_SYSTEM_PROMPT.toLowerCase()
  for (const domain of ['trade', 'geopolitic', 'financial', 'supply chain', 'policy', 'commodity']) {
    expect(prompt).toContain(domain)
  }
})

test('the battmann prompt states the five questions every analysis must answer', () => {
  const prompt = BATTMANN_SYSTEM_PROMPT.toLowerCase()
  expect(prompt).toContain('what is happening')
  expect(prompt).toContain('why is it happening')
  expect(prompt).toContain('what may happen next')
  expect(prompt).toContain('how likely is it')
  expect(prompt).toContain('what needs attention')
})

test('the battmann prompt forbids fabricating intelligence and requires labelled confidence', () => {
  const prompt = BATTMANN_SYSTEM_PROMPT.toLowerCase()
  // Rigour is the product: an invented score is worse than an absent one.
  expect(prompt).toContain('never invent')
  expect(prompt).toContain('confidence')
  expect(prompt).toContain('model estimate')
  expect(prompt).toContain('untrusted data')
  // It analyses; it does not advise on trades or profile private individuals.
  expect(prompt).toContain('not a licensed financial')
  expect(prompt).toContain('private individuals')
})

test('the battmann sub-agent prompt carries the same no-fabrication guardrails', () => {
  const prompt = BATTMANN_SUBAGENT_SYSTEM_PROMPT.toLowerCase()
  expect(prompt).toContain('never invent')
  expect(prompt).toContain('confidence')
  expect(prompt).toContain('untrusted data')
})

test('battmann mode supplies the external-evidence tools the base worker set lacks', () => {
  const base = allWorkerTools().map((tool) => tool.name)
  const added = businessTools.map((tool) => tool.name).filter((name) => !base.includes(name))
  // Without these an intelligence brief could only be guesswork.
  expect(added).toContain('web_search')
  expect(added).toContain('web_fetch')
  expect(added).toContain('presentation')
})

test('every tool battmann mode adds has a declared governor contract', () => {
  // A tool with no contract falls through to the fail-closed "unknown tool"
  // branch and blocks on an approval prompt mid-run, which is what happened the
  // first time this mode shipped. Assert the real decision, never just that one exists.
  for (const tool of businessTools) {
    const result = assessAction({ name: tool.name, input: {} })
    expect(result.reason).not.toContain('no declared safety contract')
  }
  expect(assessAction({ name: 'web_search', input: { query: 'x' } }).decision).toBe('allow')
  expect(assessAction({ name: 'web_fetch', input: { url: 'https://example.com' } }).decision).toBe('allow')
  expect(assessAction({ name: 'read_spreadsheet', input: {} }).decision).toBe('allow')
})

test('battmann research tools stay inside the existing approval boundaries', () => {
  // Adding a mode must never hand it a softer governor than any other mode.
  expect(assessAction({ name: 'communication', input: { action: 'send' } }).decision).toBe('approve')
  expect(assessAction({ name: 'browser', input: { action: 'click' } }).decision).toBe('approve')
  expect(assessAction({ name: 'read_spreadsheet', input: { path: 'C:/Windows/secret.xlsx' } }).decision).toBe('approve')
})
