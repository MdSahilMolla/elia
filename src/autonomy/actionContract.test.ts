import { describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { contractForAction, evaluatePostconditions, evaluatePreconditions } from './actionContract.ts'

describe('action contracts', () => {
  test('creates an idempotent command contract with a precondition and exit-code postcondition', async () => {
    const contract = contractForAction({ name: 'run_command', input: { command: 'bun run build' } }, process.cwd(), 'run:command:1')
    expect(contract.idempotencyKey).toBe('run:command:1')
    expect(contract.preconditions[0]).toMatchObject({ kind: 'command-available', value: 'bun' })
    expect(contract.postconditions).toEqual([{ kind: 'shell-exit-zero', description: 'the command must return exit code 0 and not time out' }])
    expect((await evaluatePreconditions(contract, process.cwd())).ok).toBe(true)
    expect(evaluatePostconditions(contract, 'exit code: 0\nstdout:\nbuilt', process.cwd())).toMatchObject({ ok: true, phase: 'postcondition' })
  })

  test('creates the same executable and exit-code contract for a direct program', async () => {
    const contract = contractForAction({ name: 'run_program', input: { program: 'bun', args: ['test'] } }, process.cwd(), 'run:program:1')
    expect(contract.preconditions[0]).toMatchObject({ kind: 'command-available', value: 'bun' })
    expect(contract.postconditions).toEqual([{ kind: 'shell-exit-zero', description: 'the command must return exit code 0 and not time out' }])
  })

  test('a capability probe gets neither the availability precondition nor the exit-zero postcondition', () => {
    // "is X installed?" cannot be gated on X already being on PATH, and a probe
    // that answers "no" via a non-zero exit is not a failure to repair.
    for (const command of ['which python3', 'where docker', 'command -v uv', 'docker --version', 'python3 --version', 'node -v', 'Get-Command rustc']) {
      const contract = contractForAction({ name: 'run_command', input: { command } }, process.cwd(), `run:probe:${command}`)
      expect(contract.preconditions.some((p) => p.kind === 'command-available')).toBe(false)
      expect(contract.postconditions).toEqual([])
    }
  })

  test('shell builtins like cd are exempt from the command-available precondition', () => {
    const contract = contractForAction({ name: 'run_command', input: { command: 'cd my-app && npm install' } }, process.cwd(), 'run:cd:1')
    expect(contract.preconditions.some((p) => p.kind === 'command-available')).toBe(false)
  })

  test('cmd.exe builtins (mkdir, copy, del, move) are exempt — they have no PATH entry on Windows', () => {
    for (const command of ['mkdir cargame', 'md cargame', 'copy a b', 'del a.txt', 'move a b', 'rmdir cargame']) {
      const contract = contractForAction({ name: 'run_command', input: { command } }, process.cwd(), `run:${command}:1`)
      expect(contract.preconditions.some((p) => p.kind === 'command-available')).toBe(false)
    }
  })

  test('a dev-server command gets no exit-zero postcondition (it never exits)', () => {
    const contract = contractForAction({ name: 'run_command', input: { command: 'npm run dev' } }, process.cwd(), 'run:dev:1')
    expect(contract.postconditions).toEqual([])
    const normal = contractForAction({ name: 'run_command', input: { command: 'npm run build' } }, process.cwd(), 'run:build:1')
    expect(normal.postconditions).toHaveLength(1)
  })

  test('does not mark a timed-out or non-zero command as verified', () => {
    const contract = contractForAction({ name: 'run_command', input: { command: 'bun test' } }, process.cwd(), 'run:command:2')
    expect(evaluatePostconditions(contract, 'exit code: 1\nstderr:\nfailed', process.cwd())).toMatchObject({ ok: false, failures: ['command did not return exit code 0 (exit code 1)'] })
    expect(evaluatePostconditions(contract, 'timed out after 1000ms (killed)', process.cwd())).toMatchObject({ ok: false, failures: ['command timed out'] })
  })

  test('robocopy succeeds with exit codes 0–7 and fails from 8 up', () => {
    for (const input of [{ name: 'run_command', input: { command: 'robocopy src dist /E' } }, { name: 'run_program', input: { program: 'robocopy.exe', args: ['src', 'dist', '/E'] } }]) {
      const contract = contractForAction(input, process.cwd(), `run:robocopy:${input.name}`)
      expect(evaluatePostconditions(contract, 'exit code: 1\nstdout:\n  Files : 12', process.cwd())).toMatchObject({ ok: true, evidence: ['command returned exit code 1 (success for this program)'] })
      expect(evaluatePostconditions(contract, 'exit code: 3', process.cwd()).ok).toBe(true)
      expect(evaluatePostconditions(contract, 'exit code: 8', process.cwd())).toMatchObject({ ok: false, failures: ['command returned exit code 8, a failure for this program (success is 0–7)'] })
      expect(evaluatePostconditions(contract, 'timed out after 1000ms (killed)', process.cwd()).ok).toBe(false)
    }
    // Every other program still has to exit 0.
    const copy = contractForAction({ name: 'run_command', input: { command: 'xcopy src dist /E' } }, process.cwd(), 'run:xcopy:1')
    expect(evaluatePostconditions(copy, 'exit code: 1', process.cwd()).ok).toBe(false)
  })

  test('requires configured browser transport and preserves takeover for browser mutations', async () => {
    const contract = contractForAction({ name: 'browser', input: { action: 'click', target: 'Publish', expectUrl: 'https://example.test/done' } }, process.cwd(), 'run:browser:1')
    expect(contract.requiresUserTakeover).toBe(true)
    expect(contract.failureDisposition).toBe('human-review')
    // Every environment here is pinned so the result cannot depend on whether
    // the machine running the suite happens to have Chrome installed — the same
    // trap the vercel precondition below documents. ELIA_BROWSER=off and
    // ELIA_BROWSER=owned both short-circuit before useOwnedBrowserByDefault
    // looks at the filesystem.
    expect((await evaluatePreconditions(contract, process.cwd(), undefined, { ELIA_BROWSER: 'off' })).ok).toBe(false)
    expect((await evaluatePreconditions(contract, process.cwd(), undefined, { ELIA_BROWSER_CDP_URL: 'ws://configured-for-test' })).ok).toBe(true)
    // A bridge variable still wins while the owned browser is switched off: the
    // bridge is a transport in its own right, not a consumer of the fallback.
    expect((await evaluatePreconditions(contract, process.cwd(), undefined, { ELIA_BROWSER: 'off', ELIA_BROWSER_CDP_URL: 'ws://configured-for-test' })).ok).toBe(true)
    expect(evaluatePostconditions(contract, '{\n  "url": "https://example.test/start"\n}', process.cwd())).toMatchObject({ ok: false })
    expect(evaluatePostconditions(contract, '{\n  "url": "https://example.test/done"\n}', process.cwd())).toMatchObject({ ok: true })
  })

  test("passes browser preconditions on elia's own headless browser when no bridge is configured", async () => {
    // The regression this covers: the gate knew only the three bridge variables,
    // so it refused every browser call on an ordinary machine with Chrome
    // installed and no bridge set — standing in front of a transport that was
    // there the whole time. Reported as evidence rather than silence, because
    // which browser answered changes how a later failure reads.
    const contract = contractForAction({ name: 'browser', input: { action: 'status' } }, process.cwd(), 'run:browser:owned')
    const owned = await evaluatePreconditions(contract, process.cwd(), undefined, { ELIA_BROWSER: 'owned' })
    expect(owned.ok).toBe(true)
    expect(owned.evidence.some((entry) => entry.includes('headless browser'))).toBe(true)

    // Turned off with nothing else configured is the one genuine failure, and it
    // has to name the fallback so the fix is not another round of bridge setup.
    const disabled = await evaluatePreconditions(contract, process.cwd(), undefined, { ELIA_BROWSER: 'off' })
    expect(disabled.ok).toBe(false)
    expect(disabled.failures.join(' ')).toContain('ELIA_BROWSER=off')
  })

  test('requires an exact approval boundary for production deployment and verifies the result', async () => {
    const contract = contractForAction({ name: 'deployment', input: { action: 'deploy', provider: 'vercel', target: 'production' } }, process.cwd(), 'deploy:production:1')
    expect(contract.requiresUserTakeover).toBe(true)
    expect(contract.failureDisposition).toBe('human-review')
    expect(contract.postconditions).toEqual([{ kind: 'result-contains', value: '"status": "deployed"', description: 'the production deployment must report a deployed status' }])
    // The contract must gate production deploys on the provider CLI actually
    // being present. Asserting a fixed `false` here silently depended on vercel
    // NOT being installed on the machine running the suite, so it broke the
    // moment someone installed it. Assert the declared precondition instead,
    // and that evaluation agrees with the real environment either way.
    expect(contract.preconditions).toEqual([
      { kind: 'command-available', value: 'vercel', description: 'vercel CLI must be available before deployment work runs' },
    ])
    const preconditions = await evaluatePreconditions(contract, process.cwd(), undefined, {})
    expect(preconditions.ok).toBe(Bun.which('vercel') !== null)
    expect(evaluatePostconditions(contract, '{\n  "status": "deployed",\n  "url": "https://example.vercel.app"\n}', process.cwd())).toMatchObject({ ok: true })
  })

  test('verifies a workspace artifact after a write', () => {
    const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'elia-contract-')))
    mkdirSync(join(cwd, 'out'))
    const target = join(cwd, 'out', 'report.txt')
    const contract = contractForAction({ name: 'write_file', input: { path: 'out/report.txt' } }, cwd, 'run:file:1')
    expect(contract.preconditions[0]?.kind).toBe('workspace-path')
    expect(evaluatePostconditions(contract, 'written', cwd)).toMatchObject({ ok: false })
    writeFileSync(target, 'verified')
    expect(evaluatePostconditions(contract, 'written', cwd)).toMatchObject({ ok: true, evidence: [`artifact exists: ${target}`] })
  })

  test('fails workspace preconditions for traversal and symlink escapes', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'elia-contract-escape-'))
    const outside = mkdtempSync(join(tmpdir(), 'elia-contract-outside-'))
    symlinkSync(outside, join(cwd, 'link'), process.platform === 'win32' ? 'junction' : 'dir')

    const traversal = contractForAction({ name: 'write_file', input: { path: '../outside.txt' } }, cwd, 'run:file:escape:1')
    const symlink = contractForAction({ name: 'edit_file', input: { path: 'link/secret.txt' } }, cwd, 'run:file:escape:2')

    expect((await evaluatePreconditions(traversal, cwd)).ok).toBe(false)
    expect((await evaluatePreconditions(symlink, cwd)).ok).toBe(false)
  })
})

test('a call with no path is told its path is missing, not that it escaped the workspace', async () => {
  // Observed live: two blocked writes reported "escapes the active workspace or
  // crosses a symlink boundary" when the real problem was an empty `path`,
  // sending the run looking for a sandboxing fault that did not exist.
  const contract = contractForAction({ name: 'write_file', input: { path: '', content: 'x' } }, process.cwd(), 'key-empty')
  const evaluation = await evaluatePreconditions(contract, process.cwd())

  expect(evaluation.ok).toBe(false)
  expect(evaluation.failures.join(' ')).toContain('no file path was given')
  expect(evaluation.failures.join(' ')).not.toContain('symlink')
})

test('a real path inside the workspace still passes', async () => {
  const contract = contractForAction({ name: 'write_file', input: { path: 'src/index.ts', content: 'x' } }, process.cwd(), 'key-real')
  const evaluation = await evaluatePreconditions(contract, process.cwd())

  expect(evaluation.ok).toBe(true)
})
