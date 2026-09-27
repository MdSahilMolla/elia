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

function tailOf(text: string, lines = 40, chars = 3_000): string {
  const tail = text.trim().split(/\r?\n/).slice(-lines).join('\n')
  return tail.length > chars ? `…${tail.slice(-chars)}` : tail
}

export type CheckRunner = (command: string, root: string, timeoutMs: number, signal?: AbortSignal) => Promise<{ exitCode: number; stdout: string; stderr: string; elapsedMs: number; timedOut: boolean }>

const defaultRunner: CheckRunner = (command, root, timeoutMs, signal) => runShell(command, timeoutMs, root, signal)

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
      check = { command, status, exitCode: result.exitCode, elapsedMs: result.elapsedMs, tail: status === 'pass' ? '' : tailOf(output) }
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
}

export function compareHealth(before: HealthReport, after: HealthReport): HealthDelta {
  const prior = new Map(before.checks.map((check) => [check.command, check.status]))
  const regressions: string[] = []
  const fixed: string[] = []
  const stillFailing: string[] = []
  for (const check of after.checks) {
    const was = prior.get(check.command)
    if (was === 'pass' && RED.has(check.status)) regressions.push(check.command)
    else if (was !== undefined && RED.has(was) && check.status === 'pass') fixed.push(check.command)
    else if (RED.has(check.status)) stillFailing.push(check.command)
  }
  return { regressions, fixed, stillFailing }
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
