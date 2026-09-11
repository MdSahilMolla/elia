import { describe, expect, it, beforeAll, afterAll } from 'bun:test'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { mkdtempSync, readFileSync } from 'node:fs'
import { createFixture, cleanupFixture } from './arch/testFixtures.ts'
import { withAgentIdentity } from '../autonomy/context.ts'
import { archDriftTool } from './archDrift.ts'

const FILES: Record<string, string> = {
  'arch.json': JSON.stringify({
    dependencyInversion: [{ interface: 'src/ports.ts', implementation: 'src/impl.ts' }],
  }),
  'src/ports.ts': `export interface Deal { x: number }\nexport const deal: Deal = { x: 1 }\n`,
  'src/impl.ts': `import type { Deal } from './ports'\nexport const deal: Deal = { x: 2 }\n`,
  'src/consumer.ts': `import { deal } from './impl'\nexport const v = deal.x\n`,
}

async function run(input: Record<string, unknown>, cwd: string): Promise<string> {
  return withAgentIdentity({ name: 't', role: 'lead', cwd }, () => archDriftTool.execute(input as never))
}

describe('arch_drift tool bridge', () => {
  let root: string
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'arch-tool'))
    createFixture(root, FILES, { includeBase: false })
  })
  afterAll(() => cleanupFixture(root))

  it('exposes the legacy name and produces an engine-driven report', async () => {
    expect(archDriftTool.name).toBe('arch_drift')
    const text = await run({ path: root, includeTests: true }, root)
    expect(text).toContain('=== Architecture Report ===')
    expect(text).toContain('dependency_inversion')
  })

  it('is read-only by default even when repairs are available', async () => {
    const text = await run({ path: root, includeTests: true }, root)
    expect(text).toContain('Read-only analysis: no files were modified.')
    expect(readFileSync(join(root, 'src/consumer.ts'), 'utf8')).toContain("from './impl'")
  })

  it('writes verified repairs only on an explicit opt-in', async () => {
    const text = await run({ path: root, includeTests: true, applyPlans: true }, root)
    expect(text).toContain('Applied 1 verified repair')
    expect(readFileSync(join(root, 'src/consumer.ts'), 'utf8')).toContain("from './ports'")
  })
})