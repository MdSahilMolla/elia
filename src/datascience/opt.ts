/**
 * Linear and mixed-integer programming. A dense two-phase simplex (Bland's rule, so it
 * cannot cycle) solves the LP relaxation and reports shadow prices and reduced costs;
 * branch and bound adds integrality. Every model is stated as Objective → Variables →
 * Constraints → Solution → Sensitivity so a reader can audit the formulation.
 */

export interface LpVariable {
  name: string
  lower?: number
  upper?: number
  integer?: boolean
  binary?: boolean
}

export interface LpConstraint {
  name?: string
  coefficients: Record<string, number>
  sense: '<=' | '>=' | '='
  rhs: number
}

export interface LpProblem {
  sense: 'max' | 'min'
  objective: Record<string, number>
  variables: LpVariable[]
  constraints: LpConstraint[]
}

export interface LpSolution {
  status: 'optimal' | 'infeasible' | 'unbounded' | 'node-limit'
  objective: number | null
  values: Record<string, number>
  constraints: Array<{ name: string; activity: number; rhs: number; sense: string; slack: number; binding: boolean; shadowPrice: number | null }>
  reducedCosts: Record<string, number>
  integer: boolean
  nodes?: number
  gap?: number
  notes: string[]
}

interface StandardForm {
  columns: string[]
  rows: number[][]
  rhs: number[]
  cost: number[]
  shift: number[]
  constraintNames: string[]
  rowSign: number[]
}

const EPS = 1e-9

function simplexCore(A: number[][], b: number[], c: number[], maxIterations = 50_000): { status: 'optimal' | 'infeasible' | 'unbounded'; x: number[]; duals: number[] } {
  const m = A.length
  const n = c.length
  // Phase 1: minimise the sum of artificials, one per row (b ≥ 0 already).
  const width = n + m
  const tableau = A.map((row, i) => [...row, ...Array.from({ length: m }, (_, j) => (i === j ? 1 : 0)), b[i]!])
  let basis = Array.from({ length: m }, (_, i) => n + i)
  const pivot = (row: number, col: number) => {
    const p = tableau[row]![col]!
    const pivotRow = tableau[row]!
    for (let j = 0; j <= width; j++) pivotRow[j]! /= p
    for (let i = 0; i < m; i++) {
      if (i === row) continue
      const factor = tableau[i]![col]!
      if (Math.abs(factor) < EPS) continue
      const target = tableau[i]!
      for (let j = 0; j <= width; j++) target[j]! -= factor * pivotRow[j]!
    }
    basis[row] = col
  }
  const run = (costs: number[], allowed: (col: number) => boolean) => {
    for (let iteration = 0; iteration < maxIterations; iteration++) {
      const reduced = Array.from({ length: width }, (_, j) => costs[j]! - basis.reduce((total, bj, i) => total + costs[bj]! * tableau[i]![j]!, 0))
      let entering = -1
      for (let j = 0; j < width; j++) if (allowed(j) && reduced[j]! < -EPS) { entering = j; break }
      if (entering < 0) return 'optimal' as const
      let leaving = -1
      let best = Number.POSITIVE_INFINITY
      for (let i = 0; i < m; i++) {
        const coefficient = tableau[i]![entering]!
        if (coefficient > EPS) {
          const ratio = tableau[i]![width]! / coefficient
          if (ratio < best - EPS || (Math.abs(ratio - best) <= EPS && basis[i]! < basis[leaving]!)) { best = ratio; leaving = i }
        }
      }
      if (leaving < 0) return 'unbounded' as const
      pivot(leaving, entering)
    }
    throw new Error('simplex iteration limit reached')
  }
  const phase1 = Array.from({ length: width }, (_, j) => (j >= n ? 1 : 0))
  run(phase1, () => true)
  const infeasibility = basis.reduce((total, bj, i) => total + (bj >= n ? tableau[i]![width]! : 0), 0)
  if (infeasibility > 1e-7) return { status: 'infeasible', x: [], duals: [] }
  // Drive remaining (zero-valued) artificials out of the basis where possible.
  for (let i = 0; i < m; i++) {
    if (basis[i]! < n) continue
    const col = tableau[i]!.slice(0, n).findIndex((value) => Math.abs(value) > EPS)
    if (col >= 0) pivot(i, col)
  }
  const phase2 = [...c, ...new Array<number>(m).fill(0)]
  const status = run(phase2, (j) => j < n)
  if (status === 'unbounded') return { status, x: [], duals: [] }
  const x = new Array<number>(n).fill(0)
  basis.forEach((bj, i) => { if (bj < n) x[bj] = tableau[i]![width]! })
  // Duals y = c_B B^-1: the artificial columns hold B^-1.
  const duals = Array.from({ length: m }, (_, k) => basis.reduce((total, bj, i) => total + (bj < n ? c[bj]! : 0) * tableau[i]![n + k]!, 0))
  basis = basis.slice()
  return { status: 'optimal', x, duals }
}

function toStandard(problem: LpProblem, extraBounds: Record<string, { lower?: number; upper?: number }> = {}): StandardForm {
  const vars = problem.variables.map((variable) => ({ ...variable, lower: extraBounds[variable.name]?.lower ?? variable.lower ?? (variable.binary ? 0 : 0), upper: extraBounds[variable.name]?.upper ?? variable.upper ?? (variable.binary ? 1 : undefined) }))
  const index = new Map(vars.map((variable, i) => [variable.name, i]))
  for (const constraint of problem.constraints) for (const name of Object.keys(constraint.coefficients)) if (!index.has(name)) throw new Error(`constraint ${constraint.name ?? ''} uses unknown variable "${name}"`)
  for (const name of Object.keys(problem.objective)) if (!index.has(name)) throw new Error(`objective uses unknown variable "${name}"`)
  const shift = vars.map((variable) => (Number.isFinite(variable.lower) ? variable.lower! : 0))
  const rowsIn: Array<{ name: string; coefficients: number[]; sense: '<=' | '>=' | '='; rhs: number }> = []
  for (const [k, constraint] of problem.constraints.entries()) {
    const coefficients = vars.map((variable) => constraint.coefficients[variable.name] ?? 0)
    const offset = coefficients.reduce((total, a, j) => total + a * shift[j]!, 0)
    rowsIn.push({ name: constraint.name ?? `c${k + 1}`, coefficients, sense: constraint.sense, rhs: constraint.rhs - offset })
  }
  vars.forEach((variable, j) => {
    if (variable.upper !== undefined && Number.isFinite(variable.upper)) rowsIn.push({ name: `upper(${variable.name})`, coefficients: vars.map((_, k) => (k === j ? 1 : 0)), sense: '<=', rhs: variable.upper - shift[j]! })
  })
  const slackCount = rowsIn.filter((row) => row.sense !== '=').length
  const n = vars.length + slackCount
  const rows: number[][] = []
  const rhs: number[] = []
  const rowSign: number[] = []
  let slack = 0
  for (const row of rowsIn) {
    const full = [...row.coefficients, ...new Array<number>(slackCount).fill(0)]
    if (row.sense !== '=') { full[vars.length + slack] = row.sense === '<=' ? 1 : -1; slack++ }
    const sign = row.rhs < 0 ? -1 : 1
    rows.push(full.map((value) => value * sign))
    rhs.push(row.rhs * sign)
    rowSign.push(sign)
  }
  const direction = problem.sense === 'max' ? -1 : 1
  const cost = [...vars.map((variable) => direction * (problem.objective[variable.name] ?? 0)), ...new Array<number>(slackCount).fill(0)]
  return { columns: [...vars.map((variable) => variable.name), ...Array.from({ length: slackCount }, (_, i) => `__slack${i}`)], rows, rhs, cost: cost.slice(0, n), shift, constraintNames: rowsIn.map((row) => row.name), rowSign }
}

function solveRelaxation(problem: LpProblem, bounds: Record<string, { lower?: number; upper?: number }> = {}): LpSolution {
  const form = toStandard(problem, bounds)
  const result = simplexCore(form.rows, form.rhs, form.cost)
  const base: LpSolution = { status: result.status, objective: null, values: {}, constraints: [], reducedCosts: {}, integer: false, notes: [] }
  if (result.status !== 'optimal') return base
  const values: Record<string, number> = {}
  problem.variables.forEach((variable, j) => { values[variable.name] = result.x[j]! + form.shift[j]! })
  const objective = Object.entries(problem.objective).reduce((total, [name, coefficient]) => total + coefficient * values[name]!, 0)
  const direction = problem.sense === 'max' ? -1 : 1
  const constraints = problem.constraints.map((constraint, k) => {
    const activity = Object.entries(constraint.coefficients).reduce((total, [name, a]) => total + a * values[name]!, 0)
    const slack = constraint.sense === '<=' ? constraint.rhs - activity : constraint.sense === '>=' ? activity - constraint.rhs : 0
    return { name: constraint.name ?? `c${k + 1}`, activity, rhs: constraint.rhs, sense: constraint.sense, slack, binding: Math.abs(slack) < 1e-7, shadowPrice: direction * result.duals[k]! * form.rowSign[k]! }
  })
  const reducedCosts: Record<string, number> = {}
  problem.variables.forEach((variable, j) => {
    const column = form.rows.map((row) => row[j]!)
    reducedCosts[variable.name] = direction * (form.cost[j]! - column.reduce((total, a, i) => total + a * result.duals[i]!, 0))
  })
  return { status: 'optimal', objective, values, constraints, reducedCosts, integer: false, notes: [] }
}

export function solveLp(problem: LpProblem, options: { nodeLimit?: number } = {}): LpSolution {
  if (!problem.variables.length) throw new Error('the model needs at least one variable')
  const integers = problem.variables.filter((variable) => variable.integer || variable.binary).map((variable) => variable.name)
  if (integers.length === 0) {
    const solution = solveRelaxation(problem)
    solution.notes.push('Shadow prices give the change in the objective per unit increase of a constraint’s right-hand side, valid only within the range where the same constraints stay binding (ranging not computed).')
    return solution
  }
  const direction = problem.sense === 'max' ? 1 : -1
  let best: LpSolution | null = null
  let nodes = 0
  const nodeLimit = options.nodeLimit ?? 20_000
  const root = solveRelaxation(problem)
  if (root.status !== 'optimal') return { ...root, integer: true }
  const stack: Array<Record<string, { lower?: number; upper?: number }>> = [{}]
  while (stack.length) {
    if (++nodes > nodeLimit) break
    const bounds = stack.pop()!
    const relaxed = solveRelaxation(problem, bounds)
    if (relaxed.status !== 'optimal') continue
    if (best && direction * relaxed.objective! <= direction * best.objective! + 1e-9) continue
    const fractional = integers.find((name) => Math.abs(relaxed.values[name]! - Math.round(relaxed.values[name]!)) > 1e-7)
    if (!fractional) {
      best = relaxed
      continue
    }
    const value = relaxed.values[fractional]!
    const current = bounds[fractional] ?? {}
    const down = { ...bounds, [fractional]: { ...current, upper: Math.floor(value) } }
    const up = { ...bounds, [fractional]: { ...current, lower: Math.ceil(value) } }
    const preferUp = value - Math.floor(value) >= 0.5
    stack.push(preferUp ? down : up, preferUp ? up : down)
  }
  if (!best) return { status: nodes > nodeLimit ? 'node-limit' : 'infeasible', objective: null, values: {}, constraints: [], reducedCosts: {}, integer: true, nodes, notes: ['no integer-feasible solution found'] }
  for (const name of integers) best.values[name] = Math.round(best.values[name]!)
  const gap = Math.abs(root.objective! - best.objective!) / Math.max(1e-9, Math.abs(best.objective!))
  return { ...best, status: nodes > nodeLimit ? 'node-limit' : 'optimal', integer: true, nodes, gap, notes: [nodes > nodeLimit ? `stopped at the node limit; the solution is feasible but may not be optimal (LP bound gap ${(gap * 100).toFixed(2)}%)` : `proved optimal by branch and bound in ${nodes} nodes`, 'Shadow prices from an integer model describe the final LP relaxation only and are not reliable marginal values.'] }
}

export function describeModel(problem: LpProblem): string[] {
  const term = (coefficients: Record<string, number>) => Object.entries(coefficients).map(([name, value]) => `${value >= 0 ? '+' : '−'} ${Math.abs(value)}·${name}`).join(' ').replace(/^\+ /, '')
  return [
    `Objective: ${problem.sense === 'max' ? 'maximise' : 'minimise'} ${term(problem.objective)}`,
    `Variables: ${problem.variables.map((variable) => `${variable.name} ${variable.binary ? '∈ {0,1}' : `${variable.integer ? 'integer ' : ''}in [${variable.lower ?? 0}, ${variable.upper ?? '∞'}]`}`).join('; ')}`,
    ...problem.constraints.map((constraint, k) => `Constraint ${constraint.name ?? `c${k + 1}`}: ${term(constraint.coefficients)} ${constraint.sense} ${constraint.rhs}`),
  ]
}
