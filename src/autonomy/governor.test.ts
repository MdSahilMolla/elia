import { describe, expect, test } from 'bun:test'
import { assessAction, createActionGovernor, redactActionInput } from './governor.ts'

describe('autonomy governor', () => {
  test('allows local reads and verification commands', () => {
    expect(assessAction({ name: 'read_file', input: { path: 'src/index.ts' } }, process.cwd()).decision).toBe('allow')
    expect(assessAction({ name: 'run_command', input: { command: 'bun test' } }, process.cwd()).risk).toBe('safe')
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

  test('fails closed for shell variants that are not provably read-only', () => {
    for (const command of [
      'rm -r -f target',
      'x=rm; $x -rf target',
      'python3 -c "import os; os.remove(\\"target\\")"',
      'git -c receive.denyCurrentBranch=ignore push origin HEAD',
    ]) {
      const result = assessAction({ name: 'run_command', input: { command } }, '/repo')
      expect(result.risk).toBe('critical')
      expect(result.decision).toBe('approve')
    }
  })

  test('allows only explicit bounded read-only shell commands', () => {
    for (const command of ['bun test', 'git status', 'ls -la', 'pwd']) {
      const result = assessAction({ name: 'run_command', input: { command } }, '/repo')
      expect(result.risk).toBe('safe')
      expect(result.decision).toBe('allow')
    }
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
    expect(assessAction({ name: 'data_science', input: { action: 'profile', path: '/tmp/events.csv' } }, '/repo').risk).toBe('critical')
    expect(assessAction({ name: 'production_readiness', input: {} }).decision).toBe('allow')
  })

  test('common production mutations are critical', () => {
    for (const command of ['kubectl apply -f deploy.yaml', 'prisma migrate deploy', 'terraform apply', 'docker push registry.example/app:latest', 'vercel --prod']) {
      expect(assessAction({ name: 'run_command', input: { command } }).risk).toBe('critical')
    }
  })

  test('deployment workflows keep preview reviewable and production critical', async () => {
    const preview = await createActionGovernor({ mode: 'unattended' }).check({
      name: 'deployment',
      input: { action: 'deploy', provider: 'vercel', target: 'preview' },
    })
    expect(preview.allowed).toBe(true)
    expect(preview.assessment.intent).toBe('deployment.preview')

    const production = await createActionGovernor({ mode: 'unattended' }).check({
      name: 'deployment',
      input: { action: 'deploy', provider: 'vercel', target: 'production' },
    })
    expect(production.allowed).toBe(false)
    expect(production.assessment.risk).toBe('critical')
    expect(production.message).toContain('unattended policy')
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

test('bounded action budget stops runaway unattended tool use', async () => {
  const governor = createActionGovernor({ mode: 'unattended', maxActions: 2 })
  expect((await governor.check({ name: 'read_file', input: { path: 'README.md' } })).allowed).toBe(true)
  expect((await governor.check({ name: 'list_files', input: { path: '.' } })).allowed).toBe(true)
  const exhausted = await governor.check({ name: 'grep', input: { pattern: 'goal', path: '.' } })
  expect(exhausted.allowed).toBe(false)
  expect(exhausted.assessment.decision).toBe('block')
  expect(exhausted.message).toContain('Action budget exhausted')
  expect(governor.stats()).toEqual({ maxActions: 2, consumed: 2, exhausted: true, blockedByBudget: 1 })
})

test('every registered tool declares a governor contract', async () => {
  // A tool with no contract falls through to the fail-closed "unknown tool"
  // branch, so the first real run that reaches for it stalls on an approval
  // prompt instead of working. That shipped twice — once for the cyber tools,
  // once for the research tools — so it is asserted across the whole registry
  // rather than tool by tool.
  const { allWorkerTools, businessTools, cyberTools } = await import('../tools/registry.ts')
  const { taskTool } = await import('../tools/task.ts')
  const { previewTool } = await import('../tools/preview.ts')

  const undeclared = [...allWorkerTools(), ...businessTools, ...cyberTools, taskTool, previewTool]
    .filter((tool) => assessAction({ name: tool.name, input: {} }).reason.includes('no declared safety contract'))
    .map((tool) => tool.name)

  expect(undeclared).toEqual([])
})

test('a genuinely unknown tool still fails closed', () => {
  const assessment = assessAction({ name: 'not_a_real_tool', input: {} })
  expect(assessment.risk).toBe('critical')
  expect(assessment.decision).toBe('approve')
  expect(assessment.reason).toContain('no declared safety contract')
})

test('a proxied MCP tool gets its own explicit fail-closed contract, not the generic unknown-tool one', () => {
  const assessment = assessAction({ name: 'mcp_github_create_issue', input: {} })
  expect(assessment.risk).toBe('critical')
  expect(assessment.decision).toBe('approve')
  expect(assessment.reversible).toBe(false)
  expect(assessment.reason).toContain('third-party MCP server')
  expect(assessment.reason).not.toContain('no declared safety contract')
})

test('research tools are allowed while consequential actions still need approval', () => {
  expect(assessAction({ name: 'web_search', input: { query: 'x' } }).decision).toBe('allow')
  expect(assessAction({ name: 'web_fetch', input: { url: 'https://example.com' } }).decision).toBe('allow')
  expect(assessAction({ name: 'run_security_tool', input: {} }).decision).toBe('approve')
  expect(assessAction({ name: 'communication', input: { action: 'send' } }).decision).toBe('approve')
  expect(assessAction({ name: 'browser', input: { action: 'click' } }).decision).toBe('approve')
})
