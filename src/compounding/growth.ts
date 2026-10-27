import { existsSync, readFileSync } from 'node:fs'
import { growthRegime, type GrowthRegime } from './theory.ts'
import { olsSlope, summarize } from './stats.ts'

/**
 * §6: whether the library is compounding, measured.
 *
 * The growth law `dK/dt ∝ K^λ` turns on one measurable number, the library
 * elasticity γ — how much each extra artifact raises success on future work.
 * The paper suggests measuring it by regressing log success on log library size
 * over time. That regression is confounded: over time the scaffold changes,
 * models change, and the tasks change, and all of it lands in the slope.
 *
 * elia has something better. Every briefing withholds a random 15% of the
 * lessons it selected (autonomy/lessons.ts), so on each run the number of
 * lessons actually shown is set partly by a coin flip. That is a randomized
 * ablation of library size. Regressing a run's clean outcome on the log of the
 * shown fraction, within runs that selected the same lessons, gives a causal
 * elasticity, not a correlation with the calendar.
 *
 * γ here is `d success / d log K` divided by mean success, i.e. `d log success
 * / d log K` near the observed operating point.
 */

interface ExposureLine {
  lessonKeys?: string[]
  heldOutKeys?: string[]
  /** Selected project lessons that were eligible for the randomized holdout. */
  trialKeys?: string[]
  verify?: 'pass' | 'fail' | 'skipped' | 'none'
  regime?: 'mechanical' | 'empirical' | 'judgment'
  clean?: boolean
}

export interface ElasticityEstimate {
  /** Runs with a randomized arm that entered the regression. */
  n: number
  gamma?: number
  /** Standard error of γ. */
  se?: number
  meanSuccess?: number
  /** Share of runs where the coin changed how many lessons were shown. */
  varied: number
  detail: string
}

export function readExposures(path: string): ExposureLine[] {
  if (!existsSync(path)) return []
  try {
    return readFileSync(path, 'utf8')
      .split('\n')
      .filter((line) => line.trim())
      .flatMap((line) => {
        try {
          return [JSON.parse(line) as ExposureLine]
        } catch {
          return []
        }
      })
  } catch {
    return []
  }
}

/** Minimum randomized runs before γ is reported. */
export const MIN_RUNS = 30

/**
 * Text-lesson elasticity from the holdout coin. Only runs that went through the
 * coin (`heldOutKeys` present) count; the regressor is log(shown / selected),
 * which the coin alone sets. Records from before `trialKeys` was added are
 * omitted: their `lessonKeys` include non-randomized rules and machine facts.
 */
export function lessonElasticity(lines: readonly ExposureLine[]): ElasticityEstimate {
  const trials = lines.filter((line) =>
    Array.isArray(line.heldOutKeys) &&
    Array.isArray(line.trialKeys) &&
    typeof line.clean === 'boolean' &&
    (line.verify === 'pass' || line.verify === 'fail') &&
    line.regime !== 'judgment',
  )
  const xs: number[] = []
  const ys: number[] = []
  let varied = 0
  for (const line of trials) {
    const selected = line.trialKeys!.length
    const shown = selected - line.heldOutKeys!.length
    if (selected === 0 || shown === 0) continue
    if (line.heldOutKeys!.length > 0) varied += 1
    xs.push(Math.log(shown / selected))
    ys.push(line.clean ? 1 : 0)
  }
  const n = xs.length
  if (n < MIN_RUNS) return { n, varied, detail: `${n} randomized run(s); γ needs ${MIN_RUNS}` }
  const fit = olsSlope(xs, ys)
  const meanSuccess = summarize(ys).mean
  if (!fit || meanSuccess === 0) return { n, varied, meanSuccess, detail: 'the shown fraction never varied, so γ is not identified' }
  const gamma = fit.slope / meanSuccess
  const se = fit.se / meanSuccess
  const significant = Math.abs(gamma) > 1.96 * se
  return {
    n,
    varied: varied / n,
    gamma,
    se,
    meanSuccess,
    detail: significant
      ? `γ = ${gamma.toFixed(2)} ± ${se.toFixed(2)}: showing more of the selected lessons ${gamma > 0 ? 'raises' : 'lowers'} the clean rate`
      : `γ = ${gamma.toFixed(2)} ± ${se.toFixed(2)}: indistinguishable from zero — carrying more lessons has no measurable effect`,
  }
}

export interface GrowthReport {
  lessons: ElasticityEstimate
  /** λ needs frontier tasks sampled over time; `undefined` until it can be measured. */
  lambda?: number
  regime?: GrowthRegime
  detail: string
}

export function growthReport(exposures: readonly ExposureLine[]): GrowthReport {
  const lessons = lessonElasticity(exposures)
  return {
    lessons,
    detail:
      lessons.gamma === undefined
        ? 'library elasticity not yet measurable'
        : `λ = γ − φ needs the difficulty exponent φ, which needs the moving-frontier task log; with γ ${lessons.gamma > 0 ? '> 0' : '≤ 0'} alone, growth is at best ${growthRegime(Math.max(0, lessons.gamma))}`,
  }
}
