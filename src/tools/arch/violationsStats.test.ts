import { describe, expect, it, beforeAll, afterAll } from 'bun:test'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { mkdtempSync } from 'node:fs'
import { openProject, parseProject, normalizePath } from './parser.ts'
import { createFixture, cleanupFixture, type Fixture } from './testFixtures.ts'
import { buildGraph, type DepGraph } from './graph.ts'
import { detectViolations } from './violations.ts'
import type { Program } from 'typescript/unstable/sync'
import type { Snapshot } from 'typescript/unstable/sync'

const FILES: Record<string, string> = {}

for (let i = 1; i <= 16; i++) {
  FILES[`leaf${i}.ts`] = `export const leaf${i} = ${i}\n`
}
for (let i = 1; i <= 5; i++) {
  FILES[`repo1/m${i}.ts`] = `import { shared } from '../types'\nexport const m${i} = shared + ${i}\n`
  FILES[`repo2/m${i}.ts`] = `import { shared } from '../types'\nexport const m${i} = shared + ${i}\n`
}
for (let i = 1; i <= 15; i++) {
  const next = i < 15 ? `import { c${i + 1} } from './c${i + 1}'\n` : ''
  FILES[`chain/c${i}.ts`] = `${next}export const c${i} = ${i}\n`
}

FILES['types.ts'] = `export const shared = 9\n`
FILES['hub.ts'] = Object.keys(FILES)
  .filter((k) => k.startsWith('leaf'))
  .map((k) => `import { ${k.replace('.ts', '')} } from './${k.replace('.ts', '')}'`)
  .join('\n') + `\nexport const hub = 1\n`
FILES['caller.ts'] = `import { hub } from './hub'\nexport const caller = hub\n`
FILES['lonely.ts'] = `export const lonely = 1\n`

describe('violations (inferred statistics)', () => {
  let fixture: Fixture
  let apiDispose: { api: unknown; snapshot: Snapshot }
  let program: Program
  const root = normalizePath(mkdtempSync(join(tmpdir(), 'arch-viol-stats')))
  const opts = () => ({ projectRoot: root, tsconfigPath: normalizePath(join(root, 'tsconfig.json')), includeTests: true, maxFiles: 200 })

  function graph(): DepGraph {
    const { files } = parseProject(program, opts())
    return buildGraph(files, opts())
  }

  beforeAll(() => {
    fixture = createFixture(root, FILES, { includeBase: false, include: ['**/*.ts'] })
    const { api, snapshot, program: p } = openProject(opts())
    apiDispose = { api, snapshot }
    program = p
  })

  afterAll(() => {
    apiDispose.snapshot.dispose()
    ;(apiDispose.api as { close: () => void }).close()
    cleanupFixture(root)
  })

  it('flags a god module as a statistical outlier on fan-out', () => {
    const { violations } = detectViolations(graph(), {})
    const god = violations.find((v) => v.type === 'god_module' && v.source === 'hub.ts')
    expect(god).toBeDefined()
    expect(god!.severity).toBe('warning')
  })

  it('flags excessive coupling across multiple inferred layers', () => {
    const { violations } = detectViolations(graph(), {})
    const coupling = violations.find((v) => v.type === 'excessive_coupling' && v.source === 'types.ts')
    expect(coupling).toBeDefined()
  })

  it('flags truly isolated (orphan) modules but not entry-like files', () => {
    const { violations } = detectViolations(graph(), {})
    const orphan = violations.find((v) => v.type === 'orphan_module' && v.source === 'lonely.ts')
    expect(orphan).toBeDefined()
    expect(orphan!.severity).toBe('info')
    const leafOrphans = violations.filter((v) => v.type === 'orphan_module' && v.source.startsWith('leaf'))
    expect(leafOrphans.length).toBe(0)
  })

  it('flags deep dependency chains beyond the configured limit', () => {
    const { violations } = detectViolations(graph(), {})
    const deep = violations.find((v) => v.type === 'deep_dependency_chain' && v.source === 'chain/c1.ts')
    expect(deep).toBeDefined()
    const mid = violations.find((v) => v.type === 'deep_dependency_chain' && v.source === 'chain/c14.ts')
    expect(mid).toBeUndefined()
  })

  it('respects an explicit maxChainDepth', () => {
    const { violations } = detectViolations(graph(), { maxChainDepth: 5 })
    expect(violations.some((v) => v.type === 'deep_dependency_chain')).toBe(true)
  })
})