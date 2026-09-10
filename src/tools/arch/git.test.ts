import { describe, expect, it, beforeAll, afterAll } from 'bun:test'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { runGit } from '../../autonomy/worktree.ts'
import { openProject, parseProject, normalizePath } from './parser.ts'
import { createFixture, cleanupFixture } from './testFixtures.ts'
import { buildGraph, type DepGraph } from './graph.ts'
import {
  isGitRepo,
  detectGitFacts,
  driftSince,
  evidenceKindFor,
  loadBaseline,
  baselineDiff,
  violationKey,
  churnRates,
  resolveRev,
} from './git.ts'
import type { Violation } from './types.ts'
import type { Program } from 'typescript/unstable/sync'
import type { Snapshot } from 'typescript/unstable/sync'

async function git(cwd: string, args: string[]): Promise<{ exitCode: number; stdout: string }> {
  const r = await runGit(args, cwd)
  return { exitCode: r.exitCode, stdout: r.stdout }
}

describe('git history and drift', () => {
  let apiDispose: { api: unknown; snapshot: Snapshot }
  let program: Program
  let graph: DepGraph
  const root = normalizePath(mkdtempSync(join(tmpdir(), 'arch-git')))
  const opts = () => ({ projectRoot: root, tsconfigPath: normalizePath(join(root, 'tsconfig.json')), includeTests: true, maxFiles: 200 })

  beforeAll(async () => {
    createFixture(
      root,
      { 'src/a.ts': exportW('a'), 'src/b.ts': exportW('b') },
      { includeBase: false },
    )
    await git(root, ['init', '-q'])
    await git(root, ['config', 'user.name', 'arch test'])
    await git(root, ['config', 'user.email', 'arch@test'])
    await git(root, ['add', '.'])
    await git(root, ['commit', '-q', '-m', 'initial'])
    await writeFileAsync(join(root, 'src/a.ts'), exportW('a v2'))
    await git(root, ['add', '.'])
    await git(root, ['commit', '-q', '-m', 'change a'])

    const { api, snapshot, program: p } = openProject(opts())
    apiDispose = { api, snapshot }
    program = p
    const { files } = parseProject(program, opts())
    graph = buildGraph(files, opts())
  })

  afterAll(() => {
    apiDispose.snapshot.dispose()
    ;(apiDispose.api as { close: () => void }).close()
    cleanupFixture(root)
    void program
  })

  it('detects the repository and its HEAD', async () => {
    expect(await isGitRepo(root)).toBe(true)
    const facts = await detectGitFacts(root, graph, { recent: 10 })
    expect(facts.detected).toBe(true)
    expect(facts.head).not.toBeNull()
    expect(facts.head!.subject).toBe('change a')
    expect(facts.dirty).toBe(false)
    expect(facts.recentCommits.length).toBeGreaterThanOrEqual(2)
  })

  it('attributes churn, last commit, authors and introduction date per module', async () => {
    const facts = await detectGitFacts(root, graph)
    const a = facts.files.find((f) => f.module.endsWith('src/a.ts'))
    const b = facts.files.find((f) => f.module.endsWith('src/b.ts'))
    expect(a).toBeDefined()
    expect(a!.churn).toBe(2)
    expect(a!.lastCommit!.subject).toBe('change a')
    expect(a!.introducedAt).not.toBeNull()
    expect(a!.authors).toEqual(['arch test'])
    expect(b!.churn).toBe(1)
  })

  it('maps git churn to a module change-rate map for hotspots', async () => {
    const facts = await detectGitFacts(root, graph)
    const rates = churnRates(facts)
    const key = Object.keys(rates).find((k) => k.endsWith('src/a.ts'))!
    expect(rates[key]).toBe(2)
  })

  it('reports drift since a base revision', async () => {
    const repo = await driftSince(root, 'HEAD~1', graph)
    expect(repo.isRepo).toBe(true)
    expect(await resolveRev(root, 'HEAD~1')).toBeTruthy()
    expect(repo.changedFiles.some((f) => f.endsWith('src/a.ts'))).toBe(true)
    expect(repo.changedModules.some((m) => m.endsWith('src/a.ts'))).toBe(true)
    expect(repo.authors).toContain('arch test')
  })

  it('degrades for the baseline file comparison', async () => {
    const v: Violation = {
      type: 'circular_dependency',
      severity: 'error',
      source: 'src/a.ts',
      target: 'src/b.ts',
      specifier: './b',
      description: 'cycle',
      suggestion: '',
      why: '',
    }
    writeFileSync(join(root, 'arch.baseline.json'), JSON.stringify({ commit: 'x', createdAt: 't', violations: [v] }))
    const baseline = loadBaseline(root)
    expect(baseline).not.toBeNull()
    const diff = baselineDiff([v], baseline!)
    expect(diff.stillPresent).toHaveLength(1)
    expect(diff.newlyAppeared).toHaveLength(0)
    expect(diff.resolved).toHaveLength(0)
    // An empty baseline file should yield null, not throw.
    writeFileSync(join(root, 'arch.baseline.json'), '{ broken')
    expect(loadBaseline(root)).toBeNull()
    expect(violationKey(v)).toBe('circular_dependency|src/a.ts|src/b.ts|./b')
  })

  it('classifies evidence kinds without overstating', () => {
    const fact: Violation = { type: 'forbidden_import', severity: 'error', source: 'x', target: 'y', description: '', suggestion: '', why: '' }
    const infer: Violation = { type: 'god_module', severity: 'warning', source: 'x', target: '', description: '', suggestion: '', why: '' }
    expect(evidenceKindFor(fact)).toBe('fact')
    expect(evidenceKindFor(infer)).toBe('inference')
  })
})

function exportW(what: string): string {
  return `export const ${what} = 1\n`
}

async function writeFileAsync(path: string, content: string): Promise<void> {
  const { writeFile } = await import('node:fs/promises')
  await writeFile(path, content, 'utf8')
}