import type { Rng } from '../rng.ts'
import { mean, median, standardDeviation } from '../stats/describe.ts'
import { chiSquareSf } from '../stats/special.ts'
import { inverseSPD, symmetricEigen } from '../stats/linalg.ts'

/**
 * Unsupervised learning on a standardized numeric matrix: clustering, dimensionality
 * reduction, and anomaly detection. Every method that samples is seeded; methods with
 * quadratic cost state and enforce their size limits instead of hanging.
 */

function sq(a: number[], b: number[]): number {
  let total = 0
  for (let index = 0; index < a.length; index++) {
    const d = a[index]! - b[index]!
    total += d * d
  }
  return total
}

// ================================================================ k-means

export interface KMeansResult {
  k: number
  labels: number[]
  centroids: number[][]
  inertia: number
  sizes: number[]
  iterations: number
}

export function kMeans(x: number[][], k: number, rng: Rng, options: { nInit?: number; maxIterations?: number } = {}): KMeansResult {
  const n = x.length
  if (k < 1 || k > n) throw new Error(`k must be between 1 and the number of rows (${n})`)
  let best: KMeansResult | undefined
  for (let run = 0; run < (options.nInit ?? 5); run++) {
    const runRng = rng.fork(run)
    const centroids: number[][] = [[...x[runRng.int(n)]!]]
    const distances = x.map((row) => sq(row, centroids[0]!))
    while (centroids.length < k) {
      const total = distances.reduce((a, b) => a + b, 0)
      let target = runRng.next() * total
      let chosen = n - 1
      for (let index = 0; index < n; index++) {
        target -= distances[index]!
        if (target <= 0) { chosen = index; break }
      }
      centroids.push([...x[chosen]!])
      x.forEach((row, index) => { distances[index] = Math.min(distances[index]!, sq(row, centroids.at(-1)!)) })
    }
    const labels = new Array<number>(n).fill(0)
    let iterations = 0
    for (; iterations < (options.maxIterations ?? 300); iterations++) {
      let changed = 0
      x.forEach((row, index) => {
        let bestCluster = 0
        let bestDistance = Number.POSITIVE_INFINITY
        centroids.forEach((centroid, c) => { const d = sq(row, centroid); if (d < bestDistance) { bestDistance = d; bestCluster = c } })
        if (labels[index] !== bestCluster || iterations === 0) { if (labels[index] !== bestCluster) changed++; labels[index] = bestCluster }
      })
      const sums = centroids.map((centroid) => centroid.map(() => 0))
      const counts = new Array<number>(k).fill(0)
      x.forEach((row, index) => { counts[labels[index]!]!++; row.forEach((value, j) => { sums[labels[index]!]![j]! += value }) })
      counts.forEach((count, c) => { if (count > 0) centroids[c] = sums[c]!.map((value) => value / count); else centroids[c] = [...x[runRng.int(n)]!] })
      if (changed === 0 && iterations > 0) break
    }
    const inertia = x.reduce((total, row, index) => total + sq(row, centroids[labels[index]!]!), 0)
    if (!best || inertia < best.inertia) best = { k, labels, centroids, inertia, sizes: Array.from({ length: k }, (_, c) => labels.filter((label) => label === c).length), iterations }
  }
  return best!
}

/** Mean silhouette coefficient, on a seeded sample of at most `sample` rows for large data. */
export function silhouette(x: number[][], labels: number[], rng: Rng, sample = 2000): number {
  const indices = x.length > sample ? rng.shuffle(Array.from({ length: x.length }, (_, index) => index)).slice(0, sample) : Array.from({ length: x.length }, (_, index) => index)
  const clusters = [...new Set(labels.filter((label) => label >= 0))]
  if (clusters.length < 2) return Number.NaN
  const scores: number[] = []
  for (const i of indices) {
    if (labels[i]! < 0) continue
    const sums = new Map<number, { total: number; count: number }>()
    for (const j of indices) {
      if (i === j || labels[j]! < 0) continue
      const entry = sums.get(labels[j]!) ?? { total: 0, count: 0 }
      entry.total += Math.sqrt(sq(x[i]!, x[j]!))
      entry.count++
      sums.set(labels[j]!, entry)
    }
    const own = sums.get(labels[i]!)
    if (!own || own.count === 0) continue
    const a = own.total / own.count
    let b = Number.POSITIVE_INFINITY
    for (const [cluster, entry] of sums) if (cluster !== labels[i]) b = Math.min(b, entry.total / entry.count)
    scores.push((b - a) / Math.max(a, b))
  }
  return scores.length ? mean(scores) : Number.NaN
}

// ================================================================ DBSCAN

export function dbscan(x: number[][], eps: number, minPoints: number): { labels: number[]; clusters: number; noise: number } {
  const n = x.length
  if (n > 20_000) throw new Error('DBSCAN here is exact O(n²); sample to at most 20,000 rows first')
  const eps2 = eps * eps
  const labels = new Array<number>(n).fill(-2)
  let cluster = -1
  const neighbours = (i: number) => {
    const out: number[] = []
    for (let j = 0; j < n; j++) if (sq(x[i]!, x[j]!) <= eps2) out.push(j)
    return out
  }
  for (let i = 0; i < n; i++) {
    if (labels[i] !== -2) continue
    const seeds = neighbours(i)
    if (seeds.length < minPoints) { labels[i] = -1; continue }
    cluster++
    labels[i] = cluster
    const queue = [...seeds]
    while (queue.length) {
      const j = queue.pop()!
      if (labels[j] === -1) labels[j] = cluster
      if (labels[j] !== -2) continue
      labels[j] = cluster
      const more = neighbours(j)
      if (more.length >= minPoints) queue.push(...more)
    }
  }
  return { labels, clusters: cluster + 1, noise: labels.filter((label) => label === -1).length }
}

/** Heuristic eps: the knee of the sorted k-distance curve (k = minPoints), on a sample. */
export function suggestEps(x: number[][], minPoints: number, rng: Rng): number {
  const sample = x.length > 2000 ? rng.shuffle(x).slice(0, 2000) : x
  const kth = sample.map((row) => sample.map((other) => Math.sqrt(sq(row, other))).sort((a, b) => a - b)[Math.min(minPoints, sample.length - 1)]!).sort((a, b) => a - b)
  const first = kth[0]!
  const last = kth.at(-1)!
  let bestIndex = 0
  let bestDistance = -1
  kth.forEach((value, index) => {
    const t = index / Math.max(1, kth.length - 1)
    const distance = Math.abs(value - (first + t * (last - first)))
    if (distance > bestDistance) { bestDistance = distance; bestIndex = index }
  })
  return kth[bestIndex]!
}

// ================================================================ hierarchical (Ward)

export function wardHierarchical(x: number[][], k: number): { labels: number[]; merges: Array<{ a: number; b: number; distance: number; size: number }> } {
  const n = x.length
  if (n > 3000) throw new Error('hierarchical clustering here needs O(n²) memory; sample to at most 3,000 rows first')
  let clusters = x.map((row, index) => ({ id: index, centroid: [...row], size: 1, members: [index] }))
  const merges: Array<{ a: number; b: number; distance: number; size: number }> = []
  let nextId = n
  while (clusters.length > k) {
    let bestI = 0
    let bestJ = 1
    let best = Number.POSITIVE_INFINITY
    for (let i = 0; i < clusters.length; i++) {
      for (let j = i + 1; j < clusters.length; j++) {
        const a = clusters[i]!
        const b = clusters[j]!
        const cost = ((a.size * b.size) / (a.size + b.size)) * sq(a.centroid, b.centroid)
        if (cost < best) { best = cost; bestI = i; bestJ = j }
      }
    }
    const a = clusters[bestI]!
    const b = clusters[bestJ]!
    const size = a.size + b.size
    const merged = { id: nextId++, centroid: a.centroid.map((value, j) => (value * a.size + b.centroid[j]! * b.size) / size), size, members: [...a.members, ...b.members] }
    merges.push({ a: a.id, b: b.id, distance: Math.sqrt(2 * best), size })
    clusters = clusters.filter((_, index) => index !== bestI && index !== bestJ)
    clusters.push(merged)
  }
  const labels = new Array<number>(n).fill(0)
  clusters.forEach((cluster, c) => cluster.members.forEach((member) => { labels[member] = c }))
  return { labels, merges: merges.slice(-20) }
}

// ================================================================ Gaussian mixture (diagonal)

export function gaussianMixture(x: number[][], k: number, rng: Rng, maxIterations = 200): { labels: number[]; weights: number[]; means: number[][]; variances: number[][]; logLikelihood: number; bic: number; probabilities: number[][] } {
  const n = x.length
  const d = x[0]!.length
  const init = kMeans(x, k, rng, { nInit: 3 })
  let means = init.centroids.map((c) => [...c])
  let variances = means.map((_, c) => Array.from({ length: d }, (_, j) => {
    const members = x.filter((_, index) => init.labels[index] === c).map((row) => row[j]!)
    return members.length > 1 ? Math.max(1e-6, standardDeviation(members) ** 2) : 1
  }))
  let weights = init.sizes.map((size) => Math.max(size, 1) / n)
  let responsibilities: number[][] = []
  let logLikelihood = Number.NEGATIVE_INFINITY
  for (let iteration = 0; iteration < maxIterations; iteration++) {
    let total = 0
    responsibilities = x.map((row) => {
      const logs = weights.map((w, c) => Math.log(w) + row.reduce((acc, value, j) => acc - 0.5 * Math.log(2 * Math.PI * variances[c]![j]!) - (value - means[c]![j]!) ** 2 / (2 * variances[c]![j]!), 0))
      const max = Math.max(...logs)
      const sum = logs.reduce((acc, value) => acc + Math.exp(value - max), 0)
      total += max + Math.log(sum)
      return logs.map((value) => Math.exp(value - max) / sum)
    })
    const nk = weights.map((_, c) => responsibilities.reduce((acc, r) => acc + r[c]!, 0) + 1e-10)
    weights = nk.map((value) => value / n)
    means = nk.map((count, c) => Array.from({ length: d }, (_, j) => x.reduce((acc, row, index) => acc + responsibilities[index]![c]! * row[j]!, 0) / count))
    variances = nk.map((count, c) => Array.from({ length: d }, (_, j) => Math.max(1e-6, x.reduce((acc, row, index) => acc + responsibilities[index]![c]! * (row[j]! - means[c]![j]!) ** 2, 0) / count)))
    if (Math.abs(total - logLikelihood) < 1e-6 * Math.abs(total)) { logLikelihood = total; break }
    logLikelihood = total
  }
  const parameters = k * 2 * d + (k - 1)
  return { labels: responsibilities.map((r) => r.indexOf(Math.max(...r))), weights, means, variances, logLikelihood, bic: -2 * logLikelihood + parameters * Math.log(n), probabilities: responsibilities }
}

// ================================================================ spectral clustering

export function spectralClustering(x: number[][], k: number, rng: Rng): { labels: number[]; gamma: number } {
  const n = x.length
  if (n > 1500) throw new Error('spectral clustering here builds a dense n×n affinity; sample to at most 1,500 rows first')
  const distances = x.map((row) => x.map((other) => sq(row, other)))
  const gamma = 1 / Math.max(1e-12, median(distances.flat().filter((value) => value > 0)))
  const affinity = distances.map((row) => row.map((value) => Math.exp(-gamma * value)))
  const degree = affinity.map((row) => row.reduce((a, b) => a + b, 0))
  const normalized = affinity.map((row, i) => row.map((value, j) => value / Math.sqrt(degree[i]! * degree[j]!)))
  const { vectors } = symmetricEigen(normalized, 60)
  const embedding = Array.from({ length: n }, (_, i) => {
    const row = vectors.slice(0, k).map((vector) => vector[i]!)
    const norm = Math.sqrt(row.reduce((a, b) => a + b * b, 0)) || 1
    return row.map((value) => value / norm)
  })
  return { labels: kMeans(embedding, k, rng).labels, gamma }
}

// ================================================================ PCA, t-SNE, NMF

export interface PcaResult {
  explainedVariance: number[]
  explainedVarianceRatio: number[]
  components: number[][]
  scores: number[][]
}

/** PCA on an already standardized matrix (so it is a correlation-matrix PCA). */
export function pca(x: number[][], components: number): PcaResult {
  const n = x.length
  const d = x[0]!.length
  const means = Array.from({ length: d }, (_, j) => mean(x.map((row) => row[j]!)))
  const centered = x.map((row) => row.map((value, j) => value - means[j]!))
  const covariance = Array.from({ length: d }, (_, i) => Array.from({ length: d }, (_, j) => centered.reduce((total, row) => total + row[i]! * row[j]!, 0) / Math.max(1, n - 1)))
  const { values, vectors } = symmetricEigen(covariance)
  const total = values.reduce((a, b) => a + Math.max(0, b), 0) || 1
  const keep = Math.min(components, d)
  return {
    explainedVariance: values.slice(0, keep),
    explainedVarianceRatio: values.slice(0, keep).map((value) => Math.max(0, value) / total),
    components: vectors.slice(0, keep),
    scores: centered.map((row) => vectors.slice(0, keep).map((vector) => row.reduce((acc, value, j) => acc + value * vector[j]!, 0))),
  }
}

/** Exact t-SNE (van der Maaten 2008) for up to 2,000 rows, seeded. */
export function tsne(x: number[][], rng: Rng, options: { perplexity?: number; iterations?: number; dimensions?: number } = {}): number[][] {
  const n = x.length
  if (n > 2000) throw new Error('t-SNE here is exact O(n²) per iteration; sample to at most 2,000 rows first')
  const perplexity = Math.min(options.perplexity ?? 30, Math.max(2, (n - 1) / 3))
  const dims = options.dimensions ?? 2
  const iterations = options.iterations ?? 750
  const d2 = x.map((row) => x.map((other) => sq(row, other)))
  const P = Array.from({ length: n }, () => new Array<number>(n).fill(0))
  const target = Math.log(perplexity)
  for (let i = 0; i < n; i++) {
    let lo = 1e-20
    let hi = 1e20
    let beta = 1
    for (let step = 0; step < 60; step++) {
      let sum = 0
      let entropy = 0
      for (let j = 0; j < n; j++) {
        if (i === j) continue
        const value = Math.exp(-d2[i]![j]! * beta)
        P[i]![j] = value
        sum += value
      }
      for (let j = 0; j < n; j++) {
        if (i === j) continue
        P[i]![j]! /= sum || 1e-300
        if (P[i]![j]! > 1e-300) entropy -= P[i]![j]! * Math.log(P[i]![j]!)
      }
      if (Math.abs(entropy - target) < 1e-5) break
      if (entropy > target) { lo = beta; beta = hi === 1e20 ? beta * 2 : (beta + hi) / 2 }
      else { hi = beta; beta = lo === 1e-20 ? beta / 2 : (beta + lo) / 2 }
    }
  }
  for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) { const value = Math.max((P[i]![j]! + P[j]![i]!) / (2 * n), 1e-12); P[i]![j] = value; P[j]![i] = value }
  const Y = Array.from({ length: n }, () => Array.from({ length: dims }, () => rng.normal(0, 1e-4)))
  const gains = Y.map((row) => row.map(() => 1))
  const velocity = Y.map((row) => row.map(() => 0))
  for (let iteration = 0; iteration < iterations; iteration++) {
    const exaggeration = iteration < 250 ? 12 : 1
    const momentum = iteration < 250 ? 0.5 : 0.8
    const num = Y.map((row) => Y.map((other) => 1 / (1 + sq(row, other))))
    let sumQ = 0
    for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) if (i !== j) sumQ += num[i]![j]!
    for (let i = 0; i < n; i++) {
      const gradient = new Array<number>(dims).fill(0)
      for (let j = 0; j < n; j++) {
        if (i === j) continue
        const q = num[i]![j]! / sumQ
        const force = 4 * (exaggeration * P[i]![j]! - q) * num[i]![j]!
        for (let k = 0; k < dims; k++) gradient[k]! += force * (Y[i]![k]! - Y[j]![k]!)
      }
      for (let k = 0; k < dims; k++) {
        gains[i]![k] = Math.sign(gradient[k]!) !== Math.sign(velocity[i]![k]!) ? gains[i]![k]! + 0.2 : Math.max(0.01, gains[i]![k]! * 0.8)
        velocity[i]![k] = momentum * velocity[i]![k]! - 200 * gains[i]![k]! * gradient[k]!
        Y[i]![k]! += velocity[i]![k]!
      }
    }
  }
  return Y
}

/** Non-negative matrix factorisation X ≈ W·H by Lee–Seung multiplicative updates. */
export function nmf(x: number[][], components: number, rng: Rng, iterations = 300): { W: number[][]; H: number[][]; reconstructionError: number } {
  if (x.some((row) => row.some((value) => value < 0))) throw new Error('NMF needs non-negative data (do not standardize; use raw counts or amounts)')
  const n = x.length
  const d = x[0]!.length
  const scale = Math.sqrt(mean(x.flat()) / components) || 1
  let W = Array.from({ length: n }, () => Array.from({ length: components }, () => rng.next() * scale))
  let H = Array.from({ length: components }, () => Array.from({ length: d }, () => rng.next() * scale))
  const product = (a: number[][], b: number[][]) => a.map((row) => b[0]!.map((_, j) => row.reduce((acc, value, k) => acc + value * b[k]![j]!, 0)))
  const transpose = (a: number[][]) => a[0]!.map((_, j) => a.map((row) => row[j]!))
  for (let iteration = 0; iteration < iterations; iteration++) {
    const WT = transpose(W)
    const numH = product(WT, x)
    const denH = product(product(WT, W), H)
    H = H.map((row, i) => row.map((value, j) => value * numH[i]![j]! / (denH[i]![j]! + 1e-12)))
    const HT = transpose(H)
    const numW = product(x, HT)
    const denW = product(W, product(H, HT))
    W = W.map((row, i) => row.map((value, j) => value * numW[i]![j]! / (denW[i]![j]! + 1e-12)))
  }
  const approx = product(W, H)
  const error = Math.sqrt(x.reduce((total, row, i) => total + row.reduce((acc, value, j) => acc + (value - approx[i]![j]!) ** 2, 0), 0))
  return { W, H, reconstructionError: error }
}

// ================================================================ anomaly detection

interface IsoNode { feature: number; split: number; left: IsoNode | null; right: IsoNode | null; size: number }

function averagePathLength(n: number): number {
  if (n <= 1) return 0
  if (n === 2) return 1
  return 2 * (Math.log(n - 1) + 0.5772156649) - (2 * (n - 1)) / n
}

/** Isolation forest (Liu et al. 2008): anomaly score in (0, 1], higher is more anomalous. */
export function isolationForest(x: number[][], rng: Rng, options: { trees?: number; sampleSize?: number } = {}): number[] {
  const n = x.length
  const sampleSize = Math.min(options.sampleSize ?? 256, n)
  const maxDepth = Math.ceil(Math.log2(sampleSize))
  const d = x[0]!.length
  const build = (rows: number[], depth: number, treeRng: Rng): IsoNode => {
    if (depth >= maxDepth || rows.length <= 1) return { feature: -1, split: 0, left: null, right: null, size: rows.length }
    const feature = treeRng.int(d)
    let min = Number.POSITIVE_INFINITY
    let max = Number.NEGATIVE_INFINITY
    for (const row of rows) { const value = x[row]![feature]!; if (value < min) min = value; if (value > max) max = value }
    if (min === max) return { feature: -1, split: 0, left: null, right: null, size: rows.length }
    const split = min + treeRng.next() * (max - min)
    return { feature, split, left: build(rows.filter((row) => x[row]![feature]! < split), depth + 1, treeRng), right: build(rows.filter((row) => x[row]![feature]! >= split), depth + 1, treeRng), size: rows.length }
  }
  const trees = Array.from({ length: options.trees ?? 200 }, (_, t) => {
    const treeRng = rng.fork(t)
    return build(treeRng.shuffle(Array.from({ length: n }, (_, index) => index)).slice(0, sampleSize), 0, treeRng)
  })
  const c = averagePathLength(sampleSize)
  return x.map((row) => {
    const pathLengths = trees.map((tree) => {
      let node: IsoNode = tree
      let depth = 0
      while (node.feature >= 0) { node = row[node.feature]! < node.split ? node.left! : node.right!; depth++ }
      return depth + averagePathLength(node.size)
    })
    return 2 ** (-mean(pathLengths) / c)
  })
}

/** Local outlier factor (Breunig et al. 2000): values well above 1 are local outliers. */
export function localOutlierFactor(x: number[][], k = 20): number[] {
  const n = x.length
  if (n > 15_000) throw new Error('LOF here is exact O(n²); sample to at most 15,000 rows first')
  const kk = Math.min(k, n - 1)
  const neighbours = x.map((row, i) => x.map((other, j) => ({ j, distance: i === j ? Number.POSITIVE_INFINITY : Math.sqrt(sq(row, other)) })).sort((a, b) => a.distance - b.distance).slice(0, kk))
  const kDistance = neighbours.map((list) => list[kk - 1]!.distance)
  const lrd = neighbours.map((list) => 1 / (mean(list.map(({ j, distance }) => Math.max(kDistance[j]!, distance))) + 1e-12))
  return neighbours.map((list, i) => mean(list.map(({ j }) => lrd[j]!)) / lrd[i]!)
}

/** Robust z-scores (median / MAD) for one numeric column. */
export function robustZ(values: number[]): number[] {
  const med = median(values)
  const mad = median(values.map((value) => Math.abs(value - med))) * 1.4826
  return values.map((value) => (mad === 0 ? 0 : (value - med) / mad))
}

/** Squared Mahalanobis distance with a chi-square p-value per row. */
export function mahalanobis(x: number[][]): { distance: number[]; pValue: number[] } {
  const d = x[0]!.length
  const means = Array.from({ length: d }, (_, j) => mean(x.map((row) => row[j]!)))
  const covariance = Array.from({ length: d }, (_, i) => Array.from({ length: d }, (_, j) => x.reduce((total, row) => total + (row[i]! - means[i]!) * (row[j]! - means[j]!), 0) / Math.max(1, x.length - 1) + (i === j ? 1e-9 : 0)))
  const inverse = inverseSPD(covariance)
  const distance = x.map((row) => {
    const centered = row.map((value, j) => value - means[j]!)
    return centered.reduce((total, value, i) => total + value * centered.reduce((acc, other, j) => acc + inverse[i]![j]! * other, 0), 0)
  })
  return { distance, pValue: distance.map((value) => chiSquareSf(value, d)) }
}
