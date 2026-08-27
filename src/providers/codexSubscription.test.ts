import { expect, test } from 'bun:test'
import { buildCodexSubscriptionPrompt, parseCodexSubscriptionModels } from './codexSubscription.ts'

test('Codex subscription prompt preserves the user conversation but excludes tool instructions', () => {
  const prompt = buildCodexSubscriptionPrompt('system rules', [
    { role: 'user', content: [{ type: 'text', text: 'explain this file' }] },
    { role: 'assistant', content: [{ type: 'tool_use', id: 'call_1', name: 'run_command', input: { command: 'dir' } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_1', content: 'listing', is_error: false }] },
  ])

  expect(prompt).toContain('system rules')
  expect(prompt).toContain('user:\nexplain this file')
  expect(prompt).toContain('user:\nlisting')
  expect(prompt).not.toContain('run_command')
  expect(prompt).toContain('Elia requested Codex model: default')
  expect(prompt).toContain('Do not modify files or execute commands')
})

test('Codex subscription models use the account-provided execution slug and display name', () => {
  expect(parseCodexSubscriptionModels({
    data: [
      { id: 'picker-id', model: 'gpt-5.3-codex', displayName: 'GPT-5.3 Codex', description: 'Best for coding', isDefault: true },
      { id: 'no-slug' },
    ],
  })).toEqual([{ id: 'gpt-5.3-codex', name: 'GPT-5.3 Codex', description: 'Best for coding', isDefault: true }])
})
