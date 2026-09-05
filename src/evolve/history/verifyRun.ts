import { runShell, type ShellResult } from '../../shell.ts'

/** A test-suite run needs far longer than an ordinary tool call. */
export const VERIFY_TIMEOUT_MS = 240_000

export interface TestCounts {
  pass: number
  fail: number
}

/**
 * Task repos are trees from before scripts/testPreload.ts existed, so they carry
 * no bunfig.toml to pin the terminal size, and any Ink test in them would reach
 * terminal-size's `tput` branch — fatal mid-render, see scripts/testPreload.ts.
 * Spawned children inherit this process's environment, so setting it once here
 * covers every task repo without modifying the tree being graded.
 */
export function pinTerminalSizeForChildren(): void {
  process.env.COLUMNS ??= '100'
  process.env.LINES ??= '24'
}

/**
 * Runs a task repo's verify command and reads Bun's own summary back out.
 *
 * Counts, not just the exit code, because the harvester has to prove a task is
 * real: "the tests failed before and passed after" is only meaningful if tests
 * actually *ran* both times. An exit code of 1 is produced just as readily by a
 * syntax error or a missing dependency as by a failing assertion.
 */
export async function runVerify(command: string, cwd: string, signal?: AbortSignal): Promise<{ result: ShellResult; counts: TestCounts }> {
  pinTerminalSizeForChildren()
  const result = await runShell(command, VERIFY_TIMEOUT_MS, cwd, signal)
  return { result, counts: parseCounts(`${result.stdout}\n${result.stderr}`) }
}

/**
 * Reads the ` N pass` / ` N fail` lines Bun prints at the end of a run.
 *
 * A literal regex rather than one built with `new RegExp(\`...\`)`: inside a
 * template literal `\s` is not a recognised escape, so it collapses to a plain
 * `s` and the pattern silently stops matching digits and whitespace at all.
 * Written out once with an alternation, there is nothing to collapse.
 *
 * Bun prints this summary on stderr, so callers must search both streams.
 */
const SUMMARY_LINE = /^\s*(\d+)\s+(pass|fail)\s*$/gm

export function parseCounts(output: string): TestCounts {
  const counts: TestCounts = { pass: 0, fail: 0 }
  // Last occurrence wins: with several test files Bun prints a per-file group
  // and then the totals, and only the totals describe the whole run.
  for (const match of output.matchAll(SUMMARY_LINE)) {
    counts[match[2] as 'pass' | 'fail'] = Number.parseInt(match[1]!, 10)
  }
  return counts
}
