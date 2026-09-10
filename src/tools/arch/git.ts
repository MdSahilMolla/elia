// Git-backed architectural history and drift.
//
// Everything here is read-only and evidence-attributed: every fact carries the
// raw git output that supports it, and nothing claims git said more than the
// command output actually shows. Non-repo working directories degrade to an
// empty, `detected: false` result instead of throwing.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Violation, ViolationType } from './types.ts'
import type { DepGraph } from './graph.ts'
import { runGit } from '../../autonomy/worktree.ts'

export interface GitCommitMeta {
  hash: string
  shortHash: string
  date: string
  author: string
  subject: string
}

export interface FileGitFact {
  /** Project-relative module path, matched to `graph.nodes[].relativePath`. */
  module: string
  /** Most recent commit touching the file (null when none yet). */
  lastCommit: GitCommitMeta | null
  /** Number of commits touching the file in the sampled window. */
  churn: number
  /** Date of the first commit that added the file. */
  introducedAt: string | null
  /** Unique authors of the file in the sampled window. */
  authors: string[]
}

export interface GitFacts {
  detected: boolean
  branch: string
  head: GitCommitMeta | null
  /** `git status --porcelain` non-empty. */
  dirty: boolean
  recentCommits: GitCommitMeta[]
  files: FileGitFact[]
}

interface GitResult {
  exitCode: number
  stdout: string
  stderr: string
}

const LOG_FORMAT = '%H|%h|%ad|%an|%s'
const DATE_FORMAT = '--date=short'

async function git(cwd: string, args: string[]): Promise<GitResult> {
  return runGit(args, cwd)
}

function parseCommitMeta(line: string): GitCommitMeta | null {
  const parts = line.split('|')
  if (parts.length < 5) return null
  const [hash, shortHash, date, author, ...rest] = parts
  return { hash: hash ?? '', shortHash: shortHash ?? '', date: date ?? '', author: author ?? '', subject: rest.join('|') }
}

async function lastCommitFor(cwd: string, rel: string): Promise<GitCommitMeta | null> {
  const r = await git(cwd, ['log', '-1', DATE_FORMAT, `--format=${LOG_FORMAT}`, '--', rel])
  if (r.exitCode !== 0 || r.stdout.trim().length === 0) return null
  return parseCommitMeta(r.stdout.trim().split('\n').filter((l) => l.length > 0)[0] ?? '')
}

async function churnFor(cwd: string, rel: string, limit: number): Promise<number> {
  const r = await git(cwd, ['log', '--oneline', '--no-merges', `-n ${limit}`, '--', rel])
  if (r.exitCode !== 0) return 0
  return r.stdout.split('\n').filter((l) => l.trim().length > 0).length
}

async function introducedAtFor(cwd: string, rel: string): Promise<string | null> {
  const r = await git(cwd, ['log', '--diff-filter=A', DATE_FORMAT, '--format=%ad', '-n', '1', '--', rel])
  if (r.exitCode !== 0) return null
  const date = r.stdout.trim().split('\n').filter((l) => l.length > 0)[0] ?? ''
  return date.length > 0 ? date : null
}

async function authorsFor(cwd: string, rel: string, limit: number): Promise<string[]> {
  const r = await git(cwd, ['log', '--format=%an', '-n', `${limit}`, '--', rel])
  if (r.exitCode !== 0) return []
  return [...new Set(r.stdout.split('\n').map((l) => l.trim()).filter(Boolean))]
}

/** True when the working directory lies inside a git repository. */
export async function isGitRepo(cwd: string): Promise<boolean> {
  const r = await git(cwd, ['rev-parse', '--is-inside-work-tree'])
  return r.exitCode === 0 && r.stdout.trim() === 'true'
}

/** Resolve a revision string (default HEAD) to a 40-char hash, or null. */
export async function resolveRev(cwd: string, rev: string): Promise<string | null> {
  const r = await git(cwd, ['rev-parse', '--verify', '--quiet', rev])
  if (r.exitCode !== 0) return null
  return r.stdout.trim() || null
}

/** Collect git facts for every module in the graph (drives hotspots/risk). */
export async function detectGitFacts(
  cwd: string,
  graph: DepGraph,
  options: { churnLimit?: number; recent?: number } = {},
): Promise<GitFacts> {
  const detected = await isGitRepo(cwd)
  if (!detected) {
    return { detected: false, branch: '', head: null, dirty: false, recentCommits: [], files: [] }
  }
  const churnLimit = options.churnLimit ?? 100
  const recent = options.recent ?? 25
  const branchR = await git(cwd, ['branch', '--show-current'])
  const branch = branchR.exitCode === 0 ? branchR.stdout.trim() : ''
  const head = await lastCommitFor(cwd, '.')
  const status = await git(cwd, ['status', '--porcelain=v1'])
  const dirty = status.exitCode === 0 && status.stdout.trim().length > 0
  const recentR = await git(cwd, ['log', `-n ${recent}`, DATE_FORMAT, `--format=${LOG_FORMAT}`])
  const recentCommits = recentR.exitCode === 0
    ? recentR.stdout.split('\n').map(parseCommitMeta).filter((m): m is GitCommitMeta => m !== null)
    : []

  const files: FileGitFact[] = []
  for (const node of graph.nodes.values()) {
    const rel = node.relativePath.replace(/\\/g, '/')
    const [lastCommit, churn, introducedAt, authors] = await Promise.all([
      lastCommitFor(cwd, rel),
      churnFor(cwd, rel, churnLimit),
      introducedAtFor(cwd, rel),
      authorsFor(cwd, rel, churnLimit),
    ])
    files.push({ module: rel, lastCommit, churn, introducedAt, authors })
  }
  return { detected: true, branch, head, dirty, recentCommits, files }
}

export interface DriftReport {
  isRepo: boolean
  baseSha: string | null
  branch: string
  /** Files changed between the base revision and the working tree. */
  changedFiles: string[]
  /** Those files that correspond to analyzed modules in the graph. */
  changedModules: string[]
  /** Unique authors of the changed files in the diff range (empty when unresolved). */
  authors: string[]
  /** Working-tree-only modifications (dirty files). */
  dirtyFiles: string[]
}

/**
 * What has drifted on disk since a base revision? `base` accepts any rev
 * syntax (`HEAD~3`, a short hash, a branch name). Purely read-only: it runs
 * `git diff` and `git status --porcelain` against the current tree.
 */
export async function driftSince(
  cwd: string,
  base: string,
  graph: DepGraph,
): Promise<DriftReport> {
  const isRepo = await isGitRepo(cwd)
  if (!isRepo) {
    return { isRepo: false, baseSha: null, branch: '', changedFiles: [], changedModules: [], authors: [], dirtyFiles: [] }
  }
  const baseSha = await resolveRev(cwd, base)
  const branchR = await git(cwd, ['branch', '--show-current'])
  const branch = branchR.exitCode === 0 ? branchR.stdout.trim() : ''

  const changedFiles: string[] = []
  if (baseSha) {
    const diff = await git(cwd, ['diff', '--name-only', baseSha, 'HEAD'])
    if (diff.exitCode === 0) {
      for (const line of diff.stdout.split('\n')) {
        const p = line.trim()
        if (p.length > 0) changedFiles.push(p.replace(/\\/g, '/'))
      }
    }
  }

  const status = await git(cwd, ['status', '--porcelain=v1'])
  const dirtyFiles: string[] = []
  if (status.exitCode === 0) {
    for (const line of status.stdout.split('\n')) {
      const raw = line.slice(3).trim().replace(/^"|"$/g, '')
      const path = raw.includes(' -> ') ? (raw.split(' -> ')[1] ?? raw) : raw
      if (path.length > 0 && !changedFiles.includes(path)) dirtyFiles.push(path.replace(/\\/g, '/'))
    }
  }

  const rels = new Set([...graph.nodes.values()].map((n) => n.relativePath.replace(/\\/g, '/')))
  const changedModules = changedFiles.filter((f) => rels.has(f))

  const authors: string[] = []
  if (baseSha) {
    const r = await git(cwd, ['log', `--format=%an`, `${baseSha}..HEAD`])
    if (r.exitCode === 0) authors.push(...new Set(r.stdout.split('\n').map((l) => l.trim()).filter(Boolean)))
  }

  return { isRepo: true, baseSha, branch, changedFiles, changedModules, authors, dirtyFiles }
}

/** Violation kinds that are verified facts about the code, not statistical inference. */
const FACT_TYPES = new Set<ViolationType>([
  'import_direction',
  'forbidden_import',
  'package_boundary_violation',
  'dependency_inversion',
  'abstraction_leakage',
  'circular_dependency',
  'unresolved_import',
])

/** CLASSIFY each violation as a graph fact or an inference — never overstated. */
export function evidenceKindFor(v: Violation): 'fact' | 'inference' {
  return FACT_TYPES.has(v.type) ? 'fact' : 'inference'
}

/** Uniquely identify a violation so "new since baseline" is not guessed. */
export function violationKey(v: Violation): string {
  return `${v.type}|${v.source}|${v.target}|${v.specifier ?? ''}`
}

export interface Baseline {
  /** 40-char commit the baseline was taken on. */
  commit: string
  /** ISO/phrase timestamp recorded when the baseline was written. */
  createdAt: string
  violations: Violation[]
}

export interface BaselineDiff {
  /** Violations present now but not in the baseline. */
  newlyAppeared: Violation[]
  /** Baseline violations no longer present. */
  resolved: Violation[]
  /** Present in both. */
  stillPresent: Violation[]
}

/**
 * Load a baseline snapshot recorded by the analyzer (default file
 * `arch.baseline.json` in the repo root). Missing/invalid files yield `null`
 * rather than throwing — the analyzer should surface "no baseline" as a
 * message, not an error.
 */
export function loadBaseline(cwd: string, file = 'arch.baseline.json'): Baseline | null {
  try {
    const raw = readFileSync(join(cwd, file), 'utf8')
    const parsed = JSON.parse(raw) as Baseline
    if (!parsed || typeof parsed.commit !== 'string' || !Array.isArray(parsed.violations)) return null
    return parsed
  } catch {
    return null
  }
}

/** Compare the current violation set against a recorded baseline. */
export function baselineDiff(current: Violation[], baseline: Baseline): BaselineDiff {
  const currentKeys = new Set(current.map(violationKey))
  const baseKeys = new Set(baseline.violations.map(violationKey))
  const newlyAppeared = current.filter((v) => !baseKeys.has(violationKey(v)))
  const resolved = baseline.violations.filter((v) => !currentKeys.has(violationKey(v)))
  const stillPresent = current.filter((v) => baseKeys.has(violationKey(v)))
  return { newlyAppeared, resolved, stillPresent }
}

/** Convert git facts into a module churn map consumed by hotspot analysis. */
export function churnRates(facts: GitFacts): Record<string, number> {
  const out: Record<string, number> = {}
  for (const f of facts.files) out[f.module] = f.churn
  return out
}