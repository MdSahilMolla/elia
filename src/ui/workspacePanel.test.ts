import { expect, test } from 'bun:test'
import { renderWorkspacePanel } from './workspacePanel.ts'

test('normal readline workspace renders the right-side workspace inspector', () => {
  const output = renderWorkspacePanel({ sessionId: 'session-test', mode: 'dev', providerLabel: 'Mercury', model: 'mercury-2' })
  expect(output).toContain('Workspace')
  expect(output).toContain('CHATS')
  expect(output).toContain('PLAN')
  expect(output).toContain('SUBAGENTS')
  expect(output).toContain('ARTIFACTS')
  expect(output).toContain('session-test')
})

test('the Ink /status is plain aligned rows — no frames, no colour codes', async () => {
  const { renderWorkspaceStatus } = await import('./workspacePanel.ts')
  const output = renderWorkspaceStatus({ sessionId: 'session-test', mode: 'dev', providerLabel: 'Mercury', model: 'mercury-2' })
  const lines = output.split('\n')
  expect(lines[0]).toBe('elia · dev')
  expect(output).toContain('model     Mercury · mercury-2')
  expect(output).toContain('session   session-test')
  expect(output).not.toMatch(/[╭╮╰╯│┌┐└┘]/)
  expect(output).not.toContain('\u001b[')
  // The empty-plan hint points at something that exists.
  expect(output).not.toMatch(/\/plan(?!\s*<)/)
})
