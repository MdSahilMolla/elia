import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { ELIA_ROOT } from '../../statePaths.ts'
import { readBoundedOutput, runProcess, terminateProcessGroup } from '../../shell.ts'
import { containerSandboxConfigured, runShellInContainer } from '../../sandbox/container.ts'
import { applyPatch, checkoutInstanceTree } from './repo.ts'
import { parseTestOutcomes, pytestInvocation, pytestShellCommand, type TestOutcome } from './testResults.ts'
import type { SweBenchInstance, SweBenchInstanceResult, SweBenchRunSummary } from './types.ts'

const AGENT_TIMEOUT_MS = 20 * 60_000
const TEST_TIMEOUT_MS = 10 * 60_000

export interface AgentRunResult {
  steps?: number
  error?: string
}

export type AgentRunner = (dir: string, problemStatement: string, maxSteps: number) => Promise<AgentRunResult>
/** Checks out one instance's starting tree (with its test_patch applied) and returns the local directory. */
export type InstanceCheckout = (instance: SweBenchInstance) => Promise<string>

const defaultCheckout: InstanceCheckout = async (instance) => {
  const dir = await checkoutInstanceTree(instance.repo, instance.base_commit, instance.instance_id)
  await applyPatch(dir, instance.test_patch)
  return dir
}

export interface RunSweBenchOptions {
  /** Cap on model round-trips per instance. */
  maxSteps?: number
  onInstanceDone?: (result: SweBenchInstanceResult) => void
  signal?: AbortSignal
  /**
   * Overrides how the agent step runs — the real default spawns a real,
   * billed elia agent loop. Tests substitute a fast in-memory stub here so
   * the rest of the pipeline (checkout, patch, test execution, scoring) can
   * be exercised for real without spending API budget on every test run.
   */
  runAgent?: AgentRunner
  /**
   * Overrides how an instance's starting tree is obtained — the real default
   * clones from GitHub via repo.ts. Tests substitute a local fixture
   * checkout here (repo.ts's own clone/checkout mechanics are covered for
   * real, offline, in repo.test.ts) so a harness test doesn't need network
   * access to exercise scoring and orchestration.
   */
  checkout?: InstanceCheckout
}

const runElia: AgentRunner = async (dir, problemStatement, maxSteps) => {
  await Bun.write(join(dir, '.elia-swebench-task.json'), JSON.stringify({ problem_statement: problemStatement, maxSteps }))
  const entry = join(ELIA_ROOT, 'src', 'bench', 'swe', 'task.ts')
  const proc = Bun.spawn(['bun', 'run', entry], { cwd: dir, stdout: 'pipe', stderr: 'pipe', env: process.env })

  let timedOut = false
  const timeout = setTimeout(() => {
    timedOut = true
    terminateProcessGroup(proc)
  }, AGENT_TIMEOUT_MS)
  let completed = false
  try {
    const [stdout, stderr] = await Promise.all([readBoundedOutput(proc.stdout, 500_000), readBoundedOutput(proc.stderr, 500_000), proc.exited])
    completed = true
    if (timedOut) return { error: `agent timed out after ${AGENT_TIMEOUT_MS}ms` }
    const lastLine = stdout.trim().split('\n').at(-1)
    if (!lastLine) return { error: `agent produced no output${stderr.trim() ? `: ${stderr.trim().slice(-800)}` : ''}` }
    const parsed = JSON.parse(lastLine) as { ok: boolean; steps: number; error?: string }
    return parsed.ok ? { steps: parsed.steps } : { steps: parsed.steps, error: parsed.error ?? 'agent reported failure' }
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) }
  } finally {
    clearTimeout(timeout)
    if (!completed) terminateProcessGroup(proc)
  }
}

/** Exported for tests — the real scoring step, worth exercising directly rather than only through the full runSweBenchInstance pipeline. */
export async function runTests(dir: string, testIds: string[], instance: SweBenchInstance): Promise<Map<string, TestOutcome>> {
  if (testIds.length === 0) return new Map()
  let result: { stdout: string; stderr: string }
  if (instance.dockerImage && containerSandboxConfigured()) {
    result = await runShellInContainer(pytestShellCommand(testIds, instance.testCommand), TEST_TIMEOUT_MS, dir)
  } else {
    const { executable, args } = pytestInvocation(testIds, instance.testCommand)
    // PYTHONDONTWRITEBYTECODE: runTests is called twice against the same
    // checkout across an agent fix (before/after) — without this, a stale
    // __pycache__/*.pyc from the pre-fix run can be reused if the source
    // file's mtime doesn't visibly advance between the two runs.
    const env: Record<string, string> = {}
    for (const [key, value] of Object.entries(process.env)) if (value !== undefined) env[key] = value
    env.PYTHONDONTWRITEBYTECODE = '1'
    result = await runProcess({ executable, args, timeoutMs: TEST_TIMEOUT_MS, cwd: dir, env })
  }
  return parseTestOutcomes(`${result.stdout}\n${result.stderr}`)
}

function scoreOutcomes(testIds: string[], outcomes: Map<string, TestOutcome>): Record<string, TestOutcome | 'MISSING'> {
  const scored: Record<string, TestOutcome | 'MISSING'> = {}
  for (const id of testIds) scored[id] = outcomes.get(id) ?? 'MISSING'
  return scored
}

/** Runs one SWE-bench instance end to end: checkout, patch, agent, tests, score. Never throws — a hard failure anywhere becomes an unresolved result with the reason recorded, so one bad instance does not abort the whole run. */
export async function runSweBenchInstance(instance: SweBenchInstance, options: RunSweBenchOptions = {}): Promise<SweBenchInstanceResult> {
  const startedAt = Date.now()
  let dir: string | undefined
  try {
    const checkout = options.checkout ?? defaultCheckout
    dir = await checkout(instance)

    const runAgent = options.runAgent ?? runElia
    const agent = await runAgent(dir, instance.problem_statement, options.maxSteps ?? 80)

    const failToPassOutcomes = await runTests(dir, instance.FAIL_TO_PASS, instance)
    const passToPassOutcomes = await runTests(dir, instance.PASS_TO_PASS, instance)
    const failToPass = scoreOutcomes(instance.FAIL_TO_PASS, failToPassOutcomes)
    const passToPass = scoreOutcomes(instance.PASS_TO_PASS, passToPassOutcomes)

    const resolved = Object.values(failToPass).every((v) => v === 'PASSED') && Object.values(passToPass).every((v) => v === 'PASSED')

    const result: SweBenchInstanceResult = {
      instance_id: instance.instance_id,
      resolved,
      failToPass,
      passToPass,
      agentSteps: agent.steps,
      agentError: agent.error,
      elapsedMs: Date.now() - startedAt,
      ...(resolved ? {} : { keptDir: dir }),
    }
    if (resolved && dir) rmSync(dir, { recursive: true, force: true })
    return result
  } catch (err) {
    return {
      instance_id: instance.instance_id,
      resolved: false,
      failToPass: {},
      passToPass: {},
      agentError: err instanceof Error ? err.message : String(err),
      elapsedMs: Date.now() - startedAt,
      keptDir: dir,
    }
  }
}

export async function runSweBenchSuite(instances: SweBenchInstance[], options: RunSweBenchOptions = {}): Promise<SweBenchRunSummary> {
  const results: SweBenchInstanceResult[] = []
  for (const instance of instances) {
    if (options.signal?.aborted) break
    const result = await runSweBenchInstance(instance, options)
    results.push(result)
    options.onInstanceDone?.(result)
  }
  return { total: results.length, resolved: results.filter((r) => r.resolved).length, results }
}
