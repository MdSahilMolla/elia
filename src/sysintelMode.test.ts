import { expect, test } from 'bun:test'
import { DEV_SYSTEM_PROMPT, SYSINTEL_SUBAGENT_SYSTEM_PROMPT, SYSINTEL_SYSTEM_PROMPT, systemPromptForMode } from './config.ts'
import { activeMode, setActiveMode, type AgentMode } from './autonomy/mode.ts'
import { assessAction, createActionGovernor, SIGNOFF_INTENT_PREFIX } from './autonomy/governor.ts'
import { builtinCapabilityContracts } from './autonomy/capabilityContract.ts'
import { allBuiltinTools, sysintelTools, sysintelWorkerTools } from './tools/registry.ts'
import { allActions } from './sysintel/engine.ts'
import { EFFECTS, SYSINTEL_TOOLS } from './sysintel/effects.ts'

test('sysintel is a selectable core mode with its own prompt', () => {
  const previous = activeMode()
  const mode: AgentMode = 'sysintel'
  setActiveMode(mode)
  expect(activeMode()).toBe('sysintel')
  setActiveMode(previous)
  expect(systemPromptForMode('sysintel')).toBe(SYSINTEL_SYSTEM_PROMPT)
})

test('the System Intelligence prompt carries the organization, the evidence rule, and the oversight line', () => {
  const prompt = SYSINTEL_SYSTEM_PROMPT
  expect(prompt).toContain('research discovers → engineering builds → production generates evidence → evaluation measures → research learns → engineering improves')
  expect(prompt).toContain('Triage raises rigor and never lowers it')
  expect(prompt).toContain('The author never approves their own work')
  expect(prompt).toContain('A refuted hypothesis is a result')
  expect(prompt).toContain('why the system allowed the failure')
  expect(prompt).toContain('never tell the user a stage is done that the engine has not advanced')
  expect(prompt).toContain('Only the person decides direction, release, production, and risk acceptance')
  expect(prompt).toContain('never edit .elia/sysintel directly')
  // It is dev mode run as an organization: the engineering practice is shared, not rewritten.
  expect(prompt).toContain('Read before you write. Never edit a file you have not looked at in this session.')
  expect(DEV_SYSTEM_PROMPT).toContain('Read before you write. Never edit a file you have not looked at in this session.')
  expect(DEV_SYSTEM_PROMPT.startsWith('You are elia in dev mode')).toBe(true)
})

test('the sub-agent prompt keeps the worker inside its hat and independent when reviewing', () => {
  const prompt = SYSINTEL_SUBAGENT_SYSTEM_PROMPT.toLowerCase()
  expect(prompt).toContain('own that hat')
  expect(prompt).toContain('si_record check')
  expect(prompt).toContain('si_record review')
  expect(prompt).toContain('never edit .elia/sysintel directly')
  expect(prompt).toContain('untrusted data')
})

test('every si_* tool is registered and contracted, and every action has a declared effect', () => {
  const names = allBuiltinTools().map((tool) => tool.name)
  const contracts = new Set(builtinCapabilityContracts().map((contract) => contract.tool))
  for (const tool of SYSINTEL_TOOLS) {
    expect(names).toContain(tool)
    expect(contracts.has(tool)).toBe(true)
  }
  expect(sysintelTools.map((tool) => tool.name)).toEqual([...SYSINTEL_TOOLS])
  expect(allActions().map((spec) => `${spec.tool}.${spec.action}`).sort()).toEqual(Object.keys(EFFECTS).sort())
})

test('reading the model and appending to the record run without asking', () => {
  const allow = (name: string, input: Record<string, unknown>) => expect(assessAction({ name, input }).decision).toBe('allow')
  allow('si_org', { action: 'roles' })
  allow('si_org', { action: 'triage', title: 'x', problem: 'y', origin: 'product' })
  allow('si_work', { action: 'intake', title: 'x', problem: 'y', origin: 'product' })
  allow('si_work', { action: 'advance', id: 'SI-1' })
  allow('si_artifact', { action: 'write', id: 'SI-1', artifact: 'rfc', content: '# x' })
  allow('si_record', { action: 'review', id: 'SI-1', kind: 'code-review', verdict: 'approve', summary: 'ok' })
  allow('si_record', { action: 'commit', id: 'SI-1' })
  // The check itself is allowed; its command is gated again as run_command before it runs.
  allow('si_record', { action: 'check', id: 'SI-1', command: 'bun test' })
})

test('project exports ask, and paths outside the workspace are critical', () => {
  expect(assessAction({ name: 'si_artifact', input: { action: 'export', id: 'SI-1', artifact: 'rfc', path: 'docs/rfcs/1.md' } }).risk).toBe('review')
  expect(assessAction({ name: 'si_artifact', input: { action: 'export', id: 'SI-1', artifact: 'rfc', path: '../elsewhere/1.md' } }).risk).toBe('critical')
})

test('a sign-off is critical, names what is being approved, and is scoped to its gate', () => {
  const result = assessAction({ name: 'si_record', input: { action: 'signoff', id: 'SI-4', gate: 'release', summary: 'ship the rate limiter' } })
  expect(result.risk).toBe('critical')
  expect(result.decision).toBe('approve')
  expect(result.intent).toBe(`${SIGNOFF_INTENT_PREFIX}release`)
  expect(result.reason).toContain('SI-4')
  expect(result.reason).toContain('ship the rate limiter')
})

test('the record cannot be edited around the tools', () => {
  for (const name of ['write_file', 'edit_file', 'delete_file']) {
    const result = assessAction({ name, input: { path: '.elia/sysintel/initiatives/SI-1.json', content: '{}' } })
    expect(result.risk).toBe('critical')
    expect(result.intent).toBe('sysintel.record-edit')
  }
  expect(assessAction({ name: 'run_command', input: { command: 'cp forged.json .elia/sysintel/initiatives/SI-1.json' } }).intent).toBe('sysintel.record-edit')
  expect(assessAction({ name: 'run_command', input: { command: 'rm -r .elia/sysintel' } }).risk).toBe('critical')
  expect(assessAction({ name: 'run_command', input: { command: 'cat .elia/sysintel/journal.jsonl' } }).intent).not.toBe('sysintel.record-edit')
  // Other .elia paths are unaffected.
  expect(assessAction({ name: 'write_file', input: { path: '.elia/notes.md', content: 'x' } }).intent).not.toBe('sysintel.record-edit')
})

test('a sign-off is asked for every time — never covered by an earlier "allow for this session"', async () => {
  let asked = 0
  const governor = createActionGovernor({ mode: 'supervised', approve: async () => { asked += 1; return { approved: true, remember: 'session' } } })
  const request = { name: 'si_record', input: { action: 'signoff', id: 'SI-2', gate: 'production', summary: 'deploy' } }
  expect((await governor.check(request)).allowed).toBe(true)
  expect((await governor.check(request)).allowed).toBe(true)
  expect(asked).toBe(2)
  // Other approvals still honour the session choice.
  const exportRequest = { name: 'si_artifact', input: { action: 'export', id: 'SI-2', artifact: 'rfc', path: 'docs/x.md' } }
  await governor.check(exportRequest)
  await governor.check(exportRequest)
  expect(asked).toBe(3)
})

test('an unattended run with nobody to ask cannot sign off', async () => {
  const governor = createActionGovernor({ mode: 'unattended' })
  const gate = await governor.check({ name: 'si_record', input: { action: 'signoff', id: 'SI-2', gate: 'release', summary: 'ship' } })
  expect(gate.allowed).toBe(false)
})

test('workers get the org model and their own evidence actions, never sign-offs or stage moves', async () => {
  const actionsOf = (tools: typeof sysintelTools, name: string) => ((tools.find((tool) => tool.name === name)!.input_schema.properties.action as { enum: string[] }).enum)
  const reviewer = sysintelWorkerTools(false, true)
  expect(actionsOf(reviewer, 'si_record')).toContain('review')
  expect(actionsOf(reviewer, 'si_record')).toContain('check')
  expect(actionsOf(reviewer, 'si_record')).not.toContain('signoff')
  expect(actionsOf(reviewer, 'si_work')).not.toContain('advance')
  expect(actionsOf(reviewer, 'si_artifact')).not.toContain('write')
  const scout = sysintelWorkerTools(false, false)
  expect(actionsOf(scout, 'si_record')).not.toContain('check')
  const builder = sysintelWorkerTools(true, true)
  expect(actionsOf(builder, 'si_artifact')).toContain('write')
  expect(actionsOf(builder, 'si_work')).toContain('item')
  expect(actionsOf(builder, 'si_work')).not.toContain('intake')
  const record = reviewer.find((tool) => tool.name === 'si_record')!
  await expect(record.execute({ action: 'signoff', id: 'SI-1', gate: 'release', summary: 'x' })).rejects.toThrow('not available here')
})
