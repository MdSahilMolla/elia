import { describe, expect, it, beforeAll, afterAll } from 'bun:test'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { createFixture, cleanupFixture } from './testFixtures.ts'
import { normalizePath } from './parser.ts'
import { buildReport, formatReport } from './report.ts'

const FILES: Record<string, string> = {
  'arch.json': JSON.stringify({
    layers: [
      { name: 'domain', include: ['src/domain/**'] },
      { name: 'api', include: ['src/api/**'] },
    ],
    dependencyInversion: [{ interface: 'src/domain/contracts.ts', implementation: 'src/domain/impl.ts' }],
    forbiddenImports: [{ from: 'src/api/**', to: 'src/domain/impl.ts', reason: 'api must go through contracts' }],
    packages: [
      { name: 'features', include: ['src/features/**'], publicApi: ['src/features/index.ts'] },
      { name: 'domain', include: ['src/domain/**'], publicApi: ['src/domain/contracts.ts'] },
    ],
  }),
  'src/domain/contracts.ts': `export interface Deal { x: number }\n`,
  'src/domain/impl.ts': `import type { Deal } from './contracts'\nexport const deal: Deal = { x: 2 }\n`,
  'src/api/handler.ts': `import { deal } from '../domain/impl'\nexport const total = deal.x + 1\n`,
  'src/features/index.ts': `export * from './widget'\n`,
  'src/features/widget.ts': `export const size = 40\n`,
  'src/features/detail.ts': `import type { Deal } from '../domain/impl'\nexport const unit: Deal = { x: 1 }\n`,
}

describe('architecture report pipeline', () => {
  let root: string
  let report: Awaited<ReturnType<typeof buildReport>>
  const readBack = (file: string) => readFileSync(join(root, file), 'utf8')

  beforeAll(async () => {
    root = normalizePath(mkdtempSync(join(tmpdir(), 'arch-report')))
    createFixture(root, FILES, { includeBase: false })
    report = await buildReport({ projectRoot: root, includeTests: true })
  })

  afterAll(() => {
    cleanupFixture(root)
  })

  it('assembles a complete, structured report', () => {
    expect(report.configSource).toBe('arch.json')
    expect(report.moduleCount).toBe(6)
    const types = report.violations.map((v) => v.type)
    expect(types).toContain('dependency_inversion')
    expect(types).toContain('forbidden_import')
    expect(types).toContain('package_boundary_violation')
    for (const v of report.violations) expect(v.why.length).toBeGreaterThan(0)
  })

  it('fills evidence split and never treats inference as fact', () => {
    expect(report.evidence.facts + report.evidence.inferences).toBe(report.violations.length)
    const inv = report.violations.find((v) => v.type === 'dependency_inversion')!
    expect(report.evidence.facts).toBeGreaterThan(0)
    expect(inv.specifier).toBe('../domain/impl')
  })

  it('produces health, hotspots, and a resolvable repair plan', () => {
    expect(report.health.distribution.evaluated).toBe(report.moduleCount)
    const resolvable = report.repairs.plans.filter((p) => p.resolution === 'resolvable')
    expect(resolvable.length).toBeGreaterThanOrEqual(2) // both inversion edges -> contracts
    const invPlan = resolvable.find((p) => p.actions[0]?.newSpecifier === '../domain/contracts')
    expect(invPlan).toBeDefined()
    expect(invPlan!.actions[0]!.file).toBe('src/api/handler.ts')
    expect(report.hotspots.length).toBeGreaterThan(0)
  })

  it('renders a deterministic, readable report and promises read-only', () => {
    const text = formatReport(report)
    expect(text).toContain('=== Architecture Report ===')
    expect(text).toContain('--- Health ---')
    expect(text).toContain('[error] dependency_inversion')
    expect(text).toContain('Read-only analysis: no files were modified.')
    expect(text).toContain('Config: arch.json')
    expect(formatReport(report)).toBe(text)
  })

  it('never modifies the analyzed source', () => {
    expect(readBack('src/api/handler.ts')).toContain("from '../domain/impl'")
    expect(readBack('src/features/detail.ts')).toContain("from '../domain/impl'")
  })

  it('readily soaks up a baseline diff when a snapshot exists', async () => {
    const snap = {
      commit: 'deadbeef',
      createdAt: '2026-01-01',
      violations: report.violations,
    }
    writeFileSync(join(root, 'arch.baseline.json'), JSON.stringify(snap), 'utf8')
    const withBaseline = await buildReport({ projectRoot: root, includeTests: true, baselineFile: 'arch.baseline.json' })
    expect(withBaseline.baseline).not.toBeNull()
    expect(withBaseline.baseline!.stillPresent.length).toBe(report.violations.length)
  })
})