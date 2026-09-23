/**
 * The subcommands of `elia compounding` that measure elia against the paper
 * "Amplification Without Distillation", and take the one step it should take
 * next.
 *
 *   elia compounding frontier          frontier, library, growth, gate power, isolation, plan
 *   elia compounding round [--spend]   run the resource governor's top activity (Algorithm 1, one round)
 *   elia compounding simulate          the paper's §11 simulations, plus the control §11.4 lacked
 *   elia compounding predict           P1–P8 and Conjecture 1, with elia's evidence on each
 *
 * `frontier`, `simulate` and `predict` are read-only. `round` acts — it may
 * audit the lessons, measure the verifier ladder or prove new benchmark tasks —
 * but without `--spend` it runs nothing that calls a model.
 */
import { writeNotice, writeUsageLine } from '../ui/stream.ts'
import { emitEvent, machineReadable } from '../ui/runtime.ts'
import { flagValue, hasFlag, strictInteger } from './argv.ts'

export const COMPOUNDING_ACTIONS = ['frontier', 'round', 'simulate', 'predict'] as const

/** Runs one of `COMPOUNDING_ACTIONS`. False when `action` is not one of them. */
export async function runCompoundingAction(action: string): Promise<boolean> {
  if (action === 'frontier') await frontier()
  else if (action === 'round') await round()
  else if (action === 'simulate') await simulate()
  else if (action === 'predict') await predict()
  else return false
  return true
}

async function frontier(): Promise<void> {

  const { gatherState } = await import('../compounding/round.ts')
  const { renderFrontier } = await import('../compounding/frontier.ts')
  const { renderLibraryHealth } = await import('../autonomy/certifiedLibrary.ts')
  const { recommend, renderPlan } = await import('../compounding/resourceGovernor.ts')
  const { readActivityLog } = await import('../compounding/round.ts')
  const { isolationChecks } = await import('../evolve/isolation.ts')
  const { isImmutablePath } = await import('../evolve/sandbox.ts')
  const { gatherSources } = await import('../compounding/runners.ts')
  const { readLedger } = await import('../evolve/ledger.ts')
  const state = gatherState(await gatherSources())
  const plan = recommend(state, readActivityLog())
  const isolation = isolationChecks(isImmutablePath, readLedger().some((record) => record.diffDigest))

  if (machineReadable) {
    emitEvent('compounding_frontier', { state, plan, isolation })
    return
  }
  const pct = (value: number) => `${Math.round(value * 100)}%`
  const growth = state.growth.lessons
  const lines = [
    renderFrontier(state.frontier),
    '',
    renderLibraryHealth(state.library),
    '',
    'LIBRARY ELASTICITY γ (randomized lesson holdout)',
    `  ${growth.detail}`,
    `  ${state.growth.detail}`,
    '',
    'SEALED GATE POWER',
    state.bench
      ? `  ${state.bench.tasks} tasks${state.bench.unbenched ? ` (${state.bench.unbenched} added since the last full run, not yet scored)` : ''} at ${pct(state.bench.passRate)}: the gate needs a gain of at least ${pct(state.bench.minimumDetectable)} and the benchmark has ${pct(1 - state.bench.passRate)} of headroom${state.bench.minimumDetectable > 1 - state.bench.passRate ? ' — no promotion is possible until it grows' : ''}`
      : '  no full benchmark run recorded (`elia bench --all`)',
    '',
    'ISOLATION (§8.3)',
    ...isolation.map((check) => `  ${check.ok ? '✓' : '✗'} ${check.id} ${check.evidence}`),
    '',
    renderPlan(plan),
  ]
  writeUsageLine(lines.join('\n'))
}

async function round(): Promise<void> {
  const { gatherState, readActivityLog, runRound } = await import('../compounding/round.ts')
  const { createRunners, gatherSources, PAID_ACTIVITIES } = await import('../compounding/runners.ts')
  const { renderPlan } = await import('../compounding/resourceGovernor.ts')
  const spend = hasFlag('--spend')

  const state = gatherState(await gatherSources())
  const history = readActivityLog()

  const result = await runRound({
    state,
    regather: async () => gatherState(await gatherSources()),
    spend,
    paid: PAID_ACTIVITIES,
    history,
    runners: createRunners({
      spend,
      history,
      onProgress: (message) => writeUsageLine(`  ${message}`),
      meta: async () => {
        const { evolve } = await import('../evolve/engine.ts')
        const generations = strictInteger(flagValue('-n') ?? '1') ?? 1
        const outcome = await evolve({ generations, promoteTo: 'branch' })
        const last = outcome.generations.at(-1)
        return { ran: outcome.generations.length > 0, cost: 5, detail: last ? `gen ${last.generation}: ${last.verdict} — ${last.reason.split('\n')[0]}` : (outcome.stoppedReason ?? 'no generation ran') }
      },
    }),
  })

  if (machineReadable) {
    emitEvent('compounding_round', { plan: result.plan, ran: result.ran, skipped: result.skipped })
    return
  }
  writeUsageLine(renderPlan(result.plan))
  if (result.ran) {
    writeNotice(`ran ${result.ran.activity}: ${result.ran.result.detail} (ΔΦ ${result.ran.deltaPhi >= 0 ? '+' : ''}${result.ran.deltaPhi.toFixed(3)})`)
  } else {
    writeNotice('nothing ran this round')
  }
  for (const entry of result.skipped.slice(0, 4)) writeUsageLine(`  skipped ${entry.activity}: ${entry.reason}`)
}

async function simulate(): Promise<void> {
  const { seededRandom } = await import('../compounding/stats.ts')
  const { simArgmax, simThreshold, simLibrary, simSteppingStones, metaLoopControls } = await import('../compounding/sim.ts')
  const { repairedSoundFraction, resamplingPrecision, soundFraction } = await import('../compounding/theory.ts')
  const seeds = strictInteger(flagValue('--seeds') ?? '10') ?? 10
  const out: string[] = ['§11.1 argmax over a learned score vs first-accept (p = 5%, η = 0.2%, α = 1%, β = 10%)']
  const rand = seededRandom(1)
  for (const n of [1, 16, 64, 128, 256, 512, 1024, 2048]) {
    const threshold = simThreshold(n, rand)
    out.push(`  N=${String(n).padStart(4)}  argmax ${simArgmax(n, rand).toFixed(3)}   threshold ${threshold.precision.toFixed(3)} (Prop 1: ${resamplingPrecision(0.05, 0.01, 0.1).toFixed(3)})  coverage ${threshold.coverage.toFixed(3)}`)
  }
  out.push('', '§11.2 error threshold, Wright–Fisher library (ε = 1%, σ = 2)')
  const libRand = seededRandom(2)
  for (const leap of [20, 40, 60, 65, 70, 100, 130, 140]) {
    out.push(`  L=${String(leap).padStart(3)}  no audit ${simLibrary(leap, libRand, { reps: 4 }).toFixed(3)} (theory ${soundFraction(2, 0.01, leap).toFixed(3)})   audit r=½ ${simLibrary(leap, libRand, { r: 0.5, reps: 4 }).toFixed(3)} (theory ${repairedSoundFraction(2, 0.01, leap, 0.5).toFixed(3)})`)
  }
  out.push('', '§11.3 stepping stones (q = 0.2, ε = 5%)')
  const stoneRand = seededRandom(3)
  for (const m of [2, 4, 6]) {
    const result = simSteppingStones(m, stoneRand)
    out.push(`  m=${m}  resample ${result.resample.toFixed(0)} (${(0.2 ** -m).toFixed(0)})  archive ${result.archive.toFixed(1)} (${m / 0.2})  sound ${result.sound.toFixed(3)} (${(0.95 ** m).toFixed(3)})`)
  }
  out.push('', `§11.4 meta-loop gating (${seeds} seeds) — with the control the paper lacked (A')`)
  for (const row of metaLoopControls({ seeds })) {
    out.push(`  ${row.label.padEnd(30)} real ${row.realAccepted.toFixed(1)}/${row.realProposed.toFixed(1)}  neutral ${row.neutralAccepted.toFixed(1)}  tamper ${row.tamperAccepted.toFixed(1)}  measured ${(row.measured * 100).toFixed(1)}  fresh ${(row.fresh * 100).toFixed(1)}  true ${(row.trueGain * 100).toFixed(1)}`)
  }
  out.push('', '  Read A\' against C: the gain comes from holdout size; the valid bar\'s job is refusing noise and it cannot stop tampering (D) — only isolation can.')
  writeUsageLine(out.join('\n'))
}

async function predict(): Promise<void> {
  const { predictions, renderPredictions } = await import('../compounding/predictions.ts')
  const { readLibrary } = await import('../autonomy/certifiedLibrary.ts')
  const { growthReport, readExposures } = await import('../compounding/growth.ts')
  const { readClosureLog } = await import('../skills/toolLog.ts')
  const { readLedger } = await import('../evolve/ledger.ts')
  const { paths } = await import('../statePaths.ts')
  const list = predictions({ ledger: readLedger(), library: readLibrary(), growth: growthReport(readExposures(paths.lessonsEfficacy)), closure: readClosureLog() })
  if (machineReadable) emitEvent('compounding_predictions', { predictions: list })
  else writeUsageLine(renderPredictions(list))
}
