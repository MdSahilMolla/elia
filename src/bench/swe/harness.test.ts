import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runGit } from '../../autonomy/worktree.ts'
import { applyPatch, checkoutFromLocalGitDir } from './repo.ts'
import { runSweBenchInstance, runSweBenchSuite, runTests, type AgentRunner, type InstanceCheckout } from './harness.ts'
import type { SweBenchInstance } from './types.ts'

let srcRepo: string
const dirsToClean: string[] = []

async function git(args: string[], cwd: string): Promise<void> {
  const result = await runGit(args, cwd)
  if (result.exitCode !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`)
}

// A tiny real Python "repo" with a real bug: add() subtracts instead of
// adding. test_patch adds the hidden test that catches it (SWE-bench's own
// convention — the test does not exist at base_commit) plus one
// already-passing test that must not regress.
beforeEach(async () => {
  srcRepo = mkdtempSync(join(tmpdir(), 'elia-swebench-fixture-'))
  dirsToClean.push(srcRepo)
  await git(['init', '-q'], srcRepo)
  await git(['config', 'user.email', 't@t.com'], srcRepo)
  await git(['config', 'user.name', 't'], srcRepo)
  writeFileSync(join(srcRepo, 'thing.py'), 'def add(a, b):\n    return a - b\n\n\ndef already_works():\n    return True\n')
  writeFileSync(join(srcRepo, 'test_already_passing.py'), 'from thing import already_works\n\ndef test_already_works():\n    assert already_works()\n')
  await git(['add', '-A'], srcRepo)
  await git(['commit', '-q', '-m', 'buggy add()'], srcRepo)
})

afterEach(() => {
  for (const dir of dirsToClean.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const TEST_PATCH = ['--- /dev/null', '+++ b/test_add.py', '@@ -0,0 +1,4 @@', '+from thing import add', '+', '+def test_add():', '+    assert add(2, 3) == 5', ''].join('\n')

function instanceFor(overrides: Partial<SweBenchInstance> = {}): SweBenchInstance {
  return {
    instance_id: 'fixture__thing-1',
    repo: 'fixture/thing', // never actually cloned — the `checkout` option below bypasses ensureRepoCached entirely
    base_commit: 'HEAD',
    problem_statement: 'add() returns the wrong result — it should add its two arguments, not subtract them.',
    test_patch: TEST_PATCH,
    FAIL_TO_PASS: ['test_add.py::test_add'],
    PASS_TO_PASS: ['test_already_passing.py::test_already_works'],
    testCommand: 'python -m pytest',
    ...overrides,
  }
}

/** Checks out the real local fixture repo, bypassing repo.ts's GitHub-clone step — that step is covered for real, offline, in repo.test.ts. Every checked-out dir is queued for cleanup. */
function fixtureCheckout(): InstanceCheckout {
  return async (instance) => {
    const bareRepo = mkdtempSync(join(tmpdir(), 'elia-swebench-bare-')) + '.git'
    dirsToClean.push(bareRepo)
    await git(['clone', '-q', '--bare', srcRepo, bareRepo], tmpdir())
    const dir = await checkoutFromLocalGitDir(bareRepo, 'HEAD', instance.instance_id)
    dirsToClean.push(dir)
    await applyPatch(dir, instance.test_patch)
    return dir
  }
}

const doesNothing: AgentRunner = async () => ({ steps: 1 })
const agentThrows: AgentRunner = async () => {
  throw new Error('the agent process crashed')
}
const fixesTheBug: AgentRunner = async (dir) => {
  writeFileSync(join(dir, 'thing.py'), 'def add(a, b):\n    return a + b\n\n\ndef already_works():\n    return True\n')
  return { steps: 3 }
}

test('runTests reports PASSED/FAILED per test id against a real pytest run', async () => {
  const dir = await fixtureCheckout()(instanceFor())
  const instance = instanceFor()
  const before = await runTests(dir, instance.FAIL_TO_PASS, instance)
  expect(before.get('test_add.py::test_add')).toBe('FAILED')

  writeFileSync(join(dir, 'thing.py'), 'def add(a, b):\n    return a + b\n\n\ndef already_works():\n    return True\n')
  const after = await runTests(dir, instance.FAIL_TO_PASS, instance)
  expect(after.get('test_add.py::test_add')).toBe('PASSED')
}, 20_000)

test('runSweBenchInstance: resolved when the agent fix makes FAIL_TO_PASS pass without breaking PASS_TO_PASS', async () => {
  const result = await runSweBenchInstance(instanceFor(), { checkout: fixtureCheckout(), runAgent: fixesTheBug })
  expect(result.resolved).toBe(true)
  expect(result.failToPass['test_add.py::test_add']).toBe('PASSED')
  expect(result.passToPass['test_already_passing.py::test_already_works']).toBe('PASSED')
  expect(result.agentSteps).toBe(3)
  expect(result.keptDir).toBeUndefined() // a resolved instance's checkout is cleaned up, not kept
}, 20_000)

test('runSweBenchInstance: unresolved when the agent makes no change, and the checkout is kept for inspection', async () => {
  const result = await runSweBenchInstance(instanceFor(), { checkout: fixtureCheckout(), runAgent: doesNothing })
  expect(result.resolved).toBe(false)
  expect(result.failToPass['test_add.py::test_add']).toBe('FAILED')
  expect(result.passToPass['test_already_passing.py::test_already_works']).toBe('PASSED') // untouched, correctly still passing
  expect(result.keptDir).toBeDefined()
}, 20_000)

test('runSweBenchInstance: a test id absent from the run output scores MISSING, not silently PASSED', async () => {
  const instance = instanceFor({ FAIL_TO_PASS: ['test_add.py::test_add', 'test_add.py::test_does_not_exist'] })
  const result = await runSweBenchInstance(instance, { checkout: fixtureCheckout(), runAgent: fixesTheBug })
  expect(result.failToPass['test_add.py::test_does_not_exist']).toBe('MISSING')
  expect(result.resolved).toBe(false) // MISSING is not PASSED — a nonexistent test never resolves an instance
}, 20_000)

test('runSweBenchInstance: an agent failure is recorded, never thrown, and the checkout is kept', async () => {
  const result = await runSweBenchInstance(instanceFor(), { checkout: fixtureCheckout(), runAgent: agentThrows })
  expect(result.resolved).toBe(false)
  expect(result.agentError).toContain('the agent process crashed')
  expect(result.keptDir).toBeDefined()
}, 20_000)

test('runSweBenchInstance: a checkout failure is recorded as an unresolved result, never thrown', async () => {
  const failingCheckout: InstanceCheckout = async () => {
    throw new Error('simulated checkout failure')
  }
  const result = await runSweBenchInstance(instanceFor(), { checkout: failingCheckout, runAgent: doesNothing })
  expect(result.resolved).toBe(false)
  expect(result.agentError).toContain('simulated checkout failure')
})

test('runSweBenchSuite aggregates total/resolved across instances and reports each via onInstanceDone', async () => {
  const seen: string[] = []
  const summary = await runSweBenchSuite([instanceFor({ instance_id: 'a' }), instanceFor({ instance_id: 'b' })], {
    checkout: fixtureCheckout(),
    runAgent: fixesTheBug,
    onInstanceDone: (r) => seen.push(r.instance_id),
  })
  expect(summary.total).toBe(2)
  expect(summary.resolved).toBe(2)
  expect(seen).toEqual(['a', 'b'])
}, 30_000)

test('runSweBenchSuite stops early when the signal is already aborted', async () => {
  const controller = new AbortController()
  controller.abort()
  const summary = await runSweBenchSuite([instanceFor({ instance_id: 'a' })], { checkout: fixtureCheckout(), runAgent: doesNothing, signal: controller.signal })
  expect(summary.total).toBe(0)
})
