import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { BenchCheck, BenchTask } from '../suite.ts'
import { contentHash, materializeTask } from './materialize.ts'
import { runVerify } from './verifyRun.ts'
import { TASKS_FILE } from './harvest.ts'
import type { HistoryTaskSpec } from './types.ts'

/**
 * The history-derived half of the benchmark.
 *
 * Each task drops the agent into elia's own repository at the commit before some
 * real piece of work, with that work's tests already written and failing, and
 * asks it to make them pass. Grading is the test suite's own exit code.
 */

/**
 * Matches `DEFAULT_MAX_STEPS` in agentLoop.ts — what a real interactive run gets.
 * A history task is a real repository, and orienting in one costs steps before
 * any code is written.
 */
export const HISTORY_TASK_MAX_STEPS = 80

let cached: HistoryTaskSpec[] | undefined

export function loadTaskSpecs(file = TASKS_FILE): HistoryTaskSpec[] {
  if (cached) return cached
  if (!existsSync(file)) {
    cached = []
    return cached
  }
  cached = JSON.parse(readFileSync(file, 'utf8')) as HistoryTaskSpec[]
  return cached
}

/** Test-only: drops the memoized specs so a test can point the loader elsewhere. */
export function resetTaskSpecCache(): void {
  cached = undefined
}

/**
 * What the agent is told.
 *
 * The commit message is deliberately *not* included. Elia's commit subjects
 * describe the fix that was chosen ("Classify why a repair loop is stuck and act
 * on it"), so handing one over turns diagnosis into transcription and inflates
 * the score. The failing tests are the whole brief — which is also the realistic
 * version of the task, and the one that cannot be gamed by rephrasing.
 */
export function promptFor(spec: HistoryTaskSpec): string {
  const tests = spec.testFiles.map((file) => `  ${file}`).join('\n')
  return [
    'This repository has failing tests. Make them pass.',
    '',
    'The failing test files are:',
    tests,
    '',
    `Run them with:  ${spec.verifyCommand}`,
    '',
    'These tests are the specification. Read them, work out what they require,',
    'and implement it in the source. Do not edit, delete, skip, or weaken any',
    'test file — a change to any of the files listed above fails this task',
    'outright, even if the suite goes green. Do not add new test files to make',
    'the command pass.',
    '',
    'You are done when the command above exits 0.',
  ].join('\n')
}

/**
 * Confirms the agent left the specification alone.
 *
 * Rewriting the failing test is the shortest path to a green command, and an
 * agent that finds it should score zero rather than 100%. Hashes are compared
 * against the exact contents that were laid down at setup, so deleting a test
 * file fails too.
 */
export function checkTestsUntouched(dir: string, expected: Map<string, string>): BenchCheck | undefined {
  for (const [file, hash] of expected) {
    const path = join(dir, file)
    if (!existsSync(path)) {
      return { passed: false, detail: `deleted the specification: ${file} is gone` }
    }
    if (contentHash(readFileSync(path, 'utf8')) !== hash) {
      return { passed: false, detail: `edited the specification: ${file} no longer matches the tests it was given` }
    }
  }
  return undefined
}

export function toBenchTask(spec: HistoryTaskSpec): BenchTask {
  // Populated by setup and read by check, which run against the same dir in the
  // same process (see fitness.ts). Keyed by dir so parallel tasks cannot collide.
  const expectedHashes = new Map<string, Map<string, string>>()

  return {
    id: spec.id,
    weight: spec.weight,
    prompt: promptFor(spec),
    maxSteps: HISTORY_TASK_MAX_STEPS,
    async setup(dir) {
      expectedHashes.set(
        dir,
        await materializeTask({ parent: spec.parent, sha: spec.sha, testFiles: spec.testFiles, dir }),
      )
    },
    async check(dir) {
      const expected = expectedHashes.get(dir)
      if (!expected) return { passed: false, detail: 'setup did not record the specification hashes' }

      const tampered = checkTestsUntouched(dir, expected)
      if (tampered) return tampered

      const { result, counts } = await runVerify(spec.verifyCommand, dir)
      if (result.timedOut) return { passed: false, detail: `verification timed out after ${result.elapsedMs}ms` }
      if (result.exitCode !== 0) {
        return { passed: false, detail: `${counts.fail} of ${counts.pass + counts.fail} tests still failing` }
      }
      if (counts.pass === 0) {
        // Green with nothing run means the command stopped matching any test.
        return { passed: false, detail: 'the verify command ran no tests' }
      }
      return { passed: true, detail: `${counts.pass} tests passing (${spec.evidence.failingBefore} were failing at the start)` }
    },
  }
}

export function historyTasks(file = TASKS_FILE): BenchTask[] {
  return loadTaskSpecs(file).map(toBenchTask)
}
