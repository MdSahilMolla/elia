import { expect, test } from 'bun:test'
import { DATASCIENCE_SUBAGENT_SYSTEM_PROMPT, DATASCIENCE_SYSTEM_PROMPT, systemPromptForMode } from './config.ts'
import { activeMode, setActiveMode, type AgentMode } from './autonomy/mode.ts'
import { assessAction } from './autonomy/governor.ts'
import { builtinCapabilityContracts } from './autonomy/capabilityContract.ts'
import { allBuiltinTools, datascienceTools, readOnlyDatascienceTools } from './tools/registry.ts'
import { capabilitiesFor, type DsTool } from './datascience/engine.ts'
import { DATASCIENCE_TOOLS, EFFECTS } from './datascience/effects.ts'
import { isProtectedSecret } from './datascience/secrets.ts'
import { loadSource } from './datascience/ingest.ts'

test('datascience is a selectable core mode with its own prompt', () => {
  const previous = activeMode()
  const mode: AgentMode = 'datascience'
  setActiveMode(mode)
  expect(activeMode()).toBe('datascience')
  setActiveMode(previous)
  expect(systemPromptForMode('datascience')).toBe(DATASCIENCE_SYSTEM_PROMPT)
})

test('the data-science prompt carries the loop, the priorities, and the delivery format', () => {
  const prompt = DATASCIENCE_SYSTEM_PROMPT
  expect(prompt).toContain('UNDERSTAND → INSPECT → PLAN → EXECUTE → VALIDATE → ANALYZE → ITERATE → EXPLAIN → DELIVER')
  expect(prompt).toContain('correctness, validation, reproducibility, scientific rigour, interpretability, performance, presentation')
  expect(prompt).toContain('Objective · Data · Method · Results · Validation · Limitations · Artifacts')
})

test('the data-science prompt forbids fabrication and holds the rigour lines', () => {
  const prompt = DATASCIENCE_SYSTEM_PROMPT.toLowerCase()
  expect(prompt).toContain('never fabricate data, calculations, model results, statistical significance, forecasts, causal relationships, or conclusions')
  expect(prompt).toContain('never turn correlation into causation')
  expect(prompt).toContain('code that ran without an exception is not a validated result')
  expect(prompt).toContain('grain')
  expect(prompt).toContain('leakage')
  expect(prompt).toContain('prediction intervals')
  expect(prompt).toContain('do not infer sensitive attributes')
  expect(prompt).toContain('untrusted data')
  // Power BI honesty: a PBIP project, never a fake .pbix.
  expect(prompt).toContain('never create or describe a fake .pbix')
  // Oversight: consequential actions are prepared and asked about, not taken.
  expect(prompt).toContain('never delete data, overwrite a production dataset, modify a production database, deploy a model')
  expect(prompt).toContain('never ask the user to paste a secret')
})

test('the data-science sub-agent prompt carries the same guardrails', () => {
  const prompt = DATASCIENCE_SUBAGENT_SYSTEM_PROMPT.toLowerCase()
  expect(prompt).toContain('run id')
  expect(prompt).toContain('"failed" is not a finding')
  expect(prompt).toContain('never turn correlation into causation')
  expect(prompt).toContain('untrusted data')
  expect(prompt).toContain('production system')
})

test('every ds_* tool is registered, contracted, and exposes every action in effects.ts', () => {
  const names = allBuiltinTools().map((tool) => tool.name)
  const contracts = new Set(builtinCapabilityContracts().map((contract) => contract.tool))
  for (const tool of DATASCIENCE_TOOLS) {
    expect(names).toContain(tool)
    expect(contracts.has(tool)).toBe(true)
  }
  const registered = DATASCIENCE_TOOLS.flatMap((tool) => capabilitiesFor(tool as DsTool).map((capability) => `${tool}.${capability.action}`)).sort()
  expect(registered).toEqual(Object.keys(EFFECTS).sort())
  expect(datascienceTools.map((tool) => tool.name)).toEqual([...DATASCIENCE_TOOLS])
})

test('analysis and workspace-local writes run without asking', () => {
  const allow = (name: string, input: Record<string, unknown>) => expect(assessAction({ name, input }).decision).toBe('allow')
  allow('ds_data', { action: 'load', name: 'orders', path: 'data/orders.csv' })
  allow('ds_data', { action: 'inspect', dataset: 'orders' })
  allow('ds_data', { action: 'transform', dataset: 'orders', steps: [] })
  allow('ds_data', { action: 'export', dataset: 'orders' })
  allow('ds_data', { action: 'load', name: 'rates', url: 'https://api.example.com/rates.json' })
  allow('ds_stats', { action: 'test', dataset: 'orders' })
  allow('ds_ml', { action: 'train', dataset: 'orders', target: 'churn' })
  allow('ds_timeseries', { action: 'forecast', dataset: 'sales' })
  allow('ds_report', { action: 'powerbi', datasets: ['orders'] })
  allow('ds_python', { action: 'capabilities' })
})

test('live databases, credentials, code, installs, and project writes ask first', () => {
  const decide = (name: string, input: Record<string, unknown>) => assessAction({ name, input })
  expect(decide('ds_data', { action: 'load', name: 'o', connection: 'postgres', dsnEnv: 'WAREHOUSE_URL', query: 'select 1' }).decision).toBe('approve')
  expect(decide('ds_data', { action: 'schema', connection: 'snowflake', dsnEnv: 'SNOW' }).decision).toBe('approve')
  const credentialed = decide('ds_data', { action: 'load', name: 'o', url: 'https://api.example.com/x', headers: { Authorization: 'Bearer ${API_TOKEN}' } })
  expect(credentialed.decision).toBe('approve')
  expect(credentialed.reason).toContain('$API_TOKEN')
  expect(credentialed.reason).toContain('api.example.com')
  expect(decide('ds_data', { action: 'load', name: 'o', urlEnv: 'SAS_URL' }).decision).toBe('approve')
  expect(decide('ds_data', { action: 'load', name: 'o', url: 's3://bucket/key.csv' }).decision).toBe('approve')
  expect(decide('ds_data', { action: 'load', name: 'o', url: 'http://localhost:8080/x', allowLocal: true }).decision).toBe('approve')
  expect(decide('ds_data', { action: 'export', dataset: 'orders', path: 'out/orders.csv' }).decision).toBe('approve')
  expect(decide('ds_python', { action: 'run', code: 'emit(1)' }).decision).toBe('approve')
  const secretCode = decide('ds_python', { action: 'run', code: "open('.env').read()" })
  expect(secretCode.risk).toBe('critical')
  expect(decide('ds_python', { action: 'run', code: "p = Path.home() / '.aws' / 'credentials'" }).risk).toBe('critical')
  // Ordinary analysis code that merely touches os.environ or tokenizes text is not escalated.
  expect(decide('ds_python', { action: 'run', code: "import os\nn = os.environ.get('OMP_NUM_THREADS')\ntokens = text.split()" }).risk).toBe('review')
  const install = decide('ds_python', { action: 'setup', profile: 'ml' })
  expect(install.decision).toBe('approve')
  expect(install.risk).toBe('critical')
  const outside = decide('ds_data', { action: 'load', name: 'o', path: '../elsewhere/orders.csv' })
  expect(outside.risk).toBe('critical')
})

test('a read-only worker gets only computation actions, enforced at execution', async () => {
  const readOnlyActions = readOnlyDatascienceTools.flatMap((tool) => ((tool.input_schema.properties.action as { enum: string[] }).enum).map((action) => `${tool.name}.${action}`))
  expect(readOnlyActions.length).toBeGreaterThan(20)
  for (const key of readOnlyActions) expect(EFFECTS[key]).toBe('compute')
  expect(readOnlyDatascienceTools.some((tool) => tool.name === 'ds_python')).toBe(false)
  const ml = readOnlyDatascienceTools.find((tool) => tool.name === 'ds_ml')!
  await expect(ml.execute({ action: 'train', dataset: 'x', target: 'y' })).rejects.toThrow('read-only')
})

test("elia's own credentials are never forwardable; a data source's are", () => {
  for (const name of ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GITHUB_TOKEN', 'GH_TOKEN', 'ELIA_API_KEY', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN', 'VERCEL_TOKEN']) {
    expect(isProtectedSecret(name)).toBe(true)
  }
  for (const name of ['WAREHOUSE_URL', 'WEATHER_API_KEY', 'SHOP_API_TOKEN']) expect(isProtectedSecret(name)).toBe(false)
})

test('ingestion refuses to put an elia credential into a request header or connection', async () => {
  // Refused before any socket opens, so the endpoint here is never contacted.
  await expect(loadSource({ url: 'https://api.example.com/data.json', headers: { Authorization: 'Bearer ${ANTHROPIC_API_KEY}' } })).rejects.toThrow('never forwarded')
  await expect(loadSource({ connection: 'postgres', dsnEnv: 'GITHUB_TOKEN', query: 'select 1' })).rejects.toThrow('never forwarded')
})
