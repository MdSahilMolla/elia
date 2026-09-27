/** Derivative-free minimisation (Nelder–Mead) for smoothing parameters, ARIMA CSS, and similar small problems. */
export function nelderMead(f: (x: number[]) => number, start: number[], options: { step?: number; maxIterations?: number; tolerance?: number; lower?: number[]; upper?: number[] } = {}): { x: number[]; value: number; iterations: number } {
  const n = start.length
  const clamp = (x: number[]) => x.map((value, index) => Math.min(options.upper?.[index] ?? Number.POSITIVE_INFINITY, Math.max(options.lower?.[index] ?? Number.NEGATIVE_INFINITY, value)))
  const evaluate = (x: number[]) => {
    const value = f(clamp(x))
    return Number.isFinite(value) ? value : Number.POSITIVE_INFINITY
  }
  const step = options.step ?? 0.1
  let simplex = [clamp(start), ...start.map((_, index) => clamp(start.map((value, j) => (j === index ? value + (value === 0 ? step : step * Math.max(1, Math.abs(value))) : value))))]
  let values = simplex.map(evaluate)
  const maxIterations = options.maxIterations ?? 200 * n
  let iteration = 0
  for (; iteration < maxIterations; iteration++) {
    const order = values.map((value, index) => ({ value, index })).sort((a, b) => a.value - b.value)
    simplex = order.map(({ index }) => simplex[index]!)
    values = order.map(({ value }) => value)
    if (Math.abs(values[n]! - values[0]!) <= (options.tolerance ?? 1e-10) * (Math.abs(values[0]!) + 1e-12)) break
    const centroid = Array.from({ length: n }, (_, j) => simplex.slice(0, n).reduce((total, point) => total + point[j]!, 0) / n)
    const worst = simplex[n]!
    const reflect = clamp(centroid.map((value, j) => value + (value - worst[j]!)))
    const reflectValue = evaluate(reflect)
    if (reflectValue < values[0]!) {
      const expand = clamp(centroid.map((value, j) => value + 2 * (value - worst[j]!)))
      const expandValue = evaluate(expand)
      if (expandValue < reflectValue) { simplex[n] = expand; values[n] = expandValue } else { simplex[n] = reflect; values[n] = reflectValue }
    } else if (reflectValue < values[n - 1]!) {
      simplex[n] = reflect
      values[n] = reflectValue
    } else {
      const contract = clamp(centroid.map((value, j) => value + 0.5 * (worst[j]! - value)))
      const contractValue = evaluate(contract)
      if (contractValue < values[n]!) { simplex[n] = contract; values[n] = contractValue } else {
        for (let i = 1; i <= n; i++) {
          simplex[i] = clamp(simplex[i]!.map((value, j) => simplex[0]![j]! + 0.5 * (value - simplex[0]![j]!)))
          values[i] = evaluate(simplex[i]!)
        }
      }
    }
  }
  const best = values.indexOf(Math.min(...values))
  return { x: clamp(simplex[best]!), value: values[best]!, iterations: iteration }
}
