import { join } from 'node:path'
import { createWorktree, mergeWorktreeIntoCwd, parseStatus, removeWorktree, runGit } from '../autonomy/worktree.ts'
import { withRepoLock } from '../repoLock.ts'
import type { Worktree } from '../autonomy/worktree.ts'
import { failureBriefing } from './select.ts'
import type { AttemptRecord, Approach, Producer } from './select.ts'
import type { Candidate } from './verify.ts'

/**
 * Somewhere for each attempt to be wrong in private.
 *
 * A search over several attempts is only sound if the attempts cannot see or
 * spoil each other's work, and for a coding agent that is a physical problem
 * rather than a logical one: three attempts editing the same checkout produce
 * one incoherent tree and a verifier that is measuring the collision. So each
 * attempt gets its own git worktree, seeded from HEAD plus whatever the user
 * already had uncommitted, and the checks run there. Only the attempt that wins
 * is copied back; the rest are deleted having never touched the user's files.
 *
 * elia already owns this machinery — `autonomy/variants.ts` runs the autonomous
 * pipeline's execute phase several times this way. What it does not have is a
 * reason to: `variantCount` is `options.variants ?? 1`, so unless someone passes
 * the flag the isolation is built and never used, and when it is used every
 * attempt runs the *same* plan and differs only by sampling. This module is the
 * same physical layer driven by the search in select.ts instead — attempts that
 * differ by approach rather than by luck, a round that reads why the last one
 * failed, and a stop the moment something passes.
 *
 * The attempt itself is injected. Running one means a full agent loop with the
 * caller's provider, tools, and prompts, and none of that belongs to a module
 * whose job is worktrees.
 */

/** Runs a single attempt inside `cwd`, which is that attempt's private checkout. */
export type AttemptRunner = (input: {
  cwd: string
  approach: Approach
  round: number
  /** The approach's instruction and, from round two on, what the rejected attempts got wrong. */
  briefing: string
  signal?: AbortSignal
}) => Promise<{ text: string; cost?: number }>

export interface IsolatedSearch {
  produce: Producer
  /**
   * Copies the winner's files into the real tree and tears every worktree down.
   * Safe to call with no winner, and safe to call twice — a search that ended
   * without an answer still has to leave the user's checkout clean.
   */
  settle(winner?: Candidate): Promise<string[]>
  /** Worktrees currently held, so a caller can report or clean up after a crash. */
  held(): Worktree[]
  /**
   * The paths a candidate's worktree changed, relative to its root.
   *
   * The merge copies files straight into the user's tree rather than going
   * through elia's write tools, so nothing in the turn would otherwise know
   * those files changed: the turn would record `filesChanged: 0`, the
   * verification-coverage metric would treat a searched turn as having had
   * nothing to check, and a rewind would not restore them. The caller snapshots
   * these before settling.
   */
  changedBy(candidate: Candidate): Promise<string[]>
}

export interface IsolatedSearchOptions {
  /** Names this search's worktrees and branches. */
  runId: string
  /** The repository the attempts branch from, and the tree the winner is merged back into. */
  sourceRoot: string
  /** Where worktrees are created. Defaults to elia's state dir. */
  baseDir?: string
  run: AttemptRunner
}

/**
 * The briefing one attempt is given.
 *
 * The approach goes first because it is what makes this attempt different from
 * its siblings, and the failures go after it because they are context rather
 * than instruction. An attempt that reads the failures first tends to write a
 * commentary on them; one that reads its own approach first goes and tries it.
 */
export function attemptBriefing(approach: Approach, priorFailures: AttemptRecord[]): string {
  const failures = failureBriefing(priorFailures)
  return failures ? `${approach.instruction}\n\n${failures}` : approach.instruction
}

export function isolatedSearch(options: IsolatedSearchOptions): IsolatedSearch {
  const worktrees = new Map<string, Worktree>()
  let index = 0
  let settled = false

  const produce: Producer = async ({ approach, round, priorFailures, signal }) => {
    const slot = index++
    // Creating the worktree is serialized; running the attempt is not.
    //
    // `git worktree add` mutates the repository — it writes under
    // `.git/worktrees` and creates a branch — and a round opens several at once
    // on the same repo. Concurrent git writes to one repository contend for the
    // index and ref locks, and the failure is intermittent rather than loud: one
    // attempt of the round simply never gets a tree. Under load that showed up
    // as a search that "found nothing" with no error anywhere to explain it.
    //
    // The serialization costs nothing worth having. Creating a worktree takes
    // milliseconds and the attempt that follows it takes a model call, so the
    // attempts still overlap almost completely. `withRepoLock` is the same
    // primitive elia's write tools use, so this also holds against a second
    // elia process working in the same checkout — which is the normal case here.
    const worktree = await withRepoLock(() =>
      createWorktree(options.runId, slot, options.sourceRoot, options.baseDir ?? join(options.sourceRoot, '.elia')),
    )
    const id = `${approach.id}-r${round}-${slot}`
    worktrees.set(id, worktree)

    const outcome = await options.run({
      cwd: worktree.path,
      approach,
      round,
      briefing: attemptBriefing(approach, priorFailures),
      signal,
    })

    // `cwd` is what makes the verifier check *this* attempt: the project's test
    // command runs inside the worktree, against the files this attempt wrote.
    return { id, approach: approach.id, text: outcome.text, cwd: worktree.path, cost: outcome.cost }
  }

  return {
    produce,
    held: () => [...worktrees.values()],
    async changedBy(candidate) {
      const worktree = worktrees.get(candidate.id)
      if (!worktree) return []
      const status = await runGit(['status', '--porcelain'], worktree.path)
      return status.exitCode === 0 ? parseStatus(status.stdout).map((change) => change.path) : []
    },
    async settle(winner) {
      if (settled) return []
      settled = true
      const winning = winner ? worktrees.get(winner.id) : undefined
      // Merge before cleanup, and only ever the winner: copying a rejected
      // attempt's files into the user's tree is the one unrecoverable mistake
      // available here.
      const merged = winning ? await mergeWorktreeIntoCwd(winning, options.sourceRoot) : []
      for (const worktree of worktrees.values()) {
        await removeWorktree(worktree, options.sourceRoot)
      }
      worktrees.clear()
      return merged
    },
  }
}
