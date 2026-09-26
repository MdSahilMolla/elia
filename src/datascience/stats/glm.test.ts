import { expect, test } from 'bun:test'
import fixture from './regression.fixture.json'
import { frameFromRows } from '../frame.ts'
import { buildDesign } from './design.ts'
import { huberRegression, logisticRegression, negativeBinomialRegression, ols, poissonRegression, randomInterceptModel } from './glm.ts'
import { createRng } from '../rng.ts'

// References computed independently with NumPy least squares and SciPy BFGS maximum likelihood.
const rows = fixture.x1.map((x1, index) => ({ x1, x2: fixture.x2[index]!, g: fixture.g[index]!, y: fixture.y[index]!, yb: fixture.yb[index]!, yc: fixture.yc[index]! }))
const frame = frameFromRows(rows)

function close(actual: number, expected: number, rel = 1e-6): void {
  expect(Math.abs(actual - expected) / Math.max(1e-12, Math.abs(expected))).toBeLessThan(rel)
}

test('OLS with a categorical feature matches NumPy, including HC3 errors', () => {
  const design = buildDesign(frame, { target: 'y', features: ['x1', 'x2', 'g'] })
  expect(design.names).toEqual(['(Intercept)', 'x1', 'x2', 'g[a]', 'g[b]'])
  const result = ols(design.x, design.y!, design.names)
  result.coefficients.forEach((coefficient, index) => {
    close(coefficient.estimate, fixture.ols.beta[index]!)
    close(coefficient.se, fixture.ols.se[index]!)
  })
  close(result.fit.rSquared!, fixture.ols.r2)
  const robust = ols(design.x, design.y!, design.names, { covariance: 'HC3' })
  robust.coefficients.forEach((coefficient, index) => close(coefficient.se, fixture.ols.hc3[index]!))
})

test('logistic regression matches SciPy maximum likelihood', () => {
  const design = buildDesign(frame, { target: 'yb', features: ['x1', 'x2'] })
  const result = logisticRegression(design.x, design.y!, design.names)
  result.coefficients.forEach((coefficient, index) => {
    close(coefficient.estimate, fixture.logit.beta[index]!, 1e-5)
    close(coefficient.se, fixture.logit.se[index]!, 1e-4)
  })
  close(result.fit.logLikelihood!, fixture.logit.ll, 1e-8)
  expect(result.coefficients[1]!.exponentiated!.label).toBe('odds ratio')
})

test('Poisson regression matches SciPy maximum likelihood', () => {
  const design = buildDesign(frame, { target: 'yc', features: ['x1', 'x2'] })
  const result = poissonRegression(design.x, design.y!, design.names)
  result.coefficients.forEach((coefficient, index) => {
    close(coefficient.estimate, fixture.poisson.beta[index]!, 1e-5)
    close(coefficient.se, fixture.poisson.se[index]!, 1e-4)
  })
  close(result.fit.logLikelihood!, fixture.poisson.ll, 1e-8)
})

test('negative binomial estimates overdispersion and flags it', () => {
  const rng = createRng(11)
  const x: number[][] = []
  const y: number[] = []
  for (let i = 0; i < 400; i++) {
    const x1 = rng.normal()
    const mu = Math.exp(1 + 0.5 * x1)
    // Gamma-Poisson mixture with shape 2 → α = 0.5
    let g = 0
    for (let k = 0; k < 2; k++) g -= Math.log(rng.next())
    const lambda = mu * (g / 2)
    let count = 0
    let p = Math.exp(-lambda)
    let s = p
    const u = rng.next()
    while (u > s && count < 1000) { count++; p *= lambda / count; s += p }
    x.push([1, x1])
    y.push(count)
  }
  const pois = poissonRegression(x, y, ['(Intercept)', 'x1'])
  expect(pois.assumptions[0]!.status).toBe('violated')
  const nb = negativeBinomialRegression(x, y, ['(Intercept)', 'x1'])
  expect(nb.fit.alpha!).toBeGreaterThan(0.3)
  expect(nb.fit.alpha!).toBeLessThan(0.8)
  expect(nb.coefficients[1]!.estimate).toBeGreaterThan(0.35)
  expect(nb.coefficients[1]!.estimate).toBeLessThan(0.65)
})

test('aliased columns are dropped and reported, the way R marks them', () => {
  const x = rows.map((row) => [1, row.x1, row.x1 * 2, row.x2])
  const result = ols(x, rows.map((row) => row.y), ['(Intercept)', 'x1', 'x1_twice', 'x2'])
  expect(result.aliased).toEqual(['x1_twice'])
  expect(result.coefficients.map((c) => c.term)).toEqual(['(Intercept)', 'x1', 'x2'])
})

test('Huber regression resists a gross outlier that drags OLS', () => {
  const x = Array.from({ length: 50 }, (_, i) => [1, i])
  const y = x.map(([, v]) => 2 + 0.5 * v!)
  y[49] = 500
  const names = ['(Intercept)', 'x']
  expect(Math.abs(ols(x, y, names).coefficients[1]!.estimate - 0.5)).toBeGreaterThan(1)
  expect(huberRegression(x, y, names).coefficients[1]!.estimate).toBeCloseTo(0.5, 3)
})

test('random-intercept model recovers the group variance share', () => {
  const rng = createRng(5)
  const x: number[][] = []
  const y: number[] = []
  const groups: string[] = []
  for (let g = 0; g < 30; g++) {
    const u = rng.normal(0, 2)
    for (let i = 0; i < 10; i++) {
      const v = rng.normal()
      x.push([1, v])
      y.push(1 + 3 * v + u + rng.normal(0, 1))
      groups.push(`g${g}`)
    }
  }
  const result = randomInterceptModel(x, y, ['(Intercept)', 'v'], groups)
  expect(result.coefficients[1]!.estimate).toBeCloseTo(3, 0)
  expect(result.fit.intraclassCorrelation!).toBeGreaterThan(0.6)
  expect(result.fit.intraclassCorrelation!).toBeLessThan(0.9)
})
