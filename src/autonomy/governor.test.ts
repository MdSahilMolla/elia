import { describe, expect, test } from 'bun:test'
import { assessAction, createActionGovernor, redactActionInput } from './governor.ts'

describe('autonomy governor', () => {
  test('allows local reads and verification commands', () => {
    expect(assessAction({ name: 'read_file', input: { path: 'src/index.ts' } }, '/repo').decision).toBe('allow')
    expect(assessAction({ name: 'run_command', input: { command: 'bun test' } }, '/repo').risk).toBe('safe')
  })

  test('classifies dependency installation as reversible review work', () => {
    const result = assessAction({ name: 'run_command', input: { command: 'bun install' } }, '/repo')
    expect(result.risk).toBe('review')
    expect(result.reversible).toBe(true)
  })

  test('classifies destructive and external commands as critical', () => {
    const result = assessAction({ name: 'run_command', input: { command: 'git push --force origin main' } }, '/repo')
    expect(result.risk).toBe('critical')
    expect(result.decision).toBe('approve')
  })

  test('allows review work in unattended mode but blocks critical work without approval', async () => {
    const governor = createActionGovernor({ mode: 'unattended' })
    expect((await governor.check({ name: 'run_command', input: { command: 'bun install' } })).allowed).toBe(true)
    const blocked = await governor.check({ name: 'run_command', input: { command: 'rm -rf /tmp/example' } })
    expect(blocked.allowed).toBe(false)
    expect(blocked.assessment.decision).toBe('block')
  })

  test('serializes approvals and records the exact request', async () => {
    const requests: string[] = []
    const governor = createActionGovernor({
      mode: 'supervised',
      approve: async (_assessment, request) => {
        requests.push(String(request.input.command))
        await Bun.sleep(2)
        return true
      },
    })
    const results = await Promise.all([
      governor.check({ name: 'run_command', input: { command: 'git commit -am change-a' } }),
      governor.check({ name: 'run_command', input: { command: 'git commit -am change-b' } }),
    ])
    expect(results.every((result) => result.allowed)).toBe(true)
    expect(requests).toEqual(['git commit -am change-a', 'git commit -am change-b'])
  })

  test('treats browser reads differently from browser mutations', () => {
    expect(assessAction({ name: 'browser', input: { action: 'snapshot' } }).risk).toBe('safe')
    expect(assessAction({ name: 'browser', input: { action: 'click', target: 'Publish' } }).risk).toBe('critical')
  })

  test('redacts credentials and browser text while keeping useful context', () => {
    expect(redactActionInput('run_command', { command: 'curl', apiKey: 'secret', path: 'src/app.ts' })).toEqual({
      command: 'curl',
      apiKey: '[REDACTED]',
      path: 'src/app.ts',
    })
    expect(redactActionInput('browser', { action: 'type', text: 'my password' })).toEqual({
      action: 'type',
      text: '[REDACTED]',
    })
  })
})
