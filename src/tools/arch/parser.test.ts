import { describe, expect, it, beforeAll, afterAll } from 'bun:test'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { mkdtempSync, readFileSync } from 'node:fs'
import { openProject, parseProject, normalizePath, closeProject, closeProjectQuietly } from './parser.ts'
import { createFixture, cleanupFixture, type Fixture } from './testFixtures.ts'
import type { Program } from 'typescript/unstable/async'
import type { API, Snapshot } from 'typescript/unstable/async'

describe('parser', () => {
  let fixture: Fixture
  let apiDispose: { api: API; snapshot: Snapshot } | undefined
  let program: Program
  beforeAll(async () => {
    fixture = createFixture(mkdtempSync(join(tmpdir(), 'arch-parser')))
    const { api, snapshot, program: p } = await openProject({
      projectRoot: fixture.rootNorm,
      tsconfigPath: fixture.tsconfig,
      includeTests: true,
      maxFiles: 50,
    })
    apiDispose = { api, snapshot }
    program = p
  })

  afterAll(async () => {
    try {
      if (apiDispose) await closeProject(apiDispose)
    } finally {
      cleanupFixture(fixture.root)
    }
  })

  it('opens the project and finds the fixture source files', async () => {
    const names = (await program.getSourceFileNames())
      .map(normalizePath)
      .filter((n) => n.startsWith(fixture.rootNorm))
    expect(names.length).toBeGreaterThanOrEqual(9)
  })

  it('parses import kinds and specifiers for src/app.ts', async () => {
    const { files } = await parseProject(program, {
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

  it('detects named re-exports and star re-exports', async () => {
    const { files } = await parseProject(program, {
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

  it('extracts type-only re-exports with correct kind', async () => {
    const { files } = await parseProject(program, {
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

  it('captures line numbers (1-based) for import specifiers', async () => {
    const { files } = await parseProject(program, {
      projectRoot: fixture.rootNorm,
      tsconfigPath: fixture.tsconfig,
      includeTests: true,
      maxFiles: 50,
    })
    const app = files.find((f) => f.path.endsWith('src/app.ts'))
    const first = app!.imports[0]!
    expect(first.line).toBe(1)
  })

  it('excludes test files when includeTests is false', async () => {
    const { files } = await parseProject(program, {
      projectRoot: fixture.rootNorm,
      tsconfigPath: fixture.tsconfig,
      includeTests: false,
      maxFiles: 50,
    })
    const specFile = files.find((f) => f.path.endsWith('app.spec.ts'))
    expect(specFile).toBeUndefined()
  })

  it('reports truncated flag when maxFiles is too small', async () => {
    const { truncated, files } = await parseProject(program, {
      projectRoot: fixture.rootNorm,
      tsconfigPath: fixture.tsconfig,
      includeTests: true,
      maxFiles: 2,
    })
    expect(truncated).toBe(true)
    expect(files.length).toBe(2)
  })
})
// Each `import()` sits under a node kind the native `forEachChild` does not
// fully enumerate, so the walk only reaches it through KIND_CHILDREN (L-35, I-11).
const HIDDEN_DYNAMIC_IMPORTS = `
export const tpl = \`\${await import('./in-template')}\`
export const tagged = tag\`\${import('./in-tagged-template')}\`
export const cond = flag ? import('./in-conditional-true') : import('./in-conditional-false')
export function* gen() { yield import('./in-yield') }
export function withDefault(m = import('./in-parameter-default')) { return m }
export class Holder { static mod = import('./in-class-field') }
export const computed = { [String(import('./in-computed-key'))]: 1 }
export const { destructured = import('./in-binding-default') } = {} as { destructured?: unknown }
export let counter = 0
export const post = (counter++, import('./in-comma'))
label: for (const x of [import('./in-labeled')]) break label
declare const flag: boolean
declare function tag(s: TemplateStringsArray, ...v: unknown[]): unknown
`

describe('parser: dynamic imports in nested expression kinds', () => {
  const root = normalizePath(mkdtempSync(join(tmpdir(), 'arch-parser-hidden')))
  let handle: { api: API; snapshot: Snapshot; program: Program } | undefined

  beforeAll(async () => {
    createFixture(root, { 'src/hidden.ts': HIDDEN_DYNAMIC_IMPORTS })
    handle = await openProject({ projectRoot: root, tsconfigPath: normalizePath(join(root, 'tsconfig.json')), includeTests: true, maxFiles: 50 })
  })

  afterAll(async () => {
    try {
      if (handle) await closeProject(handle)
    } finally {
      cleanupFixture(root)
    }
  })

  it('finds every dynamic import, wherever it is nested', async () => {
    const { files } = await parseProject(handle!.program, { projectRoot: root, tsconfigPath: normalizePath(join(root, 'tsconfig.json')), includeTests: true, maxFiles: 50 })
    const hidden = files.find((f) => f.path.endsWith('src/hidden.ts'))
    expect(hidden).toBeDefined()
    const dynamic = hidden!.imports.filter((i) => i.kind === 'dynamic').map((i) => i.specifier).sort()
    expect(dynamic).toEqual([
      './in-binding-default',
      './in-class-field',
      './in-comma',
      './in-computed-key',
      './in-conditional-false',
      './in-conditional-true',
      './in-labeled',
      './in-parameter-default',
      './in-tagged-template',
      './in-template',
      './in-yield',
    ])
  })
})

describe('parser transport', () => {
  // The regression this file's async rewrite exists for. `typescript/unstable/sync`
  // drives the compiler through a `SyncRpcChannel`, which reads
  // `child.stdout._handle.fd` — a Node internal Bun does not implement on Linux,
  // where it throws `undefined is not an object (evaluating 'stdout._handle.fd')`
  // before a single file is read. Every arch test and the `arch_drift` tool itself
  // died on it in CI. The async client speaks the same protocol over ordinary
  // piped streams, so nothing here may reach for the sync one again.
  it('never loads the sync client, whose channel cannot run under Bun on Linux', () => {
    const source = readFileSync(new URL('./parser.ts', import.meta.url), 'utf8')
    expect(source).not.toMatch(/from ['"]typescript\/unstable\/sync['"]/)
    expect(source).toMatch(/from ['"]typescript\/unstable\/async['"]/)
  })

  it('opens and closes a project without leaving a rejected request behind', async () => {
    // `close()` disposes the JSON-RPC connection and rejects everything still in
    // flight, so an un-awaited `dispose()` surfaced as an unhandled rejection
    // after the test had already passed. `closeProject` orders and awaits both.
    const local = createFixture(mkdtempSync(join(tmpdir(), 'arch-parser-close')))
    const rejections: unknown[] = []
    const onRejection = (reason: unknown): void => void rejections.push(reason)
    process.on('unhandledRejection', onRejection)
    // Held outside the try so an early failure — a rejected parse, or the
    // assertion below — still closes the compiler process rather than leaving
    // it to hold up test shutdown. Cleared once closed, so the happy path does
    // not close it twice.
    let handle: Awaited<ReturnType<typeof openProject>> | undefined
    try {
      handle = await openProject({
        projectRoot: local.rootNorm,
        tsconfigPath: local.tsconfig,
        includeTests: true,
        maxFiles: 50,
      })
      const { files } = await parseProject(handle.program, {
        projectRoot: local.rootNorm,
        tsconfigPath: local.tsconfig,
        includeTests: true,
        maxFiles: 50,
      })
      expect(files.length).toBeGreaterThan(0)
      await closeProject(handle)
      handle = undefined
      // Give any stray rejection a turn to surface before asserting none did.
      await new Promise((resolve) => setTimeout(resolve, 50))
      expect(rejections).toEqual([])
    } finally {
      if (handle) await closeProjectQuietly(handle)
      process.off('unhandledRejection', onRejection)
      cleanupFixture(local.root)
    }
  })

  it('closes the compiler connection when opening the project fails', async () => {
    // `new API({})` already owns a spawned compiler process, so a failure after
    // it — a tsconfig that does not exist, here — must not escape with the
    // connection still open: the caller never received a handle to close.
    const empty = mkdtempSync(join(tmpdir(), 'arch-parser-nocfg'))
    const before = process.listenerCount('unhandledRejection')
    await expect(
      openProject({
        projectRoot: normalizePath(empty),
        tsconfigPath: normalizePath(join(empty, 'tsconfig.json')),
        includeTests: true,
        maxFiles: 10,
      }),
    ).rejects.toThrow()
    // The real assertion is that the rejection is the *caller's* error, not a
    // teardown error layered on top of it, and that nothing was left dangling.
    expect(process.listenerCount('unhandledRejection')).toBe(before)
  })
})
