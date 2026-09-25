import { expect, test } from 'bun:test'
import type { GenerationRecord } from './ledger.ts'
import { checkIdea, SAME_IDEA, similarIdeas } from './ideas.ts'

/** The generations this machine actually ran, as the ledger recorded them. */
const LEDGER: Array<Pick<GenerationRecord, 'generation' | 'hypothesis' | 'targetFiles' | 'verdict' | 'reason' | 'note'>> = [
  { generation: 1, hypothesis: 'Add find_symbol to SPECULABLE_TOOLS in src/speculation/cache.ts', targetFiles: ['src/speculation/cache.ts'], verdict: 'rejected', reason: 'pass rate 98% → 98%, but no task improved by more than run-to-run noise', note: 'Under the rule as fixed later this was a tie on correctness with 8.3% fewer tokens' },
  { generation: 4, hypothesis: 'Improve tool descriptions for parallelism to encourage better batching', targetFiles: ['src/tools/grep.ts', 'src/tools/listFiles.ts', 'src/tools/readFile.ts'], verdict: 'rejected', reason: 'pass rate fell 98% → 97%', note: 'The pass-rate fall was one attempt in 57, within noise.' },
  { generation: 7, hypothesis: 'Shorten tool descriptions for read_file, find_symbol, and list_files to reduce token overhead per call', targetFiles: ['src/tools/findSymbol.ts', 'src/tools/listFiles.ts', 'src/tools/readFile.ts'], verdict: 'rejected', reason: 'unit tests fail: presentation.test.ts timed out', note: 'Not evidence against the change.' },
  { generation: 8, hypothesis: 'Add file existence check to speculative cache to prevent caching non-existent files', targetFiles: ['src/speculation/cache.ts'], verdict: 'error', reason: 'the attempt could not finish: Connection error.' },
  { generation: 9, hypothesis: 'Shorten read_file tool description by ~40% to reduce fixed token cost per call', targetFiles: ['src/tools/readFile.ts'], verdict: 'rejected', reason: 'regressed on field-external-contribution', note: 'Not evidence against the change. field-external-contribution is a coin flip.' },
  { generation: 10, hypothesis: 'Simplify optional parameter descriptions in finance, brain, lsp_refactor, and paper tool schemas', targetFiles: [], verdict: 'error', reason: 'the attempt could not finish: missing finish_reason for choice 0' },
  { generation: 13, hypothesis: 'Add explicit file path verification guidance to system prompt and trim redundant verbosity', targetFiles: ['src/config.ts'], verdict: 'rejected', reason: 'no measurable improvement (pass rate unchanged at 98%, tokens +1%, time +79%)' },
  { generation: 15, hypothesis: 'Add "implement from spec" guidance to builder prompt', targetFiles: ['src/autonomy/roles.ts'], verdict: 'rejected', reason: 'could not measure hist-43597e6, hist-c6e363d — refusing to compare an incomplete benchmark' },
]

const records = LEDGER.map((entry) => ({ at: 0, rationale: '', changedFiles: [], model: 'mercury-2.5', ...entry })) as GenerationRecord[]

test('on the real ledger, only the two real repeats reach the threshold', () => {
  const titles = [...records, { ...records[0]!, generation: 16, hypothesis: 'Add "implement from spec" guidance to builder prompt' }]
  const pairs: string[] = []
  for (const record of titles) {
    const others = titles.filter((other) => other.generation < record.generation)
    for (const match of similarIdeas(record, others, others.length)) {
      if (match.textSimilarity >= SAME_IDEA) pairs.push(`${match.generation}-${record.generation}`)
    }
  }
  expect(pairs.sort()).toEqual(['15-16', '7-9'])
})

test('repeating an idea that was never judged is allowed, and said to be', () => {
  // Generation 16 was right to retry 15: the provider ran out of credit mid-comparison.
  const retry = checkIdea({ hypothesis: 'Add "implement from spec" guidance to builder prompt', targetFiles: ['src/autonomy/roles.ts'] }, records)
  expect(retry.match?.generation).toBe(15)
  expect(retry.match?.judgement).toBe('not-judged')
  expect(retry.bounce).toBeUndefined()
  // And 9 retrying 7: 7's rejection was a timeout, corrected by hand.
  expect(checkIdea({ hypothesis: 'Shorten read_file tool description by ~40% to reduce fixed token cost per call' }, records.filter((record) => record.generation < 9)).bounce).toBeUndefined()
})

test('repeating an idea that was measured and rejected goes back to the proposer, with the reason', () => {
  const repeat = checkIdea({ hypothesis: 'Add file path verification guidance to the system prompt and trim verbosity', targetFiles: ['src/config.ts'] }, records)
  expect(repeat.match?.generation).toBe(13)
  expect(repeat.bounce).toContain('the same idea as generation 13')
  expect(repeat.bounce).toContain('measured and rejected: no measurable improvement')
  expect(repeat.bounce).toContain('files 100% alike')
})

test('a different idea on the same file is not a repeat', () => {
  // Generations 1 and 8 both changed speculation/cache.ts, for unrelated reasons.
  const verdict = checkIdea({ hypothesis: 'Add file existence check to speculative cache to prevent caching non-existent files', targetFiles: ['src/speculation/cache.ts'] }, records.filter((record) => record.generation === 1))
  expect(verdict.match).toBeUndefined()
  expect(verdict.bounce).toBeUndefined()
})

test('an idea already promoted is sent back as already in the source', () => {
  const promoted = [{ ...records[6]!, generation: 20, verdict: 'promoted' as const, reason: 'pass rate 93% → 97%', note: undefined }]
  const verdict = checkIdea({ hypothesis: records[6]!.hypothesis }, promoted)
  expect(verdict.bounce).toContain('was promoted: it is already in the source')
})
