import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { auditSkills } from './audit.ts'
import { libraryHealth, readLibrary } from '../autonomy/certifiedLibrary.ts'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'elia-audit-'))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

test('the audit re-runs every tool\'s test and purges the ones that stopped passing', async () => {
  const library = join(dir, 'library.jsonl')
  for (const name of ['good', 'broken', 'gone']) {
    writeFileSync(join(dir, `${name}.skill.ts`), '')
    writeFileSync(join(dir, `${name}.skill.test.ts`), '')
  }
  const result = await auditSkills({
    skillsDir: dir,
    libraryFile: library,
    runTest: async (file) => !file.includes('broken'),
    toolName: async (file) => (file.includes('gone') ? undefined : file.includes('good') ? 'good_tool' : 'broken_tool'),
  })
  expect(result.audited).toBe(3)
  expect(result.kept).toEqual(['skill:good_tool'])
  expect(result.purged.sort()).toEqual(['skill:broken_tool', 'skill:gone'])
  const artifacts = readLibrary(library)
  expect(artifacts.get('skill:broken_tool')!.purgedByAudit).toBe(true)
  // Every audited tool is evidence for the slip rate, kept or purged.
  expect(libraryHealth(artifacts).slip.trials).toBe(3)
  expect(libraryHealth(artifacts).slip.successes).toBe(2)

  // A purged tool is not audited again.
  const again = await auditSkills({ skillsDir: dir, libraryFile: library, runTest: async () => true, toolName: async (file) => (file.includes('good') ? 'good_tool' : file.includes('broken') ? 'broken_tool' : undefined) })
  expect(again.audited).toBe(1)
})
