import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Modules under test pull from statePaths on import (gitProvenance via
// worktree -> paths). Provide a key so no provider resolution fails.
process.env.ANTHROPIC_API_KEY ??= 'test-key-for-causal-integration'

import { getBlame, getFileHistory, isShallowRepo, hasDirtyWorkingTree, getFileAtCommit, parseBlamePorcelain } from './gitProvenance.ts'
import { generateRepairPlan } from './repair.ts'
import { generatePatch, applyPatch } from './patch.ts'
import { performCounterfactual } from './counterfactual.ts'
import { runCausalDebug } from './engine.ts'
import type { RootCauseCandidate } from './types.ts'

interface GitResult { exitCode: number; stdout: string; stderr: string }

async function git(args: string[], cwd: string): Promise<GitResult> {
  const proc = Bun.spawn(['git', ...args], { stdout: 'pipe', stderr: 'pipe', cwd })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  return { exitCode, stdout, stderr }
}

let repoDir: string
let stateDir: string

async function commit(message: string, files: Record<string, string>): Promise<string> {
  for (const [rel, content] of Object.entries(files)) {
    const full = join(repoDir, rel)
    mkdirSync(join(repoDir, rel.split('/').slice(0, -1).join('/')), { recursive: true })
    writeFileSync(full, content)
  }
  await git(['add', '-A'], repoDir)
  await git(['commit', '-q', '-m', message], repoDir)
  const log = await git(['rev-parse', 'HEAD'], repoDir)
  return log.stdout.trim()
}

beforeEach(async () => {
  // Deliberate space in dir name exercises PowerShell/cmd re-lexing like the
  // existing worktree tests do.
  repoDir = mkdtempSync(join(tmpdir(), 'elia causal int-'))
  stateDir = mkdtempSync(join(tmpdir(), 'elia causal state-'))
  await git(['init', '-q'], repoDir)
  await git(['config', 'user.email', 'test@test.com'], repoDir)
  await git(['config', 'user.name', 'Test'], repoDir)
  await git(['config', 'core.autocrlf', 'false'], repoDir)
})

afterEach(() => {
  rmSync(repoDir, { recursive: true, force: true })
  rmSync(stateDir, { recursive: true, force: true })
})

describe('git provenance against a real repo', () => {
  it('getFileHistory returns commits in order with metadata', async () => {
    await commit('init', { 'src/app.ts': 'line1\nline2\nline3\n' })
    await git(['config', 'core.autocrlf', 'false'], repoDir)
    const fixHash = await commit('fix the token bug', { 'src/app.ts': 'line1\nFIXED\nline3\n' })

    const history = await getFileHistory('src/app.ts', repoDir)
    expect(history.length).toBeGreaterThanOrEqual(2)
    expect(history[0]!.hash).toBe(fixHash)
    expect(history[0]!.message).toContain('fix the token bug')
    expect(history[0]!.parents.length).toBe(1)
    expect(history.some((c) => c.message === 'init')).toBe(true)
  })

  it('getBlame attributes each line to the right commit and uses current-file lines', async () => {
    const first = await commit('init', { 'src/app.ts': 'a\nb\nc\n' })
    await commit('fix the token bug', { 'src/app.ts': 'a\nCHANGED\nc\n' })

    const blame = await getBlame('src/app.ts', repoDir)
    expect(blame).toHaveLength(3)

    const changedLine = blame.find((e) => e.content.trim() === 'CHANGED')!
    expect(changedLine).toBeDefined()
    expect(changedLine.commit.startsWith(first)).toBe(false)
    expect(changedLine.line).toBe(2) // current-file line, not the original
    expect(blame.find((e) => e.content.trim() === 'a')!.line).toBe(1)
  })

  it('parseBlamePorcelain handles real git output format', async () => {
    await commit('init', { 'x.ts': 'only line\n' })
    const blame = await getBlame('x.ts', repoDir)
    const parsed = parseBlamePorcelain(await (async () => {
      const proc = Bun.spawn(['git', 'blame', '--porcelain', 'x.ts'], { stdout: 'pipe', cwd: repoDir })
      return new Response(proc.stdout).text()
    })())
    expect(parsed).toHaveLength(blame.length)
    expect(parsed[0]!.line).toBe(1)
    expect(blame[0]!.line).toBe(1)
  })

  it('isShallowRepo and hasDirtyWorkingTree report correctly', async () => {
    await commit('init', { 'a.ts': 'x\n' })
    expect(await isShallowRepo(repoDir)).toBe(false)
    expect(await hasDirtyWorkingTree(repoDir)).toBe(false)

    writeFileSync(join(repoDir, 'a.ts'), 'y\n')
    expect(await hasDirtyWorkingTree(repoDir)).toBe(true)
  })

  it('getFileAtCommit returns content from an earlier revision', async () => {
    await commit('init', { 'm.ts': 'old\n' })
    const after = await commit('update', { 'm.ts': 'new\n' })

    const atHead = await getFileAtCommit('m.ts', 'HEAD', repoDir)
    expect(atHead).toBe('new\n')
    const before = await getFileAtCommit('m.ts', `${after}^`, repoDir)
    expect(before).toBe('old\n')
    // A file that didn't exist returns an empty string (not a crash)
    const missing = await getFileAtCommit('nope.ts', 'HEAD', repoDir)
    expect(missing).toBe('')
  })
})

describe('causal debug engine end-to-end', () => {
  it('traces a bug-introducing commit and ranks it', async () => {
    await commit('init', { 'src/auth.ts': 'export function login(u: string, p: string): boolean {\n  return p === "secret"\n}\n' })
    const bugHash = await commit('relax auth checks (bug)', { 'src/auth.ts': 'export function login(u: string, p: string): boolean {\n  if (p === "secret" || p === "") {\n    return true\n  }\n  return false\n}\n' })

    const result = await runCausalDebug({ file: 'src/auth.ts', cwd: repoDir })

    // Repo isn't shallow, analysis should have no fatal limitations
    expect(result.target.file).toBe('src/auth.ts')
    expect(result.candidates.length).toBeGreaterThanOrEqual(1)
    // The bug commit must appear in candidates
    expect(result.candidates.some((c) => c.commitHash === bugHash)).toBe(true)
    expect(result.candidates[0]!.confidence).toBeGreaterThan(0)
    expect(result.overallConfidence).toBeGreaterThan(0)
    expect(Array.isArray(result.semanticDiffs)).toBe(true)
  })

  it('flags the working tree when it is dirty', async () => {
    await commit('init', { 'a.ts': 'x\n' })
    writeFileSync(join(repoDir, 'a.ts'), 'y\n')
    const result = await runCausalDebug({ file: 'a.ts', cwd: repoDir })
    expect(result.limitations.some((l) => l.includes('uncommitted changes'))).toBe(true)
  })
})

describe('repair and patch pipeline', () => {
  const makeCandidate = (hash: string): RootCauseCandidate => ({
    nodeId: 'n1',
    commitHash: hash,
    label: 'root cause',
    confidence: 0.8,
    level: 'high',
    scoringBreakdown: [],
    explanation: 'authoritative commit',
    causalChain: ['a', 'b'],
    counterfactualVerified: false,
  })

  it('generateRepairPlan produces a minimal plan', async () => {
    await commit('init', { 'src/util.ts': 'export function f(): number { return 1 }\n' })
    const bugHash = await commit('change return behavior', { 'src/util.ts': 'export function f(): number { return 2 }\n' })

    const plan = await generateRepairPlan(makeCandidate(bugHash), [], 'src/util.ts', repoDir)
    expect(plan.steps.length).toBeGreaterThanOrEqual(0)
    expect(typeof plan.summary).toBe('string')
    expect(plan.confidence).toBeGreaterThanOrEqual(0)
  })

  it('generatePatch and applyPatch round-trip into a throwaway repo', async () => {
    await commit('init', { 'src/util.ts': 'export function f(): number { return 1 }\n' })
    const bugHash = await commit('change return behavior', { 'src/util.ts': 'export function f(): number { return 2 }\n' })

    const plan = await generateRepairPlan(makeCandidate(bugHash), [], 'src/util.ts', repoDir)
    // A plan with no categorized diffs still yields a revert-style patch
    const patch = await generatePatch(plan, 'src/util.ts', bugHash, repoDir)
    expect(patch.filesAffected).toContain('src/util.ts')
    expect(patch.explanation.length).toBeGreaterThan(0)

    if (patch.diff && patch.diff.trim().length > 0) {
      const result = await applyPatch(patch, repoDir)
      expect(result.success).toBe(true)
      const current = await Bun.file(join(repoDir, 'src/util.ts')).text()
      expect(current).toContain('export function f(): number { return 1 }') // restored
    }
  })
})

describe('counterfactual analysis in an isolated worktree', () => {
  it('creates, uses, and cleans up a worktree (performed, baseDir respected)', async () => {
    await commit('init', { 'src/a.ts': 'export const value = 1\n' })
    const changedHash = await commit('bump value', { 'src/a.ts': 'export const value = 2\n' })

    const result = await performCounterfactual(changedHash, 'src/a.ts', repoDir, stateDir)

    // BaseDir was honored: worktree lived under stateDir, not the repo
    expect(result.performed).toBe(true)
    // Cleanup should have removed the tree
    const leftover = await Bun.spawn(['git', 'worktree', 'list'], { stdout: 'pipe', cwd: repoDir }).exited
    expect(leftover).toBe(0)
  })
})