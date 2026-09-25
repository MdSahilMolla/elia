import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { withAgentIdentity } from '../autonomy/context.ts'
import { commandMayReadSensitiveData, isSensitivePath } from '../autonomy/sensitivePaths.ts'
import { battmannTool } from '../tools/battmann.ts'
import { clampClearance, modelBoundary, modelBoundaryTestHooks } from './modelBoundary.ts'

afterEach(() => {
  modelBoundaryTestHooks.override = undefined
})

const LOCAL = { ceiling: 'restricted' as const, allLocal: true, cloudRoutes: [] }
const CLOUD = { ceiling: 'internal' as const, allLocal: false, cloudRoutes: ['anthropic (claude-sonnet-5)'] }

test('a hosted provider makes the session a cloud session with the internal ceiling', () => {
  // The test run is configured with an Anthropic key, so at least one route is a cloud model.
  const boundary = modelBoundary()
  expect(boundary.allLocal).toBe(false)
  expect(boundary.ceiling).toBe('internal')
  expect(clampClearance(undefined, 'internal')).toBe('internal')
  expect(clampClearance('restricted', 'internal')).toBe('internal')
  expect(clampClearance('public', 'internal')).toBe('public')
})

test('in a cloud session, classified records neither enter nor leave through the tool', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'elia-battmann-boundary-'))
  const run = async (input: Record<string, unknown>) => JSON.parse(await withAgentIdentity({ name: 'test', role: 'lead', cwd }, () => battmannTool.execute(input)))
  const evidence = { action: 'register_evidence', title: 'Supplier contract', url: 'https://erp.example/contract', sourceType: 'primary', publishedAt: '2026-01-01', retrievedAt: '2026-01-02', excerpt: 'Terms.', independenceGroup: 'erp', reliability: 0.9 }
  const object = (id: string, securityClassification: string) => ({ action: 'upsert_object', objectId: id, objectType: 'organization', name: `Entity ${id}`, validFrom: '2026-01-05', confidence: 'high', evidenceIds: ['e1'], securityClassification })

  // Records written by a human or a local model.
  modelBoundaryTestHooks.override = LOCAL
  await run({ ...evidence, evidenceId: 'e1' })
  await run(object('open-co', 'internal'))
  await run(object('secret-co', 'restricted'))
  expect((await run({ action: 'list_objects' })).objects).toHaveLength(2)

  // The same store, reached from a session that can talk to a cloud model.
  modelBoundaryTestHooks.override = CLOUD
  const listed = await run({ action: 'list_objects', clearance: 'restricted' })
  expect(listed.objects.map((item: { id: string }) => item.id)).toEqual(['open-co'])
  await expect(run(object('new-secret', 'confidential'))).rejects.toThrow('refusing to record confidential content')
  await expect(run({ ...evidence, evidenceId: 'e2', securityClassification: 'restricted' })).rejects.toThrow('Run Battmann on a local model')
  expect((await run(object('new-open', 'public'))).status).toBe('created')
})

test('the store file is a protected path, so the tool is the only way in', () => {
  expect(isSensitivePath('.elia/battmann.sqlite')).toBe(true)
  expect(isSensitivePath('.elia/battmann-acme.sqlite-wal')).toBe(true)
  expect(isSensitivePath('src/battmann/store.ts')).toBe(false)
  expect(commandMayReadSensitiveData('sqlite3 .elia/battmann.sqlite "select * from evidence"')).toBe(true)
  expect(commandMayReadSensitiveData('strings .elia/battmann.sqlite')).toBe(true)
  expect(commandMayReadSensitiveData('bun test src/battmann')).toBe(false)
})
