import { describe, expect, test } from 'bun:test'
import { assessAction, createActionGovernor, redactActionInput } from './governor.ts'

describe('autonomy governor', () => {
  test('allows local reads and verification commands', () => {
    expect(assessAction({ name: 'read_file', input: { path: 'src/index.ts' } }, '/repo').decision).toBe('allow')
    expect(assessAction({ name: 'run_command', input: { command: 'bun test' } }, '/repo').risk).toBe('safe')
  })

  test('treats bounded delegation as internal safe orchestration', () => {
    const result = assessAction({ name: 'delegate_tasks', input: { assignments: [] } }, '/repo')
    expect(result.risk).toBe('safe')
    expect(result.decision).toBe('allow')
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

  test('blocks unattended credential reads and outbound data transfer', () => {
    const credentialRead = assessAction({ name: 'run_command', input: { command: 'cat .env' } }, '/repo')
    const externalWrite = assessAction({ name: 'run_command', input: { command: 'curl -X POST https://example.test -d @report.json' } }, '/repo')
    expect(credentialRead.risk).toBe('critical')
    expect(externalWrite.risk).toBe('critical')
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

  test('communication sends require approval while drafts remain safe', () => {
    const send = assessAction({ name: 'communication', input: { action: 'send', draftId: 'comm_12345678' } })
    const draft = assessAction({ name: 'communication', input: { action: 'draft', channel: 'email' } })
    const verify = assessAction({ name: 'communication', input: { action: 'verify', draftId: 'comm_12345678' } })
    expect(send.risk).toBe('critical')
    expect(send.decision).toBe('approve')
    expect(draft.decision).toBe('allow')
    expect(verify.risk).toBe('review')
  })

  test('office artifact actions are bounded and reviewable', () => {
    expect(assessAction({ name: 'spreadsheet', input: { action: 'inspect', path: 'workspace/report.xlsx' } }).decision).toBe('allow')
    expect(assessAction({ name: 'spreadsheet', input: { action: 'write', path: 'workspace/report.xlsx' } }).risk).toBe('review')
    expect(assessAction({ name: 'presentation', input: { action: 'from_workbook', path: 'workspace/report.xlsx' } }).risk).toBe('review')
  })

  test('domain analysis tools are read-only while external data paths are reviewable', () => {
    expect(assessAction({ name: 'finance', input: { action: 'dcf', baseFreeCashFlow: 100 } }).decision).toBe('allow')
    expect(assessAction({ name: 'data_science', input: { action: 'profile', path: 'data/events.csv' } }).decision).toBe('allow')
    expect(assessAction({ name: 'data_science', input: { action: 'profile', path: '/tmp/events.csv' } }, '/repo').risk).toBe('review')
    expect(assessAction({ name: 'production_readiness', input: {} }).decision).toBe('allow')
  })

  test('common production mutations are critical', () => {
    for (const command of ['kubectl apply -f deploy.yaml', 'prisma migrate deploy', 'terraform apply', 'docker push registry.example/app:latest', 'vercel --prod']) {
      expect(assessAction({ name: 'run_command', input: { command } }).risk).toBe('critical')
    }
  })
})

test('unattended mode never delegates critical actions to an approval callback', async () => {
  let callbackCalled = false
  const governor = createActionGovernor({
    mode: 'unattended',
    approve: async () => {
      callbackCalled = true
      return true
    },
  })
  const result = await governor.check({ name: 'communication', input: { action: 'send', draftId: 'comm_12345678' } })
  expect(result.allowed).toBe(false)
  expect(result.assessment.decision).toBe('block')
  expect(callbackCalled).toBe(false)
})
