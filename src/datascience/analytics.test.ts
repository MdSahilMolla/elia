import { expect, test } from 'bun:test'
import { frameFromRows } from './frame.ts'
import { createRng } from './rng.ts'
import { cohortRetention, customerLifetimeValue, funnel, kpiComparison, rfm, rootCause } from './business.ts'
import { erlangC, monteCarlo, simulateQueue } from './simulate.ts'
import { solveLp } from './opt.ts'
import { analyzeGraph, buildGraph, components, pageRank, shortestPath } from './graph.ts'
import { geoDbscan, haversineKm, moransI, nearest, pMedian, spatialJoin } from './geo.ts'
import { clusterDocuments, detectLanguage, extractEntities, extractiveSummary, keywords, search, sentiment, topics } from './text.ts'
import { evaluateRecommenders, type Interaction } from './recsys.ts'
import { bleu, compareModels, exactMatch, grounding, retrievalMetrics, rougeL, structuredOutputValidity, tokenF1 } from './genai.ts'

test('root cause drills into the segment that explains a revenue drop and splits volume from value', () => {
  const rng = createRng(1)
  const rows: Array<Record<string, string | number>> = []
  for (const month of ['2025-01', '2025-02']) for (const region of ['north', 'south', 'east']) for (const product of ['a', 'b']) for (let i = 0; i < 40; i++) {
    const drop = month === '2025-02' && region === 'south' && product === 'b'
    if (drop && i >= 10) continue
    rows.push({ month, region, product, order_id: `${month}-${region}-${product}-${i}`, revenue: 100 + rng.normal(0, 5) })
  }
  const frame = frameFromRows(rows)
  const result = rootCause(frame, { metric: { kind: 'sum', column: 'revenue' }, dimensions: ['region', 'product'], before: 'month == "2025-01"', after: 'month == "2025-02"', drivers: { count: 'order_id' } })
  expect(result.change).toBeLessThan(0)
  expect(result.levels[0]!.dimension).toBe('region')
  expect(result.levels[0]!.segments[0]!.segment).toBe('south')
  expect(result.levels[1]!.segments[0]!.segment).toBe('b')
  expect(result.driverDecomposition![0]!.shareOfChange).toBeGreaterThan(0.9)
  expect(result.hypotheses[0]).toContain('do not establish why')
})

test('cohorts, funnels, RFM, CLV, and KPI comparison produce consistent numbers', () => {
  const events = [
    { user: 'u1', date: '2025-01-05', amount: 50 }, { user: 'u1', date: '2025-02-10', amount: 30 }, { user: 'u2', date: '2025-01-20', amount: 20 },
    { user: 'u3', date: '2025-02-01', amount: 80 }, { user: 'u3', date: '2025-03-03', amount: 60 }, { user: 'u4', date: '2025-02-14', amount: 10 },
    { user: 'u5', date: '2025-03-20', amount: 200 }, { user: 'u1', date: '2025-03-15', amount: 40 },
  ]
  const frame = frameFromRows(events)
  const cohorts = cohortRetention(frame, { entity: 'user', time: 'date' })
  expect(cohorts.cohorts[0]).toMatchObject({ cohort: '2025-01-01', size: 2 })
  expect(cohorts.cohorts[0]!.retention.slice(0, 3)).toEqual([1, 0.5, 0.5])
  const f = funnel(frameFromRows([{ visit: true, cart: true, buy: true }, { visit: true, cart: true, buy: false }, { visit: true, cart: false, buy: true }, { visit: true, cart: false, buy: false }]), { steps: ['visit', 'cart', 'buy'] })
  expect(f.steps.map((s) => s.entities)).toEqual([4, 2, 1])
  expect(f.biggestDropOff!.from).toBe('visit')
  const r = rfm(frame, { customer: 'user', date: 'date', amount: 'amount' })
  expect(r.customers.find((c) => c.customer === 'u1')!.frequency).toBe(3)
  expect(customerLifetimeValue(frame, { customer: 'user', date: 'date', amount: 'amount' }).averageOrderValue).toBeCloseTo(61.25, 6)
  const k = kpiComparison(frame, { time: 'date', measures: [{ name: 'revenue', metric: { kind: 'sum', column: 'amount' } }] })
  expect(k.kpis[0]!.values).toEqual([70, 120, 300])
})

test('Monte Carlo is reproducible, finds the dominant driver, and the queue simulation matches Erlang C', () => {
  const spec = { variables: { units: { dist: 'normal', mean: 1000, sd: 100 }, price: { dist: 'triangular', min: 8, mode: 10, max: 12 }, cost: { dist: 'constant', value: 6 } }, outputs: { profit: 'units * (price - cost) - 2000' }, iterations: 20000, seed: 7 }
  const a = monteCarlo(spec)
  const b = monteCarlo(spec)
  expect(a.outputs.profit!.mean).toBe(b.outputs.profit!.mean)
  expect(a.outputs.profit!.mean).toBeGreaterThan(1800)
  expect(a.outputs.profit!.mean).toBeLessThan(2200)
  expect(a.sensitivity[0]!.variable).toBe('price')
  const analytic = erlangC(9, 1, 12)
  const sim = simulateQueue({ arrivalRate: 9, serviceRate: 1, servers: 12, duration: 20000, seed: 3 }) as { meanWait: number; utilization: number }
  expect(sim.utilization).toBeCloseTo(0.75, 1)
  expect(Math.abs(sim.meanWait - analytic.meanWait)).toBeLessThan(0.05)
})

test('LP matches the Wyndor textbook solution and shadow prices; MILP solves a knapsack', () => {
  const lp = solveLp({ sense: 'max', objective: { x: 3, y: 5 }, variables: [{ name: 'x' }, { name: 'y' }], constraints: [{ name: 'plant1', coefficients: { x: 1 }, sense: '<=', rhs: 4 }, { name: 'plant2', coefficients: { y: 2 }, sense: '<=', rhs: 12 }, { name: 'plant3', coefficients: { x: 3, y: 2 }, sense: '<=', rhs: 18 }] })
  expect(lp.status).toBe('optimal')
  expect(lp.objective).toBeCloseTo(36, 9)
  expect(lp.values).toEqual({ x: expect.closeTo(2, 9), y: expect.closeTo(6, 9) })
  expect(lp.constraints.map((c) => Number(c.shadowPrice!.toFixed(6)))).toEqual([0, 1.5, 1])
  const min = solveLp({ sense: 'min', objective: { a: 2, b: 3 }, variables: [{ name: 'a' }, { name: 'b' }], constraints: [{ coefficients: { a: 1, b: 1 }, sense: '>=', rhs: 10 }, { coefficients: { a: 1, b: -1 }, sense: '=', rhs: 2 }] })
  expect(min.objective).toBeCloseTo(24, 9)
  const knap = solveLp({ sense: 'max', objective: { a: 60, b: 100, c: 120 }, variables: [{ name: 'a', binary: true }, { name: 'b', binary: true }, { name: 'c', binary: true }], constraints: [{ coefficients: { a: 10, b: 20, c: 30 }, sense: '<=', rhs: 50 }] })
  expect(knap.objective).toBe(220)
  expect(knap.values).toEqual({ a: 0, b: 1, c: 1 })
  expect(solveLp({ sense: 'max', objective: { x: 1 }, variables: [{ name: 'x' }], constraints: [{ coefficients: { x: 1 }, sense: '>=', rhs: 5 }] }).status).toBe('unbounded')
  expect(solveLp({ sense: 'max', objective: { x: 1 }, variables: [{ name: 'x', upper: 3 }], constraints: [{ coefficients: { x: 1 }, sense: '>=', rhs: 5 }] }).status).toBe('infeasible')
})

test('graph analytics find planted communities, components, bridges, and shortest paths', () => {
  const edges: Array<{ source: string; target: string }> = []
  for (const group of ['a', 'b', 'c']) for (let i = 0; i < 8; i++) for (let j = i + 1; j < 8; j++) edges.push({ source: `${group}${i}`, target: `${group}${j}` })
  edges.push({ source: 'a0', target: 'hub' }, { source: 'b0', target: 'hub' }, { source: 'c0', target: 'hub' }, { source: 'x', target: 'y' })
  const graph = buildGraph(edges)
  const result = analyzeGraph(graph) as { communities: { count: number; modularity: number }; components: { count: number }; topBetweenness: Array<{ node: string }> }
  expect(result.communities.count).toBe(4)
  expect(result.communities.modularity).toBeGreaterThan(0.5)
  expect(result.components.count).toBe(2)
  expect(result.topBetweenness[0]!.node).toBe('hub')
  expect(shortestPath(graph, 'a3', 'c5')!.path).toEqual(['a3', 'a0', 'hub', 'c0', 'c5'])
  const directed = buildGraph([{ source: '1', target: '2' }, { source: '2', target: '3' }, { source: '3', target: '1' }, { source: '3', target: '4' }], true)
  expect(new Set(components(directed).strong).size).toBe(2)
  const pr = pageRank(directed)
  expect(pr.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 9)
})

test('geospatial distances, nearest assignment, clustering, joins, p-median, and Moran I', () => {
  expect(haversineKm({ lat: 51.5074, lon: -0.1278 }, { lat: 48.8566, lon: 2.3522 })).toBeCloseTo(343.5, 0)
  const stores = [{ id: 'london', lat: 51.5, lon: -0.12 }, { id: 'paris', lat: 48.85, lon: 2.35 }]
  expect(nearest([{ lat: 49, lon: 2 }], stores)[0]!.facility).toBe('paris')
  const rng = createRng(2)
  const points = [...Array.from({ length: 40 }, () => ({ lat: 51.5 + rng.normal(0, 0.02), lon: -0.12 + rng.normal(0, 0.02) })), ...Array.from({ length: 40 }, () => ({ lat: 48.85 + rng.normal(0, 0.02), lon: 2.35 + rng.normal(0, 0.02) }))]
  expect(geoDbscan(points, 10, 5).clusters).toHaveLength(2)
  const square = { type: 'FeatureCollection', features: [{ properties: { name: 'box' }, geometry: { type: 'Polygon', coordinates: [[[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]]] } }] }
  expect(spatialJoin([{ lat: 5, lon: 5 }, { lat: 20, lon: 5 }], square, 'name')).toEqual(['box', null])
  expect(pMedian(points, stores, 1).chosen).toHaveLength(1)
  const values = points.map((p) => (p.lat > 50 ? 10 : 0) + rng.normal(0, 1))
  expect(moransI(points, values, 50).pValue).toBeLessThan(0.001)
})

test('text analytics: language, sentiment with negation, keywords, topics, clustering, search, summaries, entities', () => {
  expect(detectLanguage('the product is great and the delivery was fast').language).toBe('en')
  expect(detectLanguage('el producto es muy bueno y la entrega fue rápida').language).toBe('es')
  expect(sentiment('I love it, excellent support').label).toBe('positive')
  expect(sentiment('this is not good at all').label).toBe('negative')
  const docs = ['battery life is short and the battery drains fast', 'battery drains overnight, poor battery', 'shipping was late and the courier lost the parcel', 'late shipping, courier never arrived', 'screen is bright and sharp', 'sharp bright screen colours']
  expect(keywords(docs, 3)[0]!.terms.map((t) => t.term)).toContain('battery')
  const t = topics(docs, 3, createRng(1))
  expect(t.topics).toHaveLength(3)
  expect(clusterDocuments(docs, 3, createRng(1)).clusters).toHaveLength(3)
  expect(search(docs, 'courier parcel')[0]!.index).toBe(2)
  expect(extractiveSummary('The model improved accuracy. It was trained on sales data. Accuracy improved by five points on the test set. The weather was nice. Sales data came from three regions.', 2).summary).toHaveLength(2)
  expect(extractEntities('Contact a@b.com, pay $1,200 by 2025-03-01 or 5% fee').money).toEqual(['$1,200'])
})

test('recommenders beat popularity on structured preferences and report ranking metrics', () => {
  const rng = createRng(3)
  const interactions: Interaction[] = []
  for (let u = 0; u < 120; u++) {
    const taste = u % 3
    for (let k = 0; k < 8; k++) interactions.push({ user: `u${u}`, item: `i${taste * 20 + rng.int(20)}`, weight: 1, time: k })
  }
  const result = evaluateRecommenders(interactions, { k: 10, methods: ['popularity', 'item_knn', 'als'] }) as { results: Array<Record<string, number | string>> }
  const byMethod = Object.fromEntries(result.results.map((r) => [r.method, r]))
  expect(byMethod.item_knn!['hitRate@10'] as number).toBeGreaterThan(byMethod.popularity!['hitRate@10'] as number)
  expect(byMethod.als!['ndcg@10'] as number).toBeGreaterThan(0)
})

test('LLM evaluation metrics behave like their reference definitions', () => {
  expect(exactMatch('The Eiffel Tower', 'eiffel tower')).toBe(1)
  expect(tokenF1('in the year 1889', '1889')).toBeCloseTo(0.5, 9)
  expect(rougeL('the cat sat on the mat', 'the cat is on the mat')).toBeCloseTo(0.8333, 3)
  expect(bleu('the cat sat on the mat', ['the cat sat on the mat'])).toBeCloseTo(1, 6)
  expect(grounding('Revenue grew 12% to 4,500 units', 'revenue rose 12% and reached 4500 units').unsupportedNumbers).toEqual([])
  expect(grounding('Revenue grew 15%', 'revenue rose 12%').unsupportedNumbers).toEqual(['15%'])
  expect(retrievalMetrics([{ retrieved: ['d2', 'd1'], relevant: ['d1'] }], 2).mrr).toBe(0.5)
  expect(structuredOutputValidity(['{"a":1}', 'nope', '{"a":"x"}'], { required: ['a'], types: { a: 'number' } }).schemaValid).toBeCloseTo(1 / 3, 9)
  const cmp = compareModels(Array.from({ length: 100 }, (_, i) => i < 60), Array.from({ length: 100 }, (_, i) => i < 80))
  expect(cmp.mcnemar.pValue).toBeLessThan(0.001)
})
