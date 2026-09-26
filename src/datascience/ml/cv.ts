import type { Rng } from '../rng.ts'

/**
 * Resampling plans. Every split is a list of row indices so the same plan can be reused
 * across candidate models (a fair comparison) and written into the execution record.
 */

export interface Fold {
  train: number[]
  test: number[]
}

export type CvStrategy = 'kfold' | 'stratified' | 'group' | 'timeseries'

export function kFold(n: number, k: number, rng: Rng): Fold[] {
  const order = rng.shuffle(Array.from({ length: n }, (_, index) => index))
  return Array.from({ length: k }, (_, fold) => {
    const test = order.filter((_, position) => position % k === fold)
    const testSet = new Set(test)
    return { train: order.filter((index) => !testSet.has(index)), test }
  })
}

export function stratifiedKFold(labels: number[], k: number, rng: Rng): Fold[] {
  const byClass = new Map<number, number[]>()
  labels.forEach((label, index) => byClass.set(label, [...(byClass.get(label) ?? []), index]))
  const assignment = new Array<number>(labels.length)
  let offset = 0
  for (const indices of byClass.values()) {
    rng.shuffle(indices).forEach((index, position) => { assignment[index] = (position + offset) % k })
    offset += indices.length
  }
  return Array.from({ length: k }, (_, fold) => ({ train: assignment.flatMap((f, index) => (f === fold ? [] : [index])), test: assignment.flatMap((f, index) => (f === fold ? [index] : [])) }))
}

/** Folds that never split a group across train and test (e.g. all rows of one customer together). */
export function groupKFold(groups: string[], k: number, rng: Rng): Fold[] {
  const unique = rng.shuffle([...new Set(groups)])
  if (unique.length < k) throw new Error(`group k-fold needs at least ${k} groups, found ${unique.length}`)
  const sizes = new Map<string, number>()
  for (const group of groups) sizes.set(group, (sizes.get(group) ?? 0) + 1)
  const foldOf = new Map<string, number>()
  const load = new Array<number>(k).fill(0)
  for (const group of unique.sort((a, b) => sizes.get(b)! - sizes.get(a)!)) {
    const fold = load.indexOf(Math.min(...load))
    foldOf.set(group, fold)
    load[fold]! += sizes.get(group)!
  }
  return Array.from({ length: k }, (_, fold) => ({ train: groups.flatMap((g, index) => (foldOf.get(g) === fold ? [] : [index])), test: groups.flatMap((g, index) => (foldOf.get(g) === fold ? [index] : [])) }))
}

/**
 * Expanding-window time-series splits over rows already ordered by time: each fold trains on
 * everything before its test block (minus an optional gap), never on the future.
 */
export function timeSeriesSplit(n: number, k: number, gap = 0, testSize?: number): Fold[] {
  const size = testSize ?? Math.floor(n / (k + 1))
  if (size < 1) throw new Error('too few rows for time-series cross-validation')
  const folds: Fold[] = []
  for (let fold = 0; fold < k; fold++) {
    const testStart = n - (k - fold) * size
    const trainEnd = testStart - gap
    if (trainEnd < 2) continue
    folds.push({ train: Array.from({ length: trainEnd }, (_, index) => index), test: Array.from({ length: size }, (_, index) => testStart + index) })
  }
  if (folds.length === 0) throw new Error('no valid time-series folds: too few rows for this many folds and gap')
  return folds
}

/** A single holdout split: random (optionally stratified or grouped) or the most recent rows for time-ordered data. */
export function holdout(n: number, fraction: number, rng: Rng, options: { labels?: number[]; groups?: string[]; timeOrdered?: boolean } = {}): Fold {
  const testCount = Math.max(1, Math.round(n * fraction))
  if (options.timeOrdered) return { train: Array.from({ length: n - testCount }, (_, index) => index), test: Array.from({ length: testCount }, (_, index) => n - testCount + index) }
  if (options.groups) {
    const sizes = new Map<string, number>()
    for (const group of options.groups) sizes.set(group, (sizes.get(group) ?? 0) + 1)
    const unique = rng.shuffle([...sizes.keys()])
    const testGroups = new Set<string>()
    let count = 0
    for (const group of unique) {
      if (count >= testCount) break
      testGroups.add(group)
      count += sizes.get(group)!
    }
    return { train: options.groups.flatMap((g, index) => (testGroups.has(g) ? [] : [index])), test: options.groups.flatMap((g, index) => (testGroups.has(g) ? [index] : [])) }
  }
  if (options.labels) {
    const test: number[] = []
    const byClass = new Map<number, number[]>()
    options.labels.forEach((label, index) => byClass.set(label, [...(byClass.get(label) ?? []), index]))
    for (const indices of byClass.values()) test.push(...rng.shuffle(indices).slice(0, Math.max(1, Math.round(indices.length * fraction))))
    const testSet = new Set(test)
    return { train: Array.from({ length: n }, (_, index) => index).filter((index) => !testSet.has(index)), test: test.sort((a, b) => a - b) }
  }
  const order = rng.shuffle(Array.from({ length: n }, (_, index) => index))
  return { train: order.slice(testCount).sort((a, b) => a - b), test: order.slice(0, testCount).sort((a, b) => a - b) }
}

export function describeStrategy(strategy: CvStrategy, k: number, extra = ''): string {
  switch (strategy) {
    case 'kfold': return `${k}-fold cross-validation (shuffled)${extra}`
    case 'stratified': return `stratified ${k}-fold cross-validation (class proportions preserved)${extra}`
    case 'group': return `group ${k}-fold cross-validation (no group appears in both train and test)${extra}`
    case 'timeseries': return `expanding-window time-series cross-validation with ${k} folds (always train on the past, test on the future)${extra}`
  }
}
