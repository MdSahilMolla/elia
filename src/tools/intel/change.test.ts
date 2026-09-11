import { describe, expect, it, beforeAll, afterAll } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { analyzeFileFromDiff, parseGitNameStatus, buildChangeModel, type ChangedFile } from './change.ts'

describe('analyzeFileFromDiff', () => {
  it('counts additions and deletions, ignoring headers and context', () => {
    const diff = [
      'diff --git a/src/a.ts b/src/a.ts',
      '--- a/src/a.ts',
      '+++ b/src/a.ts',
      '@@ -1,5 +1,6 @@',
      ' const x = 1',
      '+export function added() { return true }',
      '-function removed() {}',
      ' const y = 2',
      '+const z = 3',
    ].join('\n')
    const file = analyzeFileFromDiff('src/a.ts', diff)
    expect(file.additions).toBe(2)
    expect(file.deletions).toBe(1)
  })

  it('detects newly added exported symbols', () => {
    const file = analyzeFileFromDiff('src/a.ts', '+export function calc(r: number): number { return r }\n+export class Parser {}\n')
    expect(file.symbols).toEqual([
      { name: 'calc', kind: 'function', change: 'added' },
      { name: 'Parser', kind: 'class', change: 'added' },
    ])
  })

  it('detects removed and signature-changed symbols', () => {
    const diff = '-export function calc(r: number) {}\n+export function calc(r: number, mode: string) {}\n-export const OLD = 1\n'
    const file = analyzeFileFromDiff('src/a.ts', diff)
    expect(file.symbols).toContainEqual({ name: 'calc', kind: 'function', change: 'signature' })
    expect(file.symbols).toContainEqual({ name: 'OLD', kind: 'const', change: 'removed' })
  })

  it('notes import and export surface changes', () => {
    const diff = "+import { db } from '../db'\n+export const run = db.x\n-import { legacy } from './legacy'\n"
    const file = analyzeFileFromDiff('src/worker.ts', diff)
    expect(file.importsChanged).toEqual(['../db', './legacy'])
    expect(file.exportsChanged).toEqual(['run'])
  })

  it('flags test, config, schema, security, api and dependency paths', () => {
    const flags = [
      analyzeFileFromDiff('src/x.test.ts', '+1'),
      analyzeFileFromDiff('schema.prisma', '+model X { id Int }'),
      analyzeFileFromDiff('.env', '+KEY=value'),
      analyzeFileFromDiff('src/security/auth.ts', '+export function login() {}'),
      analyzeFileFromDiff('src/api/orders.ts', '+export function list() {}'),
      analyzeFileFromDiff('package.json', '+{"a":1}'),
    ]
    expect(flags[0]!.isTest).toBe(true)
    expect(flags[1]!.isConfigOrSchema).toBe(true)
    expect(flags[2]!.isConfigOrSchema).toBe(true)
    expect(flags[3]!.isSecuritySurface).toBe(true)
    expect(flags[4]!.isApiSurface).toBe(true)
    expect(flags[5]!.isDependencyManifest).toBe(true)
  })

  it('handles an empty or header-only diff', () => {
    const file = analyzeFileFromDiff('src/a.ts', 'diff --git a/a b/a\n@@ -1 +1 @@\n')
    expect(file.additions).toBe(0)
    expect(file.deletions).toBe(0)
    expect(file.symbols).toEqual([])
  })
})

describe('parseGitNameStatus', () => {
  it('parses modified, added, deleted and renamed entries', () => {
    const output = ['M\tsrc/a.ts', 'A\tsrc/b.ts', 'D\tsrc/c.ts', 'R100\tsrc/old.ts\tsrc/new.ts', ''].join('\n')
    const entries = parseGitNameStatus(output)
    expect(entries).toEqual([
      { path: 'src/a.ts', type: 'M' },
      { path: 'src/b.ts', type: 'A' },
      { path: 'src/c.ts', type: 'D' },
      { path: 'src/new.ts', type: 'R', oldPath: 'src/old.ts' },
    ])
  })

  it('ignores blank and malformed lines', () => {
    expect(parseGitNameStatus('')).toEqual([])
    expect(parseGitNameStatus('this is not valid').length).toBe(0)
    expect(parseGitNameStatus('M\t\t')).toEqual([])
  })

  it('normalizes windows separators', () => {
    const entries = parseGitNameStatus('M\tsrc\\a.ts')
    expect(entries[0]!.path).toBe('src/a.ts')
  })
})

describe('buildChangeModel', () => {
  it('aggregates files through the provided runner with real-style output', async () => {
    const outputs: Record<string, string> = {
      'diff --name-status -M HEAD': 'M\tsrc/app.ts\nA\tsrc/new.ts\nD\tsrc/gone.ts\n',
      'diff HEAD -- src/app.ts': '--- a/src/app.ts\n+++ b/src/app.ts\n@@ -1 +1 @@\n-export function old() {}\n+export function app() {}\n',
      'diff HEAD -- src/new.ts': '+export const fresh = 1\n',
      'diff HEAD -- src/gone.ts': '--- a/src/gone.ts\n+++ /dev/null\n-export function gone() {}\n',
    }
    const run = async (args: string[]): Promise<string> => outputs[args.join(' ')] ?? ''

    const model = await buildChangeModel({ cwd: '.', run })
    expect(model.files).toHaveLength(3)
    expect(model.files[0]).toMatchObject({ path: 'src/app.ts', kind: 'modified' })
    expect(model.files[1]).toMatchObject({ path: 'src/new.ts', kind: 'added' })
    expect(model.files[2]).toMatchObject({ path: 'src/gone.ts', kind: 'deleted' })
    expect(model.summary.totalFiles).toBe(3)
    expect(model.summary.linesAdded).toBe(2)
    expect(model.summary.linesRemoved).toBe(2)
  })

  it('honors a commit range', async () => {
    let sawRange = false
    const run = async (args: string[]): Promise<string> => {
      if (args[0] === 'diff' && args[1] === '--name-status') sawRange = true
      return ''
    }
    await buildChangeModel({ cwd: '.', run, base: 'abc123', head: 'def456' })
    expect(sawRange).toBe(true)
  })

  it('collects test/security/config surfaces into the summary', async () => {
    const outputs: Record<string, string> = {
      'diff --name-status -M HEAD': 'M\tsrc/auth.test.ts\nM\tpackage.json\n',
      'diff HEAD -- src/auth.test.ts': '+export function check() {}\n',
      'diff HEAD -- package.json': '+{"dep": "^1.0.0"}\n',
    }
    const run = async (args: string[]): Promise<string> => outputs[args.join(' ')] ?? ''
    const model = await buildChangeModel({ cwd: '.', run })
    expect(model.summary.testsChanged).toEqual(['src/auth.test.ts'])
    expect(model.summary.dependencyManifestsChanged).toEqual(['package.json'])
  })
})

describe('buildChangeModel integration against a real git repo', () => {
  let repo: string

  const git = async (args: string[]): Promise<string> => {
    const proc = Bun.spawn(['git', ...args], { stdout: 'pipe', stderr: 'pipe', cwd: repo })
    const stdout = await new Response(proc.stdout).text()
    const code = await proc.exited
    if (code !== 0) throw new Error(`git ${args.join(' ')} failed: ${await new Response(proc.stderr).text()}`)
    return stdout
  }

  beforeAll(async () => {
    repo = mkdtempSync(join(tmpdir(), 'cb-change-repo-'))
    await git(['init', '-q'])
    await git(['config', 'user.email', 'test@test.com'])
    await git(['config', 'user.name', 'Test'])
    await git(['config', 'core.autocrlf', 'false'])
    mkdirSync(join(repo, 'src'), { recursive: true })
    writeFileSync(join(repo, 'src', 'app.ts'), 'export function app() { return 1 }\nexport function kept() { return 2 }\n')
    await git(['add', '.'])
    await git(['commit', '-q', '-m', 'initial'])
    writeFileSync(join(repo, 'src', 'app.ts'), 'export function app() { return 1 }\nexport function kept() { return 2 }\nexport function added() { return 3 }\n')
    await git(['add', '.'])
    await git(['commit', '-q', '-m', 'second'])
    writeFileSync(join(repo, 'src', 'app.ts'), 'export function app() { return 1 }\nexport function added() { return 3 }\n')
  })

  afterAll(() => {
    rmSync(repo, { recursive: true, force: true })
  })

  it('sees the working-tree change against HEAD', async () => {
    const model = await buildChangeModel({ cwd: repo })
    // app.ts changed in the working tree: `kept` was removed after the second commit.
    const appFile = model.files.find((f) => f.path === 'src/app.ts')
    expect(appFile).toBeDefined()
    expect(appFile!.symbols).toContainEqual({ name: 'kept', kind: 'function', change: 'removed' })
  })

  it('sees a commit-range change against an explicit base', async () => {
    const first = (await git(['rev-parse', 'HEAD~1'])).trim()
    const model = await buildChangeModel({ cwd: repo, base: first, head: 'HEAD' })
    const appFile = model.files.find((f) => f.path === 'src/app.ts')
    expect(appFile).toBeDefined()
    expect(appFile!.symbols).toContainEqual({ name: 'added', kind: 'function', change: 'added' })
  })

  it('uses the default git runner against a real repo', async () => {
    const model = await buildChangeModel({ cwd: repo })
    expect(model.files).toHaveLength(1)
    expect(model.files[0]!.symbols).toContainEqual({ name: 'kept', kind: 'function', change: 'removed' })
  })
})