/**
 * Special functions and probability distributions, implemented to double precision and
 * checked against SciPy reference values in special.test.ts. Every p-value, confidence
 * interval, and power figure the engine reports is computed here, never estimated by a model.
 */

const EPSILON = 1e-15
const FPMIN = 1e-300
const LANCZOS = [0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7]

export function logGamma(x: number): number {
  if (x < 0.5) return Math.log(Math.PI / Math.abs(Math.sin(Math.PI * x))) - logGamma(1 - x)
  const z = x - 1
  let a = LANCZOS[0]!
  const t = z + 7.5
  for (let index = 1; index < 9; index++) a += LANCZOS[index]! / (z + index)
  return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(a)
}

export function gamma(x: number): number {
  if (Number.isInteger(x) && x <= 0) return Number.NaN
  if (x < 0.5) return Math.PI / (Math.sin(Math.PI * x) * gamma(1 - x))
  return Math.exp(logGamma(x))
}

export function logBeta(a: number, b: number): number {
  return logGamma(a) + logGamma(b) - logGamma(a + b)
}

const logFactorialCache: number[] = [0]
export function logFactorial(n: number): number {
  if (n < 0 || !Number.isInteger(n)) return Number.NaN
  if (n < 256) {
    for (let index = logFactorialCache.length; index <= n; index++) logFactorialCache[index] = logFactorialCache[index - 1]! + Math.log(index)
    return logFactorialCache[n]!
  }
  return logGamma(n + 1)
}

export function logChoose(n: number, k: number): number {
  if (k < 0 || k > n) return Number.NEGATIVE_INFINITY
  return logFactorial(n) - logFactorial(k) - logFactorial(n - k)
}

/** Continued fraction for the incomplete beta function (modified Lentz). */
function betaContinuedFraction(x: number, a: number, b: number): number {
  const qab = a + b
  const qap = a + 1
  const qam = a - 1
  let c = 1
  let d = 1 - (qab * x) / qap
  if (Math.abs(d) < FPMIN) d = FPMIN
  d = 1 / d
  let h = d
  for (let m = 1; m <= 10_000; m++) {
    const m2 = 2 * m
    let aa = (m * (b - m) * x) / ((qam + m2) * (a + m2))
    d = 1 + aa * d
    if (Math.abs(d) < FPMIN) d = FPMIN
    c = 1 + aa / c
    if (Math.abs(c) < FPMIN) c = FPMIN
    d = 1 / d
    h *= d * c
    aa = (-(a + m) * (qab + m) * x) / ((a + m2) * (qap + m2))
    d = 1 + aa * d
    if (Math.abs(d) < FPMIN) d = FPMIN
    c = 1 + aa / c
    if (Math.abs(c) < FPMIN) c = FPMIN
    d = 1 / d
    const delta = d * c
    h *= delta
    if (Math.abs(delta - 1) < EPSILON) break
  }
  return h
}

/** Regularized incomplete beta I_x(a, b). */
export function regularizedBeta(x: number, a: number, b: number): number {
  if (Number.isNaN(x) || a <= 0 || b <= 0) return Number.NaN
  if (x <= 0) return 0
  if (x >= 1) return 1
  const front = Math.exp(a * Math.log(x) + b * Math.log1p(-x) - logBeta(a, b))
  if (x < (a + 1) / (a + b + 2)) return (front * betaContinuedFraction(x, a, b)) / a
  return 1 - (front * betaContinuedFraction(1 - x, b, a)) / b
}

/** Regularized lower incomplete gamma P(a, x). */
export function regularizedGammaP(a: number, x: number): number {
  if (x < 0 || a <= 0) return Number.NaN
  if (x === 0) return 0
  if (!Number.isFinite(x)) return 1
  if (x < a + 1) {
    let sum = 1 / a
    let term = sum
    for (let n = 1; n <= 100_000; n++) {
      term *= x / (a + n)
      sum += term
      if (Math.abs(term) < Math.abs(sum) * EPSILON) break
    }
    return Math.min(1, sum * Math.exp(-x + a * Math.log(x) - logGamma(a)))
  }
  return 1 - regularizedGammaQ(a, x)
}

/** Regularized upper incomplete gamma Q(a, x) = 1 - P(a, x), accurate in the upper tail. */
export function regularizedGammaQ(a: number, x: number): number {
  if (x < 0 || a <= 0) return Number.NaN
  if (x === 0) return 1
  if (!Number.isFinite(x)) return 0
  if (x < a + 1) return 1 - regularizedGammaP(a, x)
  let b = x + 1 - a
  let c = 1 / FPMIN
  let d = 1 / b
  let h = d
  for (let i = 1; i <= 100_000; i++) {
    const an = -i * (i - a)
    b += 2
    d = an * d + b
    if (Math.abs(d) < FPMIN) d = FPMIN
    c = b + an / c
    if (Math.abs(c) < FPMIN) c = FPMIN
    d = 1 / d
    const delta = d * c
    h *= delta
    if (Math.abs(delta - 1) < EPSILON) break
  }
  return Math.exp(-x + a * Math.log(x) - logGamma(a)) * h
}

export function erf(x: number): number {
  if (x === 0) return 0
  const value = regularizedGammaP(0.5, x * x)
  return x > 0 ? value : -value
}

export function erfc(x: number): number {
  if (x < 0) return 2 - erfc(-x)
  return regularizedGammaQ(0.5, x * x)
}

// ---------------------------------------------------------------- normal

export function normalPdf(x: number, mean = 0, sd = 1): number {
  const z = (x - mean) / sd
  return Math.exp(-0.5 * z * z) / (sd * Math.sqrt(2 * Math.PI))
}

export function normalCdf(x: number, mean = 0, sd = 1): number {
  const z = (x - mean) / sd
  if (!Number.isFinite(z)) return z > 0 ? 1 : 0
  return 0.5 * erfc(-z / Math.SQRT2)
}

/** Upper tail 1 - Φ(z), accurate far into the tail. */
export function normalSf(x: number, mean = 0, sd = 1): number {
  return normalCdf(-(x - mean) / sd)
}

/** Inverse normal CDF: Acklam's rational approximation refined by one Halley step. */
export function normalQuantile(p: number, mean = 0, sd = 1): number {
  if (Number.isNaN(p) || p < 0 || p > 1) return Number.NaN
  if (p === 0) return Number.NEGATIVE_INFINITY
  if (p === 1) return Number.POSITIVE_INFINITY
  const a = [-3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.38357751867269e2, -3.066479806614716e1, 2.506628277459239]
  const b = [-5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1, -1.328068155288572e1]
  const c = [-7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783]
  const d = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416]
  const low = 0.02425
  let x: number
  if (p < low) {
    const q = Math.sqrt(-2 * Math.log(p))
    x = (((((c[0]! * q + c[1]!) * q + c[2]!) * q + c[3]!) * q + c[4]!) * q + c[5]!) / ((((d[0]! * q + d[1]!) * q + d[2]!) * q + d[3]!) * q + 1)
  } else if (p <= 1 - low) {
    const q = p - 0.5
    const r = q * q
    x = ((((((a[0]! * r + a[1]!) * r + a[2]!) * r + a[3]!) * r + a[4]!) * r + a[5]!) * q) / (((((b[0]! * r + b[1]!) * r + b[2]!) * r + b[3]!) * r + b[4]!) * r + 1)
  } else {
    const q = Math.sqrt(-2 * Math.log1p(-p))
    x = -(((((c[0]! * q + c[1]!) * q + c[2]!) * q + c[3]!) * q + c[4]!) * q + c[5]!) / ((((d[0]! * q + d[1]!) * q + d[2]!) * q + d[3]!) * q + 1)
  }
  for (let step = 0; step < 2; step++) {
    const e = normalCdf(x) - p
    const u = e * Math.sqrt(2 * Math.PI) * Math.exp((x * x) / 2)
    x -= u / (1 + (x * u) / 2)
  }
  return mean + sd * x
}

// ---------------------------------------------------------------- root finding

/** Brent's method on a bracketing interval; throws when f(lo) and f(hi) share a sign. */
export function brent(f: (x: number) => number, lo: number, hi: number, tolerance = 1e-13, maxIterations = 500): number {
  let a = lo
  let b = hi
  let fa = f(a)
  let fb = f(b)
  if (fa === 0) return a
  if (fb === 0) return b
  if (fa * fb > 0) throw new Error('brent: root is not bracketed')
  let c = a
  let fc = fa
  let d = b - a
  let e = d
  for (let iteration = 0; iteration < maxIterations; iteration++) {
    if (fb * fc > 0) {
      c = a
      fc = fa
      d = b - a
      e = d
    }
    if (Math.abs(fc) < Math.abs(fb)) {
      a = b; b = c; c = a
      fa = fb; fb = fc; fc = fa
    }
    const tol = 2 * Number.EPSILON * Math.abs(b) + 0.5 * tolerance
    const m = 0.5 * (c - b)
    if (Math.abs(m) <= tol || fb === 0) return b
    if (Math.abs(e) >= tol && Math.abs(fa) > Math.abs(fb)) {
      const s = fb / fa
      let p: number
      let q: number
      if (a === c) {
        p = 2 * m * s
        q = 1 - s
      } else {
        const qq = fa / fc
        const r = fb / fc
        p = s * (2 * m * qq * (qq - r) - (b - a) * (r - 1))
        q = (qq - 1) * (r - 1) * (s - 1)
      }
      if (p > 0) q = -q
      else p = -p
      if (2 * p < Math.min(3 * m * q - Math.abs(tol * q), Math.abs(e * q))) {
        e = d
        d = p / q
      } else {
        d = m
        e = m
      }
    } else {
      d = m
      e = m
    }
    a = b
    fa = fb
    b += Math.abs(d) > tol ? d : m > 0 ? tol : -tol
    fb = f(b)
  }
  return b
}

/** Inverts a monotone increasing CDF on [lo, hi], expanding the upper bound as needed. */
function invertCdf(cdf: (x: number) => number, p: number, lo: number, hi: number): number {
  let upper = hi
  let guard = 0
  while (cdf(upper) < p && guard++ < 200) upper *= 2
  let lower = lo
  guard = 0
  while (cdf(lower) > p && guard++ < 200) lower = lower < 0 ? lower * 2 : lower - Math.abs(upper)
  return brent((x) => cdf(x) - p, lower, upper, 1e-12)
}

// ---------------------------------------------------------------- Student t

export function tPdf(t: number, df: number): number {
  return Math.exp(logGamma((df + 1) / 2) - logGamma(df / 2) - 0.5 * Math.log(df * Math.PI) - ((df + 1) / 2) * Math.log1p((t * t) / df))
}

export function tCdf(t: number, df: number): number {
  if (Number.isNaN(t) || !(df > 0)) return Number.NaN
  if (!Number.isFinite(t)) return t > 0 ? 1 : 0
  if (df > 1e7) return normalCdf(t)
  const x = df / (df + t * t)
  const tail = 0.5 * regularizedBeta(x, df / 2, 0.5)
  return t > 0 ? 1 - tail : tail
}

/** Two-sided and one-sided p-values for a t statistic. */
export function tPValue(t: number, df: number, alternative: Alternative = 'two-sided'): number {
  if (alternative === 'less') return tCdf(t, df)
  if (alternative === 'greater') return tCdf(-t, df)
  const x = df / (df + t * t)
  return Math.min(1, df > 1e7 ? 2 * normalCdf(-Math.abs(t)) : regularizedBeta(x, df / 2, 0.5))
}

export function tQuantile(p: number, df: number): number {
  if (p <= 0) return Number.NEGATIVE_INFINITY
  if (p >= 1) return Number.POSITIVE_INFINITY
  if (p === 0.5) return 0
  if (df > 1e7) return normalQuantile(p)
  if (p < 0.5) return -tQuantile(1 - p, df)
  const guess = Math.max(1, normalQuantile(p) * 2)
  return invertCdf((x) => tCdf(x, df), p, 0, guess * (df < 3 ? 50 : 4))
}

// ---------------------------------------------------------------- chi-square, F, beta, gamma

export function chiSquareCdf(x: number, k: number): number {
  return x <= 0 ? 0 : regularizedGammaP(k / 2, x / 2)
}

export function chiSquareSf(x: number, k: number): number {
  return x <= 0 ? 1 : regularizedGammaQ(k / 2, x / 2)
}

export function chiSquareQuantile(p: number, k: number): number {
  if (p <= 0) return 0
  if (p >= 1) return Number.POSITIVE_INFINITY
  return invertCdf((x) => chiSquareCdf(x, k), p, 0, Math.max(1, k + 10 * Math.sqrt(2 * k)))
}

export function fCdf(x: number, d1: number, d2: number): number {
  if (x <= 0) return 0
  return regularizedBeta((d1 * x) / (d1 * x + d2), d1 / 2, d2 / 2)
}

export function fSf(x: number, d1: number, d2: number): number {
  if (x <= 0) return 1
  return regularizedBeta(d2 / (d2 + d1 * x), d2 / 2, d1 / 2)
}

export function fQuantile(p: number, d1: number, d2: number): number {
  if (p <= 0) return 0
  if (p >= 1) return Number.POSITIVE_INFINITY
  return invertCdf((x) => fCdf(x, d1, d2), p, 0, 10)
}

export function betaCdf(x: number, a: number, b: number): number {
  return regularizedBeta(x, a, b)
}

export function betaQuantile(p: number, a: number, b: number): number {
  if (p <= 0) return 0
  if (p >= 1) return 1
  return brent((x) => regularizedBeta(x, a, b) - p, 0, 1, 1e-14)
}

export function gammaCdf(x: number, shape: number, scale = 1): number {
  return x <= 0 ? 0 : regularizedGammaP(shape, x / scale)
}

// ---------------------------------------------------------------- discrete

export function binomialPmf(k: number, n: number, p: number): number {
  if (k < 0 || k > n || !Number.isInteger(k)) return 0
  if (p === 0) return k === 0 ? 1 : 0
  if (p === 1) return k === n ? 1 : 0
  return Math.exp(logChoose(n, k) + k * Math.log(p) + (n - k) * Math.log1p(-p))
}

/** P(X <= k) for X ~ Binomial(n, p), through the incomplete beta identity. */
export function binomialCdf(k: number, n: number, p: number): number {
  if (k < 0) return 0
  if (k >= n) return 1
  return regularizedBeta(1 - p, n - Math.floor(k), Math.floor(k) + 1)
}

export function poissonPmf(k: number, lambda: number): number {
  if (k < 0 || !Number.isInteger(k)) return 0
  if (lambda === 0) return k === 0 ? 1 : 0
  return Math.exp(k * Math.log(lambda) - lambda - logFactorial(k))
}

export function poissonCdf(k: number, lambda: number): number {
  if (k < 0) return 0
  return regularizedGammaQ(Math.floor(k) + 1, lambda)
}

export function hypergeometricLogPmf(k: number, population: number, successes: number, draws: number): number {
  return logChoose(successes, k) + logChoose(population - successes, draws - k) - logChoose(population, draws)
}

// ---------------------------------------------------------------- noncentral distributions (power analysis)

/**
 * CDF of the noncentral t distribution: a port of R's pnt (AS 243, Lenth 1989) with
 * Guenther's twin series. Used for exact t-test power.
 */
export function noncentralTCdf(t: number, df: number, ncp: number): number {
  if (!(df > 0)) return Number.NaN
  if (ncp === 0) return tCdf(t, df)
  if (!Number.isFinite(t)) return t < 0 ? 0 : 1
  let negdel = false
  let tt = t
  let del = ncp
  if (t < 0) {
    if (ncp > 40) return 0
    negdel = true
    tt = -t
    del = -ncp
  }
  if (df > 4e5 || del * del > 2 * Math.LN2 * 1021) {
    const s = 1 / (4 * df)
    const value = normalCdf(tt * (1 - s), del, Math.sqrt(1 + tt * tt * 2 * s))
    return negdel ? 1 - value : value
  }
  let x = t * t
  x = x / (x + df)
  let tnc = 0
  if (x > 0) {
    const lambda = del * del
    let p = 0.5 * Math.exp(-0.5 * lambda)
    if (p === 0) return negdel ? 1 : 0
    let q = Math.sqrt(2 / Math.PI) * p * del
    let s = 0.5 - p
    if (s < 1e-7) s = -0.5 * Math.expm1(-0.5 * lambda)
    let a = 0.5
    const b = 0.5 * df
    const rxb = Math.pow(1 - x, b)
    const albeta = 0.5 * Math.log(Math.PI) + logGamma(b) - logGamma(0.5 + b)
    let xodd = regularizedBeta(x, a, b)
    let godd = 2 * rxb * Math.exp(a * Math.log(x) - albeta)
    const bx = b * x
    let xeven = bx < Number.EPSILON ? bx : 1 - rxb
    let geven = bx * rxb
    tnc = p * xodd + q * xeven
    for (let it = 1; it <= 1000; it++) {
      a += 1
      xodd -= godd
      xeven -= geven
      godd *= (x * (a + b - 1)) / a
      geven *= (x * (a + b - 0.5)) / (a + 0.5)
      p *= lambda / (2 * it)
      q *= lambda / (2 * it + 1)
      tnc += p * xodd + q * xeven
      s -= p
      if (s < -1e-10) break
      if (s <= 0 && it > 1) break
      const errbd = 2 * s * (xodd - godd)
      if (Math.abs(errbd) < 1e-12) break
    }
  }
  tnc += normalCdf(-del)
  const value = Math.min(tnc, 1)
  return negdel ? 1 - value : value
}

/** Poisson-mixture sum over j of w_j · term(j), walking out from the mode until weights vanish. */
function poissonMixture(halfLambda: number, term: (j: number) => number): number {
  if (halfLambda === 0) return term(0)
  const mode = Math.floor(halfLambda)
  const logWeight = (j: number) => j * Math.log(halfLambda) - halfLambda - logFactorial(j)
  let total = 0
  for (let j = mode; j >= 0; j--) {
    const weight = Math.exp(logWeight(j))
    total += weight * term(j)
    if (weight < 1e-17 && j < mode) break
  }
  for (let j = mode + 1; j < mode + 100_000; j++) {
    const weight = Math.exp(logWeight(j))
    total += weight * term(j)
    if (weight < 1e-17) break
  }
  return Math.min(1, Math.max(0, total))
}

export function noncentralChiSquareCdf(x: number, k: number, lambda: number): number {
  if (x <= 0) return 0
  return poissonMixture(lambda / 2, (j) => regularizedGammaP(k / 2 + j, x / 2))
}

export function noncentralFCdf(x: number, d1: number, d2: number, lambda: number): number {
  if (x <= 0) return 0
  const y = (d1 * x) / (d1 * x + d2)
  return poissonMixture(lambda / 2, (j) => regularizedBeta(y, d1 / 2 + j, d2 / 2))
}

// ---------------------------------------------------------------- Kolmogorov

/** Asymptotic Kolmogorov survival function Q(λ) = 2 Σ (-1)^{k-1} exp(-2 k² λ²). */
export function kolmogorovSf(lambda: number): number {
  if (lambda <= 0) return 1
  if (lambda < 0.2) return 1
  let sum = 0
  let sign = 1
  for (let k = 1; k <= 200; k++) {
    const term = sign * Math.exp(-2 * k * k * lambda * lambda)
    sum += term
    if (Math.abs(term) < 1e-16) break
    sign = -sign
  }
  return Math.min(1, Math.max(0, 2 * sum))
}

export type Alternative = 'two-sided' | 'less' | 'greater'

export function parseAlternative(value: unknown): Alternative {
  if (value === undefined || value === null) return 'two-sided'
  if (value === 'two-sided' || value === 'less' || value === 'greater') return value
  throw new Error('alternative must be "two-sided", "less", or "greater"')
}

/** p-value for a standard-normal statistic under the chosen alternative. */
export function zPValue(z: number, alternative: Alternative = 'two-sided'): number {
  if (alternative === 'less') return normalCdf(z)
  if (alternative === 'greater') return normalCdf(-z)
  return Math.min(1, 2 * normalCdf(-Math.abs(z)))
}
