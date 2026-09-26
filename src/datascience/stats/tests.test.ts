import { expect, test } from 'bun:test'
import * as T from './tests.ts'

// Reference values from SciPy 1.18 (scipy.stats), pinned.
const a = [5.1, 4.9, 6.2, 5.8, 6.0, 5.5, 5.3, 6.1, 5.7, 4.8, 5.9, 6.3]
const b = [4.2, 4.8, 5.0, 4.6, 5.2, 4.4, 4.9, 5.1, 4.3, 4.7]
const c = [6.5, 6.9, 7.1, 6.2, 6.8, 7.4, 6.6]
const expo = [0.11, 0.3897, 1.3995, 2.2001, 0.3435, 0.2578, 0.4345, 0.1026, 1.001, 0.0663, 0.4513, 3.3476, 0.2665, 1.2853, 0.516, 2.0343, 0.9077, 1.4848, 0.2893, 0.1777, 0.0018, 1.165, 0.8944, 1.2162, 0.6536, 0.5746, 0.5898, 0.5839, 0.0414, 2.1569, 1.4144, 0.0656, 1.4574, 3.0614, 0.2057, 0.7747, 0.1281, 1.2297, 2.1273, 0.906, 1.3553, 1.1572, 0.7582, 1.7702, 0.3888, 2.0401, 4.4401, 0.1966, 2.3797, 0.7139, 0.5172, 0.2044, 3.1291, 0.1254, 1.466, 0.6121, 2.517, 1.1573, 4.2542, 0.2057]

function close(actual: number, expected: number, rel = 1e-6): void {
  if (expected === 0) expect(Math.abs(actual)).toBeLessThan(1e-12)
  else expect(Math.abs(actual - expected) / Math.abs(expected)).toBeLessThan(rel)
}

test('t tests match SciPy', () => {
  const one = T.oneSampleT(a, 5.0)
  close(one.statistic, 4.297646733022671)
  close(one.pValue, 0.0012609148939617294)
  const welch = T.twoSampleT(a, b)
  close(welch.statistic, 4.993763473782184)
  close(welch.pValue, 7.785031539624179e-05)
  close(welch.df as number, 19.23471570114401)
  close(welch.ci!.lower, 0.5308460507140588)
  const student = T.twoSampleT(a, b, { equalVariance: true })
  close(student.statistic, 4.81651465513711)
  close(student.pValue, 0.00010492188261365159)
  const paired = T.pairedT(a.slice(0, 10), b)
  close(paired.statistic, 5.5622522692474545)
  close(paired.pValue, 0.00035085657058984103)
})

test('rank tests match SciPy', () => {
  const mw = T.mannWhitney(a, b)
  close(mw.statistic, 110.5)
  close(mw.pValue, 0.0009678881070311847)
  close(T.mannWhitney(a, b, 'greater').pValue, 0.00048394405351559233)
  close(T.mannWhitney(a, b, 'less').pValue, 0.999618240856994)
  const exact = T.mannWhitney(a.slice(0, 5), b.slice(0, 6))
  close(exact.statistic, 27)
  close(exact.pValue, 0.030303030303030304)
  expect(exact.method).toBe('exact')
  const paired = T.wilcoxonSignedRank(a.slice(0, 10), b)
  close(paired.statistic, 0)
  close(paired.pValue, 0.001953125)
  const one = T.wilcoxonSignedRank([1.2, -0.4, 2.3, 0.8, 1.9, -0.2, 1.1, 0.5, 1.7, 0.9, 2.2, -0.7])
  close(one.statistic, 7)
  close(one.pValue, 0.00927734375)
})

test('k-sample tests match SciPy', () => {
  const groups = { a, b, c }
  const anova = T.oneWayAnova(groups)
  close(anova.statistic, 46.96535409076564)
  close(anova.pValue, 2.3364599846998185e-09, 1e-5)
  const kw = T.kruskalWallis(groups)
  close(kw.statistic, 21.451199868507555)
  close(kw.pValue, 2.197511383385497e-05)
  const lev = T.levene(groups)
  close(lev.statistic, 0.9884661373814496)
  close(lev.pValue, 0.38570239334979545)
  const bart = T.bartlett(groups)
  close(bart.statistic, 1.5172103397994452)
  close(bart.pValue, 0.46831919736522876)
})

test('categorical tests match SciPy', () => {
  const chi = T.chiSquareIndependence([[12, 5], [3, 15]])
  close(chi.statistic, 8.294866557734204)
  close(chi.pValue, 0.003975730158598368)
  const chi3 = T.chiSquareIndependence([[20, 15, 25], [30, 10, 20]])
  close(chi3.statistic, 3.5555555555555554)
  close(chi3.pValue, 0.16901331540606607)
  const fisher = T.fisherExact([[12, 5], [3, 15]])
  close(fisher.statistic, 12)
  close(fisher.pValue, 0.002045604763600604)
  close(T.fisherExact([[12, 5], [3, 15]], 'greater').pValue, 0.0016705723384641987)
  const gof = T.chiSquareGoodnessOfFit([18, 22, 30, 30])
  close(gof.statistic, 4.32)
  close(gof.pValue, 0.2289188643361048)
})

test('normality tests match SciPy', () => {
  const sw = T.shapiroWilk(a)
  close(sw.statistic, 0.9373708494530557)
  close(sw.pValue, 0.46478162450534866, 1e-4)
  const sw60 = T.shapiroWilk(expo)
  close(sw60.statistic, 0.8543071149118526)
  close(sw60.pValue, 4.091118385392936e-06, 1e-3)
  const sw5 = T.shapiroWilk([1.1, 2.3, 0.7, 1.9, 3.2])
  close(sw5.statistic, 0.9732359765681239)
  close(sw5.pValue, 0.8955876264159002, 1e-3)
  const k2 = T.dagostinoPearson(expo)
  close(k2.statistic, 20.205422300098498)
  close(k2.pValue, 4.096833322502086e-05)
  const jb = T.jarqueBera(expo)
  close(jb.statistic, 25.988309354476367)
  close(jb.pValue, 2.2735804525019843e-06)
})

test('correlation tests match SciPy', () => {
  const pr = T.correlationTest(a.slice(0, 10), b)
  close(pr.statistic, 0.44107678901125114)
  close(pr.pValue, 0.20195948600113145)
  close(pr.ci!.lower, -0.2610453381139719)
  const sp = T.correlationTest(a.slice(0, 10), b, 'spearman')
  close(sp.statistic, 0.5030303030303029)
  close(sp.pValue, 0.13833369839449194)
  const kd = T.correlationTest(a.slice(0, 10), b, 'kendall')
  close(kd.statistic, 0.3333333333333333)
  close(kd.pValue, 0.17971249487899976)
})

test('KS statistic matches SciPy and the p-value is small', () => {
  const ks = T.kolmogorovSmirnov2(a, b)
  close(ks.statistic, 0.75)
  expect(ks.pValue).toBeLessThan(0.01)
})

test('two-proportion z test reports a Newcombe interval that brackets the difference', () => {
  const result = T.twoProportionZ(120, 1000, 100, 1000)
  expect(result.estimate!.difference).toBeCloseTo(0.02, 12)
  expect(result.ci!.lower).toBeLessThan(0.02)
  expect(result.ci!.upper).toBeGreaterThan(0.02)
  expect(result.pValue).toBeGreaterThan(0.1)
  expect(result.pValue).toBeLessThan(0.2)
})

test('MANOVA detects separated group centroids', () => {
  const groups = {
    x: [[1, 2], [1.2, 2.1], [0.9, 1.8], [1.1, 2.3], [1.0, 2.0]],
    y: [[2, 3], [2.2, 3.1], [1.9, 2.9], [2.1, 3.3], [2.0, 3.0]],
    z: [[3, 1], [3.1, 1.2], [2.9, 0.9], [3.2, 1.1], [3.0, 1.0]],
  }
  const result = T.manova(groups)
  expect(result.pValue).toBeLessThan(1e-6)
  expect(result.statistic).toBeGreaterThan(1)
})
