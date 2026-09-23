/**
 * The mathematics of "Amplification Without Distillation", as functions.
 *
 * The working paper argues that a frozen model can be amplified without any
 * weight update, and that verification rather than the model sets how far. The
 * frontier, the certified library, the sealed gate, the resource governor and
 * the rest each turn one of its results into machinery; this module holds the
 * results themselves, so the machinery and its tests share one
 * definition of each quantity instead of re-deriving it inline.
 *
 * Notation follows the paper: `p` is the generator's per-sample success rate on a
 * task family, `alpha` the verifier's false-accept rate, `beta` its false-reject
 * rate, `eps` the chance a verified step slips past verification, `sigma` the
 * reuse advantage of sound library artifacts over unsound ones.
 *
 * One deliberate departure: the paper states proofreading with independent
 * passes (slip rate ε^k). Its own Proposition 2 and the correlated-error
 * literature it cites say passes are not independent, and at ρ = 0.5 two passes
 * buy a 2x threshold rather than 100x. `proofreadSlip` therefore takes ρ and
 * reduces to the paper's formula only at ρ = 0.
 */

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.min(1, Math.max(0, value))
}

// --- §3.1 Resampling precision ------------------------------------------------

/**
 * Proposition 1: precision of the first accepted sample under resampling —
 * `p(1−β) / (p(1−β) + (1−p)α)`. Independent of how many samples are drawn.
 * Returns 0 when nothing can ever be accepted.
 */
export function resamplingPrecision(p: number, alpha: number, beta: number): number {
  const correct = clamp01(p) * (1 - clamp01(beta))
  const wrong = (1 - clamp01(p)) * clamp01(alpha)
  return correct + wrong === 0 ? 0 : correct / (correct + wrong)
}

/** Proposition 1: the chance any sample is accepted within `n` draws. */
export function acceptWithin(p: number, alpha: number, beta: number, n: number): number {
  const perSample = clamp01(p) * (1 - clamp01(beta)) + (1 - clamp01(p)) * clamp01(alpha)
  return 1 - (1 - perSample) ** Math.max(0, n)
}

/**
 * Corollary 1: whether a task family can be amplified to `target` precision by
 * sampling alone — `p/(1−p) ≥ π* / (1−π*) · α/(1−β)`. For π* = ½ and small rates
 * this is `p ≳ α`: a verifier that wrongly accepts more often than the generator
 * is right keeps the family out of reach whatever the budget.
 */
export function inFrontier(p: number, alpha: number, beta: number, target = 0.5): boolean {
  return frontierMargin(p, alpha, beta, target) >= 0
}

/**
 * How far inside (positive) or outside (negative) the frontier a family sits, in
 * log-odds. Zero is the boundary; one unit is a factor of e in the odds. This is
 * what `FrontierSampler` in Algorithm 1 steers by — tasks near zero are where a
 * little more `p` or a little less `α` changes what the engine can certify.
 */
export function frontierMargin(p: number, alpha: number, beta: number, target = 0.5): number {
  const pc = Math.min(1 - 1e-9, Math.max(1e-9, p))
  const a = Math.max(1e-9, alpha)
  const reject = Math.min(1 - 1e-9, Math.max(0, beta))
  const t = Math.min(1 - 1e-9, Math.max(1e-9, target))
  return Math.log(pc / (1 - pc)) - (Math.log(t / (1 - t)) + Math.log(a / (1 - reject)))
}

/** The smallest per-sample success rate that reaches `target` precision against this verifier. */
export function requiredSuccessRate(alpha: number, beta: number, target = 0.5): number {
  const t = Math.min(1 - 1e-9, Math.max(1e-9, target))
  const odds = (t / (1 - t)) * (clamp01(alpha) / Math.max(1e-9, 1 - clamp01(beta)))
  return odds / (1 + odds)
}

/**
 * Corollary 2: samples after which more compute changes neither precision nor,
 * up to `delta`, coverage — `ln(1/δ) / (p(1−β) + (1−p)α)`.
 */
export function saturationSamples(p: number, alpha: number, beta: number, delta = 0.01): number {
  const perSample = clamp01(p) * (1 - clamp01(beta)) + (1 - clamp01(p)) * clamp01(alpha)
  return perSample === 0 ? Number.POSITIVE_INFINITY : Math.log(1 / delta) / perSample
}

// --- §3.2 Stacked and correlated verifiers ------------------------------------

/** Proposition 2, independent case: a chain that must all accept multiplies false-accept rates. */
export function stackedFalseAccept(alphas: readonly number[]): number {
  return alphas.reduce((product, alpha) => product * clamp01(alpha), 1)
}

/**
 * Proposition 2 for two verifiers whose false accepts have correlation `rho`:
 * `α₁α₂ + ρ·√(α₁(1−α₁)α₂(1−α₂))`, which is the paper's `α² + ρα(1−α)` when the
 * rates are equal. Clamped to the feasible range, since not every ρ is
 * achievable for every pair of marginals.
 */
export function pairFalseAccept(alpha1: number, alpha2: number, rho: number): number {
  const a1 = clamp01(alpha1)
  const a2 = clamp01(alpha2)
  const joint = a1 * a2 + rho * Math.sqrt(a1 * (1 - a1) * a2 * (1 - a2))
  return Math.min(Math.min(a1, a2), Math.max(0, joint))
}

// --- §3.3 Goodhart under argmax -----------------------------------------------

/**
 * Proposition 3: argmax over `n` samples scored by a learned judge is correct at
 * most `(1 − (1−p)η)^n`, where `η` is the share of wrong samples that exploit the
 * judge. It tends to zero, which is why a learned score should gate by
 * threshold, not pick a maximum.
 */
export function argmaxPrecisionBound(p: number, eta: number, n: number): number {
  return (1 - (1 - clamp01(p)) * clamp01(eta)) ** Math.max(0, n)
}

/** Appendix A.2: the sample count at which argmax precision peaks, `ln(1 + a/b) / a`. */
export function argmaxPeak(p: number, eta: number): number {
  const a = -Math.log(1 - Math.min(1 - 1e-12, clamp01(p)))
  const b = -Math.log(1 - (1 - clamp01(p)) * clamp01(eta))
  if (a === 0) return Number.POSITIVE_INFINITY
  if (b === 0) return Number.POSITIVE_INFINITY
  return Math.log(1 + a / b) / a
}

/** Past the peak, argmax precision halves every `ln 2 / b` samples. */
export function argmaxHalvingSamples(p: number, eta: number): number {
  const b = -Math.log(1 - (1 - clamp01(p)) * clamp01(eta))
  return b === 0 ? Number.POSITIVE_INFINITY : Math.LN2 / b
}

// --- §4 Cumulative selection and stepping stones ------------------------------

/** Proposition 4: expected samples to hit an `m`-step target by resampling from scratch, `q^(−m)`. */
export function resampleWait(q: number, m: number): number {
  return clamp01(q) === 0 ? Number.POSITIVE_INFINITY : clamp01(q) ** -m
}

/** Proposition 4: the same target with an archive that keeps each stage, `m/q`. */
export function archiveWait(q: number, m: number): number {
  return clamp01(q) === 0 ? Number.POSITIVE_INFINITY : m / clamp01(q)
}

/** §4: a lineage of `m` accepted promotions, each false with probability `eps`, is fully sound with `(1−ε)^m`. */
export function lineageSoundness(eps: number, m: number): number {
  return (1 - clamp01(eps)) ** Math.max(0, m)
}

// --- §5 The epistemic error threshold -----------------------------------------

/** §5.1: the chance a derivation adding `leap` verified steps is sound, `Q = (1−ε)^L`. */
export function derivationSoundness(eps: number, leap: number): number {
  return (1 - clamp01(eps)) ** Math.max(0, leap)
}

/** §5.1: one round of the sound-fraction recursion, `σQx / (σx + c(1−x))`; `c = 1` without an audit. */
export function soundFractionStep(x: number, sigma: number, q: number, c = 1): number {
  const denominator = sigma * x + c * (1 - x)
  return denominator === 0 ? 0 : (sigma * q * x) / denominator
}

/**
 * Theorem 1: the largest leap a self-extending library sustains,
 * `L* = ln σ / −ln(1−ε) ≈ ln σ / ε`. Above it, unsound artifacts take over
 * regardless of compute.
 */
export function errorThreshold(sigma: number, eps: number): number {
  const slip = clamp01(eps)
  if (sigma <= 1) return 0
  if (slip === 0) return Number.POSITIVE_INFINITY
  return Math.log(sigma) / -Math.log(1 - slip)
}

/** Theorem 1: the sound fraction the library settles at, `x* = (σQ − 1)/(σ − 1)`, floored at 0. */
export function soundFraction(sigma: number, eps: number, leap: number): number {
  return repairedSoundFraction(sigma, eps, leap, 0, 0)
}

/**
 * §5.3 and Appendix A.1: the threshold with an independent audit that purges
 * unsound artifacts with probability `r` and sound ones with probability `betaA`.
 * An audit catching half the unsound artifacts is worth doubling σ.
 */
export function repairedThreshold(sigma: number, eps: number, r: number, betaA = 0): number {
  const slip = clamp01(eps)
  const numerator = Math.log(sigma) + Math.log(1 - clamp01(betaA)) - Math.log(1 - Math.min(1 - 1e-12, clamp01(r)))
  if (numerator <= 0) return 0
  if (slip === 0) return Number.POSITIVE_INFINITY
  return numerator / -Math.log(1 - slip)
}

/** Appendix A.1: `x* = (σ'Q − c)/(σ' − c)` with `σ' = σ(1−βₐ)` and `c = 1 − r`. */
export function repairedSoundFraction(sigma: number, eps: number, leap: number, r: number, betaA = 0): number {
  const sigmaPrime = sigma * (1 - clamp01(betaA))
  const c = 1 - clamp01(r)
  if (sigmaPrime <= c) return 0
  const q = derivationSoundness(eps, leap)
  return Math.max(0, (sigmaPrime * q - c) / (sigmaPrime - c))
}

/**
 * §5.3 proofreading: the slip rate after `k` verification passes whose slips
 * are exchangeable with pairwise correlation `rho`.
 *
 * Modelled as a beta-binomial: each artifact has a latent difficulty, and every
 * pass slips on it with that probability. At k = 2 this is exactly Proposition
 * 2's `ε² + ρε(1−ε)`; at ρ = 0 it is the paper's `ε^k`; at ρ = 1 extra passes
 * buy nothing.
 */
export function proofreadSlip(eps: number, k: number, rho = 0): number {
  const slip = clamp01(eps)
  const passes = Math.max(1, Math.floor(k))
  if (passes === 1 || slip === 0 || slip === 1) return slip
  const correlation = clamp01(rho)
  if (correlation === 0) return slip ** passes
  if (correlation === 1) return slip
  // Beta(a, b) with mean ε and intra-class correlation ρ = 1/(a+b+1).
  const total = 1 / correlation - 1
  const a = slip * total
  let probability = 1
  for (let i = 0; i < passes; i++) probability *= (a + i) / (total + i)
  return probability
}

/** The error threshold after proofreading with `k` passes at correlation `rho`. */
export function proofreadThreshold(sigma: number, eps: number, k: number, rho = 0): number {
  return errorThreshold(sigma, proofreadSlip(eps, k, rho))
}

// --- §6 Frontier expansion dynamics -------------------------------------------

export type GrowthRegime = 'polynomial' | 'exponential' | 'hyperbolic'

/** §6.1: the growth regime set by the net exponent `λ = γ − φ`. */
export function growthRegime(lambda: number, tolerance = 0.05): GrowthRegime {
  if (Math.abs(lambda - 1) <= tolerance) return 'exponential'
  return lambda < 1 ? 'polynomial' : 'hyperbolic'
}

/**
 * §6.1: `K(t)` solving `dK/dt = r·K^λ` from `K(0) = k0`. Returns Infinity past a
 * hyperbolic blow-up, which is the model's way of saying a brake must bind.
 */
export function libraryAt(k0: number, rate: number, lambda: number, t: number): number {
  if (Math.abs(lambda - 1) < 1e-12) return k0 * Math.exp(rate * t)
  const exponent = 1 - lambda
  const base = k0 ** exponent + exponent * rate * t
  if (base <= 0) return Number.POSITIVE_INFINITY
  return base ** (1 / exponent)
}

// --- §8 Statistically valid self-improvement ----------------------------------

/**
 * Proposition 5: the mean paired difference (each in [−1, 1]) a proposal must
 * beat so that, across `comparisons` proposals with no real gain, the chance of
 * any acceptance stays below `delta` — `√(2 ln(K/δ) / n)`.
 */
export function hoeffdingBar(n: number, comparisons: number, delta = 0.05): number {
  if (n <= 0) return Number.POSITIVE_INFINITY
  return Math.sqrt((2 * Math.log(Math.max(1, comparisons) / delta)) / n)
}

/**
 * Appendix A.3: the variance-aware bar, `√(2v ln(K/δ)/n) + (4/3)·ln(K/δ)/n`,
 * with `v` the variance of the paired differences.
 */
export function bernsteinBar(n: number, comparisons: number, variance: number, delta = 0.05): number {
  if (n <= 0) return Number.POSITIVE_INFINITY
  const log = Math.log(Math.max(1, comparisons) / delta)
  return Math.sqrt((2 * Math.max(0, variance) * log) / n) + (4 / 3) * (log / n)
}

/**
 * §8.1's comparison budget, turned around: how many held-out tasks the
 * Bernstein bar needs before an `effect` of this size can clear it. The paper's
 * example — a 2-point gain at K = 1,000 with σ = 0.3 — needs about 6,000.
 */
export function heldOutNeeded(effect: number, comparisons: number, sd: number, delta = 0.05): number {
  if (effect <= 0) return Number.POSITIVE_INFINITY
  let lo = 1
  let hi = 1
  while (bernsteinBar(hi, comparisons, sd * sd, delta) > effect) {
    hi *= 2
    if (hi > 1e12) return Number.POSITIVE_INFINITY
  }
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2)
    if (bernsteinBar(mid, comparisons, sd * sd, delta) <= effect) hi = mid
    else lo = mid + 1
  }
  return lo
}

/**
 * The smallest mean gain `n` held-out tasks can certify under the Bernstein bar
 * — the comparison budget of §8.1 read from the other side. Used by the
 * resource governor's rule R4.
 */
export function minimumDetectableEffect(n: number, comparisons: number, sd: number, delta = 0.05): number {
  return bernsteinBar(n, comparisons, sd * sd, delta)
}
