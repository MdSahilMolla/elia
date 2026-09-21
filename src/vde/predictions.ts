import type { GenerationRecord } from '../evolve/ledger.ts'
import type { Artifact } from './library.ts'
import type { GrowthReport } from './growth.ts'
import { bootstrappingFit, type ClosureRecord } from './toolLog.ts'

/**
 * The paper's eight falsifiable predictions, §12, and where elia stands on each.
 *
 * "The theory earns its place only if these hold." Every result in this
 * directory is theory or simulation until one of them is tested on a live
 * model. So each prediction is listed with the instrument in elia that can test
 * it and what that instrument has recorded so far — never with a verdict the
 * records do not support. A prediction nobody has run stays `untested`.
 */

export type PredictionStatus = 'untested' | 'collecting' | 'evidence'

export interface Prediction {
  id: string
  claim: string
  instrument: string
  status: PredictionStatus
  evidence: string
}

export interface PredictionInputs {
  ledger: readonly GenerationRecord[]
  library: ReadonlyMap<string, Artifact>
  growth: GrowthReport
  closure: readonly ClosureRecord[]
}

export function predictions(inputs: PredictionInputs): Prediction[] {
  const sealed = inputs.ledger.filter((record) => record.sealed)
  // Under the legacy gate, reaching `better` or beyond means the legacy rule accepted.
  const legacyAccepted = (record: GenerationRecord) => ['better', 'confirmed', 'guarded', 'promoted'].includes(record.funnel ?? '')
  const disagreements = sealed.filter((record) => record.sealed!.mode === 'legacy' && (record.sealed!.bit === 'accept') !== legacyAccepted(record))
  const fit = bootstrappingFit(inputs.closure)
  const probes = [...inputs.library.values()].filter((artifact) => artifact.kind === 'verifier')
  const admittedProbes = probes.filter((artifact) => artifact.status === 'admitted').length
  const audited = [...inputs.library.values()].filter((artifact) => artifact.purgedByAudit).length
  const tools = [...inputs.library.values()].filter((artifact) => artifact.kind === 'skill')
  const gamma = inputs.growth.lessons

  return [
    {
      id: 'P1',
      claim: 'Resampling precision plateaus at p(1−β)/(p(1−β)+(1−p)α), computed from separately measured p, α, β',
      instrument: '`elia bench` with repeats on tasks with hidden tests, against `elia vde` frontier estimates',
      status: 'untested',
      evidence: 'no run has compared a measured plateau with the computed one',
    },
    {
      id: 'P2',
      claim: 'A second same-family judge cuts false accepts only to α² + ρα(1−α); execution plus a cross-family judge approaches α²',
      instrument: 'the planted-defect critic rung (`elia gap`) run with two critics, ρ from stats.phi',
      status: 'untested',
      evidence: 'the critic rung has only ever run one judge',
    },
    {
      id: 'P3',
      claim: 'Best-of-N with a learned judge peaks, then halves every ln 2/((1−p)η) samples; exact verifiers never decline',
      instrument: 'reason/select.ts already stops at the first executed pass (thresholded, not argmax); a large-N run with a learned scorer would test the peak',
      status: 'untested',
      evidence: 'elia never argmaxes a learned score at large N, so it has no data on the peak',
    },
    {
      id: 'P4',
      claim: 'Library soundness collapses once leaps exceed ln σ/ε; an audit with catch rate r shifts the threshold by ln(1/(1−r))/ε',
      instrument: 'the certified library (σ from reuse, ε from audit purges)',
      status: inputs.library.size > 0 ? 'collecting' : 'untested',
      evidence: inputs.library.size > 0 ? `${inputs.library.size} artifact(s) certified, ${audited} purged by audit — too few leaps of varying size to see a threshold` : 'no artifacts certified yet',
    },
    {
      id: 'P5',
      claim: 'Tool artifacts have higher library elasticity γ than text strategies',
      instrument: 'γ for lessons from the randomized holdout (growth.ts); γ for tools needs the same ablation on skills',
      // Both halves are needed: γ for text alone says nothing about whether tools beat it.
      status: gamma.gamma !== undefined || tools.length > 0 ? 'collecting' : 'untested',
      evidence: gamma.gamma !== undefined
        ? `text lessons: γ = ${gamma.gamma.toFixed(2)} ± ${gamma.se!.toFixed(2)} over ${gamma.n} randomized runs; tools: ${tools.length} certified, no ablation yet — half the comparison exists`
        : gamma.detail,
    },
    {
      id: 'P6',
      claim: 'System-over-model gains are largest where writing a checker is easier than solving',
      instrument: 'probe admission (checker-writing success) against search outcomes on the same task shapes',
      status: probes.length > 0 ? 'collecting' : 'untested',
      evidence: probes.length > 0 ? `${admittedProbes} of ${probes.length} synthesized probe(s) admitted` : 'no probe has been synthesized yet',
    },
    {
      id: 'P7',
      claim: 'Naive held-out gating opens a held-out vs fresh gap and rejects real improvements; anytime-valid gating with enough tasks closes it',
      instrument: 'every evolve generation now records the sealed verdict beside the legacy one',
      status: sealed.length > 0 ? 'collecting' : 'untested',
      evidence: sealed.length > 0 ? `${sealed.length} generation(s) with both verdicts, ${disagreements.length} where they disagreed` : 'no generation has run since the sealed gate was recorded',
    },
    {
      id: 'P8',
      claim: 'When the evaluator is reachable, measured and true gains diverge even under valid statistics; isolation removes it',
      instrument: 'isolation I1–I4 plus a sandboxed meta-loop with a planted, reachable channel',
      status: 'untested',
      evidence: 'simulated only (elia vde simulate, scenario D); the live loop is isolated, so it cannot show the divergence without a deliberately planted channel',
    },
    {
      id: 'C1',
      claim: 'Conjecture 1: above a generator capability threshold, tool-construction cost grows polynomially, not exponentially, in description length',
      instrument: 'the closure log: tokens spent against size of every tool build (toolLog.ts)',
      status: fit.verdict === 'undetermined' ? (fit.n > 0 ? 'collecting' : 'untested') : 'evidence',
      evidence: fit.detail,
    },
  ]
}

export function renderPredictions(list: readonly Prediction[]): string {
  const mark = { untested: '·', collecting: '◐', evidence: '●' } as const
  const lines = ['PREDICTIONS P1–P8 and Conjecture 1 · what elia has recorded on each', '']
  for (const prediction of list) {
    lines.push(`  ${mark[prediction.status]} ${prediction.id} ${prediction.status.padEnd(10)} ${prediction.claim}`)
    lines.push(`       ${prediction.evidence}`)
  }
  lines.push('', '  · untested  ◐ collecting  ● evidence (not yet a verdict — each needs the refutation test the paper names)')
  return lines.join('\n')
}
