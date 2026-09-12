/**
 * Parses pytest's "short test summary info" section — `-rA` (report all)
 * guarantees every requested test appears there regardless of verbosity,
 * one line per test in a uniform `STATUS test::id[ - reason]` shape. Chosen
 * over the per-test progress lines (`test_id PASSED [ 33%]`) or a JSON report
 * plugin: the summary section needs no extra pytest plugin, and its format
 * is stable across pytest's own verbosity settings. Verified against a real
 * pytest run (pytest 9.0.3) before relying on it.
 */

export type TestOutcome = 'PASSED' | 'FAILED' | 'ERROR' | 'SKIPPED'

const SUMMARY_LINE = /^(PASSED|FAILED|ERROR|SKIPPED)\s+(\S+?)(?:\s+-\s+.*)?$/gm

export function parseTestOutcomes(output: string): Map<string, TestOutcome> {
  const outcomes = new Map<string, TestOutcome>()
  for (const match of output.matchAll(SUMMARY_LINE)) {
    outcomes.set(match[2]!, match[1] as TestOutcome)
  }
  return outcomes
}

export interface PytestInvocation {
  executable: string
  args: string[]
}

/**
 * Returns an argv split, not a shell-string command — a SWE-bench test id can
 * contain `[...]` (parametrized tests) or spaces in its parameter values,
 * either of which a shell would split or glob-expand, and shell.ts's `runShell`
 * on Windows only strips the *outermost* quote pair (`cmd /s`), so a
 * per-argument `"..."` quote survives as a literal character in the argv
 * pytest receives — confirmed by hand: it turned "test_add.py::test_add"
 * into a file-not-found error for the literal string with the quotes still
 * attached. runProcess (direct argv, no shell re-parsing) sidesteps this
 * entirely, the same reasoning shell.ts's own runProcess doc comment gives
 * for preferring it over runShell whenever arguments are already known.
 */
export function pytestInvocation(testIds: string[], testCommand = 'python -m pytest'): PytestInvocation {
  const [executable, ...prefixArgs] = testCommand.trim().split(/\s+/)
  return { executable: executable ?? 'python', args: [...prefixArgs, ...testIds, '-v', '--no-header', '-rA'] }
}

/**
 * The same invocation, as a single POSIX-shell-safe string — for the
 * container sandbox path, whose `docker run ... sh -c "<command>"` needs a
 * shell string, not an argv array. Single-quoted per argument (the standard
 * POSIX-safe method: end the quote, escape a literal `'` as `'\''`, reopen
 * it), not double-quoted — double quotes are exactly what turned out unsafe
 * for shell.ts's Windows `cmd /s` path; `sh -c` itself handles a properly
 * single-quoted argument correctly, this just avoids repeating the same
 * quoting mistake in a different shell.
 */
export function pytestShellCommand(testIds: string[], testCommand = 'python -m pytest'): string {
  const { executable, args } = pytestInvocation(testIds, testCommand)
  const posixQuote = (value: string) => `'${value.replace(/'/g, "'\\''")}'`
  return [executable, ...args].map(posixQuote).join(' ')
}
