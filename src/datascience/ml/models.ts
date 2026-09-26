import { createRng, type Rng } from '../rng.ts'
import { mean } from '../stats/describe.ts'
import { inverseSPD, solve } from '../stats/linalg.ts'

/**
 * Model implementations in TypeScript: linear, ridge, lasso, elastic net, logistic,
 * CART decision trees, random forests, histogram gradient boosting (the XGBoost/LightGBM
 * algorithm family: second-order leaf values, L2-regularised gains, row and column
 * subsampling, early stopping), k-nearest neighbours, Gaussian naive Bayes, a linear SVM
 * with Platt-scaled probabilities, and a multilayer perceptron. Every fitted model is plain
 * JSON, so it can be saved, versioned, and reloaded for inference.
 *
 * Inputs are the numeric matrix produced by the fitted preprocessor; targets are numbers
 * (regression) or class indices 0..k-1 (classification).
 */

export type Task = 'regression' | 'binary' | 'multiclass'
export type Algorithm = 'baseline' | 'linear' | 'ridge' | 'lasso' | 'elastic_net' | 'logistic' | 'decision_tree' | 'random_forest' | 'gradient_boosting' | 'knn' | 'naive_bayes' | 'linear_svm' | 'mlp'

export const ALGORITHMS: Record<Algorithm, { tasks: Task[]; interpretability: 'high' | 'medium' | 'low'; family: string; description: string }> = {
  baseline: { tasks: ['regression', 'binary', 'multiclass'], interpretability: 'high', family: 'baseline', description: 'predicts the training mean (regression) or class priors (classification); every real model must beat it' },
  linear: { tasks: ['regression'], interpretability: 'high', family: 'linear', description: 'ordinary least squares on standardized features' },
  ridge: { tasks: ['regression'], interpretability: 'high', family: 'linear', description: 'L2-penalised linear regression (alpha)' },
  lasso: { tasks: ['regression'], interpretability: 'high', family: 'linear', description: 'L1-penalised linear regression; zeroes out weak features (alpha)' },
  elastic_net: { tasks: ['regression'], interpretability: 'high', family: 'linear', description: 'L1+L2 penalised linear regression (alpha, l1Ratio)' },
  logistic: { tasks: ['binary', 'multiclass'], interpretability: 'high', family: 'linear', description: 'L2-penalised logistic regression (C); one-vs-rest for multiclass' },
  decision_tree: { tasks: ['regression', 'binary', 'multiclass'], interpretability: 'high', family: 'tree', description: 'CART tree (maxDepth, minSamplesLeaf)' },
  random_forest: { tasks: ['regression', 'binary', 'multiclass'], interpretability: 'medium', family: 'ensemble', description: 'bagged CART trees with feature subsampling (nEstimators, maxDepth, maxFeatures)' },
  gradient_boosting: { tasks: ['regression', 'binary', 'multiclass'], interpretability: 'medium', family: 'ensemble', description: 'histogram gradient boosting with Newton leaves and L2 regularisation (nEstimators, learningRate, maxDepth, subsample, colsample, lambda, early stopping)' },
  knn: { tasks: ['regression', 'binary', 'multiclass'], interpretability: 'low', family: 'instance', description: 'k-nearest neighbours on standardized features (k, weights)' },
  naive_bayes: { tasks: ['binary', 'multiclass'], interpretability: 'medium', family: 'probabilistic', description: 'Gaussian naive Bayes' },
  linear_svm: { tasks: ['binary', 'multiclass'], interpretability: 'medium', family: 'linear', description: 'linear support vector machine (Pegasos) with Platt-scaled probabilities (C)' },
  mlp: { tasks: ['regression', 'binary', 'multiclass'], interpretability: 'low', family: 'neural', description: 'multilayer perceptron with ReLU, Adam, L2 and early stopping (hidden, learningRate, epochs)' },
}

export interface FittedModel {
  algorithm: Algorithm
  task: Task
  classes: number
  params: Record<string, number | number[] | string | boolean>
  state: unknown
  featureImportance?: number[]
  notes: string[]
}

export interface Prediction {
  values: number[]
  probabilities?: number[][]
}

type Params = Record<string, unknown>
const p = (params: Params, key: string, fallback: number) => (typeof params[key] === 'number' && Number.isFinite(params[key]) ? (params[key] as number) : fallback)

function sigmoid(x: number): number {
  return x >= 0 ? 1 / (1 + Math.exp(-x)) : Math.exp(x) / (1 + Math.exp(x))
}

function softmax(row: number[]): number[] {
  const max = Math.max(...row)
  const exps = row.map((value) => Math.exp(value - max))
  const total = exps.reduce((a, b) => a + b, 0)
  return exps.map((value) => value / total)
}

function argmax(row: number[]): number {
  let best = 0
  for (let index = 1; index < row.length; index++) if (row[index]! > row[best]!) best = index
  return best
}

function classPriors(y: number[], k: number): number[] {
  const counts = new Array<number>(k).fill(0)
  for (const label of y) counts[label]!++
  return counts.map((count) => count / y.length)
}

// ================================================================ linear models

interface LinearState {
  intercept: number
  coefficients: number[]
}

function linearPredict(state: LinearState, x: number[][]): number[] {
  return x.map((row) => state.intercept + row.reduce((total, value, index) => total + value * state.coefficients[index]!, 0))
}

function centered(x: number[][], y: number[]): { xm: number[]; ym: number; xc: number[][]; yc: number[] } {
  const d = x[0]?.length ?? 0
  const xm = Array.from({ length: d }, (_, j) => mean(x.map((row) => row[j]!)))
  const ym = mean(y)
  return { xm, ym, xc: x.map((row) => row.map((value, j) => value - xm[j]!)), yc: y.map((value) => value - ym) }
}

function fitRidge(x: number[][], y: number[], alpha: number): LinearState {
  const d = x[0]?.length ?? 0
  const { xm, ym, xc, yc } = centered(x, y)
  const xtx = Array.from({ length: d }, () => new Array<number>(d).fill(0))
  const xty = new Array<number>(d).fill(0)
  for (let r = 0; r < xc.length; r++) {
    const row = xc[r]!
    for (let i = 0; i < d; i++) {
      xty[i]! += row[i]! * yc[r]!
      for (let j = i; j < d; j++) xtx[i]![j]! += row[i]! * row[j]!
    }
  }
  for (let i = 0; i < d; i++) {
    for (let j = 0; j < i; j++) xtx[i]![j] = xtx[j]![i]!
    xtx[i]![i]! += Math.max(alpha, 1e-10)
  }
  const beta = solve(xtx, xty)
  return { intercept: ym - beta.reduce((total, b, j) => total + b * xm[j]!, 0), coefficients: beta }
}

/** Coordinate descent for the elastic net (scikit-learn's objective). */
function fitElasticNet(x: number[][], y: number[], alpha: number, l1Ratio: number, maxIterations = 1000, tolerance = 1e-6): LinearState {
  const n = x.length
  const d = x[0]?.length ?? 0
  const { xm, ym, xc, yc } = centered(x, y)
  const columns = Array.from({ length: d }, (_, j) => xc.map((row) => row[j]!))
  const norms = columns.map((column) => column.reduce((total, value) => total + value * value, 0) / n)
  const beta = new Array<number>(d).fill(0)
  const residual = [...yc]
  for (let iteration = 0; iteration < maxIterations; iteration++) {
    let maxChange = 0
    for (let j = 0; j < d; j++) {
      if (norms[j] === 0) continue
      const column = columns[j]!
      const old = beta[j]!
      let rho = 0
      for (let i = 0; i < n; i++) rho += column[i]! * (residual[i]! + column[i]! * old)
      rho /= n
      const threshold = alpha * l1Ratio
      const updated = Math.sign(rho) * Math.max(0, Math.abs(rho) - threshold) / (norms[j]! + alpha * (1 - l1Ratio))
      if (updated !== old) {
        const delta = updated - old
        for (let i = 0; i < n; i++) residual[i]! -= column[i]! * delta
        beta[j] = updated
        maxChange = Math.max(maxChange, Math.abs(delta))
      }
    }
    if (maxChange < tolerance) break
  }
  return { intercept: ym - beta.reduce((total, b, j) => total + b * xm[j]!, 0), coefficients: beta }
}

/** Binary logistic regression with an L2 penalty 1/(2C)·‖β‖² by penalised Newton–Raphson. */
function fitBinaryLogistic(x: number[][], y: number[], c: number, weights?: number[]): LinearState {
  const n = x.length
  const d = (x[0]?.length ?? 0) + 1
  const design = x.map((row) => [1, ...row])
  let beta = new Array<number>(d).fill(0)
  const penalty = 1 / Math.max(c, 1e-8)
  for (let iteration = 0; iteration < 100; iteration++) {
    const gradient = new Array<number>(d).fill(0)
    const hessian = Array.from({ length: d }, () => new Array<number>(d).fill(0))
    for (let r = 0; r < n; r++) {
      const row = design[r]!
      const eta = row.reduce((total, value, j) => total + value * beta[j]!, 0)
      const prob = sigmoid(eta)
      const w = (weights?.[r] ?? 1)
      const g = w * (prob - y[r]!)
      const h = w * Math.max(prob * (1 - prob), 1e-10)
      for (let i = 0; i < d; i++) {
        gradient[i]! += g * row[i]!
        const hi = h * row[i]!
        for (let j = i; j < d; j++) hessian[i]![j]! += hi * row[j]!
      }
    }
    for (let i = 0; i < d; i++) {
      for (let j = 0; j < i; j++) hessian[i]![j] = hessian[j]![i]!
      if (i > 0) {
        gradient[i]! += penalty * beta[i]!
        hessian[i]![i]! += penalty
      } else hessian[0]![0]! += 1e-10
    }
    const step = solve(hessian, gradient)
    const next = beta.map((value, index) => value - step[index]!)
    const change = Math.max(...step.map(Math.abs))
    beta = next
    if (change < 1e-8) break
  }
  return { intercept: beta[0]!, coefficients: beta.slice(1) }
}

// ================================================================ histogram trees

interface Tree {
  feature: number[]
  threshold: number[]
  left: number[]
  right: number[]
  value: number[][]
  gain: number[]
  cover: number[]
}

interface Binned {
  edges: number[][]
  bins: Uint8Array[]
}

function binColumns(x: number[][], maxBins: number, rng: Rng): Binned {
  const n = x.length
  const d = x[0]?.length ?? 0
  const sampleRows = n > 20_000 ? rng.shuffle(Array.from({ length: n }, (_, index) => index)).slice(0, 20_000) : Array.from({ length: n }, (_, index) => index)
  const edges: number[][] = []
  const bins: Uint8Array[] = []
  for (let j = 0; j < d; j++) {
    const unique = [...new Set(sampleRows.map((r) => x[r]![j]!))].sort((a, b) => a - b)
    let cuts: number[]
    if (unique.length <= maxBins) cuts = unique.slice(0, -1).map((value, index) => (value + unique[index + 1]!) / 2)
    else {
      const set = new Set<number>()
      for (let b = 1; b < maxBins; b++) {
        const position = Math.floor((b * unique.length) / maxBins)
        set.add((unique[position - 1]! + unique[position]!) / 2)
      }
      cuts = [...set].sort((a, b) => a - b)
    }
    edges.push(cuts)
    const column = new Uint8Array(n)
    for (let r = 0; r < n; r++) {
      const value = x[r]![j]!
      let lo = 0
      let hi = cuts.length
      while (lo < hi) {
        const mid = (lo + hi) >> 1
        if (value <= cuts[mid]!) hi = mid
        else lo = mid + 1
      }
      column[r] = lo
    }
    bins.push(column)
  }
  return { edges, bins }
}

type Objective = { kind: 'gh'; g: Float64Array; h: Float64Array; lambda: number } | { kind: 'class'; y: Int32Array; k: number }

interface TreeParams {
  maxDepth: number
  minSamplesLeaf: number
  minGain: number
  maxFeatures: number
}

function nodeValue(objective: Objective, indices: Int32Array): number[] {
  if (objective.kind === 'gh') {
    let g = 0
    let h = 0
    for (const index of indices) {
      g += objective.g[index]!
      h += objective.h[index]!
    }
    return [-g / (h + objective.lambda)]
  }
  const counts = new Array<number>(objective.k).fill(0)
  for (const index of indices) counts[objective.y[index]!]!++
  return counts.map((count) => count / Math.max(1, indices.length))
}

function buildTree(binned: Binned, rows: Int32Array, objective: Objective, params: TreeParams, rng: Rng, features: number[]): Tree {
  const tree: Tree = { feature: [], threshold: [], left: [], right: [], value: [], gain: [], cover: [] }
  const d = features.length
  const addNode = (indices: Int32Array): number => {
    tree.feature.push(-1)
    tree.threshold.push(0)
    tree.left.push(-1)
    tree.right.push(-1)
    tree.value.push(nodeValue(objective, indices))
    tree.gain.push(0)
    tree.cover.push(indices.length)
    return tree.feature.length - 1
  }
  const grow = (node: number, indices: Int32Array, depth: number) => {
    if (depth >= params.maxDepth || indices.length < 2 * params.minSamplesLeaf) return
    const candidates = params.maxFeatures < d ? rng.shuffle(features).slice(0, params.maxFeatures) : features
    let bestGain = params.minGain
    let bestFeature = -1
    let bestBin = -1
    if (objective.kind === 'gh') {
      let gTotal = 0
      let hTotal = 0
      for (const index of indices) {
        gTotal += objective.g[index]!
        hTotal += objective.h[index]!
      }
      const parentScore = (gTotal * gTotal) / (hTotal + objective.lambda)
      for (const feature of candidates) {
        const nb = binned.edges[feature]!.length + 1
        if (nb < 2) continue
        const column = binned.bins[feature]!
        const gh = new Float64Array(nb)
        const hh = new Float64Array(nb)
        const ch = new Int32Array(nb)
        for (const index of indices) {
          const b = column[index]!
          gh[b]! += objective.g[index]!
          hh[b]! += objective.h[index]!
          ch[b]!++
        }
        let gl = 0
        let hl = 0
        let cl = 0
        for (let b = 0; b < nb - 1; b++) {
          gl += gh[b]!
          hl += hh[b]!
          cl += ch[b]!
          const cr = indices.length - cl
          if (cl < params.minSamplesLeaf) continue
          if (cr < params.minSamplesLeaf) break
          const gr = gTotal - gl
          const hr = hTotal - hl
          const gain = (gl * gl) / (hl + objective.lambda) + (gr * gr) / (hr + objective.lambda) - parentScore
          if (gain > bestGain) {
            bestGain = gain
            bestFeature = feature
            bestBin = b
          }
        }
      }
    } else {
      const k = objective.k
      const total = new Float64Array(k)
      for (const index of indices) total[objective.y[index]!]!++
      const n = indices.length
      const parent = total.reduce((acc, count) => acc + count * count, 0) / n
      for (const feature of candidates) {
        const nb = binned.edges[feature]!.length + 1
        if (nb < 2) continue
        const column = binned.bins[feature]!
        const hist = new Float64Array(nb * k)
        const ch = new Int32Array(nb)
        for (const index of indices) {
          const b = column[index]!
          hist[b * k + objective.y[index]!]!++
          ch[b]!++
        }
        const left = new Float64Array(k)
        let cl = 0
        for (let b = 0; b < nb - 1; b++) {
          for (let c = 0; c < k; c++) left[c]! += hist[b * k + c]!
          cl += ch[b]!
          const cr = n - cl
          if (cl < params.minSamplesLeaf) continue
          if (cr < params.minSamplesLeaf) break
          let sl = 0
          let sr = 0
          for (let c = 0; c < k; c++) {
            sl += left[c]! * left[c]!
            const right = total[c]! - left[c]!
            sr += right * right
          }
          const gain = sl / cl + sr / cr - parent
          if (gain > bestGain) {
            bestGain = gain
            bestFeature = feature
            bestBin = b
          }
        }
      }
    }
    if (bestFeature < 0) return
    const column = binned.bins[bestFeature]!
    let leftCount = 0
    for (const index of indices) if (column[index]! <= bestBin) leftCount++
    const leftRows = new Int32Array(leftCount)
    const rightRows = new Int32Array(indices.length - leftCount)
    let li = 0
    let ri = 0
    for (const index of indices) {
      if (column[index]! <= bestBin) leftRows[li++] = index
      else rightRows[ri++] = index
    }
    tree.feature[node] = bestFeature
    tree.threshold[node] = binned.edges[bestFeature]![bestBin]!
    tree.gain[node] = bestGain
    const leftNode = addNode(leftRows)
    const rightNode = addNode(rightRows)
    tree.left[node] = leftNode
    tree.right[node] = rightNode
    grow(leftNode, leftRows, depth + 1)
    grow(rightNode, rightRows, depth + 1)
  }
  grow(addNode(rows), rows, 0)
  return tree
}

function treeLeaf(tree: Tree, row: number[]): number {
  let node = 0
  while (tree.feature[node]! >= 0) node = row[tree.feature[node]!]! <= tree.threshold[node]! ? tree.left[node]! : tree.right[node]!
  return node
}

/** Path contributions (Saabas): prediction = root value + Σ per-feature changes along the decision path. */
export function treeContributions(tree: Tree, row: number[], output = 0): { bias: number; contributions: Map<number, number> } {
  const contributions = new Map<number, number>()
  let node = 0
  const bias = tree.value[0]![output]!
  while (tree.feature[node]! >= 0) {
    const feature = tree.feature[node]!
    const next = row[feature]! <= tree.threshold[node]! ? tree.left[node]! : tree.right[node]!
    contributions.set(feature, (contributions.get(feature) ?? 0) + tree.value[next]![output]! - tree.value[node]![output]!)
    node = next
  }
  return { bias, contributions }
}

function importanceFromTrees(trees: Tree[], d: number): number[] {
  const importance = new Array<number>(d).fill(0)
  for (const tree of trees) tree.feature.forEach((feature, node) => { if (feature >= 0) importance[feature]! += tree.gain[node]! })
  const total = importance.reduce((a, b) => a + b, 0)
  return total > 0 ? importance.map((value) => value / total) : importance
}

function allFeatures(d: number): number[] {
  return Array.from({ length: d }, (_, index) => index)
}

function fitDecisionTree(x: number[][], y: number[], task: Task, k: number, params: Params, rng: Rng): { trees: Tree[]; binnedEdges?: undefined } {
  const binned = binColumns(x, p(params, 'maxBins', 128), rng)
  const rows = Int32Array.from({ length: x.length }, (_, index) => index)
  const treeParams: TreeParams = { maxDepth: p(params, 'maxDepth', 6), minSamplesLeaf: p(params, 'minSamplesLeaf', 5), minGain: p(params, 'minGain', 1e-7), maxFeatures: x[0]!.length }
  const objective: Objective = task === 'regression' ? { kind: 'gh', g: Float64Array.from(y, (value) => -value), h: new Float64Array(y.length).fill(1), lambda: 0 } : { kind: 'class', y: Int32Array.from(y), k }
  return { trees: [buildTree(binned, rows, objective, treeParams, rng, allFeatures(x[0]!.length))] }
}

function fitRandomForest(x: number[][], y: number[], task: Task, k: number, params: Params, rng: Rng): { trees: Tree[]; oobScore: number | null } {
  const n = x.length
  const d = x[0]!.length
  const binned = binColumns(x, p(params, 'maxBins', 64), rng)
  const nEstimators = Math.max(1, Math.floor(p(params, 'nEstimators', 100)))
  const maxFeatures = Math.max(1, Math.round(p(params, 'maxFeatures', task === 'regression' ? Math.max(1, d / 3) : Math.sqrt(d))))
  const treeParams: TreeParams = { maxDepth: p(params, 'maxDepth', 12), minSamplesLeaf: p(params, 'minSamplesLeaf', task === 'regression' ? 5 : 1), minGain: 1e-7, maxFeatures }
  const trees: Tree[] = []
  const oobSum = Array.from({ length: n }, () => new Array<number>(task === 'regression' ? 1 : k).fill(0))
  const oobCount = new Array<number>(n).fill(0)
  const features = allFeatures(d)
  for (let t = 0; t < nEstimators; t++) {
    const treeRng = rng.fork(t)
    const sample = new Int32Array(n)
    const inBag = new Uint8Array(n)
    for (let i = 0; i < n; i++) {
      const drawn = treeRng.int(n)
      sample[i] = drawn
      inBag[drawn] = 1
    }
    const objective: Objective = task === 'regression' ? { kind: 'gh', g: Float64Array.from(y, (value) => -value), h: new Float64Array(n).fill(1), lambda: 0 } : { kind: 'class', y: Int32Array.from(y), k }
    const tree = buildTree(binned, sample, objective, treeParams, treeRng, features)
    trees.push(tree)
    for (let i = 0; i < n; i++) {
      if (inBag[i]) continue
      const value = tree.value[treeLeaf(tree, x[i]!)]!
      value.forEach((v, c) => { oobSum[i]![c]! += v })
      oobCount[i]!++
    }
  }
  const scored = oobSum.map((sum, i) => ({ sum, count: oobCount[i]!, i })).filter((entry) => entry.count > 0)
  let oobScore: number | null = null
  if (scored.length) {
    if (task === 'regression') {
      const actual = scored.map((entry) => y[entry.i]!)
      const my = mean(actual)
      const sse = scored.reduce((total, entry) => total + (y[entry.i]! - entry.sum[0]! / entry.count) ** 2, 0)
      const sst = actual.reduce((total, value) => total + (value - my) ** 2, 0)
      oobScore = sst === 0 ? null : 1 - sse / sst
    } else oobScore = scored.filter((entry) => argmax(entry.sum) === y[entry.i]).length / scored.length
  }
  return { trees, oobScore }
}

interface BoostState {
  init: number[]
  trees: Tree[][]
  learningRate: number
  bestIteration: number
}

function fitGradientBoosting(x: number[][], y: number[], task: Task, k: number, params: Params, rng: Rng): BoostState & { validationCurve: number[] } {
  const n = x.length
  const d = x[0]!.length
  const outputs = task === 'multiclass' ? k : 1
  const nEstimators = Math.max(1, Math.floor(p(params, 'nEstimators', 300)))
  const learningRate = p(params, 'learningRate', 0.08)
  const lambda = p(params, 'lambda', 1)
  const subsample = p(params, 'subsample', 0.8)
  const colsample = p(params, 'colsample', 0.8)
  const earlyStopping = params.earlyStopping !== false && n >= 200
  const patience = Math.floor(p(params, 'patience', 25))
  const treeParams: TreeParams = { maxDepth: p(params, 'maxDepth', 4), minSamplesLeaf: p(params, 'minSamplesLeaf', 10), minGain: p(params, 'minGain', 1e-6), maxFeatures: Math.max(1, Math.round(colsample * d)) }
  const order = rng.shuffle(Array.from({ length: n }, (_, index) => index))
  const validation = earlyStopping ? new Set(order.slice(0, Math.max(20, Math.floor(0.1 * n)))) : new Set<number>()
  const train = Array.from({ length: n }, (_, index) => index).filter((index) => !validation.has(index))
  const binned = binColumns(x, p(params, 'maxBins', 64), rng)
  let init: number[]
  if (task === 'regression') init = [mean(train.map((index) => y[index]!))]
  else if (task === 'binary') {
    const rate = Math.min(1 - 1e-6, Math.max(1e-6, mean(train.map((index) => y[index]!))))
    init = [Math.log(rate / (1 - rate))]
  } else {
    const priors = classPriors(train.map((index) => y[index]!), k).map((value) => Math.log(Math.max(value, 1e-6)))
    init = priors
  }
  const raw = Array.from({ length: n }, () => [...init])
  const trees: Tree[][] = []
  const curve: number[] = []
  let best = Number.POSITIVE_INFINITY
  let bestIteration = 0
  const features = allFeatures(d)
  const loss = (indices: Iterable<number>) => {
    let total = 0
    let count = 0
    for (const index of indices) {
      count++
      if (task === 'regression') total += (raw[index]![0]! - y[index]!) ** 2
      else if (task === 'binary') total -= y[index] === 1 ? Math.log(Math.max(1e-15, sigmoid(raw[index]![0]!))) : Math.log(Math.max(1e-15, 1 - sigmoid(raw[index]![0]!)))
      else total -= Math.log(Math.max(1e-15, softmax(raw[index]!)[y[index]!]!))
    }
    return total / Math.max(1, count)
  }
  for (let iteration = 0; iteration < nEstimators; iteration++) {
    const roundRng = rng.fork(iteration)
    const sampled = subsample < 1 ? roundRng.shuffle(train).slice(0, Math.max(2, Math.floor(subsample * train.length))) : train
    const rows = Int32Array.from(sampled)
    const roundTrees: Tree[] = []
    const probs = task === 'multiclass' ? raw.map((row) => softmax(row)) : undefined
    for (let output = 0; output < outputs; output++) {
      const g = new Float64Array(n)
      const h = new Float64Array(n)
      for (const index of sampled) {
        if (task === 'regression') {
          g[index] = raw[index]![0]! - y[index]!
          h[index] = 1
        } else if (task === 'binary') {
          const prob = sigmoid(raw[index]![0]!)
          g[index] = prob - y[index]!
          h[index] = Math.max(prob * (1 - prob), 1e-12)
        } else {
          const prob = probs![index]![output]!
          g[index] = prob - (y[index] === output ? 1 : 0)
          h[index] = Math.max(prob * (1 - prob), 1e-12)
        }
      }
      const tree = buildTree(binned, rows, { kind: 'gh', g, h, lambda }, treeParams, roundRng.fork(output), features)
      for (const node of tree.value) node[0] = node[0]! * learningRate
      roundTrees.push(tree)
      for (let index = 0; index < n; index++) raw[index]![output]! += tree.value[treeLeaf(tree, x[index]!)]![0]!
    }
    trees.push(roundTrees)
    if (earlyStopping) {
      const current = loss(validation)
      curve.push(current)
      if (current < best - 1e-9) {
        best = current
        bestIteration = iteration + 1
      } else if (iteration + 1 - bestIteration >= patience) break
    } else bestIteration = iteration + 1
  }
  return { init, trees: trees.slice(0, Math.max(1, bestIteration)), learningRate, bestIteration: Math.max(1, bestIteration), validationCurve: curve }
}

// ================================================================ other learners

interface KnnState {
  x: number[][]
  y: number[]
  k: number
  distanceWeighted: boolean
}

function knnPredict(state: KnnState, x: number[][], task: Task, classes: number): Prediction {
  const values: number[] = []
  const probabilities: number[][] = []
  for (const row of x) {
    const nearest: Array<{ distance: number; label: number }> = []
    for (let i = 0; i < state.x.length; i++) {
      const other = state.x[i]!
      let distance = 0
      for (let j = 0; j < row.length; j++) {
        const diff = row[j]! - other[j]!
        distance += diff * diff
      }
      if (nearest.length < state.k) {
        nearest.push({ distance, label: state.y[i]! })
        nearest.sort((a, b) => a.distance - b.distance)
      } else if (distance < nearest[nearest.length - 1]!.distance) {
        nearest[nearest.length - 1] = { distance, label: state.y[i]! }
        nearest.sort((a, b) => a.distance - b.distance)
      }
    }
    const weights = nearest.map((entry) => (state.distanceWeighted ? 1 / (Math.sqrt(entry.distance) + 1e-9) : 1))
    const totalWeight = weights.reduce((a, b) => a + b, 0)
    if (task === 'regression') values.push(nearest.reduce((total, entry, index) => total + entry.label * weights[index]!, 0) / totalWeight)
    else {
      const votes = new Array<number>(classes).fill(0)
      nearest.forEach((entry, index) => { votes[entry.label]! += weights[index]! })
      const probs = votes.map((vote) => vote / totalWeight)
      probabilities.push(probs)
      values.push(argmax(probs))
    }
  }
  return task === 'regression' ? { values } : { values, probabilities }
}

interface NaiveBayesState {
  priors: number[]
  means: number[][]
  variances: number[][]
}

function fitNaiveBayes(x: number[][], y: number[], k: number): NaiveBayesState {
  const d = x[0]!.length
  const priors = classPriors(y, k)
  const means = Array.from({ length: k }, () => new Array<number>(d).fill(0))
  const variances = Array.from({ length: k }, () => new Array<number>(d).fill(0))
  const counts = new Array<number>(k).fill(0)
  x.forEach((row, index) => { counts[y[index]!]!++; row.forEach((value, j) => { means[y[index]!]![j]! += value }) })
  for (let c = 0; c < k; c++) for (let j = 0; j < d; j++) means[c]![j]! /= Math.max(1, counts[c]!)
  x.forEach((row, index) => row.forEach((value, j) => { variances[y[index]!]![j]! += (value - means[y[index]!]![j]!) ** 2 }))
  let maxVariance = 0
  for (let j = 0; j < d; j++) {
    const column = x.map((row) => row[j]!)
    const m = mean(column)
    maxVariance = Math.max(maxVariance, column.reduce((total, value) => total + (value - m) ** 2, 0) / column.length)
  }
  const smoothing = 1e-9 * Math.max(maxVariance, 1e-12)
  for (let c = 0; c < k; c++) for (let j = 0; j < d; j++) variances[c]![j] = variances[c]![j]! / Math.max(1, counts[c]!) + smoothing
  return { priors, means, variances }
}

function naiveBayesPredict(state: NaiveBayesState, x: number[][]): Prediction {
  const probabilities = x.map((row) => softmax(state.priors.map((prior, c) => Math.log(Math.max(prior, 1e-300)) + row.reduce((total, value, j) => total - 0.5 * Math.log(2 * Math.PI * state.variances[c]![j]!) - (value - state.means[c]![j]!) ** 2 / (2 * state.variances[c]![j]!), 0))))
  return { values: probabilities.map(argmax), probabilities }
}

interface SvmState {
  models: Array<{ w: number[]; b: number; plattA: number; plattB: number }>
}

function fitLinearSvm(x: number[][], y: number[], k: number, params: Params, rng: Rng): SvmState {
  const c = p(params, 'C', 1)
  const lambda = 1 / (c * x.length)
  const epochs = Math.floor(p(params, 'epochs', 30))
  const outputs = k === 2 ? [1] : Array.from({ length: k }, (_, index) => index)
  const models = outputs.map((positive) => {
    const labels = y.map((label) => (label === positive ? 1 : -1))
    const d = x[0]!.length
    const w = new Array<number>(d).fill(0)
    let b = 0
    let t = 1
    for (let epoch = 0; epoch < epochs; epoch++) {
      for (const index of rng.shuffle(Array.from({ length: x.length }, (_, i) => i))) {
        const eta = 1 / (lambda * (t + 100))
        const row = x[index]!
        const margin = labels[index]! * (row.reduce((total, value, j) => total + value * w[j]!, 0) + b)
        for (let j = 0; j < d; j++) w[j]! *= 1 - eta * lambda
        if (margin < 1) {
          for (let j = 0; j < d; j++) w[j]! += eta * labels[index]! * row[j]!
          b += eta * labels[index]! * 0.1
        }
        t++
      }
    }
    const scores = x.map((row) => row.reduce((total, value, j) => total + value * w[j]!, 0) + b)
    const platt = fitBinaryLogistic(scores.map((score) => [score]), labels.map((label) => (label === 1 ? 1 : 0)), 1e6)
    return { w, b, plattA: platt.coefficients[0]!, plattB: platt.intercept }
  })
  return { models }
}

function svmPredict(state: SvmState, x: number[][], k: number): Prediction {
  const probabilities = x.map((row) => {
    const scores = state.models.map((model) => sigmoid(model.plattA * (row.reduce((total, value, j) => total + value * model.w[j]!, 0) + model.b) + model.plattB))
    if (k === 2) return [1 - scores[0]!, scores[0]!]
    const total = scores.reduce((a, b) => a + b, 0) || 1
    return scores.map((score) => score / total)
  })
  return { values: probabilities.map(argmax), probabilities }
}

interface MlpState {
  layers: Array<{ w: number[][]; b: number[] }>
  yMean: number
  ySd: number
  epochsRun: number
}

function fitMlp(x: number[][], y: number[], task: Task, k: number, params: Params, rng: Rng): MlpState {
  const hidden = Array.isArray(params.hidden) ? (params.hidden as number[]).map((value) => Math.max(1, Math.floor(value))) : [Math.min(64, Math.max(8, 2 * (x[0]?.length ?? 4)))]
  const outputs = task === 'multiclass' ? k : 1
  const sizes = [x[0]!.length, ...hidden, outputs]
  const lr = p(params, 'learningRate', 1e-3)
  const l2 = p(params, 'l2', 1e-4)
  const epochs = Math.floor(p(params, 'epochs', 200))
  const batch = Math.floor(p(params, 'batchSize', 64))
  const yMean = task === 'regression' ? mean(y) : 0
  const ySd = task === 'regression' ? Math.sqrt(mean(y.map((value) => (value - yMean) ** 2))) || 1 : 1
  const target = task === 'regression' ? y.map((value) => (value - yMean) / ySd) : y
  const layers = sizes.slice(1).map((size, index) => ({ w: Array.from({ length: size }, () => Array.from({ length: sizes[index]! }, () => rng.normal(0, Math.sqrt(2 / sizes[index]!)))), b: new Array<number>(size).fill(0) }))
  const m = layers.map((layer) => ({ w: layer.w.map((row) => row.map(() => 0)), b: layer.b.map(() => 0) }))
  const v = layers.map((layer) => ({ w: layer.w.map((row) => row.map(() => 0)), b: layer.b.map(() => 0) }))
  const order = rng.shuffle(Array.from({ length: x.length }, (_, index) => index))
  const validationSize = x.length >= 100 ? Math.floor(0.1 * x.length) : 0
  const validation = order.slice(0, validationSize)
  const train = order.slice(validationSize)
  const forward = (row: number[]) => {
    const activations = [row]
    layers.forEach((layer, index) => {
      const input = activations[activations.length - 1]!
      const z = layer.w.map((weights, unit) => weights.reduce((total, weight, j) => total + weight * input[j]!, layer.b[unit]!))
      activations.push(index === layers.length - 1 ? z : z.map((value) => Math.max(0, value)))
    })
    return activations
  }
  const outputLoss = (out: number[], label: number) => {
    if (task === 'regression') return 0.5 * (out[0]! - label) ** 2
    if (task === 'binary') { const prob = sigmoid(out[0]!); return -(label === 1 ? Math.log(Math.max(prob, 1e-15)) : Math.log(Math.max(1 - prob, 1e-15))) }
    return -Math.log(Math.max(softmax(out)[label]!, 1e-15))
  }
  let best = Number.POSITIVE_INFINITY
  let bestLayers = JSON.parse(JSON.stringify(layers)) as typeof layers
  let stale = 0
  let step = 0
  let epochsRun = 0
  for (let epoch = 0; epoch < epochs; epoch++) {
    epochsRun = epoch + 1
    const shuffled = rng.shuffle(train)
    for (let start = 0; start < shuffled.length; start += batch) {
      const members = shuffled.slice(start, start + batch)
      const gradW = layers.map((layer) => layer.w.map((row) => row.map(() => 0)))
      const gradB = layers.map((layer) => layer.b.map(() => 0))
      for (const index of members) {
        const activations = forward(x[index]!)
        const out = activations[activations.length - 1]!
        let delta: number[]
        if (task === 'regression') delta = [out[0]! - target[index]!]
        else if (task === 'binary') delta = [sigmoid(out[0]!) - target[index]!]
        else delta = softmax(out).map((prob, c) => prob - (c === target[index] ? 1 : 0))
        for (let l = layers.length - 1; l >= 0; l--) {
          const input = activations[l]!
          for (let unit = 0; unit < delta.length; unit++) {
            gradB[l]![unit]! += delta[unit]!
            for (let j = 0; j < input.length; j++) gradW[l]![unit]![j]! += delta[unit]! * input[j]!
          }
          if (l > 0) {
            const next = new Array<number>(input.length).fill(0)
            for (let j = 0; j < input.length; j++) {
              if (input[j]! <= 0) continue
              let s = 0
              for (let unit = 0; unit < delta.length; unit++) s += layers[l]!.w[unit]![j]! * delta[unit]!
              next[j] = s
            }
            delta = next
          }
        }
      }
      step++
      const b1 = 0.9
      const b2 = 0.999
      layers.forEach((layer, l) => {
        layer.w.forEach((row, unit) => row.forEach((weight, j) => {
          const g = gradW[l]![unit]![j]! / members.length + l2 * weight
          m[l]!.w[unit]![j] = b1 * m[l]!.w[unit]![j]! + (1 - b1) * g
          v[l]!.w[unit]![j] = b2 * v[l]!.w[unit]![j]! + (1 - b2) * g * g
          row[j] = weight - (lr * (m[l]!.w[unit]![j]! / (1 - b1 ** step))) / (Math.sqrt(v[l]!.w[unit]![j]! / (1 - b2 ** step)) + 1e-8)
        }))
        layer.b.forEach((bias, unit) => {
          const g = gradB[l]![unit]! / members.length
          m[l]!.b[unit] = b1 * m[l]!.b[unit]! + (1 - b1) * g
          v[l]!.b[unit] = b2 * v[l]!.b[unit]! + (1 - b2) * g * g
          layer.b[unit] = bias - (lr * (m[l]!.b[unit]! / (1 - b1 ** step))) / (Math.sqrt(v[l]!.b[unit]! / (1 - b2 ** step)) + 1e-8)
        })
      })
    }
    if (validation.length) {
      const current = mean(validation.map((index) => outputLoss(forward(x[index]!).at(-1)!, target[index]!)))
      if (current < best - 1e-6) {
        best = current
        bestLayers = JSON.parse(JSON.stringify(layers)) as typeof layers
        stale = 0
      } else if (++stale >= 15) break
    } else bestLayers = layers
  }
  return { layers: bestLayers, yMean, ySd, epochsRun }
}

function mlpForward(state: MlpState, row: number[]): number[] {
  let input = row
  state.layers.forEach((layer, index) => {
    const z = layer.w.map((weights, unit) => weights.reduce((total, weight, j) => total + weight * input[j]!, layer.b[unit]!))
    input = index === state.layers.length - 1 ? z : z.map((value) => Math.max(0, value))
  })
  return input
}

// ================================================================ dispatch

export function fitModel(algorithm: Algorithm, task: Task, x: number[][], y: number[], classes: number, params: Params = {}, seed = 42): FittedModel {
  if (!ALGORITHMS[algorithm]) throw new Error(`unknown algorithm "${algorithm}"; available: ${Object.keys(ALGORITHMS).join(', ')}`)
  if (!ALGORITHMS[algorithm].tasks.includes(task)) throw new Error(`${algorithm} does not support ${task} tasks`)
  if (x.length === 0) throw new Error('no training rows')
  const rng = createRng(seed)
  const d = x[0]!.length
  const cleanParams = Object.fromEntries(Object.entries(params).filter(([, value]) => ['number', 'string', 'boolean'].includes(typeof value) || Array.isArray(value))) as FittedModel['params']
  const base = { algorithm, task, classes, params: cleanParams, notes: [] as string[] }
  switch (algorithm) {
    case 'baseline':
      return { ...base, state: task === 'regression' ? { mean: mean(y) } : { priors: classPriors(y, classes) } }
    case 'linear':
    case 'ridge': {
      const state = fitRidge(x, y, algorithm === 'linear' ? 1e-8 : p(params, 'alpha', 1))
      return { ...base, state, featureImportance: normalizedAbs(state.coefficients) }
    }
    case 'lasso':
    case 'elastic_net': {
      const state = fitElasticNet(x, y, p(params, 'alpha', 0.01), algorithm === 'lasso' ? 1 : p(params, 'l1Ratio', 0.5))
      const zeroed = state.coefficients.filter((value) => value === 0).length
      return { ...base, state, featureImportance: normalizedAbs(state.coefficients), notes: zeroed ? [`${zeroed} of ${d} coefficients shrunk exactly to zero`] : [] }
    }
    case 'logistic': {
      const c = p(params, 'C', 1)
      const weights = params.classWeight === 'balanced' ? balancedWeights(y, classes) : undefined
      const models = classes === 2 ? [fitBinaryLogistic(x, y, c, weights)] : Array.from({ length: classes }, (_, positive) => fitBinaryLogistic(x, y.map((label) => (label === positive ? 1 : 0)), c, weights))
      return { ...base, state: { models }, featureImportance: normalizedAbs(models.reduce((sums, model) => sums.map((value, j) => value + Math.abs(model.coefficients[j]!)), new Array<number>(d).fill(0))) }
    }
    case 'decision_tree': {
      const { trees } = fitDecisionTree(x, y, task, classes, params, rng)
      return { ...base, state: { trees }, featureImportance: importanceFromTrees(trees, d) }
    }
    case 'random_forest': {
      const { trees, oobScore } = fitRandomForest(x, y, task, classes, params, rng)
      return { ...base, state: { trees, oobScore }, featureImportance: importanceFromTrees(trees, d), notes: oobScore === null ? [] : [`out-of-bag ${task === 'regression' ? 'R²' : 'accuracy'} ${oobScore.toFixed(4)}`] }
    }
    case 'gradient_boosting': {
      const state = fitGradientBoosting(x, y, task, classes, params, rng)
      const { validationCurve, ...saved } = state
      return { ...base, state: saved, featureImportance: importanceFromTrees(state.trees.flat(), d), notes: [`${state.bestIteration} boosting rounds kept${validationCurve.length ? ' (early stopping on a 10% internal validation split)' : ''}`] }
    }
    case 'knn': {
      const cap = Math.floor(p(params, 'maxTrainRows', 20_000))
      const rows = x.length > cap ? rng.shuffle(Array.from({ length: x.length }, (_, index) => index)).slice(0, cap) : Array.from({ length: x.length }, (_, index) => index)
      const state: KnnState = { x: rows.map((index) => x[index]!), y: rows.map((index) => y[index]!), k: Math.max(1, Math.min(Math.floor(p(params, 'k', 15)), rows.length)), distanceWeighted: params.weights === 'distance' }
      return { ...base, state, notes: x.length > cap ? [`k-NN keeps a random ${cap} of ${x.length} training rows for tractable prediction`] : [] }
    }
    case 'naive_bayes':
      return { ...base, state: fitNaiveBayes(x, y, classes) }
    case 'linear_svm': {
      const state = fitLinearSvm(x, y, classes, params, rng)
      return { ...base, state, featureImportance: normalizedAbs(state.models.reduce((sums, model) => sums.map((value, j) => value + Math.abs(model.w[j]!)), new Array<number>(d).fill(0))) }
    }
    case 'mlp': {
      const state = fitMlp(x, y, task, classes, params, rng)
      return { ...base, state, notes: [`trained ${state.epochsRun} epochs with early stopping`] }
    }
  }
}

function normalizedAbs(values: number[]): number[] {
  const total = values.reduce((sum, value) => sum + Math.abs(value), 0)
  return values.map((value) => (total > 0 ? Math.abs(value) / total : 0))
}

function balancedWeights(y: number[], k: number): number[] {
  const priors = classPriors(y, k)
  return y.map((label) => 1 / (k * Math.max(priors[label]!, 1e-12)))
}

export function predictModel(model: FittedModel, x: number[][]): Prediction {
  const { task, classes } = model
  switch (model.algorithm) {
    case 'baseline': {
      if (task === 'regression') return { values: x.map(() => (model.state as { mean: number }).mean) }
      const priors = (model.state as { priors: number[] }).priors
      return { values: x.map(() => argmax(priors)), probabilities: x.map(() => [...priors]) }
    }
    case 'linear':
    case 'ridge':
    case 'lasso':
    case 'elastic_net':
      return { values: linearPredict(model.state as LinearState, x) }
    case 'logistic': {
      const { models } = model.state as { models: LinearState[] }
      const probabilities = classes === 2
        ? linearPredict(models[0]!, x).map((score) => [1 - sigmoid(score), sigmoid(score)])
        : x.map((row) => {
            const scores = models.map((m) => sigmoid(linearPredict(m, [row])[0]!))
            const total = scores.reduce((a, b) => a + b, 0) || 1
            return scores.map((score) => score / total)
          })
      return { values: probabilities.map(argmax), probabilities }
    }
    case 'decision_tree':
    case 'random_forest': {
      const { trees } = model.state as { trees: Tree[] }
      if (task === 'regression') return { values: x.map((row) => mean(trees.map((tree) => tree.value[treeLeaf(tree, row)]![0]!))) }
      const probabilities = x.map((row) => {
        const sums = new Array<number>(classes).fill(0)
        for (const tree of trees) tree.value[treeLeaf(tree, row)]!.forEach((value, c) => { sums[c]! += value })
        return sums.map((value) => value / trees.length)
      })
      return { values: probabilities.map(argmax), probabilities }
    }
    case 'gradient_boosting': {
      const state = model.state as BoostState
      const raw = x.map((row) => {
        const out = [...state.init]
        for (const round of state.trees) round.forEach((tree, output) => { out[output]! += tree.value[treeLeaf(tree, row)]![0]! })
        return out
      })
      if (task === 'regression') return { values: raw.map((row) => row[0]!) }
      const probabilities = task === 'binary' ? raw.map((row) => { const prob = sigmoid(row[0]!); return [1 - prob, prob] }) : raw.map(softmax)
      return { values: probabilities.map(argmax), probabilities }
    }
    case 'knn':
      return knnPredict(model.state as KnnState, x, task, classes)
    case 'naive_bayes':
      return naiveBayesPredict(model.state as NaiveBayesState, x)
    case 'linear_svm':
      return svmPredict(model.state as SvmState, x, classes)
    case 'mlp': {
      const state = model.state as MlpState
      const outputs = x.map((row) => mlpForward(state, row))
      if (task === 'regression') return { values: outputs.map((out) => out[0]! * state.ySd + state.yMean) }
      const probabilities = task === 'binary' ? outputs.map((out) => { const prob = sigmoid(out[0]!); return [1 - prob, prob] }) : outputs.map(softmax)
      return { values: probabilities.map(argmax), probabilities }
    }
  }
}

/**
 * Local explanation of one row: exact additive contributions for linear models, Saabas
 * path contributions for tree models (averaged over trees), and a one-at-a-time baseline
 * substitution for the rest. Returned in the model's raw output space (value, log-odds, …).
 */
export function explainRow(model: FittedModel, row: number[], baseline: number[]): { method: string; bias: number; contributions: number[] } {
  const d = row.length
  switch (model.algorithm) {
    case 'linear':
    case 'ridge':
    case 'lasso':
    case 'elastic_net': {
      const state = model.state as LinearState
      const bias = state.intercept + state.coefficients.reduce((total, c, j) => total + c * baseline[j]!, 0)
      return { method: 'exact linear contributions β·(x − baseline)', bias, contributions: state.coefficients.map((c, j) => c * (row[j]! - baseline[j]!)) }
    }
    case 'logistic': {
      const state = (model.state as { models: LinearState[] }).models[model.classes === 2 ? 0 : 0]!
      const bias = state.intercept + state.coefficients.reduce((total, c, j) => total + c * baseline[j]!, 0)
      return { method: `exact log-odds contributions β·(x − baseline)${model.classes > 2 ? ' for class 0 (one-vs-rest)' : ''}`, bias, contributions: state.coefficients.map((c, j) => c * (row[j]! - baseline[j]!)) }
    }
    case 'decision_tree':
    case 'random_forest':
    case 'gradient_boosting': {
      const output = model.task === 'binary' && model.algorithm !== 'gradient_boosting' ? 1 : 0
      const trees = model.algorithm === 'gradient_boosting' ? (model.state as BoostState).trees.map((round) => round[0]!) : (model.state as { trees: Tree[] }).trees
      const contributions = new Array<number>(d).fill(0)
      let bias = 0
      for (const tree of trees) {
        const result = treeContributions(tree, row, output)
        bias += result.bias
        for (const [feature, value] of result.contributions) contributions[feature]! += value
      }
      if (model.algorithm === 'gradient_boosting') bias += (model.state as BoostState).init[0]!
      else {
        bias /= trees.length
        for (let j = 0; j < d; j++) contributions[j]! /= trees.length
      }
      return { method: model.algorithm === 'gradient_boosting' ? `tree path contributions (Saabas) in ${model.task === 'regression' ? 'target units' : 'log-odds'}${model.task === 'multiclass' ? ' for class 0' : ''}` : 'tree path contributions (Saabas), averaged over trees', bias, contributions }
    }
    default: {
      const output = (values: number[][]) => {
        const prediction = predictModel(model, values)
        return prediction.probabilities ? prediction.probabilities.map((probs) => probs[model.classes === 2 ? 1 : prediction.values[0]!]!) : prediction.values
      }
      const full = output([row])[0]!
      const bias = output([baseline])[0]!
      const contributions = Array.from({ length: d }, (_, j) => {
        const substituted = [...row]
        substituted[j] = baseline[j]!
        return full - output([substituted])[0]!
      })
      return { method: 'one-at-a-time substitution with the training median/mode (approximate; contributions need not sum to the prediction)', bias, contributions }
    }
  }
}

export { inverseSPD, argmax, sigmoid }
