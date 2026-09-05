import { expect, test } from 'bun:test'
import terminalSize from 'terminal-size'

/**
 * Guards the fix for CI run 33959103008, where `App.test.tsx`'s status-bar test
 * failed all three `--retry` attempts with React's "Should not already be
 * working."
 *
 * The cause was not flake. `ink-testing-library`'s fake stdout exposes
 * `columns` but no `rows`, so Ink's `getWindowSize` rejects it and calls
 * `terminal-size` on every layout pass. With no TTY, no `/dev/tty` and no
 * `COLUMNS`/`LINES` — exactly a GitHub Linux runner — `terminal-size` reaches
 * its `tput` branch and runs a *synchronous* `execFileSync` from inside React's
 * commit phase, which re-enters the scheduler mid-commit.
 *
 * scripts/testPreload.ts pins COLUMNS/LINES so `terminal-size` returns from its
 * env branch first. These assertions fail if that preload stops being applied
 * (a dropped bunfig.toml, a runner invoked without it), which is the only way
 * the spawn path can come back.
 */
test('the test environment pins a terminal size, so Ink never shells out mid-render', () => {
  expect(process.env.COLUMNS).toBe('100')
  expect(process.env.LINES).toBe('24')
})

test('terminal-size resolves without reaching its spawning branches', () => {
  const stream = (s: { columns?: number; rows?: number } | undefined) => Boolean(s?.columns && s?.rows)

  // `terminal-size` answers from `process.stdout`/`stderr` first when those
  // carry dimensions — an interactive terminal, where the `tput` branch is
  // unreachable and there is nothing for the preload to guard.
  if (stream(process.stdout) || stream(process.stderr)) {
    expect(terminalSize().columns).toBeGreaterThan(0)
    return
  }

  // Otherwise — a piped runner, and the case that broke CI — the env branch has
  // to catch it. Only that branch can produce this exact pair: `tput`/`/dev/tty`
  // report the real terminal, and the hardcoded fallback is 80x24.
  expect(terminalSize()).toEqual({ columns: 100, rows: 24 })
})
