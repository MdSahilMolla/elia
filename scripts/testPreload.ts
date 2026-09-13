import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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
;(paths as { promptHistory: string }).promptHistory = join(testState, 'prompt-history')
;(paths as { diagnostics: string }).diagnostics = join(testState, 'diagnostics.ndjson')
