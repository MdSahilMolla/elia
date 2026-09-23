import { setDefaultTimeout } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { paths } from '../src/statePaths.ts'

/**
 * Preloaded before every `bun test` module (see bunfig.toml).
 *
 * Ink's `getWindowSize` needs BOTH `columns` and `rows` from the stream it is
 * given, and `ink-testing-library`'s fake stdout only defines `columns`. So
 * every layout pass in every Ink test falls through to `terminal-size`, which
 * on a non-TTY Linux runner (no `stdout.columns`, no `/dev/tty`, no
 * `COLUMNS`/`LINES`) shells out to `tput` via a **synchronous** `execFileSync`
 * — from inside React's commit phase. That sync spawn lets the React scheduler
 * re-enter a commit that is already in flight, and the render dies with
 * "Should not already be working."
 *
 * It is load-dependent, so it survives `--retry`: CI run 33959103008 failed
 * `App.test.tsx`'s status-bar test on all three attempts while the same test
 * passed locally on Windows, where `stdout.columns`/`rows` are populated and
 * the `tput` path is never taken.
 *
 * Setting COLUMNS/LINES makes `terminal-size` return from its env branch before
 * it ever spawns anything. That removes the re-entrancy crash, drops two child
 * processes per layout pass on CI, and pins every Ink test to one frame width
 * so wrap-sensitive assertions mean the same thing on every machine.
 *
 * 100 columns matches `ink-testing-library`'s own fake `stdout.columns`, so the
 * width Ink lays out to is the width the captured frame was rendered at.
 */
process.env.COLUMNS ??= '100'
process.env.LINES ??= '24'

// A provider that fails on its side is asked again after 2s, 8s and 30s
// (agentLoop.ts). Tests that provoke those failures on purpose should see the
// retries, not sit through them.
process.env.ELIA_TRANSIENT_RETRY_DELAYS_MS ??= '0,0,0'
// Same for a pass where no provider could be reached at all: one immediate
// re-walk of the chain, so a test that means every route to fail still fails.
process.env.ELIA_OUTAGE_RETRY_DELAYS_MS ??= '0'

/**
 * Tests run from the repo root, so `paths` points at the developer's own
 * `.elia/` state. The Ink tests submit prompts through the real InputBox, which
 * appends each one to `paths.promptHistory` — "do the thing", "long running
 * task" and "line one…" were landing in the operator's ↑-history on every test
 * run — and every error a test provokes on purpose (an unreachable OTel
 * collector, an MCP echo server that exits early) was appended to the real
 * `.elia/diagnostics.ndjson`, burying the entries worth reading. Point both at
 * a throwaway directory for the whole test process.
 */
const testState = mkdtempSync(join(tmpdir(), 'elia-test-state-'))

// Redirect *every* path under `.elia/`, not the two that were noticed first.
//
// The same reasoning applies to all of them, and the ones left behind mattered
// more: a test that starts a real autonomous run writes a real receipt into the
// real `.elia/runs`. 34 of this repository's 63 receipts were test artifacts —
// 26 of them one orient-only test's 'create an expo app for notetaking', run
// once per suite execution. `elia compounding` and `elia distill` compute every
// number they report from those receipts, so the measurements meant to say
// whether elia is improving were mostly describing its own test suite.
//
// Derived by prefix rather than by listing keys, so a path added to `paths`
// later is isolated without anyone having to remember this file.
const realState = paths.state
for (const [key, value] of Object.entries(paths)) {
  if (key === 'state' || typeof value !== 'string' || !value.startsWith(realState)) continue
  ;(paths as Record<string, string>)[key] = join(testState, relative(realState, value))
}
;(paths as Record<string, string>).state = testState

/**
 * One per-test timeout for every way the suite is run.
 *
 * CI runs `bun test --timeout=20000`; a plain local `bun test` used bun's 5s
 * default. So the two were never running the same suite: tests that spawn the
 * real CLI, a shell, or a language server take seconds, and on a machine
 * already busy with other work they crossed 5s and failed locally while CI,
 * with four times the budget, passed. That split taught people to read a red
 * local run as "probably load" — which is exactly how a real regression gets
 * waved through.
 *
 * bun 1.3 ignores `[test] timeout` in bunfig.toml, so it is set here, where it
 * applies to every test module however the suite is invoked. A test that
 * passes its own timeout still gets that one, so deliberately tight bounds
 * still bite. Keep this equal to the CI flag.
 */
setDefaultTimeout(20_000)

/**
 * `browser` falls back to launching elia's own headless Chrome when no bridge
 * is configured. A test that calls the tool with nothing configured — several
 * do, to check the no-bridge message — would otherwise start a real browser
 * process on any machine that has Chrome. Tests that want the built-in browser
 * set `ELIA_BROWSER=owned` themselves.
 */
process.env.ELIA_BROWSER ??= 'off'
