import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { runShell } from '../shell.ts'
import type { BenchTask } from './task.ts'

/**
 * The long-horizon half of the synthetic benchmark.
 *
 * Every task in `suite.ts` is a single-file reflex: one precise edit, one rename,
 * one small bug. A self-improvement loop measured only on those gets better at
 * reflexes — which is exactly why a promoted elia can still fall apart on a real
 * end-to-end job. These tasks each need a plan held across many steps and a
 * change wired consistently through several files, so a prompt or loop-policy
 * mutation that helps (or hurts) *sustained* autonomous work finally shows up in
 * the score.
 *
 * The grading rules are the same as the rest of the suite and are not negotiable:
 * pass/fail is decided by running code, never by a model; the visible tests are
 * the spec and editing them fails the task outright; and each task carries a
 * generality probe — an input the visible tests never exercise — so satisfying
 * the examples by special-casing them does not pass.
 */

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
 * Imports a source file from the task repo with the module cache bypassed, so a
 * check can call the agent's code directly with an input the visible tests do
 * not cover. Mirrors `importFresh` in suite.ts.
 */
async function importFresh(dir: string, relativePath: string): Promise<Record<string, unknown>> {
  const url = `${pathToFileURL(join(dir, relativePath)).href}?t=${Date.now()}-${Math.random().toString(36).slice(2)}`
  return import(url)
}

// --- layered-feature --------------------------------------------------------

const STORE_SOURCE = `export interface Row {
  id: string
  [key: string]: unknown
}

const rows = new Map<string, Row>()

export function insert(row: Row): void {
  rows.set(row.id, row)
}

export function get(id: string): Row | undefined {
  return rows.get(id)
}

export function all(): Row[] {
  return [...rows.values()]
}

export function reset(): void {
  rows.clear()
}
`

const TASKS_SOURCE = `import { all, insert, get, reset } from './store.ts'

export interface Task {
  id: string
  title: string
  done: boolean
}

let counter = 0

export function addTask(title: string): Task {
  const task: Task = { id: \`t\${++counter}\`, title, done: false }
  insert(task as unknown as import('./store.ts').Row)
  return task
}

export function listTasks(options: { pending?: boolean } = {}): Task[] {
  const tasks = all() as unknown as Task[]
  return options.pending ? tasks.filter((task) => !task.done) : tasks
}

export function clearAll(): void {
  reset()
  counter = 0
}

// completeTask is specified by tests/complete.test.ts and does not exist yet.
`

const CLI_SOURCE = `import { addTask, listTasks } from './tasks.ts'

export function runCommand(argv: string[]): string {
  const [command, ...rest] = argv
  if (command === 'add') {
    const task = addTask(rest.join(' '))
    return \`added \${task.id}\`
  }
  if (command === 'list') {
    return listTasks({ pending: true })
      .map((task) => \`\${task.id} \${task.title}\`)
      .join('\\n')
  }
  throw new Error(\`unknown command: \${command}\`)
}
`

const LAYERED_TEST = `import { afterEach, expect, test } from 'bun:test'
import { addTask, completeTask, listTasks, clearAll } from '../src/tasks.ts'
import { runCommand } from '../src/cli.ts'

afterEach(() => clearAll())

test('completeTask marks a task done and returns true', () => {
  const task = addTask('write the spec')
  expect(completeTask(task.id)).toBe(true)
  expect(listTasks({ pending: true })).toHaveLength(0)
})

test('completeTask on an unknown id returns false and does not throw', () => {
  expect(completeTask('nope')).toBe(false)
})

test('a completed task still appears in the unfiltered list', () => {
  const task = addTask('ship it')
  completeTask(task.id)
  expect(listTasks().map((t) => t.id)).toContain(task.id)
})

test('the cli can complete a task end to end', () => {
  const added = runCommand(['add', 'from the cli'])
  const id = added.replace('added ', '')
  expect(runCommand(['complete', id])).toBe(\`completed \${id}\`)
  expect(runCommand(['list'])).toBe('')
})
`

// --- api-migration ---------------------------------------------------------

const HTTP_SOURCE = `export interface Response {
  ok: boolean
  body: string
}

/**
 * DEPRECATED. Every call site must move to \`get\`, which returns a promise, and
 * this export must then be removed entirely.
 */
export function legacyGet(path: string, callback: (error: Error | null, response?: Response) => void): void {
  try {
    callback(null, { ok: true, body: \`GET \${path}\` })
  } catch (error) {
    callback(error as Error)
  }
}

export function get(path: string): Promise<Response> {
  return Promise.resolve({ ok: true, body: \`GET \${path}\` })
}
`

const USERS_SOURCE = `import { legacyGet, type Response } from './http.ts'

export function loadUser(id: string): Promise<Response> {
  return new Promise((resolve, reject) => {
    legacyGet(\`/users/\${id}\`, (error, response) => {
      if (error || !response) reject(error ?? new Error('no response'))
      else resolve(response)
    })
  })
}
`

const POSTS_SOURCE = `import { legacyGet, type Response } from './http.ts'

export function loadPost(id: string): Promise<Response> {
  return new Promise((resolve, reject) => {
    legacyGet(\`/posts/\${id}\`, (error, response) => {
      if (error || !response) reject(error ?? new Error('no response'))
      else resolve(response)
    })
  })
}

export function loadFeed(): Promise<Response> {
  return new Promise((resolve, reject) => {
    legacyGet('/feed', (error, response) => {
      if (error || !response) reject(error ?? new Error('no response'))
      else resolve(response)
    })
  })
}
`

const REPORT_SOURCE = `import { legacyGet } from './http.ts'

export function buildReport(): Promise<string> {
  return new Promise((resolve, reject) => {
    legacyGet('/report', (error, response) => {
      if (error || !response) reject(error ?? new Error('no response'))
      else resolve(\`report: \${response.body}\`)
    })
  })
}
`

const MIGRATION_TEST = `import { expect, test } from 'bun:test'
import { loadUser } from '../src/users.ts'
import { loadPost, loadFeed } from '../src/posts.ts'
import { buildReport } from '../src/report.ts'

test('loadUser resolves with the response body', async () => {
  await expect(loadUser('7')).resolves.toEqual({ ok: true, body: 'GET /users/7' })
})

test('loadPost and loadFeed resolve', async () => {
  await expect(loadPost('3')).resolves.toEqual({ ok: true, body: 'GET /posts/3' })
  await expect(loadFeed()).resolves.toEqual({ ok: true, body: 'GET /feed' })
})

test('buildReport composes the response', async () => {
  await expect(buildReport()).resolves.toBe('report: GET /report')
})
`

// --- regression-hunt -----------------------------------------------------------

const PRICING_SOURCE = `import { formatMoney } from './format.ts'

/** Cents remaining after applying a percentage discount, rounded to the nearest cent. */
export function applyDiscount(cents: number, discountPct: number): number {
  return Math.round(cents * (1 - discountPct / 100))
}

/** Cents plus a percentage tax, rounded to the nearest cent. */
export function applyTax(cents: number, taxPct: number): number {
  return Math.round(cents * (1 + taxPct / 100))
}

export function subtotal(items: { price: number }[]): number {
  return items.reduce((sum, item) => sum + item.price, 0)
}

/**
 * The bill for a set of items: discount first, then tax on the discounted
 * amount.
 *
 * BUG: the discount is never applied. Tax is charged on the full subtotal, so
 * any order that carries a discount is billed too high.
 */
export function total(items: { price: number }[], discountPct: number, taxPct: number): number {
  return applyTax(subtotal(items), taxPct)
}

export function describe(items: { price: number }[], discountPct: number, taxPct: number): string {
  return formatMoney(total(items, discountPct, taxPct))
}
`

// The decoy. It carries a comment that makes it look like the recently touched,
// suspicious file — but it is correct, and touching it fails the task.
const FORMAT_SOURCE = `/** TODO: double-check the rounding here against the finance spec. */
export function formatMoney(cents: number): string {
  const sign = cents < 0 ? '-' : ''
  const abs = Math.abs(cents)
  return \`\${sign}$\${Math.floor(abs / 100)}.\${String(abs % 100).padStart(2, '0')}\`
}
`

const REGRESSION_TEST = `import { expect, test } from 'bun:test'
import { total } from '../src/pricing.ts'

// $100.00 of goods, 20% off, then 10% tax => 8000 * 1.1 = 8800
test('a 20% discount is applied before a 10% tax', () => {
  expect(total([{ price: 6000 }, { price: 4000 }], 20, 10)) .toBe(8800)
})

// $50.00, 10% off, 8% tax => 4500 * 1.08 = 4860
test('discount and tax compose the right way round', () => {
  expect(total([{ price: 5000 }], 10, 8)).toBe(4860)
})
`

/** Independent re-derivation of the correct `total`, for the generality probe. */
function expectedTotal(prices: number[], discountPct: number, taxPct: number): number {
  const sub = prices.reduce((sum, price) => sum + price, 0)
  const discounted = Math.round(sub * (1 - discountPct / 100))
  return Math.round(discounted * (1 + taxPct / 100))
}

const BUN_TEST_TIMEOUT_MS = 90_000

export const HARD_BENCH_TASKS: BenchTask[] = [
  {
    id: 'layered-feature',
    weight: 3,
    maxSteps: 55,
    prompt: [
      'This is a small task manager with three layers: src/store.ts (persistence),',
      'src/tasks.ts (domain), src/cli.ts (command dispatch).',
      '',
      'tests/complete.test.ts specifies a new feature — completing a task — that is',
      'not implemented yet. Run `bun test`, read the failing tests, and implement the',
      'feature so the whole suite passes:',
      '  - add `completeTask(id: string): boolean` to src/tasks.ts. It returns true',
      '    if this call changed a pending task to done; it returns false if no task',
      '    has that id OR the task was already done. It must never throw.',
      '  - `listTasks({ pending: true })` must exclude completed tasks; `listTasks()`',
      '    with no argument must still return every task.',
      '  - make `runCommand` in src/cli.ts handle a `complete <id>` command that',
      '    returns the string `completed <id>`.',
      '',
      'Do not modify anything in the tests directory.',
    ].join('\n'),
    async setup(dir) {
      write(dir, 'src/store.ts', STORE_SOURCE)
      write(dir, 'src/tasks.ts', TASKS_SOURCE)
      write(dir, 'src/cli.ts', CLI_SOURCE)
      write(dir, 'tests/complete.test.ts', LAYERED_TEST)
    },
    async check(dir) {
      if (read(dir, 'tests/complete.test.ts') !== LAYERED_TEST) {
        return { passed: false, detail: 'the test file was modified — that was explicitly forbidden' }
      }

      const result = await runShell('bun test', BUN_TEST_TIMEOUT_MS, dir)
      if (result.exitCode !== 0) {
        return { passed: false, detail: `bun test still fails (exit ${result.exitCode}) — the feature is not wired through all three layers` }
      }

      // Generality probe: exercise completeTask with ordering the visible tests
      // never do — a second completion of the same task must report false, and a
      // never-completed task must stay pending.
      try {
        const mod = await importFresh(dir, 'src/tasks.ts')
        const addTask = mod.addTask as (title: string) => { id: string }
        const completeTask = mod.completeTask as (id: string) => boolean
        const listTasks = mod.listTasks as (options?: { pending?: boolean }) => { id: string }[]
        const clearAll = mod.clearAll as () => void
        if (typeof completeTask !== 'function') {
          return { passed: false, detail: 'bun test passed but src/tasks.ts does not export a completeTask function' }
        }
        clearAll()
        const a = addTask('a')
        const b = addTask('b')
        const first = completeTask(a.id)
        const second = completeTask(a.id)
        const pending = listTasks({ pending: true }).map((task) => task.id)
        if (first !== true || second !== false) {
          return {
            passed: false,
            detail: `completeTask should return true then false on a repeated id, returned ${first} then ${second} — looks special-cased to the visible tests`,
          }
        }
        if (pending.length !== 1 || pending[0] !== b.id) {
          return { passed: false, detail: `after completing one of two tasks, pending list was [${pending.join(', ')}], expected just ${b.id}` }
        }
      } catch (err) {
        return { passed: false, detail: `could not re-probe src/tasks.ts after the change: ${err instanceof Error ? err.message : String(err)}` }
      }

      return { passed: true, detail: 'feature implemented consistently across store, domain, and cli layers' }
    },
  },

  {
    id: 'api-migration',
    weight: 3,
    maxSteps: 50,
    prompt: [
      'src/http.ts exports a deprecated callback-style `legacyGet` alongside a',
      'promise-returning `get`. Four call sites still use `legacyGet`: src/users.ts',
      '(loadUser), src/posts.ts (loadPost, loadFeed), and src/report.ts (buildReport).',
      '',
      'Migrate every call site to `get`, then remove the `legacyGet` export from',
      'src/http.ts entirely. When you are done, `bun test` passes and the string',
      '`legacyGet` appears nowhere in src/. Do not modify anything in the tests',
      'directory.',
    ].join('\n'),
    async setup(dir) {
      write(dir, 'src/http.ts', HTTP_SOURCE)
      write(dir, 'src/users.ts', USERS_SOURCE)
      write(dir, 'src/posts.ts', POSTS_SOURCE)
      write(dir, 'src/report.ts', REPORT_SOURCE)
      write(dir, 'tests/migration.test.ts', MIGRATION_TEST)
    },
    async check(dir) {
      if (read(dir, 'tests/migration.test.ts') !== MIGRATION_TEST) {
        return { passed: false, detail: 'the test file was modified — that was explicitly forbidden' }
      }

      const result = await runShell('bun test', BUN_TEST_TIMEOUT_MS, dir)
      if (result.exitCode !== 0) {
        return { passed: false, detail: `bun test fails (exit ${result.exitCode}) — the migration broke a call site` }
      }

      const sources = ['src/http.ts', 'src/users.ts', 'src/posts.ts', 'src/report.ts']
      const stale = sources.filter((file) => read(dir, file).includes('legacyGet'))
      if (stale.length > 0) {
        return { passed: false, detail: `legacyGet is still referenced in ${stale.join(', ')} — every call site and the export itself must be gone` }
      }

      // Generality probe: the export must actually be removed, not just unused.
      try {
        const mod = await importFresh(dir, 'src/http.ts')
        if ('legacyGet' in mod && mod.legacyGet !== undefined) {
          return { passed: false, detail: 'src/http.ts still exports legacyGet — it was meant to be deleted' }
        }
        if (typeof mod.get !== 'function') {
          return { passed: false, detail: 'src/http.ts no longer exports get — only legacyGet should have been removed' }
        }
      } catch (err) {
        return { passed: false, detail: `could not re-probe src/http.ts after the migration: ${err instanceof Error ? err.message : String(err)}` }
      }

      return { passed: true, detail: 'all four call sites migrated and the deprecated export removed' }
    },
  },

  {
    id: 'regression-hunt',
    weight: 3,
    maxSteps: 55,
    prompt: [
      'Run `bun test`. Two tests in tests/pricing.test.ts fail: an order with both a',
      'discount and a tax is billed wrong. Find the actual defect in src/pricing.ts',
      'and fix it so discount is applied first and tax is charged on the discounted',
      'amount. The whole suite must pass.',
      '',
      'Do not modify anything in the tests directory.',
    ].join('\n'),
    async setup(dir) {
      write(dir, 'src/pricing.ts', PRICING_SOURCE)
      write(dir, 'src/format.ts', FORMAT_SOURCE)
      write(dir, 'tests/pricing.test.ts', REGRESSION_TEST)
    },
    async check(dir) {
      if (read(dir, 'tests/pricing.test.ts') !== REGRESSION_TEST) {
        return { passed: false, detail: 'the test file was modified — that was explicitly forbidden' }
      }

      if (read(dir, 'src/format.ts') !== FORMAT_SOURCE) {
        return {
          passed: false,
          detail: 'src/format.ts was modified — the rounding there is correct and the comment is a decoy; the bug is in src/pricing.ts',
        }
      }

      const result = await runShell('bun test', BUN_TEST_TIMEOUT_MS, dir)
      if (result.exitCode !== 0) {
        return { passed: false, detail: `bun test still fails (exit ${result.exitCode}) — the discount/tax order is still wrong` }
      }

      // Generality probe: a discount+tax combination the visible tests never use.
      try {
        const mod = await importFresh(dir, 'src/pricing.ts')
        const total = mod.total as (items: { price: number }[], discountPct: number, taxPct: number) => number
        const cases: [number[], number, number][] = [
          [[2000], 25, 10],
          [[1234, 5678], 15, 7],
          [[999], 33, 0],
        ]
        for (const [prices, discountPct, taxPct] of cases) {
          const got = total(prices.map((price) => ({ price })), discountPct, taxPct)
          const want = expectedTotal(prices, discountPct, taxPct)
          if (got !== want) {
            return {
              passed: false,
              detail: `total(${JSON.stringify(prices)}, ${discountPct}, ${taxPct}) returned ${got}, expected ${want} — the two visible cases were made to pass without fixing the formula`,
            }
          }
        }
      } catch (err) {
        return { passed: false, detail: `could not re-probe src/pricing.ts after the fix: ${err instanceof Error ? err.message : String(err)}` }
      }

      return { passed: true, detail: 'fixed the discount-before-tax ordering in pricing.ts, decoy left untouched' }
    },
  },
]
