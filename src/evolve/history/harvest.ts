import { rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ELIA_ROOT } from '../../statePaths.ts'
import { runGit } from '../../autonomy/worktree.ts'
import { fileAtCommit, makeTaskDir, materializeTask, writeFileInDir } from './materialize.ts'
import { runVerify } from './verifyRun.ts'
import type { HistoryTaskSpec } from './types.ts'

/**
 * Turns elia's own git history into benchmark tasks, and refuses to emit one it
 * cannot prove.
 *
 * The proof is the whole point. A benchmark nobody validated is how the previous
 * suite ended up scoring 100% on every candidate it ever measured — at which
 * point it ranked candidates by token count alone and said nothing about whether
 * they could code. So each candidate commit here is actually run twice, in a real
 * checkout: once with only the tests applied (which must fail) and once with the
 * commit's real source applied (which must pass). Anything that does not show
 * both is dropped, with the reason recorded.
 */

export const TASKS_FILE = join(ELIA_ROOT, 'src', 'evolve', 'history', 'tasks.json')

export interface HarvestOptions {
  /** How many commits back to consider. */
  scan?: number
  /** Stop once this many tasks have been validated. */
  limit?: number
  /** Upper bound on non-test source files a commit may touch, to keep tasks scoped. */
  maxSourceFiles?: number
  /** Upper bound on test files a commit may touch. */
  maxTestFiles?: number
  repoRoot?: string
  onProgress?: (message: string) => void
}

export interface RejectedCandidate {
  sha: string
  subject: string
  reason: string
}

export interface HarvestResult {
  tasks: HistoryTaskSpec[]
  rejected: RejectedCandidate[]
  considered: number
}

const TEST_FILE = /\.test\.tsx?$/
const SOURCE_FILE = /^src\/.*\.tsx?$/

export interface Candidate {
  sha: string
  parent: string
  subject: string
  sourceFiles: string[]
  testFiles: string[]
}

/** Splits a commit's changed paths into the work and the specification. */
export function partitionFiles(paths: string[]): { sourceFiles: string[]; testFiles: string[] } {
  const relevant = paths.filter((path) => SOURCE_FILE.test(path))
  return {
    sourceFiles: relevant.filter((path) => !TEST_FILE.test(path)),
    testFiles: relevant.filter((path) => TEST_FILE.test(path)),
  }
}

/**
 * A commit is worth trying when it changed both source and tests, and stayed
 * small enough that the task has a single recognisable subject. Merges are
 * skipped: their diff against the first parent is other people's work.
 */
export function isCandidateShape(
  candidate: { sourceFiles: string[]; testFiles: string[] },
  options: { maxSourceFiles: number; maxTestFiles: number },
): boolean {
  const { sourceFiles, testFiles } = candidate
  if (sourceFiles.length === 0 || testFiles.length === 0) return false
  if (sourceFiles.length > options.maxSourceFiles) return false
  if (testFiles.length > options.maxTestFiles) return false
  // The verify command passes test paths to Bun unquoted; see verifyCommandFor.
  if (testFiles.some((file) => /\s/.test(file))) return false
  return true
}

/**
 * Lists commits worth trying, newest first.
 *
 * Shas and subjects are read in separate calls on purpose: packing them into one
 * `--format` needs a delimiter, and any delimiter can legitimately appear inside
 * a commit subject. Asking git for one field at a time removes the parsing
 * question entirely.
 */
async function listCandidates(
  scan: number,
  options: { maxSourceFiles: number; maxTestFiles: number },
  repoRoot: string,
): Promise<Candidate[]> {
  const log = await runGit(['log', `-n${scan}`, '--no-merges', '--format=%H %P'], repoRoot)
  if (log.exitCode !== 0) throw new Error(`git log failed: ${log.stderr}`)

  const candidates: Candidate[] = []
  for (const line of log.stdout.split('\n').map((entry) => entry.trim()).filter(Boolean)) {
    const [sha, parent] = line.split(/\s+/)
    if (!sha || !parent) continue

    const changed = await runGit(['show', '--name-only', '--format=', sha], repoRoot)
    if (changed.exitCode !== 0) continue
    const paths = changed.stdout.split('\n').map((entry) => entry.trim()).filter(Boolean)
    const partitioned = partitionFiles(paths)
    if (!isCandidateShape(partitioned, options)) continue

    const subject = await runGit(['log', '-1', '--format=%s', sha], repoRoot)
    candidates.push({ sha, parent, subject: subject.stdout.trim(), ...partitioned })
  }
  return candidates
}

/**
 * `bun test` over exactly the files that describe this task.
 *
 * The paths are left unquoted. `runShell` invokes `cmd /d /s /c "<command>"` on
 * Windows, and `/s` makes cmd strip only the outermost pair of quotes and pass
 * everything else through verbatim — so a quoted path arrives at Bun with the
 * quotes still attached and matches no test file at all ("The following filters
 * did not match any test files"). Repository-relative source paths contain no
 * spaces, and `isCandidateShape` rejects any that do, so there is nothing to
 * quote.
 */
export function verifyCommandFor(testFiles: string[]): string {
  return `bun test --timeout=20000 ${testFiles.join(' ')}`
}

/**
 * Runs one candidate through the fail-then-pass gate.
 *
 * Both halves run in the same freshly materialized directory: the "after" state
 * is produced by writing the commit's own source over the "before" state, which
 * is exactly the edit the agent will be asked to make.
 */
export async function validateCandidate(
  candidate: Candidate,
  repoRoot: string,
): Promise<{ spec: HistoryTaskSpec } | { reason: string }> {
  const dir = makeTaskDir(candidate.sha.slice(0, 7))
  const verifyCommand = verifyCommandFor(candidate.testFiles)
  try {
    await materializeTask({ parent: candidate.parent, sha: candidate.sha, testFiles: candidate.testFiles, dir, repoRoot })

    const before = await runVerify(verifyCommand, dir)
    if (before.result.timedOut) return { reason: 'tests timed out on the parent tree' }
    if (before.result.exitCode === 0) {
      return { reason: 'tests already pass on the parent tree — the commit added no testable behaviour' }
    }

    for (const sourceFile of candidate.sourceFiles) {
      // A commit can delete a file; nothing to write, and its absence is already
      // part of the parent tree the agent starts from.
      const content = await fileAtCommit(candidate.sha, sourceFile, repoRoot).catch(() => undefined)
      if (content !== undefined) writeFileInDir(dir, sourceFile, content)
    }

    const after = await runVerify(verifyCommand, dir)
    if (after.result.exitCode !== 0) {
      // Usually the commit's tests lean on a file it did not itself change, or on
      // a build step. Real work, but not reproducible from the commit alone.
      return { reason: `tests still fail after applying the commit's own source (${after.counts.fail} failing)` }
    }
    if (after.counts.pass === 0) return { reason: 'no tests actually ran after the fix' }

    return {
      spec: {
        id: `hist-${candidate.sha.slice(0, 7)}`,
        sha: candidate.sha,
        parent: candidate.parent,
        subject: candidate.subject,
        testFiles: candidate.testFiles,
        sourceFiles: candidate.sourceFiles,
        verifyCommand,
        evidence: { failingBefore: Math.max(before.counts.fail, 1), passingAfter: after.counts.pass },
        weight: 2,
      },
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

export async function harvest(options: HarvestOptions = {}): Promise<HarvestResult> {
  const scan = options.scan ?? 200
  const limit = options.limit ?? 12
  const repoRoot = options.repoRoot ?? ELIA_ROOT
  const shape = { maxSourceFiles: options.maxSourceFiles ?? 3, maxTestFiles: options.maxTestFiles ?? 2 }
  const report = options.onProgress ?? (() => {})

  const candidates = await listCandidates(scan, shape, repoRoot)
  report(`${candidates.length} candidate commits in the last ${scan}`)

  const tasks: HistoryTaskSpec[] = []
  const rejected: RejectedCandidate[] = []

  for (const candidate of candidates) {
    if (tasks.length >= limit) break
    const outcome = await validateCandidate(candidate, repoRoot)
    if ('spec' in outcome) {
      tasks.push(outcome.spec)
      report(`  kept ${outcome.spec.id} — ${candidate.subject.slice(0, 64)}`)
    } else {
      rejected.push({ sha: candidate.sha, subject: candidate.subject, reason: outcome.reason })
      report(`  drop ${candidate.sha.slice(0, 7)} — ${outcome.reason}`)
    }
  }

  return { tasks, rejected, considered: candidates.length }
}

export function writeTasksFile(tasks: HistoryTaskSpec[], file = TASKS_FILE): void {
  writeFileSync(file, `${JSON.stringify(tasks, null, 2)}\n`)
}
