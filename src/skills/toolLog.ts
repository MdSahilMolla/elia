import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { appendSecureFile, ensureSecureDirectory } from '../securePersistence.ts'
import { compoundingStateDir, registerArtifact, type Check } from '../autonomy/certifiedLibrary.ts'
import { olsSlope } from '../compounding/stats.ts'

/**
 * Every attempt to build a tool, kept — §7's tool closure and Conjecture 1.
 *
 * Tool closure says a frozen model's long-run capability is the best pipeline
 * it can build and verify, so a tool that passes its gates is the most valuable
 * thing the library can hold, and a failed attempt is worth keeping too: it is
 * a dead end the next attempt should not walk into (§9.2, "failure records are
 * first-class artifacts").
 *
 * The bootstrapping-threshold conjecture is empirical: below some generator
 * capability, the cost of building a tool grows exponentially with its
 * description length; above it, polynomially. So each attempt also logs what it
 * cost and how long the thing it built was, and `bootstrappingFit` fits both
 * shapes to the record.
 */

export interface ToolConstruction {
  pattern: string
  ok: boolean
  reason: string
  /** Tokens the builder spent. */
  tokens: number
  /** Size of what it produced, in bytes — the description length. 0 when nothing was produced. */
  bytes: number
  toolName?: string
  /** Whether a test written for the tool ran and passed. */
  testPassed?: boolean
  /** Whether the tool loaded and exposed a valid schema. */
  loaded?: boolean
}

export function closureLogPath(dir = compoundingStateDir()): string {
  return join(dir, 'closure.jsonl')
}

/** Records one construction attempt in the closure log and the certified library. Never throws. */
export function recordToolConstruction(attempt: ToolConstruction, options: { logPath?: string; libraryFile?: string } = {}): void {
  const at = Date.now()
  const logPath = options.logPath ?? closureLogPath()
  try {
    ensureSecureDirectory(dirname(logPath))
    appendSecureFile(logPath, `${JSON.stringify({ at, ...attempt })}\n`)
  } catch {
    // The log is for measuring closure; the tool (or its absence) is unaffected.
  }
  try {
    const library = options.libraryFile ? [options.libraryFile] : []
    if (attempt.ok && attempt.toolName) {
      const checks: Check[] = []
      if (attempt.testPassed !== undefined) checks.push({ verifier: 'builder test', tier: 'exact', family: 'execution', passed: attempt.testPassed, at })
      if (attempt.loaded !== undefined) checks.push({ verifier: 'tool loads with a valid schema', tier: 'exact', family: 'structural', passed: attempt.loaded, at })
      registerArtifact({ id: `skill:${attempt.toolName}`, kind: 'skill', summary: `tool for ${attempt.pattern}`, source: 'skill-synthesis', checks }, ...library)
    } else {
      registerArtifact(
        {
          id: `failure:skill:${attempt.pattern}:${at.toString(36)}`,
          kind: 'failure',
          summary: `could not build a tool for ${attempt.pattern}: ${attempt.reason.slice(0, 300)}`,
          source: 'skill-synthesis',
          checks: [{ verifier: 'dead-end record', tier: 'exact', family: 'record', passed: true, at }],
        },
        ...library,
      )
    }
  } catch {
    // Certification is evidence; never let it fail the synthesis that produced it.
  }
}

export interface ClosureRecord extends ToolConstruction {
  at: number
}

export function readClosureLog(path = closureLogPath()): ClosureRecord[] {
  if (!existsSync(path)) return []
  try {
    return readFileSync(path, 'utf8')
      .split('\n')
      .filter((line) => line.trim())
      .flatMap((line) => {
        try {
          return [JSON.parse(line) as ClosureRecord]
        } catch {
          return []
        }
      })
  } catch {
    return []
  }
}

export interface BootstrappingFit {
  /** Successful constructions the fit used. */
  n: number
  /** log(cost) against length: the exponential shape. */
  exponential?: { slope: number; r2: number }
  /** log(cost) against log(length): the polynomial shape. */
  polynomial?: { slope: number; r2: number }
  /** Which shape fits better, or why it cannot be said. */
  verdict: 'exponential' | 'polynomial' | 'undetermined'
  detail: string
}

/** Minimum successful builds before the shape of the cost curve is worth reporting. */
export const MIN_FIT = 6

function r2(xs: number[], ys: number[], slope: number, intercept: number): number {
  const mean = ys.reduce((sum, y) => sum + y, 0) / ys.length
  let total = 0
  let residual = 0
  for (let i = 0; i < ys.length; i++) {
    total += (ys[i]! - mean) ** 2
    residual += (ys[i]! - (intercept + slope * xs[i]!)) ** 2
  }
  return total === 0 ? 0 : 1 - residual / total
}

/**
 * Conjecture 1's test on elia's own record: does the cost of a tool grow like
 * `e^(length)` or like `length^k`? Undetermined until there are `MIN_FIT`
 * successful builds, and when neither shape clearly wins.
 */
export function bootstrappingFit(records: readonly ClosureRecord[]): BootstrappingFit {
  const built = records.filter((record) => record.ok && record.tokens > 0 && record.bytes > 0)
  if (built.length < MIN_FIT) {
    return { n: built.length, verdict: 'undetermined', detail: `${built.length} successful build(s) logged; the fit needs ${MIN_FIT}` }
  }
  const logCost = built.map((record) => Math.log(record.tokens))
  const length = built.map((record) => record.bytes / 1000)
  const logLength = built.map((record) => Math.log(record.bytes))
  const expFit = olsSlope(length, logCost)
  const polyFit = olsSlope(logLength, logCost)
  const exponential = expFit ? { slope: expFit.slope, r2: r2(length, logCost, expFit.slope, expFit.intercept) } : undefined
  const polynomial = polyFit ? { slope: polyFit.slope, r2: r2(logLength, logCost, polyFit.slope, polyFit.intercept) } : undefined
  const fit: BootstrappingFit = { n: built.length, verdict: 'undetermined', detail: '', ...(exponential ? { exponential } : {}), ...(polynomial ? { polynomial } : {}) }
  if (!exponential || !polynomial) return { ...fit, detail: 'the builds do not vary in length enough to fit either shape' }
  const margin = 0.05
  if (polynomial.r2 > exponential.r2 + margin) {
    return { ...fit, verdict: 'polynomial', detail: `cost grows like length^${polynomial.slope.toFixed(2)} (R² ${polynomial.r2.toFixed(2)} vs ${exponential.r2.toFixed(2)} exponential) — consistent with being above the bootstrapping threshold` }
  }
  if (exponential.r2 > polynomial.r2 + margin) {
    return { ...fit, verdict: 'exponential', detail: `cost grows exponentially with length (R² ${exponential.r2.toFixed(2)} vs ${polynomial.r2.toFixed(2)} polynomial) — consistent with being below the bootstrapping threshold` }
  }
  return { ...fit, detail: `neither shape fits clearly better (R² ${exponential.r2.toFixed(2)} exponential, ${polynomial.r2.toFixed(2)} polynomial)` }
}
