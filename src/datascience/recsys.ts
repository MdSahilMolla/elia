import { createRng } from './rng.ts'
import { mean } from './stats/describe.ts'

/**
 * Recommender systems on user–item interactions: popularity, item-based collaborative
 * filtering, implicit-feedback matrix factorisation (ALS), and a hybrid blend, evaluated by
 * a per-user holdout with ranking metrics at k (precision, recall, MAP, NDCG, hit rate),
 * catalogue coverage, and intra-list diversity, with a cold-start breakdown.
 */

export interface Interaction { user: string; item: string; weight: number; time?: number }
export type RecommenderMethod = 'popularity' | 'item_knn' | 'als' | 'hybrid'

interface Model {
  method: RecommenderMethod
  recommend(user: string, k: number, exclude: Set<string>): string[]
}

function popularityModel(train: Interaction[]): Model & { ranking: string[] } {
  const counts = new Map<string, number>()
  for (const interaction of train) counts.set(interaction.item, (counts.get(interaction.item) ?? 0) + interaction.weight)
  const ranking = [...counts.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).map(([item]) => item)
  return { method: 'popularity', ranking, recommend: (_user, k, exclude) => ranking.filter((item) => !exclude.has(item)).slice(0, k) }
}

function itemKnnModel(train: Interaction[], neighbours = 50): Model {
  const byUser = new Map<string, Map<string, number>>()
  const byItem = new Map<string, Map<string, number>>()
  for (const { user, item, weight } of train) {
    byUser.set(user, (byUser.get(user) ?? new Map()).set(item, (byUser.get(user)?.get(item) ?? 0) + weight))
    byItem.set(item, (byItem.get(item) ?? new Map()).set(user, (byItem.get(item)?.get(user) ?? 0) + weight))
  }
  const norms = new Map([...byItem.entries()].map(([item, users]) => [item, Math.sqrt([...users.values()].reduce((t, w) => t + w * w, 0))]))
  const similarityCache = new Map<string, Array<[string, number]>>()
  const similar = (item: string) => {
    const cached = similarityCache.get(item)
    if (cached) return cached
    const scores = new Map<string, number>()
    for (const [user, w] of byItem.get(item) ?? []) for (const [other, w2] of byUser.get(user)!) if (other !== item) scores.set(other, (scores.get(other) ?? 0) + w * w2)
    const list = [...scores.entries()].map(([other, dot]) => [other, dot / ((norms.get(item) ?? 1) * (norms.get(other) ?? 1))] as [string, number]).sort((a, b) => b[1] - a[1]).slice(0, neighbours)
    similarityCache.set(item, list)
    return list
  }
  const fallback = popularityModel(train)
  return {
    method: 'item_knn',
    recommend(user, k, exclude) {
      const history = byUser.get(user)
      if (!history) return fallback.recommend(user, k, exclude)
      const scores = new Map<string, number>()
      for (const [item, w] of history) for (const [other, s] of similar(item)) if (!exclude.has(other) && !history.has(other)) scores.set(other, (scores.get(other) ?? 0) + s * w)
      const ranked = [...scores.entries()].sort((a, b) => b[1] - a[1]).map(([item]) => item)
      return [...ranked, ...fallback.recommend(user, k, new Set([...exclude, ...ranked, ...history.keys()]))].slice(0, k)
    },
  }
}

/** Implicit ALS (Hu, Koren & Volinsky 2008) with confidence 1 + α·weight. */
function alsModel(train: Interaction[], options: { factors?: number; regularization?: number; alpha?: number; iterations?: number; seed?: number } = {}): Model {
  const users = [...new Set(train.map((i) => i.user))]
  const items = [...new Set(train.map((i) => i.item))]
  if (users.length * items.length > 25_000_000) throw new Error('ALS here is dense in the item dimension; keep users × items under 25 million or sample')
  const f = options.factors ?? 16
  const lambda = options.regularization ?? 0.1
  const alpha = options.alpha ?? 20
  const rng = createRng(options.seed ?? 42)
  const ui = new Map(users.map((u, i) => [u, i]))
  const ii = new Map(items.map((it, i) => [it, i]))
  const userRows: Array<Array<[number, number]>> = users.map(() => [])
  const itemRows: Array<Array<[number, number]>> = items.map(() => [])
  for (const { user, item, weight } of train) { userRows[ui.get(user)!]!.push([ii.get(item)!, weight]); itemRows[ii.get(item)!]!.push([ui.get(user)!, weight]) }
  let X = users.map(() => Array.from({ length: f }, () => rng.normal(0, 0.1)))
  let Y = items.map(() => Array.from({ length: f }, () => rng.normal(0, 0.1)))
  const solveFactors = (fixed: number[][], rows: Array<Array<[number, number]>>) => {
    const YtY = Array.from({ length: f }, (_, a) => Array.from({ length: f }, (_, b) => fixed.reduce((t, v) => t + v[a]! * v[b]!, 0)))
    return rows.map((entries) => {
      const A = YtY.map((row, a) => row.map((value, b) => value + (a === b ? lambda : 0)))
      const rhs = new Array<number>(f).fill(0)
      for (const [j, weight] of entries) {
        const c = 1 + alpha * weight
        const y = fixed[j]!
        for (let a = 0; a < f; a++) { rhs[a]! += c * y[a]!; for (let b = 0; b < f; b++) A[a]![b]! += (c - 1) * y[a]! * y[b]! }
      }
      return gaussSolve(A, rhs)
    })
  }
  for (let iteration = 0; iteration < (options.iterations ?? 10); iteration++) {
    X = solveFactors(Y, userRows)
    Y = solveFactors(X, itemRows)
  }
  const fallback = popularityModel(train)
  return {
    method: 'als',
    recommend(user, k, exclude) {
      const u = ui.get(user)
      if (u === undefined) return fallback.recommend(user, k, exclude)
      const seen = new Set(userRows[u]!.map(([j]) => items[j]!))
      return items.map((item, j) => ({ item, score: X[u]!.reduce((t, v, a) => t + v * Y[j]![a]!, 0) })).filter((entry) => !seen.has(entry.item) && !exclude.has(entry.item)).sort((a, b) => b.score - a.score).slice(0, k).map((entry) => entry.item)
    },
  }
}

function gaussSolve(A: number[][], b: number[]): number[] {
  const n = b.length
  const m = A.map((row, i) => [...row, b[i]!])
  for (let c = 0; c < n; c++) {
    let p = c
    for (let r = c + 1; r < n; r++) if (Math.abs(m[r]![c]!) > Math.abs(m[p]![c]!)) p = r
    ;[m[c], m[p]] = [m[p]!, m[c]!]
    const pivot = m[c]![c]! || 1e-12
    for (let r = c + 1; r < n; r++) { const factor = m[r]![c]! / pivot; for (let k = c; k <= n; k++) m[r]![k]! -= factor * m[c]![k]! }
  }
  const x = new Array<number>(n).fill(0)
  for (let r = n - 1; r >= 0; r--) { let s = m[r]![n]!; for (let k = r + 1; k < n; k++) s -= m[r]![k]! * x[k]!; x[r] = s / (m[r]![r]! || 1e-12) }
  return x
}

function hybridModel(train: Interaction[], seed: number): Model {
  const knn = itemKnnModel(train)
  const pop = popularityModel(train)
  let als: Model | undefined
  try { als = alsModel(train, { seed }) } catch { als = undefined }
  return {
    method: 'hybrid',
    recommend(user, k, exclude) {
      const scores = new Map<string, number>()
      const add = (list: string[], weight: number) => list.forEach((item, rank) => scores.set(item, (scores.get(item) ?? 0) + weight / (rank + 1)))
      add(knn.recommend(user, 3 * k, exclude), 0.5)
      if (als) add(als.recommend(user, 3 * k, exclude), 0.4)
      add(pop.recommend(user, 3 * k, exclude), 0.1)
      return [...scores.entries()].sort((a, b) => b[1] - a[1]).slice(0, k).map(([item]) => item)
    },
  }
}

export function buildRecommender(method: RecommenderMethod, train: Interaction[], seed = 42): Model {
  if (method === 'popularity') return popularityModel(train)
  if (method === 'item_knn') return itemKnnModel(train)
  if (method === 'als') return alsModel(train, { seed })
  return hybridModel(train, seed)
}

export function evaluateRecommenders(interactions: Interaction[], options: { k?: number; methods?: RecommenderMethod[]; seed?: number; holdoutPerUser?: number; itemFeatures?: Map<string, string> } = {}): Record<string, unknown> {
  const k = options.k ?? 10
  const seed = options.seed ?? 42
  const rng = createRng(seed)
  const byUser = new Map<string, Interaction[]>()
  for (const interaction of interactions) byUser.set(interaction.user, [...(byUser.get(interaction.user) ?? []), interaction])
  const train: Interaction[] = []
  const test = new Map<string, Set<string>>()
  const historyLength = new Map<string, number>()
  const hasTime = interactions.every((interaction) => interaction.time !== undefined)
  for (const [user, rows] of byUser) {
    if (rows.length < 3) { train.push(...rows); continue }
    const ordered = hasTime ? [...rows].sort((a, b) => a.time! - b.time!) : rng.shuffle(rows)
    const holdout = ordered.slice(-(options.holdoutPerUser ?? 1))
    train.push(...ordered.slice(0, ordered.length - holdout.length))
    test.set(user, new Set(holdout.map((row) => row.item)))
    historyLength.set(user, ordered.length - holdout.length)
  }
  if (test.size < 10) throw new Error('evaluation needs at least 10 users with 3 or more interactions')
  const catalogue = new Set(interactions.map((i) => i.item))
  const seenByUser = new Map<string, Set<string>>()
  for (const row of train) { const set = seenByUser.get(row.user) ?? new Set<string>(); set.add(row.item); seenByUser.set(row.user, set) }
  const results = (options.methods ?? ['popularity', 'item_knn', 'als', 'hybrid']).map((method) => {
    let model: Model
    try { model = buildRecommender(method, train, seed) } catch (error) { return { method, failed: (error as Error).message } }
    const precision: number[] = []; const recall: number[] = []; const ap: number[] = []; const ndcg: number[] = []; const hits: number[] = []
    const recommended = new Set<string>()
    const diversity: number[] = []
    const coldHits: number[] = []
    for (const [user, relevant] of test) {
      const seen = seenByUser.get(user) ?? new Set<string>()
      const list = model.recommend(user, k, seen)
      list.forEach((item) => recommended.add(item))
      let hitCount = 0
      let apSum = 0
      let dcg = 0
      list.forEach((item, rank) => { if (relevant.has(item)) { hitCount++; apSum += hitCount / (rank + 1); dcg += 1 / Math.log2(rank + 2) } })
      const idcg = Array.from({ length: Math.min(relevant.size, k) }, (_, rank) => 1 / Math.log2(rank + 2)).reduce((a, b) => a + b, 0)
      precision.push(hitCount / k)
      recall.push(hitCount / relevant.size)
      ap.push(apSum / Math.min(relevant.size, k))
      ndcg.push(idcg ? dcg / idcg : 0)
      hits.push(hitCount > 0 ? 1 : 0)
      if ((historyLength.get(user) ?? 0) <= 3) coldHits.push(hitCount > 0 ? 1 : 0)
      if (options.itemFeatures && list.length > 1) {
        let pairs = 0; let different = 0
        for (let a = 0; a < list.length; a++) for (let b = a + 1; b < list.length; b++) { pairs++; if (options.itemFeatures.get(list[a]!) !== options.itemFeatures.get(list[b]!)) different++ }
        diversity.push(different / pairs)
      }
    }
    return { method, [`precision@${k}`]: mean(precision), [`recall@${k}`]: mean(recall), [`map@${k}`]: mean(ap), [`ndcg@${k}`]: mean(ndcg), [`hitRate@${k}`]: mean(hits), coverage: recommended.size / catalogue.size, ...(diversity.length ? { intraListDiversity: mean(diversity) } : {}), coldStartHitRate: coldHits.length ? mean(coldHits) : null, coldStartUsers: coldHits.length }
  })
  return {
    k,
    split: hasTime ? `each user's most recent ${options.holdoutPerUser ?? 1} interaction(s) held out (time-aware)` : `a random ${options.holdoutPerUser ?? 1} interaction(s) per user held out`,
    users: byUser.size,
    evaluatedUsers: test.size,
    items: catalogue.size,
    trainInteractions: train.length,
    results: results.sort((a, b) => (((b as Record<string, unknown>)[`ndcg@${k}`] as number | undefined) ?? -1) - (((a as Record<string, unknown>)[`ndcg@${k}`] as number | undefined) ?? -1)),
    notes: ['Offline ranking metrics measure how well past behaviour is reproduced; they do not measure the causal effect of showing recommendations — that needs an online experiment.', 'Cold-start users (≤ 3 training interactions) fall back to popularity where a model has no signal.'],
  }
}
