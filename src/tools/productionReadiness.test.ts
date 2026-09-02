import { afterAll, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { withAgentIdentity } from '../autonomy/context.ts'
import { productionReadinessTool } from './productionReadiness.ts'

const testDir = mkdtempSync(join(tmpdir(), 'elia-production-readiness-'))
mkdirSync(join(testDir, '.github', 'workflows'), { recursive: true })
mkdirSync(join(testDir, 'migrations'), { recursive: true })
mkdirSync(join(testDir, 'src', 'observability'), { recursive: true })
writeFileSync(join(testDir, 'package.json'), '{"scripts":{"test":"bun test","build":"bun build src/index.ts"}}\n')
writeFileSync(join(testDir, '.env.example'), 'DATABASE_URL=\n')
writeFileSync(join(testDir, '.gitignore'), '.env\n')
writeFileSync(join(testDir, 'Dockerfile'), 'FROM oven/bun\n')
writeFileSync(join(testDir, '.github', 'workflows', 'ci.yml'), 'name: CI\n')
writeFileSync(join(testDir, 'migrations', '001-init.sql'), 'create table accounts(id integer);\n')
writeFileSync(join(testDir, 'src', 'observability', 'health.ts'), 'export const health = true\n')

function runInTestRoot(): Promise<string> {
  return withAgentIdentity({ name: 'test', role: 'lead', cwd: testDir }, () => productionReadinessTool.execute({}))
}

test('production readiness detects delivery evidence without claiming deployment success', async () => {
  const result = JSON.parse(await runInTestRoot()) as { action: string; readiness: string; score: number; checks: Array<{ id: string; status: string }>; limitations: string[] }
  expect(result.action).toBe('production_readiness')
  expect(result.score).toBeGreaterThan(0)
  expect(result.readiness).toBe('ready-for-staging-review')
  expect(result.checks.find((check) => check.id === 'ci')?.status).toBe('pass')
  expect(result.checks.find((check) => check.id === 'deployment')?.status).toBe('pass')
  expect(result.limitations.some((item) => item.includes('does not connect to staging or production'))).toBe(true)
})

test('production readiness remains conservative for an empty repository', async () => {
  const emptyRoot = mkdtempSync(join(tmpdir(), 'elia-empty-production-'))
  try {
    const result = JSON.parse(await withAgentIdentity({ name: 'test', role: 'lead', cwd: emptyRoot }, () => productionReadinessTool.execute({}))) as { readiness: string; score: number }
    expect(result.readiness).toBe('insufficient-evidence')
    expect(result.score).toBe(0)
  } finally {
    rmSync(emptyRoot, { recursive: true, force: true })
  }
})

afterAll(() => rmSync(testDir, { recursive: true, force: true }))
