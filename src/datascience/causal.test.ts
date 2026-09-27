import { expect, test } from 'bun:test'
import { createRng } from './rng.ts'
import { analyzeAbTest, analyzeDag, designExperiment, differenceInDifferences, propensityAnalysis, regressionDiscontinuity, syntheticControl, twoStageLeastSquares } from './causal.ts'

test('A/B analysis reports lift with CIs, detects sample-ratio mismatch, and applies CUPED', () => {
  const ok = analyzeAbTest({ metricType: 'proportion', control: 'A', variants: [{ name: 'A', successes: 500, n: 10000 }, { name: 'B', successes: 600, n: 10050 }], minimumEffect: 0.005 })
  expect(ok.srm!.failed).toBe(false)
  expect(ok.results[0]!.significant).toBe(true)
  expect(ok.results[0]!.ci[0]).toBeGreaterThan(0)
  const broken = analyzeAbTest({ metricType: 'proportion', control: 'A', variants: [{ name: 'A', successes: 500, n: 10000 }, { name: 'B', successes: 520, n: 9000 }] })
  expect(broken.srm!.failed).toBe(true)
  expect(broken.interpretation[0]).toContain('SAMPLE RATIO MISMATCH')
  const rng = createRng(1)
  const make = (shift: number) => Array.from({ length: 400 }, () => { const pre = rng.normal(100, 20); return { pre, post: pre * 0.9 + shift + rng.normal(0, 5) } })
  const a = make(0)
  const b = make(2)
  const cuped = analyzeAbTest({ metricType: 'mean', control: 'A', variants: [{ name: 'A', values: a.map((r) => r.post), covariate: a.map((r) => r.pre) }, { name: 'B', values: b.map((r) => r.post), covariate: b.map((r) => r.pre) }] })
  expect(cuped.cuped!.varianceReduction).toBeGreaterThan(0.8)
  expect(cuped.results[0]!.significant).toBe(true)
})

test('experiment design gives the standard sample size and duration', () => {
  const plan = designExperiment({ metricType: 'proportion', baseline: 0.1, minimumEffect: 0.02, dailyTraffic: 1000 })
  expect(plan.perVariant as number).toBeGreaterThan(3800)
  expect(plan.perVariant as number).toBeLessThan(3900)
  expect(plan.days as number).toBe(Math.ceil((plan.total as number) / 1000))
})

test('difference-in-differences recovers a planted effect and flags non-parallel pre-trends', () => {
  const rng = createRng(2)
  const y: number[] = []; const treated: number[] = []; const post: number[] = []; const time: number[] = []; const clusters: string[] = []
  for (let unit = 0; unit < 60; unit++) for (let t = 0; t < 10; t++) {
    const tr = unit < 30 ? 1 : 0
    const p = t >= 5 ? 1 : 0
    y.push(10 + 2 * tr + 0.5 * t + 3 * tr * p + rng.normal(0, 1)); treated.push(tr); post.push(p); time.push(t); clusters.push(`u${unit}`)
  }
  const result = differenceInDifferences({ y, treated, post, time, clusters })
  expect(result.effect.estimate).toBeCloseTo(3, 0)
  expect(result.effect.ci[0]).toBeLessThan(3)
  expect(result.effect.ci[1]).toBeGreaterThan(3)
  expect(result.assumptions[0]!.status).toBe('met')
  const diverging = y.map((value, i) => value + (treated[i]! && !post[i] ? 0.8 * time[i]! : 0))
  expect(differenceInDifferences({ y: diverging, treated, post, time, clusters }).assumptions[0]!.status).toBe('violated')
})

test('propensity methods remove confounding that biases the naive difference', () => {
  const rng = createRng(3)
  const x: number[][] = []; const t: number[] = []; const y: number[] = []
  for (let i = 0; i < 1500; i++) {
    const age = rng.normal(0, 1); const income = rng.normal(0, 1)
    const treated = rng.next() < 1 / (1 + Math.exp(-(1.2 * age + 0.8 * income))) ? 1 : 0
    x.push([age, income]); t.push(treated); y.push(2 * treated + 3 * age + 2 * income + rng.normal(0, 1))
  }
  const naive = y.filter((_, i) => t[i] === 1).reduce((a, b) => a + b, 0) / t.filter((v) => v === 1).length - y.filter((_, i) => t[i] === 0).reduce((a, b) => a + b, 0) / t.filter((v) => v === 0).length
  expect(naive).toBeGreaterThan(3.5)
  const result = propensityAnalysis({ y, treated: t, x, names: ['age', 'income'], bootstrap: 100 })
  expect(result.aipw.estimate).toBeCloseTo(2, 0)
  expect(Math.abs(result.ate.estimate - 2)).toBeLessThan(0.6)
  expect(Math.abs(result.balance[0]!.smdWeighted)).toBeLessThan(Math.abs(result.balance[0]!.smdBefore))
})

test('regression discontinuity and 2SLS recover planted effects; weak instruments are flagged', () => {
  const rng = createRng(4)
  const running = Array.from({ length: 2000 }, () => rng.next() * 2 - 1)
  const y = running.map((r) => 1 + 0.8 * r + (r >= 0 ? 1.5 : 0) + rng.normal(0, 0.3))
  const rd = regressionDiscontinuity({ y, running, cutoff: 0 })
  expect(rd.effect.estimate).toBeCloseTo(1.5, 0)
  const z = Array.from({ length: 2000 }, () => rng.normal())
  const u = z.map(() => rng.normal())
  const xEndog = z.map((zi, i) => 0.8 * zi + u[i]! + rng.normal(0, 0.5))
  const out = xEndog.map((xi, i) => 2 * xi + 2 * u[i]! + rng.normal(0, 0.5))
  const iv = twoStageLeastSquares({ y: out, endogenous: xEndog, instruments: z.map((zi) => [zi]) })
  expect(iv.effect.estimate).toBeCloseTo(2, 0)
  expect(iv.olsEstimate).toBeGreaterThan(2.5)
  expect(iv.weakInstruments).toBe(false)
  const weak = twoStageLeastSquares({ y: out, endogenous: xEndog, instruments: z.map(() => [rng.normal()]) })
  expect(weak.weakInstruments).toBe(true)
})

test('synthetic control weights donors and DAG analysis finds adjustment sets and bad controls', () => {
  const rng = createRng(5)
  const donors: Record<string, number[]> = {}
  for (let d = 0; d < 6; d++) donors[`d${d}`] = Array.from({ length: 30 }, (_, t) => 10 + d + 0.3 * t + rng.normal(0, 0.2))
  const treated = donors.d1!.map((value, t) => 0.5 * value + 0.5 * donors.d3![t]! + (t >= 20 ? 4 : 0))
  const sc = syntheticControl({ treated, donors, preperiods: 20 })
  expect(sc.averagePostGap).toBeCloseTo(4, 0)
  expect(sc.placebo.rank).toBe(1)
  const dag = analyzeDag({ edges: [['age', 'treatment'], ['age', 'outcome'], ['treatment', 'engagement'], ['engagement', 'outcome']], treatment: 'treatment', outcome: 'outcome', controls: ['age', 'engagement'] })
  expect(dag.recommendedAdjustment).toEqual(['age'])
  expect(dag.badControls.map((b) => b.variable)).toEqual(['engagement'])
})
