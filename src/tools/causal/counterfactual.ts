// Counterfactual analysis: test whether removing a candidate change
// eliminates the failure, using isolated git worktrees.

import type { CounterfactualResult, ReproductionResult } from './types.ts'
import { runGit } from '../../autonomy/worktree.ts'
import { reproduceFromFile } from './reproduction.ts'
import { join } from 'node:path'
import { paths } from '../../statePaths.ts'
import { rm } from 'node:fs/promises'

const COUNTERFACTUAL_TIMEOUT_MS = 60_000

/** Perform counterfactual analysis in an isolated worktree. */
export async function performCounterfactual(
  candidateCommitHash: string,
  targetFile: string,
  cwd: string,
  baseDir: string = paths.state,
): Promise<CounterfactualResult> {
  const worktreeId = `counterfactual_${Date.now()}`
  const worktreePath = join(baseDir, 'worktrees', worktreeId)

  try {
    // Create isolated worktree
    const createResult = await runGit(
      ['worktree', 'add', '--detach', worktreePath, 'HEAD'],
      cwd,
    )

    if (createResult.exitCode !== 0) {
      return {
        performed: false,
        candidateCausal: false,
        counterfactualReproduction: { established: false, bugConfirmed: false, output: '', limitation: 'Failed to create worktree' },
        explanation: 'Could not create isolated worktree for counterfactual analysis',
        limitation: `Worktree creation failed: ${createResult.stderr}`,
      }
    }

    // First, reproduce the bug in the current state
    const currentReproduction = await reproduceFromFile(targetFile, worktreePath)

    // Now revert the candidate commit
    const revertResult = await runGit(
      ['revert', '--no-commit', candidateCommitHash],
      worktreePath,
    )

    if (revertResult.exitCode !== 0) {
      // Try a simpler approach: checkout the file before the commit
      const checkoutResult = await runGit(
        ['checkout', `${candidateCommitHash}^`, '--', targetFile],
        worktreePath,
      )

      if (checkoutResult.exitCode !== 0) {
        await cleanupWorktree(worktreePath, cwd)
        return {
          performed: false,
          candidateCausal: false,
          counterfactualReproduction: { established: false, bugConfirmed: false, output: '', limitation: 'Could not revert candidate change' },
          explanation: 'Failed to revert the candidate commit for counterfactual analysis',
          limitation: 'Revert produced conflicts or the commit could not be undone cleanly',
        }
      }
    }

    // Now reproduce the bug in the counterfactual state
    const counterfactualReproduction = await reproduceFromFile(targetFile, worktreePath)

    // Compare results
    const candidateCausal = currentReproduction.bugConfirmed && !counterfactualReproduction.bugConfirmed

    // Cleanup
    await cleanupWorktree(worktreePath, cwd)

    return {
      performed: true,
      candidateCausal,
      counterfactualReproduction,
      explanation: candidateCausal
        ? `Counterfactual analysis confirmed: reverting commit ${candidateCommitHash.slice(0, 8)} eliminates the failure. This is strong evidence that this commit is the root cause.`
        : `Counterfactual analysis did not confirm: reverting commit ${candidateCommitHash.slice(0, 8)} did not eliminate the failure. The root cause may be elsewhere or the failure may not be reproducible.`,
    }
  } catch (error) {
    await cleanupWorktree(worktreePath, cwd)
    const msg = error instanceof Error ? error.message : String(error)
    return {
      performed: false,
      candidateCausal: false,
      counterfactualReproduction: { established: false, bugConfirmed: false, output: '', limitation: `Error: ${msg}` },
      explanation: 'Counterfactual analysis failed due to an unexpected error',
      limitation: `Error during analysis: ${msg}`,
    }
  }
}

/** Cleanup a worktree reliably. */
async function cleanupWorktree(worktreePath: string, sourceRoot: string): Promise<void> {
  try {
    await runGit(['worktree', 'remove', '--force', worktreePath], sourceRoot)
  } catch {
    // Best-effort cleanup
  }
  try {
    await rm(worktreePath, { recursive: true, force: true }).catch(() => {})
  } catch {
    // Best-effort cleanup
  }
}

/** Perform a simpler counterfactual by reverting a single file. */
export async function performFileCounterfactual(
  candidateCommitHash: string,
  targetFile: string,
  cwd: string,
  baseDir: string = paths.state,
): Promise<CounterfactualResult> {
  const worktreeId = `cf_file_${Date.now()}`
  const worktreePath = join(baseDir, 'worktrees', worktreeId)

  try {
    const createResult = await runGit(
      ['worktree', 'add', '--detach', worktreePath, 'HEAD'],
      cwd,
    )

    if (createResult.exitCode !== 0) {
      return {
        performed: false,
        candidateCausal: false,
        counterfactualReproduction: { established: false, bugConfirmed: false, output: '', limitation: 'Failed to create worktree' },
        explanation: 'Could not create isolated worktree',
        limitation: `Worktree creation failed: ${createResult.stderr}`,
      }
    }

    // Checkout the file from before the candidate commit
    const checkoutResult = await runGit(
      ['checkout', `${candidateCommitHash}^`, '--', targetFile],
      worktreePath,
    )

    if (checkoutResult.exitCode !== 0) {
      await cleanupWorktree(worktreePath, cwd)
      return {
        performed: false,
        candidateCausal: false,
        counterfactualReproduction: { established: false, bugConfirmed: false, output: '', limitation: 'Could not checkout file from before commit' },
        explanation: 'Failed to checkout file state from before the candidate commit',
        limitation: 'File may not exist at that commit or checkout failed',
      }
    }

    // Reproduce in counterfactual state
    const reproduction = await reproduceFromFile(targetFile, worktreePath)
    const candidateCausal = reproduction.bugConfirmed === false

    await cleanupWorktree(worktreePath, cwd)

    return {
      performed: true,
      candidateCausal,
      counterfactualReproduction: reproduction,
      explanation: candidateCausal
        ? `File-level counterfactual confirmed: reverting ${targetFile} to before commit ${candidateCommitHash.slice(0, 8)} eliminates the failure.`
        : `File-level counterfactual did not confirm: reverting ${targetFile} did not eliminate the failure.`,
    }
  } catch (error) {
    await cleanupWorktree(worktreePath, cwd)
    const msg = error instanceof Error ? error.message : String(error)
    return {
      performed: false,
      candidateCausal: false,
      counterfactualReproduction: { established: false, bugConfirmed: false, output: '', limitation: `Error: ${msg}` },
      explanation: 'Counterfactual analysis failed',
      limitation: `Error: ${msg}`,
    }
  }
}
