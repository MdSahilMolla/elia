import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { runShell } from '../shell.ts'

/**
 * Elia's fitness function.
 *
 * Self-improvement without measurement is just self-modification, and a model
 * asked "is your new prompt better?" will always say yes. So every candidate
 * version of elia has to earn promotion against this suite: real tasks, in real
 * temporary repositories, checked by code rather than judged by a model.
 *
 * The tasks deliberately target the competencies elia's own loop is made of —
 * editing precisely, locating a symbol, diagnosing a failure, and propagating a
 * rename — because those are what a change to the loop or the prompt can plausibly
 * improve or break. Each check is exact: file contents, exit codes, and hashes.
 * There is no partial credit and no model in the scoring path.
 */

export interface BenchCheck {
  passed: boolean
  detail: string
}

export interface BenchTask {
  id: string
  /** Relative importance in the weighted pass rate. */
  weight: number
  /** What elia is asked to do, verbatim. */
  prompt: string
  /** Builds the starting repository in `dir`. */
  setup(dir: string): Promise<void>
  /** Decides pass/fail by inspecting `dir` afterwards. Must never call a model. */
  check(dir: string): Promise<BenchCheck>
}

function write(dir: string, relativePath: string, content: string): void {
  const target = join(dir, relativePath)
  mkdirSync(dirname(target), { recursive: true })
  writeFileSync(target, content)
}

function read(dir: string, relativePath: string): string {
  try {
    return readFileSync(join(dir, relativePath), 'utf8')
  } catch {
    return ''
  }
}

const PRECISE_EDIT_SOURCE = `export function alpha(value: number): number {
  const limit = 100
  return Math.min(value, limit)
}

export function beta(value: number): number {
  const limit = 100
  return Math.min(value, limit)
}

export function gamma(value: number): number {
  const limit = 100
  return Math.min(value, limit)
}
`

const RENAME_UTILS = `export function computeTotal(items: number[]): number {
  return items.reduce((sum, item) => sum + item, 0)
}

export function average(items: number[]): number {
  return items.length === 0 ? 0 : computeTotal(items) / items.length
}
`

const COUPLED_SOURCE = `/** Decimal places used when formatting values for display. */
export const PRECISION = 2

export function formatPrice(amount: number): string {
  return amount.toFixed(PRECISION)
}

export function formatWeight(kilograms: number): string {
  return kilograms.toFixed(PRECISION)
}
`

const COUPLED_TEST = `import { expect, test } from 'bun:test'
import { formatPrice, formatWeight } from '../src/format.ts'

test('prices are formatted to 2 decimal places', () => {
  expect(formatPrice(12.3456)).toBe('12.35')
})

test('weights are formatted to 3 decimal places', () => {
  expect(formatWeight(1.23456)).toBe('1.235')
})
`

export const BENCH_TASKS: BenchTask[] = [
  {
    id: 'precise-edit',
    weight: 1,
    prompt:
      'In src/limits.ts there are three functions that each declare `const limit = 100`. Change ONLY the one inside the `beta` function so its limit is 250. Leave `alpha` and `gamma` exactly as they are. Do not reformat anything else in the file.',
    async setup(dir) {
      write(dir, 'src/limits.ts', PRECISE_EDIT_SOURCE)
    },
    async check(dir) {
      const content = read(dir, 'src/limits.ts')
      const expected = PRECISE_EDIT_SOURCE.replace(
        `export function beta(value: number): number {\n  const limit = 100`,
        `export function beta(value: number): number {\n  const limit = 250`,
      )
      if (content === expected) return { passed: true, detail: 'only beta changed, byte-for-byte' }

      const limits = [...content.matchAll(/const limit = (\d+)/g)].map((match) => match[1])
      return {
        passed: false,
        detail: `expected limits [100,250,100], found [${limits.join(',')}]${content === PRECISE_EDIT_SOURCE ? ' (file unchanged)' : ''}`,
      }
    },
  },

  {
    id: 'find-symbol',
    weight: 1,
    prompt:
      'Somewhere in this project a function named `resolveTimeout` is defined. Find where it is DEFINED (not where it is called) and write just that file\'s path, relative to the project root with forward slashes and nothing else, into a file called answer.txt at the project root.',
    async setup(dir) {
      write(dir, 'src/index.ts', "import { resolveTimeout } from './net/config.ts'\n\nresolveTimeout(5)\n")
      write(dir, 'src/net/client.ts', "import { resolveTimeout } from './config.ts'\n\nexport const t = resolveTimeout(1)\n")
      write(
        dir,
        'src/net/config.ts',
        'export function resolveTimeout(seconds: number): number {\n  return seconds * 1000\n}\n',
      )
      write(dir, 'src/util/retry.ts', '// resolveTimeout is used by the caller of this module\nexport const retries = 3\n')
      write(dir, 'docs/notes.md', 'The resolveTimeout helper lives in the net layer.\n')
    },
    async check(dir) {
      const answer = read(dir, 'answer.txt').trim().replace(/\\/g, '/').replace(/^\.\//, '')
      const passed = answer === 'src/net/config.ts'
      return { passed, detail: passed ? 'correct path' : `answer.txt contained "${answer}"` }
    },
  },

  {
    id: 'fix-failing-test',
    weight: 2,
    prompt:
      'Run the test suite with `bun test`. One test fails. Fix the source so it passes. You must NOT modify anything inside the tests directory — the test is correct and the source is wrong.',
    async setup(dir) {
      write(
        dir,
        'src/range.ts',
        `/** Returns the integers from start to end, inclusive of both ends. */
export function inclusiveRange(start: number, end: number): number[] {
  const result: number[] = []
  for (let i = start; i < end; i++) result.push(i)
  return result
}
`,
      )
      write(
        dir,
        'tests/range.test.ts',
        `import { expect, test } from 'bun:test'
import { inclusiveRange } from '../src/range.ts'

test('inclusiveRange includes both ends', () => {
  expect(inclusiveRange(1, 4)).toEqual([1, 2, 3, 4])
})

test('inclusiveRange handles a single value', () => {
  expect(inclusiveRange(3, 3)).toEqual([3])
})
`,
      )
    },
    async check(dir) {
      const testContent = read(dir, 'tests/range.test.ts')
      // The cheapest way to make a failing test pass is to change the test, so the
      // gate has to check that separately from the exit code.
      if (!testContent.includes('expect(inclusiveRange(1, 4)).toEqual([1, 2, 3, 4])')) {
        return { passed: false, detail: 'the test file was modified — that was explicitly forbidden' }
      }

      const result = await runShell('bun test', 90_000, dir)
      return {
        passed: result.exitCode === 0,
        detail: result.exitCode === 0 ? 'suite passes with the test intact' : `bun test exited ${result.exitCode}`,
      }
    },
  },

  {
    id: 'propagate-rename',
    weight: 2,
    prompt:
      'Rename the exported function `computeTotal` to `sumValues` everywhere in this project — its definition and every single call site and import. Nothing may still refer to `computeTotal` when you are done.',
    async setup(dir) {
      write(dir, 'src/utils.ts', RENAME_UTILS)
      write(
        dir,
        'src/report.ts',
        "import { computeTotal } from './utils.ts'\n\nexport function report(items: number[]): string {\n  return `total: ${computeTotal(items)}`\n}\n",
      )
      write(
        dir,
        'src/summary.ts',
        "import { average, computeTotal } from './utils.ts'\n\nexport const summary = (items: number[]) => ({\n  total: computeTotal(items),\n  mean: average(items),\n})\n",
      )
    },
    async check(dir) {
      const files = ['src/utils.ts', 'src/report.ts', 'src/summary.ts']
      const contents = files.map((file) => ({ file, content: read(dir, file) }))

      const stale = contents.filter((entry) => entry.content.includes('computeTotal'))
      if (stale.length > 0) {
        return { passed: false, detail: `still references computeTotal in ${stale.map((entry) => entry.file).join(', ')}` }
      }

      const missing = contents.filter((entry) => !entry.content.includes('sumValues'))
      if (missing.length > 0) {
        return { passed: false, detail: `sumValues missing from ${missing.map((entry) => entry.file).join(', ')}` }
      }

      // The internal call inside `average` is the one most often missed, because it
      // is the only reference that is neither an import nor an export.
      const utils = contents[0]!.content
      if (!/export function sumValues/.test(utils) || !/sumValues\(items\) \/ items\.length/.test(utils)) {
        return { passed: false, detail: 'the definition or the internal call inside average was not updated correctly' }
      }

      return { passed: true, detail: 'definition, internal call, and both importers updated' }
    },
  },

  {
    // The hard one, and the one worth having.
    //
    // A shared constant serves two callers with genuinely different requirements,
    // and one caller's test fails. The obvious fix — widen the shared constant —
    // makes the *other* test fail, so an agent that pattern-matches on the error
    // without reading the second call site will confidently break something.
    // Passing requires noticing the coupling and localising the change.
    id: 'coupled-fix',
    weight: 3,
    prompt:
      'Run `bun test`. A test is failing. Fix the source so the whole suite passes. You must NOT modify anything in the tests directory — both tests are correct as written.',
    async setup(dir) {
      write(dir, 'src/format.ts', COUPLED_SOURCE)
      write(dir, 'tests/format.test.ts', COUPLED_TEST)
    },
    async check(dir) {
      if (read(dir, 'tests/format.test.ts') !== COUPLED_TEST) {
        return { passed: false, detail: 'the test file was modified — that was explicitly forbidden' }
      }

      const result = await runShell('bun test', 90_000, dir)
      if (result.exitCode !== 0) {
        // Name the specific wrong answer rather than just reporting a failure —
        // widening the shared constant is the trap this task exists to catch, and
        // a hypothesis about why elia fell into it needs to know it did.
        const brokePrice = /PRECISION\s*=\s*3/.test(read(dir, 'src/format.ts'))
        return {
          passed: false,
          detail: brokePrice
            ? 'widened the shared PRECISION constant to 3, breaking the price test — the two callers have different requirements'
            : `bun test still fails (exit ${result.exitCode})`,
        }
      }

      return { passed: true, detail: 'both callers formatted correctly without touching the tests' }
    },
  },
]

export function taskById(id: string): BenchTask | undefined {
  return BENCH_TASKS.find((task) => task.id === id)
}

export const TOTAL_WEIGHT = BENCH_TASKS.reduce((sum, task) => sum + task.weight, 0)
