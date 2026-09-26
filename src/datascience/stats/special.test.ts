import { expect, test } from 'bun:test'
import * as special from './special.ts'

// Reference values from SciPy 1.18 (scipy.special / scipy.stats), generated once and pinned here.
const REFERENCE: Array<[string, number]> = [
  ['logGamma(0.5)', 0.5723649429247],
  ['logGamma(10.3)', 13.482036786138359],
  ['logGamma(1e-3)', 6.907178885383853],
  ['logGamma(171.2)', 707.60092684767],
  ['regularizedBeta(0.3,2.5,4)', 0.3521975859067672],
  ['regularizedBeta(0.999,0.5,30)', 1.0],
  ['regularizedBeta(0.01,50,0.5)', 7.998227417904834e-102],
  ['regularizedGammaP(3.5,2)', 0.22022259152428406],
  ['regularizedGammaQ(10,25)', 0.0002214766382487833],
  ['regularizedGammaP(0.5,0.001)', 0.035670591729679894],
  ['erf(0.7)', 0.6778011938374184],
  ['erfc(4.5)', 1.9661604415428876e-10],
  ['normalCdf(-1.96)', 0.024997895148220435],
  ['normalCdf(-8)', 6.22096057427174e-16],
  ['normalCdf(2.5)', 0.9937903346742238],
  ['normalQuantile(0.975)', 1.959963984540054],
  ['normalQuantile(1e-10)', -6.361340902404056],
  ['normalQuantile(0.3)', -0.5244005127080409],
  ['tCdf(2.1,7)', 0.9630644018935387],
  ['tCdf(-3.5,2.5)', 0.026172773480160175],
  ['tCdf(0.3,300)', 0.6178075405859293],
  ['tQuantile(0.975,10)', 2.228138851986274],
  ['tQuantile(0.995,3)', 5.840909309733355],
  ['tQuantile(0.025,1)', -12.706204736174705],
  ['tQuantile(0.9,1000)', 1.2823987214609243],
  ['chiSquareSf(11.07,5)', 0.05000961862240546],
  ['chiSquareCdf(0.5,1)', 0.5204998778130466],
  ['chiSquareQuantile(0.95,3)', 7.8147279032511765],
  ['chiSquareSf(150,100)', 0.0009039320423540184],
  ['fSf(3.2,2,27)', 0.056602226408500815],
  ['fCdf(1.5,5,10)', 0.7267134845242299],
  ['fQuantile(0.95,3,40)', 2.8387453980206403],
  ['betaQuantile(0.025,3,8)', 0.06673951117773447],
  ['binomialCdf(3,10,0.4)', 0.3822806015999999],
  ['binomialPmf(3,10,0.4)', 0.21499084799999982],
  ['poissonCdf(4,2.5)', 0.8911780189141513],
  ['noncentralTCdf(2.0,20,1.5)', 0.6746299141380349],
  ['noncentralTCdf(-1.0,8,0.5)', 0.07672309311130018],
  ['noncentralTCdf(1.97,98,2.8)', 0.2041458271748968],
  ['noncentralChiSquareCdf(10,4,3)', 0.7837631816817807],
  ['noncentralFCdf(3.0,3,40,8)', 0.42500456111473184],
  ['kolmogorovSf(1.2)', 0.11224966667072497],
]

for (const [call, expected] of REFERENCE) {
  test(`${call} matches SciPy`, () => {
    const match = /^(\w+)\((.*)\)$/.exec(call)!
    const fn = (special as unknown as Record<string, (...args: number[]) => number>)[match[1]!]!
    const actual = fn(...match[2]!.split(',').map(Number))
    if (expected === 0 || Math.abs(expected) < 1e-300) expect(Math.abs(actual)).toBeLessThan(1e-300)
    else expect(Math.abs(actual - expected) / Math.abs(expected)).toBeLessThan(1e-8)
  })
}

test('brent finds a bracketed root and refuses an unbracketed one', () => {
  expect(special.brent((x) => x * x - 2, 0, 2)).toBeCloseTo(Math.SQRT2, 12)
  expect(() => special.brent((x) => x * x + 1, 0, 2)).toThrow(/bracketed/)
})

test('two-sided t p-value agrees with twice the tail', () => {
  expect(special.tPValue(2.1, 7)).toBeCloseTo(2 * (1 - 0.9630644018935387), 12)
  expect(special.tPValue(2.1, 7, 'greater')).toBeCloseTo(1 - 0.9630644018935387, 12)
})
