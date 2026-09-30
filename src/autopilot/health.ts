/**
 * Health: which of the project's own checks pass right now.
 *
 * "Where does this repo stand" is answered by running its checks, not by a
 * model reading its README. Every check runs — this is a census, not a gate,
 * so it is not fail-fast the way `runVerification` is — and each one lands in
 * exactly one state:
 *
 *   pass          exit 0 and it actually tested something
 *   fail          non-zero exit
 *   timeout       killed at the time limit
 *   inconclusive  a test runner that found no tests (proves nothing either way)
 *   blocked       the governor would refuse it in an unattended run, so it is
 *                 not run here either — the autopilot never runs a command its
 *                 own workers could not
 *
 * Two reports compare into regressions (pass → fail/timeout) and fixes
 * (fail/timeout → pass), which is all the ratchet needs.
 */

import { assessAction } from '../autonomy/governor.ts'
import { isNoTestsResult } from '../autonomy/verify.ts'
import { isLongRunningServerCommand, runShell } from '../shell.ts'
import type { CheckHealth, CheckStatus, HealthReport } from './types.ts'

export const DEFAULT_CHECK_TIMEOUT_MS = 10 * 60_000

export function checkTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const seconds = Number.parseInt(env.ELIA_AUTOPILOT_CHECK_TIMEOUT_S ?? '', 10)
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1_000 : DEFAULT_CHECK_TIMEOUT_MS
}

/**
 * The failing tests a runner's output names, when it is a runner elia can read:
 * bun `(fail) name [2ms]`, jest/vitest `✕ name (3 ms)`, pytest `FAILED path::test`,
 * go `--- FAIL: TestX (0.00s)`, cargo `test x ... FAILED`. Undefined when none is
 * recognised: then only the check's pass or fail can be compared.
 */
export function failingTests(output: string): string[] | undefined {
  const names = new Set<string>()
  for (const line of output.split(/\r?\n/)) {
    const bun = /^\s*\(fail\)\s+(.+?)(?:\s+\[[\d.]+m?s\])?\s*$/.exec(line)
    const jest = /^\s*[✕×]\s+(.+?)(?:\s+\(\d+(?:\.\d+)?\s*m?s\))?\s*$/.exec(line)
    const pytest = /^FAILED\s+(\S+)/.exec(line)
    const go = /^\s*--- FAIL:\s+(\S+)/.exec(line)
    const cargo = /^test\s+(\S+)\s+\.\.\.\s+FAILED\s*$/.exec(line)
    const name = (bun ?? jest ?? pytest ?? go ?? cargo)?.[1]?.trim()
    if (name) names.add(name)
  }
  return names.size > 0 ? [...names].sort() : undefined
}

/** Lines that name what failed, wherever a runner prints them: bun's `(fail) name`, jest/vitest `FAIL`, compiler `error:`. */
const FAILURE_LINE = /^\s*(?:\(fail\)|✗|×|FAIL\b|--- FAIL|FAILED\b|error(?:\[\w+\])?:|\w*Error:|thread '.*' panicked)/i

/**
 * What a failed check said, for the repair goal. The end of the output alone
 * is a runner's summary: elia's own suite ended "4705 pass · 7 fail" and the
 * goal to fix it was never told which seven. The lines naming failures come
 * first, from anywhere in the output, then the end as before.
 */
function tailOf(text: string, lines = 40, chars = 3_000): string {
  const all = text.trim().split(/\r?\n/)
  const tail = all.slice(-lines).join('\n')
  const failures = [...new Set(all.filter((line) => FAILURE_LINE.test(line)).map((line) => line.trim()))].slice(0, 30)
  const named = failures.length > 0 ? `Failures:\n${failures.join('\n')}\n\nEnd of output:\n` : ''
  const budget = Math.max(chars - named.length, chars / 2)
  return `${named.slice(0, chars / 2)}${tail.length > budget ? `…${tail.slice(-budget)}` : tail}`
}

export type CheckRunner = (command: string, root: string, timeoutMs: number, signal?: AbortSignal) => Promise<{ exitCode: number; stdout: string; stderr: string; elapsedMs: number; timedOut: boolean }>

/**
 * The project's own checks run without elia's credentials. They are the
 * project's code, not elia's: they have no use for its provider keys, and a
 * test suite that finds one may spend it (elia's own cliSmoke test starts a
 * live model run when a key is in reach, on every health measurement).
 */
const defaultRunner: CheckRunner = async (command, root, timeoutMs, signal) => {
  const { withoutEliaSecrets } = await import('../tools/environment.ts')
  return runShell(command, timeoutMs, root, signal, withoutEliaSecrets())
}

export async function measureHealth(
  root: string,
  commands: readonly string[],
  options: { signal?: AbortSignal; timeoutMs?: number; runner?: CheckRunner; now?: () => Date; onCheck?: (check: CheckHealth) => void } = {},
): Promise<HealthReport> {
  const runner = options.runner ?? defaultRunner
  const timeoutMs = options.timeoutMs ?? checkTimeoutMs()
  const checks: CheckHealth[] = []
  for (const command of [...new Set(commands)]) {
    if (options.signal?.aborted) break
    let check: CheckHealth
    if (isLongRunningServerCommand(command) || assessAction({ name: 'run_command', input: { command } }, root).risk === 'critical') {
      check = { command, status: 'blocked', exitCode: -1, elapsedMs: 0, tail: 'not run: the unattended governor would refuse this command (or it starts a server), so it cannot serve as a check' }
    } else {
      const result = await runner(command, root, timeoutMs, options.signal)
      const output = `${result.stdout}\n${result.stderr}`
      const status: CheckStatus = result.timedOut
        ? 'timeout'
        : isNoTestsResult({ command, exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr, elapsedMs: result.elapsedMs, timedOut: false })
          ? 'inconclusive'
          : result.exitCode === 0
            ? 'pass'
            : 'fail'
      const failures = status === 'pass' ? undefined : failingTests(output)
      check = { command, status, exitCode: result.exitCode, elapsedMs: result.elapsedMs, tail: status === 'pass' ? '' : tailOf(output), ...(failures ? { failures } : {}) }
    }
    checks.push(check)
    options.onCheck?.(check)
  }
  return { takenAt: (options.now?.() ?? new Date()).toISOString(), checks }
}

const RED: ReadonlySet<CheckStatus> = new Set(['fail', 'timeout'])

export interface HealthDelta {
  regressions: string[]
  fixed: string[]
  stillFailing: string[]
  /** Still red, but tests that passed before now fail: a regression hidden inside a red check. */
  worsened: Array<{ command: string; newFailures: string[] }>
  /** Still red, but strictly fewer failing tests and no new ones: progress a whole-check pass/fail cannot see. */
  improved: Array<{ command: string; before: number; after: number; fixedTests: string[] }>
}

export function compareHealth(before: HealthReport, after: HealthReport): HealthDelta {
  const prior = new Map(before.checks.map((check) => [check.command, check]))
  const regressions: string[] = []
  const fixed: string[] = []
  const stillFailing: string[] = []
  const worsened: HealthDelta['worsened'] = []
  const improved: HealthDelta['improved'] = []
  for (const check of after.checks) {
    const was = prior.get(check.command)?.status
    if (was === 'pass' && RED.has(check.status)) regressions.push(check.command)
    else if (was !== undefined && RED.has(was) && check.status === 'pass') fixed.push(check.command)
    else if (RED.has(check.status)) {
      stillFailing.push(check.command)
      // Red before and after: compare which tests fail, when both runs named them.
      const earlier = prior.get(check.command)?.failures
      if (earlier && check.failures) {
        const newFailures = check.failures.filter((name) => !earlier.includes(name))
        const fixedTests = earlier.filter((name) => !check.failures!.includes(name))
        if (newFailures.length > 0) worsened.push({ command: check.command, newFailures })
        else if (fixedTests.length > 0) improved.push({ command: check.command, before: earlier.length, after: check.failures.length, fixedTests })
      }
    }
  }
  return { regressions, fixed, stillFailing, worsened, improved }
}

export function passingChecks(report: HealthReport | undefined): string[] {
  return report?.checks.filter((check) => check.status === 'pass').map((check) => check.command) ?? []
}

export function failingChecks(report: HealthReport | undefined): CheckHealth[] {
  return report?.checks.filter((check) => RED.has(check.status)) ?? []
}

export function summarizeHealth(report: HealthReport | undefined): string {
  if (!report || report.checks.length === 0) return 'no checks to measure'
  const counts = new Map<CheckStatus, number>()
  for (const check of report.checks) counts.set(check.status, (counts.get(check.status) ?? 0) + 1)
  return [...counts.entries()].map(([status, count]) => `${count} ${status}`).join(', ')
}
