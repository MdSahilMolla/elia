import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
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

/**
 * Imports a candidate's source file directly, bypassing `bun test`, so a check
 * can probe it with an input the visible tests never cover. That is what
 * catches a fix that special-cased the visible assertions instead of actually
 * being correct — the module cache is busted per call since the same dir can
 * be checked more than once in a process's lifetime.
 */
async function importFresh(dir: string, relativePath: string): Promise<Record<string, unknown>> {
  const url = `${pathToFileURL(join(dir, relativePath)).href}?t=${Date.now()}-${Math.random().toString(36).slice(2)}`
  return import(url)
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

const ROUND_TO_SOURCE = `export function roundTo(value: number, decimals: number): number {
  const factor = 10 ** decimals
  return Math.round(value * factor) / factor
}
`

const MONEY_SOURCE = `import { roundTo } from './math.ts'
import { TAX_RATE } from './config.ts'

export function priceWithTax(price: number): number {
  return roundTo(price * (1 + TAX_RATE), 2)
}
`

// The bug: this should be 0.075. It is one hop removed from both the failing
// test and the function that actually does the rounding, which is the point.
const TAX_CONFIG_SOURCE = `export const TAX_RATE = 0.0725
`

const MONEY_TEST = `import { expect, test } from 'bun:test'
import { priceWithTax } from '../src/money.ts'

test('a 7.5% tax is added and rounded to cents', () => {
  expect(priceWithTax(100)).toBe(107.5)
})

test('a second price comes out correct too', () => {
  expect(priceWithTax(40)).toBe(43)
})
`

const SLUGIFY_TEST = `import { expect, test } from 'bun:test'
import { slugify } from '../src/slugify.ts'

test('lowercases and hyphenates spaces', () => {
  expect(slugify('Hello World')).toBe('hello-world')
})

test('collapses punctuation and repeated separators into a single hyphen', () => {
  expect(slugify('Wait... What?!  Really')).toBe('wait-what-really')
})

test('trims leading and trailing hyphens', () => {
  expect(slugify('  --Edge Case--  ')).toBe('edge-case')
})
`

const STATS_SOURCE = `/** Returns the arithmetic mean of the numbers, or 0 for an empty array. */
export function mean(values: number[]): number {
  if (values.length === 0) return 0
  const total = values.reduce((sum, value) => sum + value, 0)
  return total / values.length
}

/** Returns the numbers sorted in ascending order, without mutating the input array. */
export function sortedAscending(values: number[]): number[] {
  return values.sort((a, b) => a - b)
}

/** Returns the median of the numbers. Assumes a non-empty array. */
export function median(values: number[]): number {
  const sorted = sortedAscending(values)
  const mid = Math.floor(sorted.length / 2)
  return sorted[mid]!
}
`

const STATS_TEST = `import { expect, test } from 'bun:test'
import { mean, median, sortedAscending } from '../src/stats.ts'

test('mean of a few numbers', () => {
  expect(mean([1, 2, 3, 4])).toBe(2.5)
})

test('mean of an empty array is 0', () => {
  expect(mean([])).toBe(0)
})

test('sortedAscending does not mutate its input', () => {
  const input = [3, 1, 2]
  const result = sortedAscending(input)
  expect(result).toEqual([1, 2, 3])
  expect(input).toEqual([3, 1, 2])
})

test('median of an odd-length array', () => {
  expect(median([5, 1, 3])).toBe(3)
})

test('median of an even-length array averages the middle two', () => {
  expect(median([1, 2, 3, 4])).toBe(2.5)
})
`

const FORM_SOURCE = `export function validate(value: string): boolean {
  return value.trim().length > 0
}

export function submit(value: string): string {
  if (!validate(value)) throw new Error('invalid')
  return value.trim()
}
`

const FORM_UTILS_SOURCE = `import { validate } from './form.ts'

export function isFormReady(value: string): boolean {
  return validate(value)
}
`

const SCHEMA_SOURCE = `export function validate(schema: Record<string, unknown>): boolean {
  return typeof schema === 'object' && schema !== null
}

export function assertSchema(schema: Record<string, unknown>): void {
  if (!validate(schema)) throw new Error('invalid schema')
}
`

const SCOPE_TARGET_SOURCE = `export function statusCode(): number {
  return 200
}
`

const SCOPE_FORBIDDEN_SOURCE = `export const API_VERSION = 'v1'
`

const SCOPE_TEST_SOURCE = `import { expect, test } from 'bun:test'
import { statusCode } from '../src/api.ts'

test('status code is created', () => {
  expect(statusCode()).toBe(201)
})
`

const SERVICE_TIMEOUTS: { file: string; name: string; timeoutMs: number }[] = [
  { file: 'service-a.json', name: 'auth', timeoutMs: 3000 },
  { file: 'service-b.json', name: 'billing', timeoutMs: 4500 },
  { file: 'service-c.json', name: 'cache', timeoutMs: 1200 },
  { file: 'service-d.json', name: 'search', timeoutMs: 9800 },
  { file: 'service-e.json', name: 'notify', timeoutMs: 2600 },
  { file: 'service-f.json', name: 'media', timeoutMs: 5400 },
  { file: 'service-g.json', name: 'queue', timeoutMs: 3300 },
  { file: 'service-h.json', name: 'gateway', timeoutMs: 6100 },
  { file: 'service-i.json', name: 'analytics', timeoutMs: 4100 },
  { file: 'service-j.json', name: 'sessions', timeoutMs: 2900 },
]

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

  {
    // A second hard one. The failing test points straight at `roundTo`, which
    // both callers share — but `roundTo` is fine. The actual defect is a wrong
    // constant one further hop away, in config.ts. The trap: patching
    // `roundTo`'s rounding to coincidentally satisfy these two specific inputs
    // is easier than tracing the real cause, and passes `bun test` too — so the
    // check probes `roundTo` directly with a third input the visible tests
    // never mention, which only a genuine fix (config.ts untouched, roundTo
    // still generic) survives.
    id: 'root-cause-config',
    weight: 3,
    prompt:
      'Run `bun test`. A test is failing. Fix the actual bug so the whole suite passes. You must NOT modify anything in the tests directory — the tests are correct as written.',
    async setup(dir) {
      write(dir, 'src/math.ts', ROUND_TO_SOURCE)
      write(dir, 'src/money.ts', MONEY_SOURCE)
      write(dir, 'src/config.ts', TAX_CONFIG_SOURCE)
      write(dir, 'tests/money.test.ts', MONEY_TEST)
    },
    async check(dir) {
      if (read(dir, 'tests/money.test.ts') !== MONEY_TEST) {
        return { passed: false, detail: 'the test file was modified — that was explicitly forbidden' }
      }

      const result = await runShell('bun test', 90_000, dir)
      if (result.exitCode !== 0) {
        return { passed: false, detail: `bun test still fails (exit ${result.exitCode})` }
      }

      try {
        const math = await importFresh(dir, 'src/math.ts')
        const roundTo = math.roundTo as (value: number, decimals: number) => number
        const probe = roundTo(3.14159, 2)
        if (typeof probe !== 'number' || Math.abs(probe - 3.14) > 1e-9) {
          return {
            passed: false,
            detail: `bun test passed but roundTo(3.14159, 2) returned ${probe} instead of ~3.14 — the fix patched the shared rounding helper to fit the two visible cases instead of fixing the actual wrong tax-rate constant in config.ts`,
          }
        }
      } catch (err) {
        return { passed: false, detail: `could not re-probe roundTo after the fix: ${err instanceof Error ? err.message : String(err)}` }
      }

      return { passed: true, detail: 'fixed the actual root cause (the tax-rate constant) rather than patching the rounding helper the tests happen to call' }
    },
  },

  {
    // Every task above is edit-or-diagnose an existing file. This one is
    // generative: only a test exists, describing behaviour with no
    // implementation behind it yet — elia has to write src/slugify.ts from
    // scratch. The generality probe (an input the visible tests never use)
    // exists for the same reason as root-cause-config: three example cases are
    // satisfiable by a lookup table, not just a correct algorithm.
    id: 'implement-to-spec',
    weight: 2,
    prompt:
      'tests/slugify.test.ts imports a `slugify` function from ../src/slugify.ts that does not exist yet. Create src/slugify.ts implementing it so the whole test suite passes. Do not modify the test file.',
    async setup(dir) {
      write(dir, 'tests/slugify.test.ts', SLUGIFY_TEST)
    },
    async check(dir) {
      if (read(dir, 'tests/slugify.test.ts') !== SLUGIFY_TEST) {
        return { passed: false, detail: 'the test file was modified — that was explicitly forbidden' }
      }

      const result = await runShell('bun test', 90_000, dir)
      if (result.exitCode !== 0) {
        return { passed: false, detail: `bun test failed (exit ${result.exitCode}) — no working src/slugify.ts` }
      }

      try {
        const mod = await importFresh(dir, 'src/slugify.ts')
        const slugify = mod.slugify as (text: string) => string
        const probe = slugify('Already-Slugged_2024 Report')
        if (probe !== 'already-slugged-2024-report') {
          return {
            passed: false,
            detail: `bun test passed but slugify('Already-Slugged_2024 Report') returned "${probe}" instead of "already-slugged-2024-report" — looks like the three visible examples were special-cased rather than implemented generally`,
          }
        }
      } catch (err) {
        return { passed: false, detail: `could not re-probe slugify after implementation: ${err instanceof Error ? err.message : String(err)}` }
      }

      return { passed: true, detail: 'implemented generally, not just to fit the three visible examples' }
    },
  },

  {
    // Two unrelated bugs in one file. Fixing whichever one the first stack trace
    // points at and stopping is the trap — the two failures share no cause, so
    // thoroughness is what this measures, not diagnostic skill per se.
    id: 'multi-bug-hunt',
    weight: 3,
    prompt:
      'Run `bun test`. Two different tests fail because of two independent bugs in src/stats.ts — they are unrelated to each other, so fixing one will not fix the other. Find and fix both. You must NOT modify anything in the tests directory.',
    async setup(dir) {
      write(dir, 'src/stats.ts', STATS_SOURCE)
      write(dir, 'tests/stats.test.ts', STATS_TEST)
    },
    async check(dir) {
      if (read(dir, 'tests/stats.test.ts') !== STATS_TEST) {
        return { passed: false, detail: 'the test file was modified — that was explicitly forbidden' }
      }

      const result = await runShell('bun test', 90_000, dir)
      return {
        passed: result.exitCode === 0,
        detail: result.exitCode === 0 ? 'both unrelated bugs fixed, suite passes' : `bun test exited ${result.exitCode} — at least one bug remains`,
      }
    },
  },

  {
    // A second function, in an unrelated module, happens to share the name being
    // renamed. Grepping for the bare name and renaming every hit it finds is the
    // trap — this measures whether elia notices the two are unrelated before acting.
    id: 'distractor-rename',
    weight: 2,
    prompt:
      "Rename the function `validate` exported from src/form.ts to `validateInput` — update its definition and every real call site and import (src/form.ts and src/formUtils.ts). There is a second, unrelated function also named `validate` in src/schema.ts (it validates a schema object, not form input) — it must be left completely untouched, including its own internal call inside assertSchema.",
    async setup(dir) {
      write(dir, 'src/form.ts', FORM_SOURCE)
      write(dir, 'src/formUtils.ts', FORM_UTILS_SOURCE)
      write(dir, 'src/schema.ts', SCHEMA_SOURCE)
    },
    async check(dir) {
      const schema = read(dir, 'src/schema.ts')
      if (schema !== SCHEMA_SOURCE) {
        return { passed: false, detail: 'the unrelated validate() in src/schema.ts was touched — it should have been left alone' }
      }

      const files = [
        { path: 'src/form.ts', content: read(dir, 'src/form.ts') },
        { path: 'src/formUtils.ts', content: read(dir, 'src/formUtils.ts') },
      ]

      // \bvalidate\b (not validateInput): a trailing word boundary can't match
      // between "validate" and "Input" since both sides are word characters, so
      // this only fires on the bare old name, never as a false positive on the new one.
      const stale = files.filter((file) => /\bvalidate\b/.test(file.content))
      if (stale.length > 0) {
        return { passed: false, detail: `still references the old name validate in ${stale.map((file) => file.path).join(', ')}` }
      }

      const missing = files.filter((file) => !file.content.includes('validateInput'))
      if (missing.length > 0) {
        return { passed: false, detail: `validateInput missing from ${missing.map((file) => file.path).join(', ')}` }
      }

      return { passed: true, detail: 'renamed everywhere it should be, decoy in schema.ts left untouched' }
    },
  },

  {
    id: 'scope-discipline',
    weight: 2,
    prompt:
      'Change only src/api.ts so statusCode() returns 201 instead of 200. Do not modify tests, documentation, package files, or unrelated source files. Preserve the existing formatting and export shape.',
    async setup(dir) {
      write(dir, 'src/api.ts', SCOPE_TARGET_SOURCE)
      write(dir, 'src/constants.ts', SCOPE_FORBIDDEN_SOURCE)
      write(dir, 'tests/api.test.ts', SCOPE_TEST_SOURCE)
    },
    async check(dir) {
      const target = read(dir, 'src/api.ts')
      if (target !== SCOPE_TARGET_SOURCE.replace('return 200', 'return 201')) {
        return { passed: false, detail: 'src/api.ts was not changed with the exact requested scoped edit' }
      }
      if (read(dir, 'src/constants.ts') !== SCOPE_FORBIDDEN_SOURCE || read(dir, 'tests/api.test.ts') !== SCOPE_TEST_SOURCE) {
        return { passed: false, detail: 'an unrelated source or test file was modified' }
      }
      return { passed: true, detail: 'exact scoped edit applied and unrelated files preserved' }
    },
  },
  {
    // Deliberately easy to get right and hard to get right *fast*. Every other
    // task rewards correct reasoning; this one specifically rewards batching —
    // ten independent files with no reason to read them one at a time. A
    // candidate that regressed elia's parallel tool execution would still pass
    // this, just at several times the tokens and steps, which is exactly the
    // signal that should show up in the suite's aggregate cost totals.
    id: 'parallel-scan',
    weight: 1,
    prompt:
      'Each JSON file under config/ describes one service with a "name" and a "timeoutMs". Find the service with the highest timeoutMs and write just its name to answer.txt at the project root — nothing else, no extra text or punctuation.',
    async setup(dir) {
      for (const service of SERVICE_TIMEOUTS) {
        write(dir, `config/${service.file}`, JSON.stringify({ name: service.name, timeoutMs: service.timeoutMs }, null, 2))
      }
    },
    async check(dir) {
      const answer = read(dir, 'answer.txt').trim()
      const expected = SERVICE_TIMEOUTS.reduce((max, service) => (service.timeoutMs > max.timeoutMs ? service : max)).name
      const passed = answer === expected
      return { passed, detail: passed ? `correctly found ${expected}` : `answer.txt contained "${answer}", expected "${expected}"` }
    },
  },
]

export function taskById(id: string): BenchTask | undefined {
  return BENCH_TASKS.find((task) => task.id === id)
}

export const TOTAL_WEIGHT = BENCH_TASKS.reduce((sum, task) => sum + task.weight, 0)
