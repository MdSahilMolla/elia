import { expect, test } from 'bun:test'
import { fileURLToPath } from 'node:url'
import { CodexAppServerClient } from './codexAppServer.ts'
import type { ProviderActivity } from './types.ts'

test('Codex app-server reuses one connection and streams consecutive turns', async () => {
  const fixture = fileURLToPath(new URL('./fixtures/codexAppServer.ts', import.meta.url))
  const client = new CodexAppServerClient([process.execPath, fixture])

  try {
    await client.connect()
    const models = await client.request('model/list', { includeHidden: false })
    expect(models).toEqual({ data: [{ model: 'fixture-model', displayName: 'Fixture Model' }] })
    const thread = await client.request('thread/start', {}) as { thread: { id: string } }

    const text: string[] = []
    const thinking: string[] = []
    const activities: ProviderActivity[] = []
    const first = await client.runTurn({
      threadId: thread.thread.id,
      text: 'first',
      cwd: process.cwd(),
      onText: (delta) => text.push(delta),
      onThinking: (delta) => thinking.push(delta),
      onActivity: (activity) => activities.push(activity),
    })
    const second = await client.runTurn({
      threadId: thread.thread.id,
      text: 'second',
      cwd: process.cwd(),
      onText: (delta) => text.push(delta),
    })

    expect(text).toEqual(['done:first', 'done:second'])
    expect(thinking).toEqual(['checking'])
    expect(activities.map((activity) => activity.title)).toEqual([
      'Starting Codex turn',
      'Plan updated',
      'Running command',
      'Command output',
      'Command output',
      'Command completed',
      'Changing files',
      'Workspace diff updated',
      'File changes completed',
      'Model rerouted: fixture-model → fixture-fast',
      'Codex warning',
      'Codex turn completed',
    ])
    expect(activities.find((activity) => activity.title === 'Plan updated')?.detail).toContain('[active] Inspect files')
    expect(activities.filter((activity) => activity.kind === 'command_output').map((activity) => activity.detail)).toEqual(['one line', 'partial output'])
    expect(activities.find((activity) => activity.kind === 'file_change')?.detail).toContain('index.html')
    expect(activities.find((activity) => activity.kind === 'diff')?.detail).toContain('+<main>Elia</main>')
    expect(first).toEqual({
      text: 'done:first',
      usage: { inputTokens: 10, outputTokens: 4, cacheReadTokens: 5, cacheWriteTokens: 2 },
    })
    expect(second.text).toBe('done:second')
  } finally {
    await client.closeAndWait()
  }
})
