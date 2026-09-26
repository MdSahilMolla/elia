/**
 * Dense linear algebra for the regression, GLM, PCA, and ML code. Matrices are row-major
 * `number[][]`; sizes here are "features × features" or "rows × features" of a tabular
 * dataset, so clarity wins over BLAS-level tricks.
 */
export type Matrix = number[][]
export type Vector = number[]

export function zeros(rows: number, cols: number): Matrix {
  return Array.from({ length: rows }, () => new Array<number>(cols).fill(0))
}

export function identity(n: number): Matrix {
  const out = zeros(n, n)
  for (let index = 0; index < n; index++) out[index]![index] = 1
  return out
}

export function transpose(a: Matrix): Matrix {
  if (a.length === 0) return []
  const out = zeros(a[0]!.length, a.length)
  for (let i = 0; i < a.length; i++) for (let j = 0; j < a[0]!.length; j++) out[j]![i] = a[i]![j]!
  return out
}

export function matMul(a: Matrix, b: Matrix): Matrix {
  const n = a.length
  const m = b[0]?.length ?? 0
  const k = b.length
  const out = zeros(n, m)
  for (let i = 0; i < n; i++) {
    const row = a[i]!
    const target = out[i]!
    for (let p = 0; p < k; p++) {
      const value = row[p]!
      if (value === 0) continue
      const other = b[p]!
      for (let j = 0; j < m; j++) target[j]! += value * other[j]!
    }
  }
  return out
}

export function matVec(a: Matrix, v: Vector): Vector {
  return a.map((row) => {
    let sum = 0
    for (let index = 0; index < row.length; index++) sum += row[index]! * v[index]!
    return sum
  })
}

export function dot(a: Vector, b: Vector): number {
  let sum = 0
  for (let index = 0; index < a.length; index++) sum += a[index]! * b[index]!
  return sum
}

/** X'WX for a design matrix X (n×p) and optional row weights. */
export function gram(x: Matrix, weights?: Vector): Matrix {
  const p = x[0]?.length ?? 0
  const out = zeros(p, p)
  for (let r = 0; r < x.length; r++) {
    const row = x[r]!
    const w = weights ? weights[r]! : 1
    if (w === 0) continue
    for (let i = 0; i < p; i++) {
      const wi = w * row[i]!
      if (wi === 0) continue
      const target = out[i]!
      for (let j = i; j < p; j++) target[j]! += wi * row[j]!
    }
  }
  for (let i = 0; i < p; i++) for (let j = 0; j < i; j++) out[i]![j] = out[j]![i]!
  return out
}

/** X'Wy. */
export function crossVec(x: Matrix, y: Vector, weights?: Vector): Vector {
  const p = x[0]?.length ?? 0
  const out = new Array<number>(p).fill(0)
  for (let r = 0; r < x.length; r++) {
    const w = (weights ? weights[r]! : 1) * y[r]!
    if (w === 0) continue
    const row = x[r]!
    for (let i = 0; i < p; i++) out[i]! += row[i]! * w
  }
  return out
}

export class SingularMatrixError extends Error {
  constructor(message = 'matrix is singular or not positive definite') {
    super(message)
    this.name = 'SingularMatrixError'
  }
}

/** Cholesky factor L of a symmetric positive-definite matrix (A = L Lᵀ). */
export function cholesky(a: Matrix): Matrix {
  const n = a.length
  const l = zeros(n, n)
  const scale = Math.max(1e-300, ...a.map((row, index) => Math.abs(row[index]!)))
  for (let i = 0; i < n; i++) {
    for (let j = 0; j <= i; j++) {
      let sum = a[i]![j]!
      for (let k = 0; k < j; k++) sum -= l[i]![k]! * l[j]![k]!
      if (i === j) {
        if (sum <= scale * 1e-13) throw new SingularMatrixError()
        l[i]![j] = Math.sqrt(sum)
      } else {
        l[i]![j] = sum / l[j]![j]!
      }
    }
  }
  return l
}

export function choleskySolve(l: Matrix, b: Vector): Vector {
  const n = l.length
  const y = new Array<number>(n).fill(0)
  for (let i = 0; i < n; i++) {
    let sum = b[i]!
    for (let k = 0; k < i; k++) sum -= l[i]![k]! * y[k]!
    y[i] = sum / l[i]![i]!
  }
  const x = new Array<number>(n).fill(0)
  for (let i = n - 1; i >= 0; i--) {
    let sum = y[i]!
    for (let k = i + 1; k < n; k++) sum -= l[k]![i]! * x[k]!
    x[i] = sum / l[i]![i]!
  }
  return x
}

export function inverseSPD(a: Matrix): Matrix {
  const l = cholesky(a)
  const n = a.length
  const out = zeros(n, n)
  for (let column = 0; column < n; column++) {
    const unit = new Array<number>(n).fill(0)
    unit[column] = 1
    const solution = choleskySolve(l, unit)
    for (let row = 0; row < n; row++) out[row]![column] = solution[row]!
  }
  return out
}

/** Solves A x = b for a general square matrix by LU with partial pivoting. */
export function solve(a: Matrix, b: Vector): Vector {
  const n = a.length
  const m = a.map((row, index) => [...row, b[index]!])
  for (let column = 0; column < n; column++) {
    let pivot = column
    for (let row = column + 1; row < n; row++) if (Math.abs(m[row]![column]!) > Math.abs(m[pivot]![column]!)) pivot = row
    if (Math.abs(m[pivot]![column]!) < 1e-14) throw new SingularMatrixError()
    ;[m[column], m[pivot]] = [m[pivot]!, m[column]!]
    for (let row = column + 1; row < n; row++) {
      const factor = m[row]![column]! / m[column]![column]!
      if (factor === 0) continue
      for (let k = column; k <= n; k++) m[row]![k]! -= factor * m[column]![k]!
    }
  }
  const x = new Array<number>(n).fill(0)
  for (let row = n - 1; row >= 0; row--) {
    let sum = m[row]![n]!
    for (let k = row + 1; k < n; k++) sum -= m[row]![k]! * x[k]!
    x[row] = sum / m[row]![row]!
  }
  return x
}

export function inverse(a: Matrix): Matrix {
  const n = a.length
  const out = zeros(n, n)
  for (let column = 0; column < n; column++) {
    const unit = new Array<number>(n).fill(0)
    unit[column] = 1
    const solution = solve(a, unit)
    for (let row = 0; row < n; row++) out[row]![column] = solution[row]!
  }
  return out
}

/**
 * Finds columns that are (numerically) linear combinations of earlier ones, the way R's
 * `lm` marks aliased coefficients. Returns the indices to keep and the aliased ones.
 */
export function independentColumns(x: Matrix, tolerance = 1e-9): { keep: number[]; aliased: number[] } {
  const p = x[0]?.length ?? 0
  const basis: Vector[] = []
  const keep: number[] = []
  const aliased: number[] = []
  for (let column = 0; column < p; column++) {
    const v = x.map((row) => row[column]!)
    const norm = Math.sqrt(dot(v, v))
    if (norm === 0) {
      aliased.push(column)
      continue
    }
    const residual = [...v]
    for (const q of basis) {
      const projection = dot(residual, q)
      for (let index = 0; index < residual.length; index++) residual[index]! -= projection * q[index]!
    }
    const residualNorm = Math.sqrt(dot(residual, residual))
    if (residualNorm <= tolerance * norm) {
      aliased.push(column)
      continue
    }
    basis.push(residual.map((value) => value / residualNorm))
    keep.push(column)
  }
  return { keep, aliased }
}

/**
 * Eigen-decomposition of a symmetric matrix by cyclic Jacobi rotations. Returns eigenvalues
 * in descending order with unit eigenvectors as columns (vectors[i] is the i-th eigenvector).
 */
export function symmetricEigen(a: Matrix, maxSweeps = 100): { values: number[]; vectors: Vector[] } {
  const n = a.length
  const m = a.map((row) => [...row])
  const v = identity(n)
  for (let sweep = 0; sweep < maxSweeps; sweep++) {
    let off = 0
    for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) off += m[i]![j]! ** 2
    if (off < 1e-22) break
    for (let p = 0; p < n; p++) {
      for (let q = p + 1; q < n; q++) {
        const apq = m[p]![q]!
        if (Math.abs(apq) < 1e-300) continue
        const theta = (m[q]![q]! - m[p]![p]!) / (2 * apq)
        const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1))
        const c = 1 / Math.sqrt(t * t + 1)
        const s = t * c
        for (let k = 0; k < n; k++) {
          const mkp = m[k]![p]!
          const mkq = m[k]![q]!
          m[k]![p] = c * mkp - s * mkq
          m[k]![q] = s * mkp + c * mkq
        }
        for (let k = 0; k < n; k++) {
          const mpk = m[p]![k]!
          const mqk = m[q]![k]!
          m[p]![k] = c * mpk - s * mqk
          m[q]![k] = s * mpk + c * mqk
        }
        for (let k = 0; k < n; k++) {
          const vkp = v[k]![p]!
          const vkq = v[k]![q]!
          v[k]![p] = c * vkp - s * vkq
          v[k]![q] = s * vkp + c * vkq
        }
      }
    }
  }
  const order = Array.from({ length: n }, (_, index) => index).sort((i, j) => m[j]![j]! - m[i]![i]!)
  return {
    values: order.map((index) => m[index]![index]!),
    vectors: order.map((index) => {
      const vector = v.map((row) => row[index]!)
      // Deterministic sign: the largest-magnitude loading is positive.
      const largest = vector.reduce((best, value) => (Math.abs(value) > Math.abs(best) ? value : best), 0)
      return largest < 0 ? vector.map((value) => -value) : vector
    }),
  }
}

/** Ratio of the largest to smallest singular value of X (via eigenvalues of X'X). */
export function conditionNumber(x: Matrix): number {
  const { values } = symmetricEigen(gram(x))
  const max = values[0] ?? 0
  const min = values.at(-1) ?? 0
  return min <= 0 ? Number.POSITIVE_INFINITY : Math.sqrt(max / min)
}
