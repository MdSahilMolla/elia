import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { ELIA_ROOT } from '../config.ts'
import { appendSecureFile, ensureSecureDirectory } from '../securePersistence.ts'
import { createSandbox, promote } from '../evolve/sandbox.ts'
import { compareScorecards, measureFitness, toMetrics } from '../evolve/fitness.ts'
import { computeGapVector } from '../gap/scoreboard.ts'
import { checkGapNotRegressed } from '../gap/guard.ts'
import { readLatestGapVector } from '../gap/report.ts'
import { runValueProbes } from '../values/probes.ts'
import { checkValueDrift, readLatestProbeRun, recordProbeRun } from '../values/drift.ts'
import { addFragment } from './fragments.ts'
import type { DistillationCandidate } from './mine.ts'

/**
 * The double gate every distilled fragment must clear before it becomes a
 * standing instruction.
 *
 * A generator improvement only ships if the verifier can still see straight
 * after it: the fragment must hold or improve the evolve benchmark, must not
 * regress the generator–verifier gap, and must not move the value probes. Any
 * one of those failing rejects the candidate — a fragment that made elia faster
 * at the cost of honesty or of the critics' grip is not an improvement.
 */

export interface GateOptions {
  /** Do everything except the final promote. */
  dryRun?: boolean
  signal?: AbortSignal
  onStage?: (stage: string) => void
}

export interface GateResult {
  candidate: DistillationCandidate
  verdict: 'promoted' | 'rejected' | 'dry-run-pass'
  reason: string
}

const GATE_TIMEOUT_MS = 300_000

export async function evaluateCandidate(candidate: DistillationCandidate, options: GateOptions = {}): Promise<GateResult> {
  const stage = options.onStage ?? (() => {})
  const sandbox = createSandbox(Date.now())
  const record = (verdict: GateResult['verdict'], reason: string): GateResult => {
    ledger({ at: Date.now(), role: candidate.role, fragment: candidate.fragment, verdict, reason, sourceRunIds: candidate.sourceRunIds })
    return { candidate, verdict, reason }
  }

  try {
    // 1. apply the fragment into the sandbox copy
    addFragment(candidate.role, candidate.fragment, sandbox.root)

    // 2. it must still typecheck and pass the existing tests
    stage('typecheck + tests')
    const tc = await spawnIn(sandbox.root, ['bun', 'run', 'typecheck'])
    if (tc.exitCode !== 0 && !/not found|ENOENT/i.test(tc.output)) {
      return record('rejected', `sandbox does not typecheck:\n${tc.output.slice(-600)}`)
    }
    const test = await spawnIn(sandbox.root, ['bun', 'test'])
    if (test.exitCode !== 0) return record('rejected', `sandbox tests fail:\n${test.output.slice(-600)}`)

    // 3. the evolve benchmark must hold or improve
    stage('evolve benchmark')
    const baseCard = await measureFitness({ sourceRoot: ELIA_ROOT })
    const candCard = await measureFitness({ sourceRoot: sandbox.root })
    const base = toMetrics(baseCard)
    const cand = toMetrics(candCard)
    const regressed = base.passed.filter((id) => !cand.passed.includes(id))
    if (regressed.length > 0) return record('rejected', `benchmark regressed on ${regressed.join(', ')}`)
    if (cand.passRate < base.passRate) return record('rejected', `benchmark pass rate fell ${pct(base.passRate)} → ${pct(cand.passRate)}`)

    // 4. the generator–verifier gap must not regress
    stage('generator–verifier gap')
    const priorGap = readLatestGapVector()
    if (priorGap) {
      const nowGap = await computeGapVector()
      const guard = checkGapNotRegressed(priorGap, nowGap)
      if (!guard.ok) return record('rejected', `gap regressed: ${guard.regressions.join('; ')}`)
    }

    // 5. the value probes must not move
    stage('value probes')
    let probeBaseline = readLatestProbeRun()
    if (!probeBaseline) {
      probeBaseline = await runValueProbes({ signal: options.signal })
      recordProbeRun(probeBaseline, 'gate-baseline')
    }
    const probeAfter = await runValueProbes({ signal: options.signal })
    const drift = checkValueDrift(probeBaseline, probeAfter)
    if (!drift.ok) return record('rejected', `value drift: ${drift.regressions.join('; ')}`)

    // 6. ship it
    if (options.dryRun) {
      return record('dry-run-pass', `would promote: pass rate ${pct(base.passRate)} → ${pct(cand.passRate)}, gap held, no value drift`)
    }
    stage('promote')
    const backup = promote(sandbox, ['src/distill/fragments.generated.json'])
    return record('promoted', `promoted to ${candidate.role}; rollback: copy ${backup} back over ${ELIA_ROOT}`)
  } catch (err) {
    return record('rejected', `gate error: ${err instanceof Error ? err.message : String(err)}`)
  } finally {
    // Keep a rejected sandbox for inspection only on failure would be nicer, but
    // these are large; the ledger has the reason.
    rmSync(sandbox.root, { recursive: true, force: true })
  }
}

interface SpawnResult {
  exitCode: number
  output: string
}

async function spawnIn(cwd: string, cmd: string[]): Promise<SpawnResult> {
  try {
    const proc = Bun.spawn(cmd, { cwd, stdout: 'pipe', stderr: 'pipe', env: { ...process.env, NO_COLOR: '1' } })
    const timer = setTimeout(() => proc.kill(), GATE_TIMEOUT_MS)
    try {
      const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()])
      await proc.exited
      return { exitCode: proc.exitCode ?? 1, output: `${out}\n${err}` }
    } finally {
      clearTimeout(timer)
    }
  } catch (err) {
    return { exitCode: 1, output: err instanceof Error ? err.message : String(err) }
  }
}

interface LedgerEntry {
  at: number
  role: string
  fragment: string
  verdict: string
  reason: string
  sourceRunIds: string[]
}

function ledger(entry: LedgerEntry): void {
  try {
    ensureSecureDirectory(join(ELIA_ROOT, '.distill'))
    appendSecureFile(join(ELIA_ROOT, '.distill', 'ledger.jsonl'), `${JSON.stringify(entry)}\n`)
  } catch {
    // best effort
  }
}

function pct(value: number): string {
  return `${Math.round(value * 100)}%`
}
