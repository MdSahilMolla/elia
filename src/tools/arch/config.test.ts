import { describe, expect, it, beforeAll, afterAll } from 'bun:test'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { loadArchitectureConfig, compilePattern, matchesAny, basenameNoExt } from './config.ts'
import { normalizePath } from './parser.ts'

describe('config', () => {
  const root = normalizePath(mkdtempSync(join(tmpdir(), 'arch-config')))

  beforeAll(() => {
    mkdirSync(root, { recursive: true })
    writeFileSync(
      root + '/arch.json',
      JSON.stringify({
        architecture: {
          direction: 'downward',
          layers: [{ name: 'domain', include: ['src/domain/**'], publicApi: ['src/domain/index.ts'] }],
          forbiddenImports: [{ from: 'src/web/**', to: 'src/infra/**' }],
          dependencyInversion: [{ interface: 'src/ports.ts', implementation: 'src/adapters/**' }],
        },
      }),
    )
    writeFileSync(
      root + '/package.json',
      JSON.stringify({
        name: 'pkg',
        architecture: { direction: 'downward', layers: [{ name: 'legacy', include: ['legacy/**'] }] },
      }),
    )
  })

  afterAll(() => rmSync(root, { recursive: true, force: true }))

  it('loads from arch.json', () => {
    const loaded = loadArchitectureConfig(root)
    expect(loaded.source).toBe(root + '/arch.json')
    expect(loaded.config.direction).toBe('downward')
    expect(loaded.config.layers?.[0]?.name).toBe('domain')
  })

  it('loads an architecture key from package.json when no arch file exists', () => {
    const dir = normalizePath(join(root, 'node-pkg'))
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      dir + '/package.json',
      JSON.stringify({ architecture: { direction: 'downward', layers: [{ name: 'x', include: ['x/**'] }] } }),
    )
    const loaded = loadArchitectureConfig(dir)
    expect(loaded.source).toBe(dir + '/package.json')
    expect(loaded.config.layers?.[0]?.name).toBe('x')
  })

  it('returns empty config when nothing is configured', () => {
    const dir = normalizePath(join(root, 'empty'))
    mkdirSync(dir, { recursive: true })
    const loaded = loadArchitectureConfig(dir)
    expect(loaded.source).toBe('')
    expect(loaded.config).toEqual({})
  })

  it('loads an explicit config path (relative to root)', () => {
    const dir = normalizePath(join(root, 'explicit'))
    mkdirSync(dir, { recursive: true })
    writeFileSync(dir + '/rules.json', JSON.stringify({ architecture: { forbiddenImports: [] } }))
    const loaded = loadArchitectureConfig(dir, 'rules.json')
    expect(loaded.source).toBe(dir + '/rules.json')
  })

  it('throws on invalid JSON config', () => {
    const dir = normalizePath(join(root, 'bad'))
    mkdirSync(dir, { recursive: true })
    writeFileSync(dir + '/arch.json', '{ nope')
    expect(() => loadArchitectureConfig(dir)).toThrow(/not valid JSON/)
  })

  it('throws on duplicate layer names', () => {
    const dir = normalizePath(join(root, 'dup'))
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      dir + '/arch.json',
      JSON.stringify({ architecture: { layers: [{ name: 'a', include: ['a/**'] }, { name: 'a', include: ['b/**'] }] } }),
    )
    expect(() => loadArchitectureConfig(dir)).toThrow(/duplicate layer/)
  })
})

describe('pattern matching', () => {
  it('compilePattern handles directories, wildcards, and leaves', () => {
    expect(compilePattern('src/domain/**').test('src/domain/a/b.ts')).toBe(true)
    expect(compilePattern('src/domain/**').test('src/other.ts')).toBe(false)
    expect(compilePattern('src/*.ts').test('src/a.ts')).toBe(true)
    expect(compilePattern('src/*.ts').test('src/a/b.ts')).toBe(false)
    expect(compilePattern('src/domain/').test('src/domain/x.ts')).toBe(true)
    expect(compilePattern('src/domain/').test('src/other/x.ts')).toBe(false)
  })

  it('matchesAny returns true when any pattern matches', () => {
    expect(matchesAny('web/page.ts', ['web/**'])).toBe(true)
    expect(matchesAny('web/page.ts', ['core/**', 'web/**'])).toBe(true)
    expect(matchesAny('web/page.ts', ['core/**'])).toBe(false)
    expect(matchesAny('web/page.ts', undefined)).toBe(false)
  })

  it('basenameNoExt strips the directory and extension', () => {
    expect(basenameNoExt('src/a/b.ts')).toBe('b')
    expect(basenameNoExt('index.ts')).toBe('index')
    expect(basenameNoExt('a.b.c.ts')).toBe('a.b.c')
  })
})