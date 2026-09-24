import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { ELIA_ROOT } from '../config.ts'
import { EVOLUTION_DIR } from './ledger.ts'

/**
 * An isolated copy of elia's own source for a candidate mutation to be applied to
 * and measured in.
 *
 * Editing the live source and rolling back on failure is not an option: elia is
 * the process doing the editing, and a half-applied mutation to the agent loop
 * would break the thing that was supposed to revert it. So every generation gets
 * a full copy, and the live tree is touched only after the candidate has already
 * passed the gate.
 *
 * The sandbox is placed *inside* elia's root rather than in a temp directory
 * because Bun resolves `node_modules` by walking up the tree — so a nested copy
 * inherits the real dependency tree with no install, no symlink, and no junction.
 */

/**
 * Copied into every sandbox. Everything else (node_modules, .git, .evolution) is
 * either inherited or irrelevant.
 *
 * Beyond the source itself, this is everything `bun run typecheck` and `bun test`
 * need to mean the same thing here as in the live tree — because the gate runs
 * exactly those two commands and rejects a candidate whose tests fail:
 *   - `bunfig.toml` pins the test preload *and* `root = "src"`, which keeps the
 *     deliberately-failing fixtures elia builds under `workspace/` out of
 *     discovery;
 *   - `scripts/` holds that preload, which pins the terminal size so Ink never
 *     shells out mid-render;
 *   - `values/` holds the Value Core the prompt is assembled from, which one
 *     test asserts is present and active;
 *   - `bin/` is the CLI entry point the smoke tests spawn;
 *   - `extensions/` (183K, no dependencies of its own) holds the VS Code copy of
 *     the bridge wire types, which one test reads to check the two copies have
 *     not drifted — a check a candidate touching those types should still face.
 * Without them the suite failed 21 tests in the sandbox and passed in the tree it
 * was copied from, so every candidate was rejected for the sandbox's own shape.
 * The first three are part of how a candidate is judged and are immutable to it
 * (`IMMUTABLE_FILES`). `bin/` and `extensions/` are ordinary implementation it
 * may improve, and nothing measures through them — the benchmark spawns
 * `src/evolve/benchTask.ts`, not the CLI.
 */
const COPIED_ENTRIES = ['src', 'package.json', 'tsconfig.json', 'bunfig.toml', 'scripts', 'values', 'bin', 'extensions']
const TRACKED_ROOT_FILES = ['package.json', 'tsconfig.json']

/**
 * Files a candidate is not allowed to change.
 *
 * This is the reward-hacking guard. Every one of these is part of how a candidate
 * gets judged: the tasks, the checks, the scoring rules, the comparison, and the
 * gate itself. A model asked to improve its benchmark score can improve it far
 * more cheaply by editing the benchmark, and it will — not from malice but because
 * that genuinely is the shortest path to the stated objective. Making the measuring
 * apparatus off-limits is what keeps the score meaning what it says.
 */
export const IMMUTABLE_FILES = [
  'src/evolve/suite.ts',
  'src/evolve/hardSuite.ts',
  'src/evolve/fieldSuite.ts',
  'src/evolve/fitness.ts',
  'src/evolve/engine.ts',
  'src/evolve/ledger.ts',
  'src/evolve/sandbox.ts',
  'src/evolve/benchTask.ts',
  // What a task is allowed to be approved for. A candidate that could widen
  // this could approve its own way onto the network in the middle of being
  // measured, which is the same class of hole as rewriting a task's check.
  'src/evolve/benchPolicy.ts',
  'src/evolve/candidateTools.ts',
  // What the proposer is allowed to see about its own real-world behaviour.
  // engine.ts is immutable because hypothesisBrief() is the proposer's entire
  // view of the world, and a slice of that brief living in a mutable file
  // reopens the hole immutability closed: nothing in the promotion gate reads
  // the field evidence, so a candidate that made a real benchmark gain *and*
  // quietly narrowed the evidence — dropped the shape its own change made
  // worse, raised the occurrence floor, emptied a benchTasks list — would pass
  // every check, and the next generation would propose into a narrower world
  // without being able to see the damage. The same attack is already fixtured
  // one layer down, in gap/critic.test.ts.
  'src/evolve/fieldEvidence.ts',
  // The traces of failing tasks that the proposer is shown, for the same reason:
  // choosing what a later generation sees is choosing how it searches.
  'src/evolve/trace.ts',
  // How a candidate gets measured by its own code. If a candidate could rewrite
  // this, it could route the gap and value checks back at the live tree and make
  // them pass by construction — the exact bug those checks were just fixed for.
  'src/evolve/measureTree.ts',
  // Which tools each tree gives its agent: a candidate that could edit this
  // could report the live list while shipping a shorter one (toolSurface.ts).
  'src/evolve/toolSurface.ts',
  // Which tasks a candidate is measured on, and when the measuring stops. These
  // decide the verdict just as much as fitness.ts computes it: a candidate that
  // could rewrite the sieve could mark every task unreachable and be promoted
  // for a change nothing ever ran, and one that could rewrite the recorder or
  // the baseline cache could poison the evidence those decisions are made from.
  'src/evolve/sieve.ts',
  'src/evolve/reach.ts',
  // Which half of the corpus the proposer is blind to. This is the one file
  // whose whole value is that the candidate cannot see past it: a candidate
  // able to edit split.ts could set the held-out fraction to nothing, or return
  // the full failure list from blindEvidence, and every later generation would
  // be briefed on the tasks it is supposed to be judged on blind. The
  // generalisation label in the ledger would keep printing, and would mean
  // nothing — the failure mode this whole file list exists to prevent.
  'src/evolve/split.ts',
  // The history-derived tasks: their specs, and the prompt each one is given.
  // The benchmark spawns the *candidate's* benchTask.ts, which reads both from
  // the candidate's own copy — so a candidate that could edit them could hand
  // itself the commit subject `promptFor` deliberately withholds, or drop the
  // tasks it fails, and every score would rise with nothing improved (§8.3,
  // Proposition 6: a gain in measurement, not in utility).
  'src/evolve/history/**',
  'src/evolve/reachRecorder.ts',
  'src/evolve/baselineCache.ts',
  // How search strategies are trialled and adopted. The strategy itself is
  // state the loop rewrites; the rules that judge a strategy are not.
  'src/evolve/strategy.ts',
  'src/evolve/benchLessons.ts',
  'src/evolve/metaPropose.ts',
  // The sealed gate, the isolation checks, the certified library and its
  // auditor, the frontier measurements and the resource governor with the
  // runners it acts through. "The meta-loop must never modify the resource
  // governor, the evaluator, the auditor or its own permissions" (§14 of
  // Amplification Without Distillation) — a candidate that could would be
  // grading itself. The theory, statistics, simulations and predictions they
  // compute with are here too: a changed formula is a changed verdict.
  'src/evolve/acceptance.ts',
  'src/evolve/isolation.ts',
  'src/evolve/archive.ts',
  'src/autonomy/certifiedLibrary.ts',
  'src/autonomy/lessonCertificates.ts',
  'src/compounding/theory.ts',
  'src/compounding/stats.ts',
  'src/compounding/frontier.ts',
  'src/compounding/growth.ts',
  'src/compounding/resourceGovernor.ts',
  'src/compounding/round.ts',
  'src/compounding/runners.ts',
  'src/compounding/sim.ts',
  'src/compounding/predictions.ts',
  'src/skills/audit.ts',
  'src/skills/closure.ts',
  'src/skills/toolLog.ts',
  'src/reason/probe.ts',
  'package.json',
  'tsconfig.json',
  'src/**/*.test.ts',
  // How the suite that gates promotion is run. `bunfig.toml` chooses the preload
  // and pins discovery to `src`; `scripts/` holds that preload, the security
  // scan and the benchmarks. A candidate that could edit either would not need
  // to pass the tests — it could point discovery at an empty directory, or make
  // the preload swallow what it does not like. These arrived in the sandbox only
  // so `bun test` would mean the same thing there as in the live tree; they are
  // named here so that is all they can do.
  'bunfig.toml',
  'scripts/**',
  // These files are the deterministic safety boundary. Candidates may improve
  // planning and execution, but may not weaken authorization, containment,
  // policy, redaction, or high-impact tool enforcement to manufacture a win.
  'src/autonomy/governor.ts',
  'src/autonomy/actionContract.ts',
  'src/autonomy/context.ts',
  'src/autonomy/policy.ts',
  'src/autonomy/sensitivePaths.ts',
  'src/securePersistence.ts',
  'src/ui/redact.ts',
  'src/tools/browser.ts',
  'src/tools/communication.ts',
  'src/tools/codex.ts',
  'src/tools/deployment.ts',
  'src/tools/github.ts',
  'src/tools/runCommand.ts',
  // The Value Core and its checks. A self-improvement loop may rewrite how elia
  // works but never what it is for — a change here needs a human commit.
  'values/**',
  'src/values/**',
  'src/gap/**',
  // The distillation gate is itself a measuring apparatus: it decides which
  // distilled fragments become standing instructions. `elia evolve` may rewrite
  // how elia plans and works — not the rules by which its own improvements are
  // judged.
  'src/distill/gate.ts',
]

/**
 * IMMUTABLE_FILES compiled once: exact paths compare as strings, globs through
 * Bun.Glob. The list used to be matched with `includes` alone, so its globs
 * (`src/**\/*.test.ts`, `values/**`) never matched anything and were enforced
 * only by a hand-kept duplicate of the same rules — which is how the list the
 * candidate is *shown* and the list actually *enforced* could drift apart.
 * Now the list is the enforcement.
 */
const IMMUTABLE_MATCHERS: Array<(path: string) => boolean> = IMMUTABLE_FILES.map((entry) => {
  if (!/[*?[{]/.test(entry)) return (path: string) => path === entry
  const glob = new Bun.Glob(entry)
  return (path: string) => glob.match(path)
})

/** Whether a single repo-relative path is off-limits to an evolve candidate. */
export function isImmutablePath(file: string): boolean {
  const normalized = file.replace(/\\/g, '/').replace(/^\.\//, '')
  return IMMUTABLE_MATCHERS.some((matches) => matches(normalized))
}

export interface Sandbox {
  generation: number
  /** Root of the copied source tree; pass this to `measureFitness`. */
  root: string
  /** Where the live files that were overwritten are backed up, so promotion is reversible. */
  backupDir: string
  /**
   * Each tracked file's content hash as it was copied in — what the candidate
   * started from. A generation runs for many minutes while people (and other
   * sessions) keep editing the live tree; measuring "what the candidate
   * changed" against the live tree *at promotion time* counted their edits as
   * the candidate's, so promoting copied the stale sandbox version back over
   * them, deleted files they had added, and blamed the candidate for touching
   * an immutable file they had edited. Absent on a hand-built sandbox, which
   * then compares against the live tree as before.
   */
  base?: ReadonlyMap<string, string>
}

function contentHash(path: string): string | undefined {
  const content = readIfPresent(path)
  return content === undefined ? undefined : String(Bun.hash(content))
}

function snapshotHashes(root: string): Map<string, string> {
  const hashes = new Map<string, string>()
  for (const relativePath of trackedFilesIn(root)) {
    const hash = contentHash(join(root, relativePath))
    if (hash !== undefined) hashes.set(relativePath, hash)
  }
  return hashes
}

/**
 * How many full sandbox copies (`gen-N/`) to keep around. A rejected
 * generation's sandbox is deliberately left for inspection, but each one is a
 * whole copy of `src/`, so without a cap `.evolution/` grew by one per
 * generation forever. The small `gen-N-backup/` rollback directories of
 * promoted generations are never pruned — they are how a promotion is undone.
 */
export const KEEP_SANDBOXES = 5

/**
 * Delete all but the `keep` most recent `gen-N/` sandbox copies. Returns what
 * was removed.
 *
 * Pruning is generation-scoped: only copies numerically older than
 * `currentGeneration` (the generation the caller just claimed) are eligible,
 * and "most recent" is decided by the generation number, never by mtime.
 * Generation numbers are claimed under a file lock and are unique and
 * monotonic, so a numerically lower copy is older no matter when it was last
 * touched. Sorting on mtime let a stale copy (oldest mtime) be `rmSync`'d
 * while a sibling `elia evolve` was still measuring it — mtime changes on
 * every read anyway, so the deletion order was never deterministic.
 */
export function pruneSandboxes(keep = KEEP_SANDBOXES, dir = EVOLUTION_DIR, currentGeneration = Number.POSITIVE_INFINITY): string[] {
  let entries: Array<{ path: string; generation: number }>
  try {
    entries = readdirSync(dir)
      .filter((name) => /^gen-(\d+)$/.test(name))
      .map((name) => {
        const match = /^gen-(\d+)$/.exec(name)!
        return { path: join(dir, name), generation: Number.parseInt(match[1]!, 10) }
      })
  } catch {
    return []
  }
  const removed: string[] = []
  for (const { path } of entries
    .filter((entry) => entry.generation < currentGeneration)
    .sort((a, b) => b.generation - a.generation)
    .slice(Math.max(0, keep))) {
    try {
      rmSync(path, { recursive: true, force: true })
      removed.push(path)
    } catch {
      // In use (Windows) or already gone — the next prune gets it.
    }
  }
  return removed
}

export function createSandbox(generation: number, liveRoot = ELIA_ROOT, dir = EVOLUTION_DIR): Sandbox {
  const root = join(dir, `gen-${generation}`)
  // Make room first, so the new one plus the kept ones stay within the cap.
  // Prune only generations older than the one just claimed: a sibling evolve
  // process's live sandbox carries a generation number inside the keep window,
  // and must survive this prune regardless of its mtime.
  pruneSandboxes(KEEP_SANDBOXES - 1, dir, generation)
  rmSync(root, { recursive: true, force: true })
  mkdirSync(root, { recursive: true })

  for (const entry of COPIED_ENTRIES) {
    const from = join(liveRoot, entry)
    if (!existsSync(from)) continue
    const to = join(root, entry)
    if (statSync(from).isDirectory()) cpSync(from, to, { recursive: true })
    else copyFileSync(from, to)
  }

  return { generation, root, backupDir: join(dir, `gen-${generation}-backup`), base: snapshotHashes(root) }
}

export function removeSandbox(sandbox: Sandbox): void {
  rmSync(sandbox.root, { recursive: true, force: true })
}

/**
 * Every source file that differs between the sandbox and the live tree.
 *
 * Compared by content rather than by trusting the builder's report: what matters
 * to the gate is what actually changed on disk, which is regularly not what the
 * report says.
 */
export function changedFiles(sandbox: Sandbox, liveRoot = ELIA_ROOT): string[] {
  const changed: string[] = []

  // Against what the candidate started from, not the live tree as it is now.
  if (sandbox.base) {
    for (const relativePath of trackedFilesIn(sandbox.root)) {
      if (contentHash(join(sandbox.root, relativePath)) !== sandbox.base.get(relativePath)) changed.push(relativePath)
    }
    for (const relativePath of sandbox.base.keys()) {
      if (!existsSync(join(sandbox.root, relativePath))) changed.push(relativePath)
    }
    return [...new Set(changed)].sort()
  }

  for (const relativePath of trackedFilesIn(sandbox.root)) {
    const candidate = readIfPresent(join(sandbox.root, relativePath))
    const live = readIfPresent(join(liveRoot, relativePath))
    if (candidate !== live) changed.push(relativePath)
  }

  // A file the candidate deleted still counts as a change.
  for (const relativePath of trackedFilesIn(liveRoot)) {
    if (!existsSync(join(sandbox.root, relativePath))) changed.push(relativePath)
  }

  return [...new Set(changed)].sort()
}

/** A promotion refused because the live tree moved under a file the candidate changed. */
export class LiveTreeConflict extends Error {
  constructor(readonly files: string[]) {
    super(`the live tree changed ${files.join(', ')} while the generation ran — promoting would overwrite that work`)
    this.name = 'LiveTreeConflict'
  }
}

/** Changed files whose live copy no longer matches what the candidate started from. */
export function liveConflicts(sandbox: Sandbox, changed: string[], liveRoot = ELIA_ROOT): string[] {
  if (!sandbox.base) return []
  return changed.filter((relativePath) => contentHash(join(liveRoot, relativePath)) !== sandbox.base!.get(relativePath))
}

/** Which of the changed files the candidate was forbidden from touching. */
export function violatedImmutables(changed: string[]): string[] {
  return changed.filter(isImmutablePath)
}

/**
 * Moves a passing candidate into the live tree, backing up what it replaces.
 * Returns the backup directory so a promotion can be undone by copying it back.
 */
export function promote(sandbox: Sandbox, changed: string[], liveRoot = ELIA_ROOT): string {
  // Someone changed a file the candidate also changed: promoting would throw
  // their work away. Refuse before touching anything.
  const conflicts = liveConflicts(sandbox, changed, liveRoot)
  if (conflicts.length > 0) throw new LiveTreeConflict(conflicts)

  rmSync(sandbox.backupDir, { recursive: true, force: true })
  mkdirSync(sandbox.backupDir, { recursive: true })

  // Finish every backup before touching the live tree. If backup fails, there is
  // nothing to roll back because promotion has not started.
  for (const relativePath of changed) {
    const livePath = join(liveRoot, relativePath)
    if (existsSync(livePath)) {
      const backupPath = join(sandbox.backupDir, relativePath)
      mkdirSync(join(backupPath, '..'), { recursive: true })
      copyFileSync(livePath, backupPath)
    }

  }

  const applied: string[] = []
  try {
    for (const relativePath of changed) {
      const livePath = join(liveRoot, relativePath)
      const candidatePath = join(sandbox.root, relativePath)
      applied.push(relativePath)
      if (existsSync(candidatePath)) {
        mkdirSync(join(livePath, '..'), { recursive: true })
        copyFileSync(candidatePath, livePath)
      } else {
        // The candidate deleted it; mirror that, having backed it up first.
        rmSync(livePath, { force: true })
      }
    }
  } catch (error) {
    rollback(sandbox, applied, liveRoot)
    throw error
  }

  return sandbox.backupDir
}

/** Undoes a promotion from its backup directory. */
export function rollback(sandbox: Sandbox, changed: string[], liveRoot = ELIA_ROOT): void {
  for (const relativePath of changed) {
    const backupPath = join(sandbox.backupDir, relativePath)
    const livePath = join(liveRoot, relativePath)
    if (existsSync(backupPath)) {
      mkdirSync(join(livePath, '..'), { recursive: true })
      copyFileSync(backupPath, livePath)
    } else {
      // No backup means promotion introduced this file. A real rollback must
      // remove it instead of leaving a partially promoted candidate behind.
      rmSync(livePath, { force: true })
    }
  }
}

function trackedFilesIn(root: string): string[] {
  const srcDir = join(root, 'src')
  const files: string[] = []
  if (existsSync(srcDir)) {
    const glob = new Bun.Glob('**/*.ts')
    for (const path of glob.scanSync({ cwd: srcDir, dot: false })) {
      files.push(`src/${path.replace(/\\/g, '/')}`)
    }
  }
  for (const file of TRACKED_ROOT_FILES) if (existsSync(join(root, file))) files.push(file)
  return files
}

function readIfPresent(path: string): string | undefined {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return undefined
  }
}

/** A short human-readable diff summary for the ledger and the terminal. */
export function describeChanges(sandbox: Sandbox, changed: string[], liveRoot = ELIA_ROOT): string {
  return changed
    .map((relativePath) => {
      const candidate = readIfPresent(join(sandbox.root, relativePath))
      const live = readIfPresent(join(liveRoot, relativePath))
      if (candidate === undefined) return `  - ${relativePath} (deleted)`
      if (live === undefined) return `  + ${relativePath} (new, ${candidate.split('\n').length} lines)`
      const delta = candidate.split('\n').length - live.split('\n').length
      return `  ~ ${relativePath} (${delta >= 0 ? '+' : ''}${delta} lines)`
    })
    .join('\n')
}

export function relativeToRoot(path: string, root = ELIA_ROOT): string {
  return relative(root, path).replace(/\\/g, '/')
}

/**
 * Commits a passing candidate to its own branch instead of copying it into the
 * live tree — what an unattended run does, so nobody finds their checkout
 * changed under them. Built with git plumbing and a throwaway index: the
 * working tree, the real index and the current branch are never touched.
 *
 * The branch is HEAD plus exactly the candidate's changes, so it refuses when a
 * changed file has uncommitted edits in the live tree: the candidate was built
 * on top of them, and committing its copy would smuggle those edits in too.
 * Returns the new commit's sha.
 */
export async function promoteToBranch(
  sandbox: Sandbox,
  changed: string[],
  branch: string,
  message: string,
  liveRoot = ELIA_ROOT,
): Promise<string> {
  const { runGit } = await import('../autonomy/worktree.ts')
  const conflicts = liveConflicts(sandbox, changed, liveRoot)
  if (conflicts.length > 0) throw new LiveTreeConflict(conflicts)

  const git = async (args: string[], env?: Record<string, string>): Promise<string> => {
    const result = await runGit(['-C', liveRoot, ...args], undefined, env)
    if (result.exitCode !== 0) throw new Error(`git ${args[0]} failed: ${(result.stderr || result.stdout).trim()}`)
    return result.stdout.trim()
  }

  const dirty = (await git(['status', '--porcelain=v1', '--untracked-files=all', '--', ...changed])).split('\n').filter(Boolean)
  if (dirty.length > 0) throw new LiveTreeConflict(dirty.map((line) => line.slice(3)))

  const head = await git(['rev-parse', 'HEAD'])
  const indexDir = mkdtempSync(join(tmpdir(), 'elia-evolve-index-'))
  const env = { GIT_INDEX_FILE: join(indexDir, 'index') }
  try {
    await git(['read-tree', head], env)
    for (const relativePath of changed) {
      const candidatePath = join(sandbox.root, relativePath)
      if (existsSync(candidatePath)) {
        // --path applies the repo's own filters (line endings), as `git add` would.
        const blob = await git(['hash-object', '-w', `--path=${relativePath}`, candidatePath])
        await git(['update-index', '--add', '--cacheinfo', `100644,${blob},${relativePath}`], env)
      } else {
        await git(['update-index', '--force-remove', '--', relativePath], env)
      }
    }
    const tree = await git(['write-tree'], env)
    const commit = await git(['commit-tree', tree, '-p', head, '-m', message])
    await git(['update-ref', `refs/heads/${branch}`, commit])
    return commit
  } finally {
    rmSync(indexDir, { recursive: true, force: true })
  }
}
