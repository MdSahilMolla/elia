import { describe, expect, it, beforeAll, afterAll } from 'bun:test'
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { resolveSpecifier, loadTsconfigAliases } from './resolver.ts'
import { normalizePath } from './parser.ts'

describe('resolver', () => {
  const root = normalizePath(mkdtempSync(join(tmpdir(), 'arch-resolver')))
  const src = root + '/src'

  beforeAll(() => {
    mkdirSync(root, { recursive: true })
    mkdirSync(root + '/src/deep', { recursive: true })
    writeFileSync(root + '/src/index.ts', '')
    writeFileSync(root + '/src/types.ts', '')
    writeFileSync(root + '/src/types.d.ts', '')
    writeFileSync(root + '/src/comp.tsx', '')
    writeFileSync(root + '/src/deep/nested.ts', '')
    writeFileSync(
      root + '/tsconfig.json',
      JSON.stringify({
        compilerOptions: {
          baseUrl: '.',
          paths: {
            '@types/*': ['src/*'],
            'alias': ['src/index.ts'],
          },
          strict: true,
        },
      }),
    )
  })

  afterAll(() => rmSync(root, { recursive: true, force: true }))

  const opts = () => ({
    projectRoot: root,
    ...loadTsconfigAliases(root + '/tsconfig.json'),
  })

  it('resolves relative ./module.ts', () => {
    const result = resolveSpecifier(src + '/file.ts', './types', opts())
    expect(result.status).toBe('file')
    expect(result.path?.endsWith('src/types.ts')).toBe(true)
  })

  it('resolves relative ./module with .d.ts fallback', () => {
    const result = resolveSpecifier(src + '/file.ts', './types', opts())
    expect(result.path?.endsWith('types.ts')).toBe(true)
  })

  it('resolves relative directory to index', () => {
    mkdirSync(root + '/src/deep', { recursive: true })
    writeFileSync(root + '/src/deep/index.ts', '')
    const result = resolveSpecifier(src + '/face.ts', './deep', opts())
    expect(result.status).toBe('file')
    expect(result.path?.endsWith('deep/index.ts')).toBe(true)
  })

  it('returns unresolved for missing relative', () => {
    const result = resolveSpecifier(src + '/file.ts', './does-not-exist', opts())
    expect(result.status).toBe('unresolved')
  })

  it('resolves via tsconfig paths pattern', () => {
    const result = resolveSpecifier(src + '/file.ts', '@types/deep/nested', opts())
    expect(result.status).toBe('file')
    expect(result.path?.endsWith('deep/nested.ts')).toBe(true)
  })

  it('resolves bare specifier as external', () => {
    const result = resolveSpecifier(src + '/file.ts', 'some-package', opts())
    expect(result.status).toBe('external')
    expect(result.externalSpecifier).toBe('some-package')
  })

  it('loads tsconfig baseUrl and paths from extends chain', () => {
    const parent = root + '/base.tsconfig.json'
    writeFileSync(parent, JSON.stringify({ compilerOptions: { baseUrl: '..', paths: {} } }))
    writeFileSync(root + '/child.tsconfig.json', JSON.stringify({ extends: './base.tsconfig.json', compilerOptions: { paths: { x: ['src/types.ts'] } } }))
    const loaded = loadTsconfigAliases(root + '/child.tsconfig.json')
    expect(loaded.paths).toBeDefined()
    expect(loaded.baseUrl).toBe('..')
  })
})