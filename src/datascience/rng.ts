/**
 * Seeded pseudo-random numbers. Every stochastic step in the engine (splits, bootstrap,
 * permutation, forests, k-means seeding, Monte Carlo) draws from one of these so that a
 * recorded seed reproduces the run exactly. `Math.random` is never used for analysis.
 */
export interface Rng {
  seed: number
  /** Uniform on [0, 1). */
  next(): number
  /** Integer on [0, n). */
  int(n: number): number
  normal(mean?: number, sd?: number): number
  shuffle<T>(items: T[]): T[]
  /** Sample `k` indices from [0, n) with replacement. */
  sampleWithReplacement(n: number, k: number): number[]
  fork(label: number): Rng
}

export const DEFAULT_SEED = 42

/** xmur3 string hash → 32-bit seed, so a label like "fold-3" can seed a stream. */
export function hashSeed(text: string): number {
  let h = 1779033703 ^ text.length
  for (let index = 0; index < text.length; index++) {
    h = Math.imul(h ^ text.charCodeAt(index), 3432918353)
    h = (h << 13) | (h >>> 19)
  }
  h = Math.imul(h ^ (h >>> 16), 2246822507)
  h = Math.imul(h ^ (h >>> 13), 3266489909)
  return (h ^= h >>> 16) >>> 0
}

/** sfc32 generator seeded through splitmix32; fast, 128-bit state, passes PractRand to large sizes. */
export function createRng(seed: number = DEFAULT_SEED): Rng {
  let state = seed >>> 0
  const splitmix = () => {
    state = (state + 0x9e3779b9) >>> 0
    let z = state
    z = Math.imul(z ^ (z >>> 16), 0x85ebca6b)
    z = Math.imul(z ^ (z >>> 13), 0xc2b2ae35)
    return (z ^ (z >>> 16)) >>> 0
  }
  let a = splitmix()
  let b = splitmix()
  let c = splitmix()
  let d = splitmix()
  const next = () => {
    a >>>= 0; b >>>= 0; c >>>= 0; d >>>= 0
    let t = (a + b) | 0
    a = b ^ (b >>> 9)
    b = (c + (c << 3)) | 0
    c = (c << 21) | (c >>> 11)
    d = (d + 1) | 0
    t = (t + d) | 0
    c = (c + t) | 0
    return (t >>> 0) / 4294967296
  }
  for (let index = 0; index < 12; index++) next()
  let spare: number | undefined
  const rng: Rng = {
    seed,
    next,
    int(n) {
      return Math.floor(next() * n)
    },
    normal(mean = 0, sd = 1) {
      if (spare !== undefined) {
        const value = spare
        spare = undefined
        return mean + sd * value
      }
      let u = 0
      let v = 0
      let s = 0
      do {
        u = next() * 2 - 1
        v = next() * 2 - 1
        s = u * u + v * v
      } while (s >= 1 || s === 0)
      const factor = Math.sqrt((-2 * Math.log(s)) / s)
      spare = v * factor
      return mean + sd * u * factor
    },
    shuffle(items) {
      const copy = [...items]
      for (let index = copy.length - 1; index > 0; index--) {
        const swap = Math.floor(next() * (index + 1))
        ;[copy[index], copy[swap]] = [copy[swap]!, copy[index]!]
      }
      return copy
    },
    sampleWithReplacement(n, k) {
      return Array.from({ length: k }, () => Math.floor(next() * n))
    },
    fork(label) {
      return createRng(hashSeed(`${seed}:${label}`))
    },
  }
  return rng
}

/** Reads a user-supplied seed, defaulting to {@link DEFAULT_SEED}; always recorded with the run. */
export function seedFrom(input: unknown): number {
  if (input === undefined || input === null) return DEFAULT_SEED
  if (typeof input !== 'number' || !Number.isInteger(input) || input < 0 || input > 2 ** 32 - 1) throw new Error('seed must be a non-negative 32-bit integer')
  return input
}
