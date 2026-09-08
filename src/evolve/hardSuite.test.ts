import { afterEach, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { HARD_BENCH_TASKS } from './hardSuite.ts'

/**
 * A benchmark task whose `check()` is wrong silently corrupts every generation
 * of the self-improvement loop. These tests never run a real agent — they hand
 * `check()` a solved state, an unsolved state, and each trap the task exists to
 * catch, and confirm it tells them apart.
 */

const taskById = (id: string) => HARD_BENCH_TASKS.find((task) => task.id === id)!

let dirs: string[] = []

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), `elia-hardsuite-${prefix}-`))
  dirs.push(dir)
  return dir
}

function put(dir: string, relativePath: string, content: string): void {
  const target = join(dir, relativePath)
  mkdirSync(dirname(target), { recursive: true })
  writeFileSync(target, content)
}

afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
  dirs = []
})

// --- layered-feature ---------------------------------------------------------

const LAYERED_TASKS_SOLVED = `import { all, insert, get, reset } from './store.ts'

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

export function completeTask(id: string): boolean {
  const task = get(id) as unknown as Task | undefined
  if (!task || task.done) return false
  task.done = true
  insert(task as unknown as import('./store.ts').Row)
  return true
}
`

// Passes every visible test but never rejects a repeated completion.
const LAYERED_TASKS_SPECIAL_CASED = LAYERED_TASKS_SOLVED.replace(
  'if (!task || task.done) return false',
  'if (!task) return false',
)

const LAYERED_CLI_SOLVED = `import { addTask, completeTask, listTasks } from './tasks.ts'

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
  if (command === 'complete') {
    const id = rest[0] ?? ''
    return completeTask(id) ? \`completed \${id}\` : \`unknown task \${id}\`
  }
  throw new Error(\`unknown command: \${command}\`)
}
`

test('layered-feature: fails on the unsolved state', async () => {
  const task = taskById('layered-feature')
  const dir = tempDir('layered-unsolved')
  await task.setup(dir)
  expect((await task.check(dir)).passed).toBe(false)
}, 30_000)

test('layered-feature: rejects an implementation edited into the test file', async () => {
  const task = taskById('layered-feature')
  const dir = tempDir('layered-tampered')
  await task.setup(dir)
  writeFileSync(join(dir, 'tests/complete.test.ts'), 'import { test } from "bun:test"\ntest("noop", () => {})\n')
  const result = await task.check(dir)
  expect(result.passed).toBe(false)
  expect(result.detail).toContain('modified')
}, 30_000)

test('layered-feature: rejects a version that special-cases the visible tests', async () => {
  const task = taskById('layered-feature')
  const dir = tempDir('layered-special')
  await task.setup(dir)
  put(dir, 'src/tasks.ts', LAYERED_TASKS_SPECIAL_CASED)
  put(dir, 'src/cli.ts', LAYERED_CLI_SOLVED)
  const result = await task.check(dir)
  expect(result.passed).toBe(false)
  expect(result.detail).toMatch(/special-cased|repeated id/)
}, 30_000)

test('layered-feature: passes when the feature is wired through every layer', async () => {
  const task = taskById('layered-feature')
  const dir = tempDir('layered-solved')
  await task.setup(dir)
  put(dir, 'src/tasks.ts', LAYERED_TASKS_SOLVED)
  put(dir, 'src/cli.ts', LAYERED_CLI_SOLVED)
  const result = await task.check(dir)
  expect(result.passed).toBe(true)
}, 30_000)

// --- api-migration ---------------------------------------------------------

const HTTP_MIGRATED = `export interface Response {
  ok: boolean
  body: string
}

export function get(path: string): Promise<Response> {
  return Promise.resolve({ ok: true, body: \`GET \${path}\` })
}
`

const USERS_MIGRATED = `import { get, type Response } from './http.ts'

export async function loadUser(id: string): Promise<Response> {
  return get(\`/users/\${id}\`)
}
`

const POSTS_MIGRATED = `import { get, type Response } from './http.ts'

export async function loadPost(id: string): Promise<Response> {
  return get(\`/posts/\${id}\`)
}

export async function loadFeed(): Promise<Response> {
  return get('/feed')
}
`

const REPORT_MIGRATED = `import { get } from './http.ts'

export async function buildReport(): Promise<string> {
  const response = await get('/report')
  return \`report: \${response.body}\`
}
`

test('api-migration: fails on the unsolved state', async () => {
  const task = taskById('api-migration')
  const dir = tempDir('migration-unsolved')
  await task.setup(dir)
  expect((await task.check(dir)).passed).toBe(false)
}, 30_000)

test('api-migration: fails when one call site is left on the old API', async () => {
  const task = taskById('api-migration')
  const dir = tempDir('migration-partial')
  await task.setup(dir)
  put(dir, 'src/http.ts', HTTP_MIGRATED)
  put(dir, 'src/users.ts', USERS_MIGRATED)
  put(dir, 'src/posts.ts', POSTS_MIGRATED)
  // report.ts left untouched — still imports and calls legacyGet, which no
  // longer exists, so this also breaks the build.
  const result = await task.check(dir)
  expect(result.passed).toBe(false)
}, 30_000)

test('api-migration: fails when legacyGet is only made unused, not removed', async () => {
  const task = taskById('api-migration')
  const dir = tempDir('migration-unused')
  await task.setup(dir)
  // Every call site migrated, but the deprecated export is still there.
  put(dir, 'src/users.ts', USERS_MIGRATED)
  put(dir, 'src/posts.ts', POSTS_MIGRATED)
  put(dir, 'src/report.ts', REPORT_MIGRATED)
  const result = await task.check(dir)
  expect(result.passed).toBe(false)
  expect(result.detail).toContain('legacyGet')
}, 30_000)

test('api-migration: passes when every call site is migrated and the export removed', async () => {
  const task = taskById('api-migration')
  const dir = tempDir('migration-solved')
  await task.setup(dir)
  put(dir, 'src/http.ts', HTTP_MIGRATED)
  put(dir, 'src/users.ts', USERS_MIGRATED)
  put(dir, 'src/posts.ts', POSTS_MIGRATED)
  put(dir, 'src/report.ts', REPORT_MIGRATED)
  const result = await task.check(dir)
  expect(result.passed).toBe(true)
}, 30_000)

// --- regression-hunt -----------------------------------------------------------

const PRICING_FIXED = `import { formatMoney } from './format.ts'

export function applyDiscount(cents: number, discountPct: number): number {
  return Math.round(cents * (1 - discountPct / 100))
}

export function applyTax(cents: number, taxPct: number): number {
  return Math.round(cents * (1 + taxPct / 100))
}

export function subtotal(items: { price: number }[]): number {
  return items.reduce((sum, item) => sum + item.price, 0)
}

export function total(items: { price: number }[], discountPct: number, taxPct: number): number {
  const discounted = applyDiscount(subtotal(items), discountPct)
  return applyTax(discounted, taxPct)
}

export function describe(items: { price: number }[], discountPct: number, taxPct: number): string {
  return formatMoney(total(items, discountPct, taxPct))
}
`

// Green on the two visible cases, wrong on everything else.
const PRICING_HARDCODED = PRICING_FIXED.replace(
  'const discounted = applyDiscount(subtotal(items), discountPct)\n  return applyTax(discounted, taxPct)',
  "if (discountPct === 20 && taxPct === 10) return 8800\n  if (discountPct === 10 && taxPct === 8) return 4860\n  return applyTax(subtotal(items), taxPct)",
)

test('regression-hunt: fails on the unsolved state', async () => {
  const task = taskById('regression-hunt')
  const dir = tempDir('regression-unsolved')
  await task.setup(dir)
  expect((await task.check(dir)).passed).toBe(false)
}, 30_000)

test('regression-hunt: fails when the decoy file is touched', async () => {
  const task = taskById('regression-hunt')
  const dir = tempDir('regression-decoy')
  await task.setup(dir)
  put(dir, 'src/pricing.ts', PRICING_FIXED)
  put(dir, 'src/format.ts', '/** reviewed */\nexport function formatMoney(cents: number): string {\n  return `$${(cents / 100).toFixed(2)}`\n}\n')
  const result = await task.check(dir)
  expect(result.passed).toBe(false)
  expect(result.detail).toContain('format.ts')
}, 30_000)

test('regression-hunt: fails a fix that hard-codes the two visible cases', async () => {
  const task = taskById('regression-hunt')
  const dir = tempDir('regression-hardcoded')
  await task.setup(dir)
  put(dir, 'src/pricing.ts', PRICING_HARDCODED)
  const result = await task.check(dir)
  expect(result.passed).toBe(false)
  expect(result.detail).toMatch(/expected|formula/)
}, 30_000)

test('regression-hunt: passes when the real discount-before-tax bug is fixed', async () => {
  const task = taskById('regression-hunt')
  const dir = tempDir('regression-solved')
  await task.setup(dir)
  put(dir, 'src/pricing.ts', PRICING_FIXED)
  const result = await task.check(dir)
  expect(result.passed).toBe(true)
}, 30_000)

test('every hard task carries a non-trivial step budget and weight', () => {
  for (const task of HARD_BENCH_TASKS) {
    expect(task.maxSteps ?? 0).toBeGreaterThanOrEqual(40)
    expect(task.weight).toBeGreaterThanOrEqual(2)
    expect(task.prompt).toContain('tests')
  }
})
