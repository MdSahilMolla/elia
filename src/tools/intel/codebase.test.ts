import { describe, expect, it, beforeAll, afterAll } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { indexCodebase, findFile, importersOf, exportedSymbols, dependencyNames } from './codebase.ts'

let root: string

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'cb-model-'))
  const files: Record<string, string> = {
    'package.json': JSON.stringify({
      name: 'fixture',
      dependencies: { zod: '^3.0.0', express: '^4.0.0' },
      devDependencies: { 'bun-types': '^1.0.0' },
    }),
    'tsconfig.json': '{}',
    '.env.example': 'PORT=3000\n',
    'src/math.ts':
      "export function add(a: number, b: number): number {\n  return a + b\n}\nexport const PI = 3.14\ninterface Private { x: number }\n",
    'src/app.ts':
      "import { add } from './math'\nimport { PI } from './math'\nexport function run(): number {\n  return add(1, 2) + PI\n}\nexport default run\n",
    'src/math.test.ts': "import { add } from './math'\nimport { test } from 'bun:test'\n",
    'src/api/orders.ts': "export function listOrders() { return [] }\nimport { z } from 'zod'\n",
    'src/security/auth.ts': "export function login() {}\nexport class AuthService {}\n",
    'src/config/features.ts': 'export const flags = { beta: true }\n',
    'prisma/schema.prisma': 'model User { id Int }\n',
    'src/chart.md': '# chart\n',
  }
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(root, rel)
    mkdirSync(join(abs, '..'), { recursive: true })
    writeFileSync(abs, content)
  }
  mkdirSync(join(root, '.git'), { recursive: true })
  writeFileSync(join(root, '.git', 'HEAD'), 'ref: refs/heads/main\n')
  mkdirSync(join(root, 'node_modules'), { recursive: true })
  writeFileSync(join(root, 'node_modules', 'placeholder.txt'), 'ignore me')
})

afterAll(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('indexCodebase', () => {
  it('indexes the fixture deterministically', () => {
    const model = indexCodebase(root)
    expect(model.files.map((f) => f.path)).toEqual([
      '.env.example',
      'package.json',
      'prisma/schema.prisma',
      'src/api/orders.ts',
      'src/app.ts',
      'src/chart.md',
      'src/config/features.ts',
      'src/math.test.ts',
      'src/math.ts',
      'src/security/auth.ts',
      'tsconfig.json',
    ])
    expect(model.testFiles).toEqual(['src/math.test.ts'])
    expect(model.schemaFiles).toEqual(['prisma/schema.prisma'])
    expect(model.configFiles).toContain('package.json')
    expect(model.configFiles).toContain('tsconfig.json')
    expect(model.configFiles).toContain('.env.example')
    expect(model.securitySurfaceFiles).toEqual(['src/security/auth.ts'])
    expect(model.apiSurfaceFiles).toEqual(['src/api/orders.ts'])
    expect(model.truncated).toBe(false)
  })

  it('detects the git branch from .git/HEAD', () => {
    expect(indexCodebase(root).scm).toEqual({ type: 'git', branch: 'main' })
  })

  it('handles a non-git or missing root without throwing', () => {
    const missing = indexCodebase(join(root, 'does-not-exist'))
    expect(missing.files).toEqual([])
    expect(missing.scm.type).toBe('unknown')
    expect(missing.dependencies).toEqual([])
  })

  it('skips node_modules and honors ignoreDirs', () => {
    const full = indexCodebase(root)
    expect(full.files.some((f) => f.path.includes('node_modules'))).toBe(false)
    const narrowed = indexCodebase(root, { ignoreDirs: ['src'] })
    expect(narrowed.files.some((f) => f.path.startsWith('src/'))).toBe(false)
  })

  it('honors the maxFiles cap', () => {
    const capped = indexCodebase(root, { maxFiles: 3 })
    expect(capped.files.length).toBe(3)
    expect(capped.truncated).toBe(true)
  })

  it('honors the only filter', () => {
    const scoped = indexCodebase(root, { only: ['src'] })
    expect(scoped.files.every((f) => f.path.startsWith('src/'))).toBe(true)
    expect(scoped.files.length).toBe(7)
  })

  it('is deterministic across consecutive runs', () => {
    expect(indexCodebase(root).files.map((f) => f.path)).toEqual(indexCodebase(root).files.map((f) => f.path))
  })
})

describe('file facts', () => {
  it('extracts imports, exports and exported symbols with line numbers', () => {
    const model = indexCodebase(root)
    const math = findFile(model, 'src/math.ts')!
    expect(math.imports).toEqual([])
    expect(math.exports).toEqual(['add', 'PI'])
    expect(math.symbols).toEqual([
      { name: 'add', kind: 'function', line: 1, exported: true },
      { name: 'PI', kind: 'const', line: 4, exported: true },
    ])
    expect(math.isTest).toBe(false)
    expect(math.lineCount).toBe(6)

    const app = findFile(model, 'src/app.ts')!
    expect(app.imports).toEqual(['./math'])
    expect(app.exports).toEqual(['run', 'default'])
    expect(app.symbols).toEqual([{ name: 'run', kind: 'function', line: 3, exported: true }])
  })

  it('flags test, config, schema, security and api files', () => {
    const model = indexCodebase(root)
    expect(findFile(model, 'src/math.test.ts')!.isTest).toBe(true)
    expect(findFile(model, 'prisma/schema.prisma')!.isSchema).toBe(true)
    expect(findFile(model, 'src/security/auth.ts')!.securitySurface).toBe(true)
    expect(findFile(model, 'src/api/orders.ts')!.apiSurface).toBe(true)
    expect(findFile(model, 'src/chart.md')!.language).toBe('markdown')
  })
})

describe('dependency collection', () => {
  it('groups runtime and dev dependencies', () => {
    const names = dependencyNames(indexCodebase(root))
    expect(names.has('zod')).toBe(true)
    expect(names.has('express')).toBe(true)
    expect(names.has('bun-types')).toBe(true)
    const model = indexCodebase(root)
    const bunTypes = model.dependencies.find((d) => d.name === 'bun-types')!
    expect(bunTypes.kind).toBe('dev')
  })
})

describe('importersOf', () => {
  it('finds files importing a target module', () => {
    const model = indexCodebase(root)
    expect(importersOf(model, 'src/math.ts')).toEqual(['src/app.ts', 'src/math.test.ts'])
  })

  it('returns empty for unknown or unimported targets', () => {
    const model = indexCodebase(root)
    expect(importersOf(model, 'src/nope.ts')).toEqual([])
    expect(importersOf(model, 'src/math.test.ts')).toEqual([])
  })

  it('ignores the target itself', () => {
    const model = indexCodebase(root)
    expect(importersOf(model, 'src/security/auth.ts')).toEqual([])
  })
})

describe('exportedSymbols', () => {
  it('keys exported symbols by file path', () => {
    const model = indexCodebase(root)
    const map = exportedSymbols(model)
    const mathSymbols = map.get('src/math.ts')!
    expect(mathSymbols.map((s) => s.name)).toEqual(['add', 'PI'])
    expect(map.has('src/chart.md')).toBe(false)
  })
})