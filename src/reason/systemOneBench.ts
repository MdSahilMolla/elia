import { CORPUS } from '../gap/corpus.ts'
import type { PlantedDefect } from '../gap/types.ts'
import { predictLabelled, type PredictResult, type YesNo } from './systemOne.ts'

/**
 * Scores Jev on the gap ladder's planted-defect corpus, where the right answer
 * is known: each defect ships a clean control and a defective variant. This is
 * the one place Jev can be measured without waiting for real turns to fail, so
 * `elia jev bench` is the first thing to run with a new key.
 */

export interface BenchRow {
  defectId: string
  variant: 'clean' | 'defective'
  expectedCatch: string
  result?: PredictResult
}

export const REVIEW_QUESTION: YesNo = {
  instructions: 'The code in files is correct.',
  criteria: {
    true: 'No bug, security hole, or behaviour that contradicts what the code evidently intends',
    false: 'Contains a bug, a security hole, or behaviour that contradicts what the code evidently intends',
  },
}

export async function runSystemOneBench(options: { corpus?: PlantedDefect[]; signal?: AbortSignal; onRow?: (row: BenchRow) => void } = {}): Promise<BenchRow[]> {
  const rows: BenchRow[] = []
  for (const defect of options.corpus ?? CORPUS) {
    for (const variant of ['clean', 'defective'] as const) {
      if (options.signal?.aborted) return rows
      // Only the files: the corpus's own summary names the defect.
      const state = { files: defect[variant] }
      const result = await predictLabelled('critic-defect', state, REVIEW_QUESTION, variant === 'clean', { timeoutMs: 10_000, signal: options.signal })
      const row: BenchRow = { defectId: defect.id, variant, expectedCatch: defect.expectedCatch, result }
      rows.push(row)
      options.onRow?.(row)
    }
  }
  return rows
}
