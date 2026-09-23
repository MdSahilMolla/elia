import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { ELIA_ROOT } from '../../statePaths.ts'
import { ensureSecureDirectory, writeSecureFile } from '../../securePersistence.ts'
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
  /** Commits not to validate: already tasks, or already refused. Proving one costs two test runs. */
  skip?: ReadonlySet<string>
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

  const skip = options.skip ?? new Set<string>()
  const candidates = (await listCandidates(scan, shape, repoRoot)).filter((candidate) => !skip.has(candidate.sha))
  report(`${candidates.length} candidate commits in the last ${scan}${skip.size > 0 ? ` not already tried` : ''}`)

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

/**
 * Tasks harvested after the tracked set was written.
 *
 * `elia bench --harvest` rewrites the tracked `tasks.json`, which is a change a
 * person commits. The resource governor also grows the benchmark by itself —
 * rule R4: a held-out set too small to certify a gain makes every evolve
 * generation a coin nobody can read — and it does so from a background process
 * that shares a checkout with other work. So what it finds goes here, in
 * elia's own state beside the evolution ledger, never the working tree, and the
 * loader merges it in.
 */
export const HARVESTED_FILE = join(ELIA_ROOT, '.evolution', 'harvested-tasks.json')

export interface HarvestedTasks {
  tasks: HistoryTaskSpec[]
  /** Commits already tried and refused, so a later harvest does not pay again to prove the same thing. */
  rejected: Array<{ sha: string; reason: string; at: number }>
}

/**
 * The harvested-tasks file the benchmark should read, or undefined for none.
 *
 * An evolve sandbox is a copy of `src/` at `<live>/.evolution/gen-N`, and the
 * benchmark runs the candidate's own copy of the task loader — so the file is
 * looked for beside the sandbox too. Without that, a candidate would be
 * measured on fewer tasks than the baseline it is compared with. Under
 * `bun test` the benchmark is exactly the tracked set, so a machine that has
 * harvested sees the same tasks as CI.
 */
export function harvestedFileFor(root = ELIA_ROOT, env: Record<string, string | undefined> = process.env): string | undefined {
  const override = env.ELIA_HARVESTED_TASKS?.trim()
  if (override) return override === 'off' ? undefined : override
  if (env.NODE_ENV === 'test') return undefined
  const own = join(root, '.evolution', 'harvested-tasks.json')
  if (existsSync(own)) return own
  const parent = dirname(root)
  if (basename(parent) === '.evolution') {
    const live = join(parent, 'harvested-tasks.json')
    if (existsSync(live)) return live
  }
  return undefined
}

export function readHarvested(file: string | undefined): HarvestedTasks {
  if (!file || !existsSync(file)) return { tasks: [], rejected: [] }
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as Partial<HarvestedTasks>
    return {
      tasks: Array.isArray(parsed.tasks) ? parsed.tasks.filter((task) => typeof task?.id === 'string' && typeof task.sha === 'string') : [],
      rejected: Array.isArray(parsed.rejected) ? parsed.rejected.filter((entry) => typeof entry?.sha === 'string') : [],
    }
  } catch {
    // A corrupt file adds no tasks; the tracked set still runs.
    return { tasks: [], rejected: [] }
  }
}

export interface GrowResult {
  added: HistoryTaskSpec[]
  refused: number
  considered: number
  /** Tasks in the harvested file after this run. */
  harvested: number
}

/**
 * Validates commits nobody has tried yet and appends the ones that prove out.
 * Never rewrites the tracked set, never re-proves a known task, and never
 * re-tries a commit that was refused for a reason that will not change. A
 * timeout is not such a reason, so it is not remembered.
 */
export async function growHarvest(
  options: HarvestOptions & { tracked: readonly HistoryTaskSpec[]; file?: string; now?: number; run?: typeof harvest },
): Promise<GrowResult> {
  const file = options.file ?? HARVESTED_FILE
  const existing = readHarvested(file)
  const skip = new Set([
    ...options.tracked.map((task) => task.sha),
    ...existing.tasks.map((task) => task.sha),
    ...existing.rejected.map((entry) => entry.sha),
  ])
  const result = await (options.run ?? harvest)({ ...options, skip })
  const at = options.now ?? Date.now()
  const lasting = result.rejected.filter((entry) => !/timed out/i.test(entry.reason))
  if (result.tasks.length > 0 || lasting.length > 0) {
    const next: HarvestedTasks = {
      tasks: [...existing.tasks, ...result.tasks],
      rejected: [...existing.rejected, ...lasting.map((entry) => ({ sha: entry.sha, reason: entry.reason, at }))],
    }
    ensureSecureDirectory(dirname(file))
    writeSecureFile(file, `${JSON.stringify(next, null, 2)}\n`)
  }
  return { added: result.tasks, refused: result.rejected.length, considered: result.considered, harvested: existing.tasks.length + result.tasks.length }
}
