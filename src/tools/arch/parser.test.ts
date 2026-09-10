import { describe, expect, it, beforeAll, afterAll } from 'bun:test'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { mkdtempSync } from 'node:fs'
import { openProject, parseProject, normalizePath } from './parser.ts'
import { createFixture, cleanupFixture, type Fixture } from './testFixtures.ts'
import type { Program } from 'typescript/unstable/sync'
import type { Snapshot } from 'typescript/unstable/sync'

describe('parser', () => {
  let fixture: Fixture
  let apiDispose: { api: unknown; snapshot: Snapshot }
  let program: Program
  beforeAll(async () => {
    fixture = createFixture(mkdtempSync(join(tmpdir(), 'arch-parser')))
    const { api, snapshot, program: p } = openProject({
      projectRoot: fixture.rootNorm,
      tsconfigPath: fixture.tsconfig,
      includeTests: true,
      maxFiles: 50,
    })
    apiDispose = { api, snapshot }
    program = p
  })

  afterAll(() => {
    apiDispose.snapshot.dispose()
    ;(apiDispose.api as { close: () => void }).close()
    cleanupFixture(fixture.root)
  })

  it('opens the project and finds the fixture source files', () => {
    const names = program.getSourceFileNames()
      .map(normalizePath)
      .filter((n) => n.startsWith(fixture.rootNorm))
    expect(names.length).toBeGreaterThanOrEqual(9)
  })

  it('parses import kinds and specifiers for src/app.ts', () => {
    const { files } = parseProject(program, {
      projectRoot: fixture.rootNorm,
      tsconfigPath: fixture.tsconfig,
      includeTests: true,
      maxFiles: 50,
    })
    const app = files.find((f) => f.path.endsWith('src/app.ts'))
    expect(app).toBeDefined()
    expect(app!.imports.length).toBe(5)
    const specs = app!.imports.map((i) => [i.specifier, i.kind, i.isTypeOnly])
    expect(specs).toEqual([
      ['./core/types', 'static', false],
      ['./core/types', 'type-only', true],
      ['./core/util', 'static', false],
      ['plugin-pkg', 'static', false],
      ['./core/util', 'reexport', false],
    ])
  })

  it('detects named re-exports and star re-exports', () => {
    const { files } = parseProject(program, {
      projectRoot: fixture.rootNorm,
      tsconfigPath: fixture.tsconfig,
      includeTests: true,
      maxFiles: 50,
    })
    const app = files.find((f) => f.path.endsWith('src/app.ts'))
    const appExports = app!.exports.filter((e) => e.kind === 'named' && e.names.includes('plus'))
    expect(appExports.length).toBe(1)

    const idx = files.find((f) => f.path.endsWith('src/index.ts'))
    expect(idx).toBeDefined()
    const star = idx!.exports.filter((e) => e.names.includes('*'))
    expect(star.length).toBeGreaterThanOrEqual(1)
  })

  it('extracts type-only re-exports with correct kind', () => {
    const { files } = parseProject(program, {
      projectRoot: fixture.rootNorm,
      tsconfigPath: fixture.tsconfig,
      includeTests: true,
      maxFiles: 50,
    })
    const mix = files.find((f) => f.path.endsWith('src/mix.ts'))
    expect(mix).toBeDefined()
    const reexport = mix!.imports.find((i) => i.kind === 'reexport' && i.specifier === './core/types')
    expect(reexport).toBeDefined()
    expect(reexport!.isTypeOnly).toBe(true)
    expect(reexport!.names).toEqual(['T'])
  })

  it('captures line numbers (1-based) for import specifiers', () => {
    const { files } = parseProject(program, {
      projectRoot: fixture.rootNorm,
      tsconfigPath: fixture.tsconfig,
      includeTests: true,
      maxFiles: 50,
    })
    const app = files.find((f) => f.path.endsWith('src/app.ts'))
    const first = app!.imports[0]!
    expect(first.line).toBe(1)
  })

  it('excludes test files when includeTests is false', () => {
    const { files } = parseProject(program, {
      projectRoot: fixture.rootNorm,
      tsconfigPath: fixture.tsconfig,
      includeTests: false,
      maxFiles: 50,
    })
    const specFile = files.find((f) => f.path.endsWith('app.spec.ts'))
    expect(specFile).toBeUndefined()
  })

  it('reports truncated flag when maxFiles is too small', () => {
    const { truncated, files } = parseProject(program, {
      projectRoot: fixture.rootNorm,
      tsconfigPath: fixture.tsconfig,
      includeTests: true,
      maxFiles: 2,
    })
    expect(truncated).toBe(true)
    expect(files.length).toBe(2)
  })
})