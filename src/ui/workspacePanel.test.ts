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
