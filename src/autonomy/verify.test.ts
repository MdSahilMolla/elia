import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test } from 'bun:test'
import { fallbackStaticPageVerification, hasBlockingIssues, isCommandNotFound, isNoTestsResult, isUnrunnableCommandFailure, requireCriticVerdict, runVerification, staticRenderRole, unwinnableVerificationCommands } from './verify.ts'
import { resetPreviewServerForTests } from '../preview/server.ts'

afterEach(() => {
  resetPreviewServerForTests()
})

test('a missing critic verdict fails closed with a blocking issue', () => {
  const verdict = requireCriticVerdict(undefined)

  expect(verdict.verdict).toBe('revise')
  expect(verdict.issues[0]?.severity).toBe('blocker')
  expect(hasBlockingIssues(verdict)).toBe(true)
})

test('a submitted critic verdict is preserved', () => {
  const submitted = { verdict: 'approve' as const, summary: 'sound', issues: [] }
  expect(requireCriticVerdict(submitted)).toBe(submitted)
})

test('verification fails closed and stops when the governor blocks a command', async () => {
  const outcome = await runVerification(['echo safe', 'curl -X POST https://example.test --data secret'],     undefined,
    undefined,
    {
      mode: 'unattended' as const,
      stats: () => ({ maxActions: 0, consumed: 0, exhausted: false, blockedByBudget: 0 }),
      async check(request) {

      const blocked = request.input.command === 'curl -X POST https://example.test --data secret'
      return {
        allowed: !blocked,
        message: blocked ? 'external write blocked' : undefined,
        assessment: {
          risk: blocked ? 'critical' : 'safe',
          decision: blocked ? 'block' : 'allow',
          reason: blocked ? 'external write blocked' : 'safe',
          intent: 'run_command',
          resources: [],
          reversible: !blocked,
        },
      }
    },
  })

  expect(outcome.passed).toBe(false)
  expect(outcome.results).toHaveLength(2)
  expect(outcome.results[0]?.exitCode).toBe(0)
  expect(outcome.results[1]?.exitCode).toBe(126)
  expect(outcome.results[1]?.stderr).toContain('external write blocked')
})

// Verbatim from run 2026-09-11-5q7z-abo2: the planner's only "verification"
// was manual-testing prose, so cmd.exe rejected it on every attempt with this
// exact message — a failure that proves nothing about the built game, which
// actually worked.
test('a check written in another shell’s vocabulary is dropped from the plan, in every mode', () => {
  // Run 2026-09-10-oabx-7ui6 on Windows: `bun --version` passed and `ls` failed
  // "'ls' is not recognized" three times, so the all-unrunnable fallback never
  // applied and each repair rewrote working code.
  const plan = ['bun --version', 'ls workspace/edcdemo/']
  const noLs = () => null
  expect(unwinnableVerificationCommands(plan, { unattended: false, platform: 'win32', which: noLs })).toEqual(['ls workspace/edcdemo/'])
  expect(unwinnableVerificationCommands(plan, { unattended: true, platform: 'win32', which: noLs })).toEqual(['ls workspace/edcdemo/'])
  // Where it is a real command — any POSIX shell, or Git's `ls` on a Windows PATH — it stays.
  expect(unwinnableVerificationCommands(plan, { unattended: false, platform: 'linux', which: noLs })).toEqual([])
  expect(unwinnableVerificationCommands(plan, { unattended: false, platform: 'win32', which: () => 'C:/Program Files/Git/usr/bin/ls.exe' })).toEqual([])
})

test('a command the governor refuses is dropped only when there is nobody to approve it', () => {
  const plan = ['bun test', 'bun run src/server.ts & sleep 2 && curl -s http://localhost:3000/']
  expect(unwinnableVerificationCommands(plan, { unattended: true, platform: 'linux' })).toEqual([plan[1]!])
  expect(unwinnableVerificationCommands(plan, { unattended: false, platform: 'linux' })).toEqual([])
})

test('a shell-rejected command is recognised as unrunnable, not a real failure', () => {
  const result = {
    command: 'Open X in browser, verify Y',
    exitCode: 1,
    stdout: '',
    stderr: "'Open' is not recognized as an internal or external command, operable program or batch file.",
    elapsedMs: 37,
    timedOut: false,
  }
  expect(isUnrunnableCommandFailure(result)).toBe(true)
})

test('a real test-suite failure is not mistaken for an unrunnable command', () => {
  const result = { command: 'bun test', exitCode: 1, stdout: '', stderr: '1 test failed', elapsedMs: 500, timedOut: false }
  expect(isUnrunnableCommandFailure(result)).toBe(false)
})

test('a timeout is not mistaken for an unrunnable command', () => {
  const result = { command: 'bun test', exitCode: 1, stdout: '', stderr: '', elapsedMs: 300_000, timedOut: true }
  expect(isUnrunnableCommandFailure(result)).toBe(false)
})

// Seen live 2026-09-15: "change the greeting" in a project with no tests. Bun
// exits 1 on "0 test files matching …", the gate called it a failing check, and
// the repair turn wrote a test file nobody asked for.
test('a test runner with nothing to run is unproven, not failed', () => {
  const bun = { command: 'npm test', exitCode: 1, stdout: '', stderr: 'error: 0 test files matching **{.test,.spec,_test_,_spec_}.{js,ts,jsx,tsx} in --cwd="x"', elapsedMs: 90, timedOut: false }
  const jest = { command: 'npx jest', exitCode: 1, stdout: 'No tests found, exiting with code 1', stderr: '', elapsedMs: 90, timedOut: false }
  expect(isNoTestsResult(bun)).toBe(true)
  expect(isNoTestsResult(jest)).toBe(true)
  expect(isUnrunnableCommandFailure(bun)).toBe(true)
  expect(isNoTestsResult({ command: 'bun test', exitCode: 1, stdout: '', stderr: '3 tests failed', elapsedMs: 90, timedOut: false })).toBe(false)
})

// Run 2026-09-20-gp6s-q6lh was "verified" by a `bun test` over a file of
// console.asserts: "Ran 0 tests across 1 file", exit 0. Every runner below
// exits 0 having run nothing.
test('a runner that exits 0 having run no tests is unproven, not a pass', () => {
  const zero = (command: string, stdout: string, stderr = '') => ({ command, exitCode: 0, stdout, stderr, elapsedMs: 60, timedOut: false })
  const empty = [
    zero('bun test', 'bun test v1.3.14 (0d9b296a)\nAll tests passed!', 'index.test.ts:\n\n 0 pass\n 0 fail\nRan 0 tests across 1 file. [61.00ms]'),
    zero('node --test', 'TAP version 13\n1..0\n# tests 0\n# pass 0\n# fail 0'),
    zero('npx mocha', '\n\n  0 passing (2ms)\n'),
    zero('cargo test', '   Compiling kit v0.1.0\nrunning 0 tests\n\ntest result: ok. 0 passed; 0 failed\n\n   Doc-tests kit\n\nrunning 0 tests\n'),
    zero('go test ./...', '?   \texample.com/kit\t[no test files]\n'),
  ]
  for (const result of empty) {
    expect(isNoTestsResult(result)).toBe(true)
    expect(isUnrunnableCommandFailure(result)).toBe(true)
  }
  const real = [
    zero('bun test', '', ' 4 pass\n 0 fail\nRan 4 tests across 1 file. [80.00ms]'),
    zero('node --test', '# tests 3\n# pass 3\n# fail 0'),
    zero('npx mocha', '  3 passing (4ms)'),
    zero('cargo test', 'running 5 tests\n\ntest result: ok. 5 passed\n\n   Doc-tests kit\n\nrunning 0 tests\n'),
    zero('go test ./...', '?   \texample.com/kit/cmd\t[no test files]\nok  \texample.com/kit\t0.012s\n'),
  ]
  for (const result of real) {
    expect(isNoTestsResult(result)).toBe(false)
    expect(isUnrunnableCommandFailure(result)).toBe(false)
  }
})

test('a test file with no tests in it does not carry the gate', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'elia-verify-zero-tests-'))
  try {
    writeFileSync(join(dir, 'package.json'), '{ "name": "t" }')
    writeFileSync(join(dir, 'index.test.ts'), 'console.assert(1 + 1 === 2, "math")\nconsole.log("All tests passed!")\n')
    const alone = await runVerification(['bun test'], dir, undefined, allowAllGovernor())
    expect(alone.passed).toBe(false)
    expect(alone.inconclusive).toContain('bun test found no tests')
    expect(staticRenderRole(alone, true)).toBe('substitute')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the gate reports an empty test suite as inconclusive instead of failing — and a real check beside it still counts', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'elia-verify-no-tests-'))
  try {
    writeFileSync(join(dir, 'package.json'), '{ "name": "t" }')
    const alone = await runVerification(['bun test'], dir, undefined, allowAllGovernor())
    expect(alone.passed).toBe(false)
    expect(alone.inconclusive).toContain('found no tests')
    const withTypecheck = await runVerification(['exit 0', 'bun test'], dir, undefined, allowAllGovernor())
    expect(withTypecheck.passed).toBe(true)
    expect(withTypecheck.inconclusive).toContain('bun test found no tests')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a program the shell cannot find is recognised exactly, and only when asked is it skipped', async () => {
  const winMissing = { command: 'mypy .', exitCode: 1, stdout: '', stderr: "'mypy' is not recognized as an internal or external command,\r\noperable program or batch file.\r\n", elapsedMs: 5, timedOut: false }
  const shMissing = { command: 'mypy .', exitCode: 127, stdout: '', stderr: 'sh: 1: mypy: not found\n', elapsedMs: 5, timedOut: false }
  const realFailure = { command: 'pytest -q', exitCode: 1, stdout: "FileNotFoundError: [Errno 2] No such file or directory: 'data.csv'", stderr: '', elapsedMs: 5, timedOut: false }
  const otherProgram = { command: 'npm test', exitCode: 1, stdout: '', stderr: "'jest' is not recognized as an internal or external command,", elapsedMs: 5, timedOut: false }
  expect(isCommandNotFound(winMissing)).toBe(true)
  expect(isCommandNotFound(shMissing)).toBe(true)
  expect(isCommandNotFound(realFailure)).toBe(false)
  // A script whose *own* child is missing is a broken project, not a missing check.
  expect(isCommandNotFound(otherProgram)).toBe(false)

  const dir = mkdtempSync(join(tmpdir(), 'elia-verify-missing-program-'))
  try {
    const missing = 'elia-definitely-not-installed-xyz --check'
    const strict = await runVerification([missing, 'exit 0'], dir, undefined, allowAllGovernor())
    expect(strict.passed).toBe(false)
    expect(strict.inconclusive).toBeUndefined()

    const lenient = await runVerification([missing, 'exit 0'], dir, undefined, allowAllGovernor(), { skipMissingPrograms: true })
    expect(lenient.passed).toBe(true)
    expect(lenient.inconclusive).toContain(`${missing} could not run`)

    const nothingRan = await runVerification([missing], dir, undefined, allowAllGovernor(), { skipMissingPrograms: true })
    expect(nothingRan.passed).toBe(false)
    expect(nothingRan.inconclusive).toContain('not installed')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// A Flask plan's `python app.py` kept one run on "Checking the result" for the
// full five-minute verification timeout, and was then reported as a failure.
test('an app entrypoint that starts a server is probed out as unproven, not waited out as a failure', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'elia-verify-server-probe-'))
  try {
    writeFileSync(join(dir, 'server.ts'), 'setInterval(() => {}, 1000)\n')
    writeFileSync(join(dir, 'check.ts'), 'process.exit(0)\n')

    const started = Date.now()
    const alone = await runVerification(['bun server.ts'], dir, undefined, allowAllGovernor(), { serverProbeMs: 1500 })
    expect(Date.now() - started).toBeLessThan(15_000)
    // Nothing but a server: unrunnable, so the loop's fallback applies — never a pass.
    expect(alone.passed).toBe(false)
    expect(alone.results[0]!.stderr).toContain('starts a server rather than finishing')
    expect(isUnrunnableCommandFailure(alone.results[0]!)).toBe(true)

    // Beside a check that finishes, the server is skipped and the check decides.
    const mixed = await runVerification(['bun server.ts', 'bun check.ts'], dir, undefined, allowAllGovernor(), { serverProbeMs: 1500 })
    expect(mixed.passed).toBe(true)
    expect(mixed.results.map((result) => result.command)).toEqual(['[skipped] bun server.ts', 'bun check.ts'])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}, 30_000)

test('fallbackStaticPageVerification has nothing to check when no page changed', async () => {
  const outcome = await fallbackStaticPageVerification(['src/thing.ts'], process.cwd())
  expect(outcome).toBeUndefined()
})

test('fallbackStaticPageVerification renders a real static page and passes', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'elia-verify-static-'))
  try {
    writeFileSync(join(dir, 'index.html'), '<!DOCTYPE html><html><body><h1>Car Racing</h1></body></html>')
    const outcome = await fallbackStaticPageVerification(['index.html'], dir)
    expect(outcome?.passed).toBe(true)
    expect(outcome?.results[0]?.exitCode).toBe(0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('fallbackStaticPageVerification fails when the declared page is not actually on disk', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'elia-verify-static-missing-'))
  try {
    const outcome = await fallbackStaticPageVerification(['missing.html'], dir)
    expect(outcome?.passed).toBe(false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// Seen live: run 2026-09-12-3nhx-e790. The plan declared `index.html`, but a
// worker confused about its own already-isolated cwd wrote the file one level
// deeper at `workspace/index.html`. The literal declared-path check 404'd
// even though a real, working deliverable existed on disk.
test('fallbackStaticPageVerification finds a uniquely-named page that landed at a different path than declared', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'elia-verify-static-nested-'))
  try {
    mkdirSync(join(dir, 'workspace'), { recursive: true })
    writeFileSync(join(dir, 'workspace', 'index.html'), '<!DOCTYPE html><html><body><h1>Mountain Car</h1></body></html>')
    const outcome = await fallbackStaticPageVerification(['index.html'], dir)
    expect(outcome?.passed).toBe(true)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// Run 2026-09-13-l0av-rnq0: the plan's verification was
// ["bun install", "bun run build", "bun run dev"]. The first two passed; the
// third ran for 236 seconds, was killed, and exited 58 — so the gate could
// never pass, and the run ended `needs-attention` with a working Vite build on
// disk. A dev server is not a check.
test('a dev server is dropped from the gate instead of blocking it', async () => {
  const outcome = await runVerification(['bun run dev'], undefined, undefined, allowAllGovernor())
  expect(outcome.passed).toBe(false)
  // Nothing ran, so the work is unproven rather than disproven — the caller's
  // render fallback handles this, a repair loop cannot.
  expect(outcome.results.every(isUnrunnableCommandFailure)).toBe(true)
})

// `exit N` rather than `node -e "..."`: nested quotes do not survive cmd.exe,
// which is the shell this runs through on Windows.
test('a dev server alongside real checks does not fail them', async () => {
  const outcome = await runVerification(['bun run dev', 'exit 0'], undefined, undefined, allowAllGovernor())
  expect(outcome.passed).toBe(true)
  expect(outcome.results.some((result) => result.command.startsWith('[skipped]'))).toBe(true)
})

test('a real failing check still fails the gate when a server is present', async () => {
  const outcome = await runVerification(['bun run dev', 'exit 3'], undefined, undefined, allowAllGovernor())
  expect(outcome.passed).toBe(false)
  expect(outcome.results.some((result) => result.exitCode === 3)).toBe(true)
})

/** A governor that permits every command, so a test exercises the gate itself. */
function allowAllGovernor() {
  return {
    mode: 'unattended' as const,
    stats: () => ({ maxActions: 0, consumed: 0, exhausted: false, blockedByBudget: 0 }),
    async check() {
      return {
        allowed: true,
        assessment: { risk: 'safe' as const, decision: 'allow' as const, reason: 'test', intent: 'run_command', resources: [], reversible: true },
      }
    },
  }
}

// A4-03: an empty verification command list used to "pass" with zero checks —
// runVerification([]) returned { passed: true, results: [] }, so a run whose
// plan declared nothing to verify went green without proving anything.
test('an empty verification is unverified, not green', async () => {
  const outcome = await runVerification([], undefined, undefined, allowAllGovernor())
  expect(outcome.passed).toBe(false)
  expect(outcome.results).toHaveLength(0)
  expect(outcome.inconclusive).toContain('no verification commands')
})

test('each check reports queued, then running, then how it landed — and a check after a failure never runs', async () => {
  const events: string[] = []
  const outcome = await runVerification(['exit 0', 'exit 3', 'exit 0 '], undefined, undefined, allowAllGovernor(), {
    onCheck: (event) => events.push(`${event.command.trim()}:${event.state}`),
  })
  expect(outcome.passed).toBe(false)
  expect(events).toEqual(['exit 0:queued', 'exit 3:queued', 'exit 0:queued', 'exit 0:running', 'exit 0:passed', 'exit 3:running', 'exit 3:failed'])
})

test('a watcher that throws cannot break the gate', async () => {
  const outcome = await runVerification(['exit 0'], undefined, undefined, allowAllGovernor(), {
    onCheck: () => {
      throw new Error('ui went away')
    },
  })
  expect(outcome.passed).toBe(true)
})

test('a static page is rendered for evidence when no declared command could run', () => {
  // `runVerification([])` — the shape a plan reaches verification with once its
  // only declared check was refused and the project has no manifest to infer
  // one from. Zero results, so the old "every result is unrunnable" guard was
  // vacuously skipped and the page was never rendered (run 2026-09-15-cqd0-omdu).
  expect(staticRenderRole({ passed: false, results: [] }, true)).toBe('substitute')
})

test('a static page render augments declared checks that did pass', () => {
  const passed = { passed: true, results: [{ command: 'bun test', exitCode: 0, stdout: '', stderr: '', elapsedMs: 1, timedOut: false }] }
  expect(staticRenderRole(passed, true)).toBe('augment')
})

test('a genuine verification failure is not papered over by a render check', () => {
  const failed = {
    passed: false,
    results: [{ command: 'bun test', exitCode: 1, stdout: '', stderr: '2 failing', elapsedMs: 1, timedOut: false }],
  }
  expect(staticRenderRole(failed, true)).toBe('none')
})

test('unrunnable declared checks are substituted by the render check', () => {
  const unrunnable = {
    passed: false,
    results: [{ command: 'Open index.html', exitCode: 1, stdout: '', stderr: "'Open' is not recognized as an internal or external command", elapsedMs: 1, timedOut: false }],
  }
  expect(staticRenderRole(unrunnable, true)).toBe('substitute')
})

test('no renderable page means no render check, whatever the verification said', () => {
  expect(staticRenderRole({ passed: false, results: [] }, false)).toBe('none')
  expect(staticRenderRole({ passed: true, results: [] }, false)).toBe('none')
})

// The tool path has installed-and-retried on "Cannot find module" for a long
// time (`runCommand.ts`), but the verification gate called `runShell` directly
// and never did — the one place a missing module is least likely to be a
// defect in the change. The run reported a red gate, repaired code that was
// never broken, and handed off; two of the twelve needs-attention runs in
// `.elia/runs` ended on exactly that "environment problem, not a defect" stall.
function recordingGovernor(allow: boolean, declared: string[]) {
  // Anything the gate asks about that is *not* one of the declared checks is a
  // command elia decided to run on its own — the install attempt under test.
  const asked: string[] = []
  return {
    asked,
    governor: {
      mode: 'unattended' as const,
      stats: () => ({ maxActions: 0, consumed: 0, exhausted: false, blockedByBudget: 0 }),
      async check(request: { name: string; input: Record<string, unknown> }) {
        const command = String(request.input.command ?? '')
        if (declared.includes(command)) {
          return { allowed: true, assessment: { risk: 'safe' as const, decision: 'allow' as const, reason: 'test', intent: 'run_command', resources: [], reversible: true } }
        }
        asked.push(command)
        return { allowed: allow, assessment: { risk: 'review' as const, decision: (allow ? 'allow' : 'block') as 'allow' | 'block', reason: 'test', intent: 'run_command', resources: [], reversible: true } }
      },
    },
  }
}

test('a check that fails only on a missing dependency asks to install it', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'elia-verify-autoinstall-'))
  try {
    writeFileSync(join(dir, 'check.ts'), 'console.error("Error: Cannot find module \'left-pad\'")\nprocess.exit(1)\n')
    // Denied, so no package manager actually runs: what is under test is that
    // the gate now reaches for the install at all.
    const denied = recordingGovernor(false, ['bun check.ts'])
    const outcome = await runVerification(['bun check.ts'], dir, undefined, denied.governor)

    expect(denied.asked).toEqual(['npm install left-pad'])
    // Denied install: the original failure stands, exactly as before.
    expect(outcome.passed).toBe(false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('an ordinary failing check is never mistaken for a missing dependency', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'elia-verify-real-failure-'))
  try {
    writeFileSync(join(dir, 'check.ts'), 'console.error("AssertionError: expected 3 to equal 4")\nprocess.exit(1)\n')
    const denied = recordingGovernor(false, ['bun check.ts'])
    const outcome = await runVerification(['bun check.ts'], dir, undefined, denied.governor)

    expect(denied.asked).toEqual([])
    expect(outcome.passed).toBe(false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a failing install command is not retried by installing again', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'elia-verify-install-loop-'))
  try {
    writeFileSync(join(dir, 'package.json'), '{ "name": "t" }')
    const denied = recordingGovernor(false, ['npm install nope-does-not-exist-xyz'])
    // The check *is* an install, and it failed reporting a missing module.
    // Installing on top of a broken install is not the fix.
    await runVerification(['npm install nope-does-not-exist-xyz'], dir, undefined, denied.governor)
    expect(denied.asked).toEqual([])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}, 60_000)

// End to end over the shape that stranded run 2026-09-15-cqd0-omdu (a tip
// calculator): the plan's only declared check was refused at approval time and
// `detectChecks` found no manifest to infer a replacement from, so
// verification ran with an empty command list. The page was fine; nothing
// looked at it, and the run ended `needs-attention` asking a human to.
test('a page with no declared check left to run is still proved, not handed to a human', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'elia-verify-no-commands-'))
  try {
    writeFileSync(join(dir, 'index.html'), '<!DOCTYPE html><html><body><h1>Tip Calculator</h1><input id="bill"></body></html>')

    const verification = await runVerification([], dir, undefined, allowAllGovernor())
    // Nothing ran, so on its own this is unproven — the state the run used to end in.
    expect(verification.passed).toBe(false)
    expect(verification.results).toHaveLength(0)

    // The page is the only evidence available, so it becomes the verification.
    expect(staticRenderRole(verification, true)).toBe('substitute')
    const rendered = await fallbackStaticPageVerification(['index.html'], dir)
    expect(rendered?.passed).toBe(true)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}, 30_000)

test('a page that does not render is still a red gate, not a free pass', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'elia-verify-broken-page-'))
  try {
    // Declared by the plan, never written by the workers — the deliverable is missing.
    writeFileSync(join(dir, 'unrelated.txt'), 'x')

    const verification = await runVerification([], dir, undefined, allowAllGovernor())
    expect(staticRenderRole(verification, true)).toBe('substitute')
    const rendered = await fallbackStaticPageVerification(['index.html'], dir)
    expect(rendered?.passed).toBe(false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}, 30_000)
