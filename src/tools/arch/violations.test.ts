import { describe, expect, it, beforeAll, afterAll } from 'bun:test'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { openProject, parseProject, normalizePath } from './parser.ts'
import { createFixture, cleanupFixture, type Fixture } from './testFixtures.ts'
import { buildGraph, type DepGraph } from './graph.ts'
import { detectViolations, type DetectionResult } from './violations.ts'
import { loadArchitectureConfig, type ArchitectureConfig } from './config.ts'
import type { Program } from 'typescript/unstable/sync'
import type { Snapshot } from 'typescript/unstable/sync'

const RULES = {
  architecture: {
    direction: 'downward',
    layers: [
      { name: 'web', include: ['src/web/**'], publicApi: ['src/web/index.ts'] },
      { name: 'model', include: ['src/model/**'], publicApi: ['src/model/index.ts'] },
    ],
    forbiddenImports: [{ from: 'src/forbidden/**', to: 'src/target.ts', reason: 'no target access' }],
    packages: [
      { name: 'pkgA', include: ['src/pkgA/**'], publicApi: ['src/pkgA/index.ts'] },
      { name: 'pkgB', include: ['src/pkgB/**'] },
    ],
    dependencyInversion: [{ interface: 'src/contracts.ts', implementation: 'src/impl.ts' }],
    legacyLibAppRule: true,
    exempt: ['src/entry.ts'],
  },
}

const RULE_FILES: Record<string, string> = {
  'src/web/index.ts': `export * from './shared'\n`,
  'src/web/shared.ts': `export const shared = 1\n`,
  'src/web/page.ts': `import { model } from '../model/internal'\nexport const page = model\n`,
  'src/model/index.ts': `export * from './internal'\n`,
  'src/model/internal.ts': `export const model = 1\n`,
  'src/model/upward.ts': `import { shared } from '../web/shared'\nexport const upward = shared\n`,
  'src/forbidden/consumer.ts': `import { target } from '../target'\nexport const x = target\n`,
  'src/target.ts': `export const target = 1\n`,
  'src/pkgA/index.ts': `export * from './internal'\n`,
  'src/pkgA/internal.ts': `export const hidden = 1\n`,
  'src/pkgB/index.ts': `import { hidden } from '../pkgA/internal'\nexport const pkgBvalue = hidden\n`,
  'src/contracts.ts': `export interface Deal { x: number }\n`,
  'src/impl.ts': `import type { Deal } from './contracts'\nexport const deal: Deal = { x: 1 }\n`,
  'src/uses.ts': `import { deal } from './impl'\nexport const v = deal.x\n`,
  'src/broken.ts': `export const nope = 1\nimport { nope as n } from './missing-module'\nexport const b = n\n`,
  'src/entry.ts': `export async function load() {\n  const m = await import('./not-there')\n  return m\n}\n`,
  'src/lib/helper.ts': `import { thing } from '../app/thing'\nexport const helper = thing\n`,
  'src/app/thing.ts': `export const thing = 1\n`,
}

describe('violations (configured architecture)', () => {
  let fixture: Fixture
  let apiDispose: { api: unknown; snapshot: Snapshot }
  let program: Program
  const root = normalizePath(mkdtempSync(join(tmpdir(), 'arch-viol-rules')))

  const opts = () => ({ projectRoot: root, tsconfigPath: normalizePath(join(root, 'tsconfig.json')), includeTests: true, maxFiles: 100 })

  function graph(): DepGraph {
    const { files } = parseProject(program, opts())
    return buildGraph(files, opts())
  }

  function detect(config: ArchitectureConfig): DetectionResult {
    return detectViolations(graph(), config)
  }

  beforeAll(() => {
    fixture = createFixture(root, RULE_FILES, { includeBase: false })
    writeFileSync(join(root, 'arch.json'), JSON.stringify(RULES))
    const { api, snapshot, program: p } = openProject(opts())
    apiDispose = { api, snapshot }
    program = p
  })

  afterAll(() => {
    apiDispose.snapshot.dispose()
    ;(apiDispose.api as { close: () => void }).close()
    cleanupFixture(root)
  })

  it('loads the architecture config written to arch.json', () => {
    const loaded = loadArchitectureConfig(root)
    expect(loaded.config.direction).toBe('downward')
    expect(loaded.config.layers?.length).toBe(2)
  })

  it('detects upward layer imports (model → web)', () => {
    const { violations } = detect(loadArchitectureConfig(root).config)
    const up = violations.filter((v) => v.type === 'import_direction' && v.source.endsWith('model/upward.ts'))
    expect(up.length).toBeGreaterThanOrEqual(1)
    expect(up[0]!.target.endsWith('web/shared.ts')).toBe(true)
  })

  it('detects the legacy lib → app rule', () => {
    const { violations } = detect(loadArchitectureConfig(root).config)
    const legacy = violations.some((v) => v.type === 'import_direction' && v.source.endsWith('lib/helper.ts'))
    expect(legacy).toBe(true)
  })

  it('detects abstraction leakage into non-public layer paths', () => {
    const { violations } = detect(loadArchitectureConfig(root).config)
    const leak = violations.filter((v) => v.type === 'abstraction_leakage' && v.source.endsWith('web/page.ts'))
    expect(leak.length).toBeGreaterThanOrEqual(1)
    expect(leak[0]!.target.endsWith('model/internal.ts')).toBe(true)
  })

  it('detects forbidden imports from configured rules', () => {
    const { violations } = detect(loadArchitectureConfig(root).config)
    const forbidden = violations.find((v) => v.type === 'forbidden_import' && v.source.endsWith('forbidden/consumer.ts'))
    expect(forbidden).toBeDefined()
    expect(forbidden!.target.endsWith('target.ts')).toBe(true)
  })

  it('detects package boundary violations (non-public path)', () => {
    const { violations } = detect(loadArchitectureConfig(root).config)
    const pkg = violations.find((v) => v.type === 'package_boundary_violation' && v.source.endsWith('pkgB/index.ts'))
    expect(pkg).toBeDefined()
    expect(pkg!.target.endsWith('pkgA/internal.ts')).toBe(true)
  })

  it('detects dependency inversion (concrete instead of interface)', () => {
    const { violations } = detect(loadArchitectureConfig(root).config)
    const inv = violations.find((v) => v.type === 'dependency_inversion' && v.source.endsWith('uses.ts'))
    expect(inv).toBeDefined()
    expect(inv!.target.endsWith('impl.ts')).toBe(true)
  })

  it('detects unresolved imports and honors exempt paths', () => {
    const { violations } = detect(loadArchitectureConfig(root).config)
    const broken = violations.find((v) => v.type === 'unresolved_import' && v.source.endsWith('broken.ts'))
    expect(broken).toBeDefined()
    const entry = violations.find((v) => v.type === 'unresolved_import' && v.source.endsWith('entry.ts'))
    expect(entry).toBeUndefined()
  })

  it('does not fabricate cycles in this acyclic fixture', () => {
    const { violations } = detect({})
    expect(violations.filter((v) => v.type === 'circular_dependency').length).toBe(0)
  })
})