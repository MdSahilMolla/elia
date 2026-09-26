/**
 * Multiple-testing correction. Family-wise error control (Bonferroni, Holm, Hochberg) and
 * false-discovery-rate control (Benjamini–Hochberg, Benjamini–Yekutieli); adjusted p-values
 * match statsmodels' `multipletests`.
 */
export type CorrectionMethod = 'bonferroni' | 'holm' | 'hochberg' | 'fdr_bh' | 'fdr_by' | 'none'

export const CORRECTION_METHODS: CorrectionMethod[] = ['bonferroni', 'holm', 'hochberg', 'fdr_bh', 'fdr_by', 'none']

export function adjustPValues(pValues: number[], method: CorrectionMethod = 'holm'): number[] {
  const m = pValues.length
  if (m === 0) return []
  if (pValues.some((p) => !(p >= 0 && p <= 1))) throw new Error('p-values must be between 0 and 1')
  const order = pValues.map((p, index) => ({ p, index })).sort((a, b) => a.p - b.p)
  const adjusted = new Array<number>(m)
  switch (method) {
    case 'none':
      return [...pValues]
    case 'bonferroni':
      return pValues.map((p) => Math.min(1, p * m))
    case 'holm': {
      let running = 0
      order.forEach(({ p, index }, rank) => {
        running = Math.max(running, Math.min(1, (m - rank) * p))
        adjusted[index] = running
      })
      return adjusted
    }
    case 'hochberg': {
      let running = 1
      for (let rank = m - 1; rank >= 0; rank--) {
        const { p, index } = order[rank]!
        running = Math.min(running, Math.min(1, (m - rank) * p))
        adjusted[index] = running
      }
      return adjusted
    }
    case 'fdr_bh':
    case 'fdr_by': {
      const c = method === 'fdr_by' ? Array.from({ length: m }, (_, k) => 1 / (k + 1)).reduce((a, b) => a + b, 0) : 1
      let running = 1
      for (let rank = m - 1; rank >= 0; rank--) {
        const { p, index } = order[rank]!
        running = Math.min(running, Math.min(1, (p * m * c) / (rank + 1)))
        adjusted[index] = running
      }
      return adjusted
    }
  }
}

export function parseCorrection(value: unknown): CorrectionMethod {
  if (value === undefined || value === null) return 'holm'
  if (typeof value === 'string' && (CORRECTION_METHODS as string[]).includes(value)) return value as CorrectionMethod
  throw new Error(`correction must be one of ${CORRECTION_METHODS.join(', ')}`)
}
