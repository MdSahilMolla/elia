import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { BenchTask } from './task.ts'

/**
 * Tasks shaped from what actually goes wrong in real use.
 *
 * The rest of the suite was written from a list of competencies, and elia
 * passes 50 of its 54 tasks; the four it fails ask for whole features rebuilt
 * from history, which no prompt or tool change moves. So the evolution loop had
 * nothing it could win, and every candidate tied or regressed. Meanwhile the
 * action ledger shows the same failure shapes over and over in real sessions:
 * POSIX habits on a Windows shell, `cd` smuggled into a command instead of
 * `cwd`. Each task below
 * is one of those shapes, small enough to run in seconds, with a step budget
 * that the shape wastes — so the habit costs the task, and a change that fixes
 * the habit shows up as a pass.
 *
 * Not here: "started a server with run_command" (24 in the ledger). A task for
 * it was built and measured 0/3 on mercury-2.5 — and the trace showed the model
 * doing the right thing (the process tool) and the benchmark's unattended
 * policy refusing it, because nobody is there to approve starting a process.
 * That task measured the policy, not elia, and no candidate could pass it
 * without weakening the policy. It stays unscored until the benchmark has a
 * sanctioned way to run a server.
 *
 * Checks read files and never call a model. Immutable to the loop
 * (sandbox.ts IMMUTABLE_FILES), like every other file that decides a verdict.
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

const SOURCE_FILES: Record<string, string> = {
  'src/index.ts': 'export * from "./core/math.ts"\n',
  'src/core/math.ts': 'export const add = (a: number, b: number) => a + b\n',
  'src/core/math.test.ts': 'import "./math.ts"\n',
  'src/core/strings/pad.ts': 'export const pad = (s: string) => s.padStart(4)\n',
  'src/core/strings/trim.ts': 'export const trim = (s: string) => s.trim()\n',
  'src/core/strings/pad.test.ts': 'import "./pad.ts"\n',
  'src/io/read.ts': 'export const read = () => ""\n',
  'src/io/write.ts': 'export const write = () => {}\n',
  'src/io/formats/json.ts': 'export const json = JSON.stringify\n',
  'src/io/formats/csv.ts': 'export const csv = (rows: string[][]) => rows.map((row) => row.join(",")).join("\\n")\n',
  'src/io/formats/csv.test.ts': 'import "./csv.ts"\n',
  'src/types.d.ts': 'declare const version: string\n',
  'src/README.md': '# not a source file\n',
  'scripts/build.ts': 'console.log("build")\n',
  'vendor/lib/left-pad.ts': 'export default 1\n',
}
// .ts files under src/, recursively, excluding *.test.ts — types.d.ts counts.
const SOURCE_COUNT = Object.keys(SOURCE_FILES).filter((path) => path.startsWith('src/') && path.endsWith('.ts') && !path.endsWith('.test.ts')).length

export const FIELD_BENCH_TASKS: BenchTask[] = [
  {
    // Field shape: POSIX commands on a Windows shell (ls/find/wc/which are not there under cmd.exe).
    id: 'field-count-sources',
    weight: 1,
    maxSteps: 6,
    prompt:
      'How many TypeScript source files are under src/ (recursively)? Count files ending in .ts, including .d.ts, but not test files (*.test.ts). Write only the number into answer.txt at the project root.',
    async setup(dir) {
      for (const [path, content] of Object.entries(SOURCE_FILES)) write(dir, path, content)
    },
    async check(dir) {
      const answer = read(dir, 'answer.txt').trim()
      if (answer === String(SOURCE_COUNT)) return { passed: true, detail: `counted ${SOURCE_COUNT}` }
      return { passed: false, detail: answer ? `answered ${answer}, expected ${SOURCE_COUNT}` : 'answer.txt is missing or empty' }
    },
  },
  {
    // Field shape: `cd sub && …` in run_command instead of passing cwd (17 in the ledger),
    // plus scripts that only exist in a sub-package.
    id: 'field-subpackage-test',
    weight: 1,
    maxSteps: 10,
    prompt:
      'This is a small monorepo. The test suite of the package in packages/core fails. Find and fix the bug in that package\'s source (not in its tests), and run that package\'s own test script to confirm it passes.',
    async setup(dir) {
      write(dir, 'package.json', '{ "name": "mono", "private": true, "workspaces": ["packages/*"] }\n')
      write(dir, 'packages/core/package.json', '{ "name": "@mono/core", "type": "module", "scripts": { "test": "bun test" } }\n')
      write(
        dir,
        'packages/core/src/range.ts',
        '/** The integers from start up to and including end. */\nexport function range(start: number, end: number): number[] {\n  const out: number[] = []\n  for (let i = start; i < end; i++) out.push(i)\n  return out\n}\n',
      )
      write(
        dir,
        'packages/core/src/range.test.ts',
        "import { expect, test } from 'bun:test'\nimport { range } from './range.ts'\n\ntest('range includes both ends', () => {\n  expect(range(1, 4)).toEqual([1, 2, 3, 4])\n  expect(range(3, 3)).toEqual([3])\n})\n",
      )
      write(dir, 'packages/web/package.json', '{ "name": "@mono/web", "type": "module", "scripts": { "test": "bun test" } }\n')
      write(dir, 'packages/web/src/app.ts', 'export const app = "web"\n')
    },
    async check(dir) {
      const test = read(dir, 'packages/core/src/range.test.ts')
      if (!test.includes('expect(range(1, 4)).toEqual([1, 2, 3, 4])') || !test.includes('expect(range(3, 3)).toEqual([3])')) {
        return { passed: false, detail: 'the test was edited instead of the source' }
      }
      const source = read(dir, 'packages/core/src/range.ts')
      if (!source) return { passed: false, detail: 'packages/core/src/range.ts is gone' }
      // A uniquely named copy: Bun caches a module by path and ignores a query
      // string, so importing the file itself would score the first attempt's
      // version on every later one.
      const probe = join(dir, 'packages/core/src', `.check-${crypto.randomUUID()}.ts`)
      try {
        writeFileSync(probe, source)
        const { range } = (await import(pathToFileURL(probe).href)) as { range: (a: number, b: number) => number[] }
        const cases: Array<[number, number, number[]]> = [
          [1, 4, [1, 2, 3, 4]],
          [3, 3, [3]],
          [-2, 1, [-2, -1, 0, 1]],
        ]
        for (const [start, end, expected] of cases) {
          const got = range(start, end)
          if (JSON.stringify(got) !== JSON.stringify(expected)) return { passed: false, detail: `range(${start}, ${end}) returned ${JSON.stringify(got)}` }
        }
        return { passed: true, detail: 'range is inclusive, including cases the visible test does not cover' }
      } catch (error) {
        return { passed: false, detail: `range.ts no longer loads: ${error instanceof Error ? error.message : String(error)}` }
      } finally {
        rmSync(probe, { force: true })
      }
    },
  },
]
