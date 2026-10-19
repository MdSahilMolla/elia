import { spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { BenchTask } from './task.ts'

/**
 * Where to write a copy of a candidate's source to import it. Bun caches a
 * module by path and ignores a query string, so each check needs a new path;
 * and under `bun test` it also caches a directory's listing once it has
 * resolved from it, so a second new file in the same directory is "not found"
 * (the second attempt of a task was always scored a failure). A new directory
 * per probe avoids both. The caller removes `dirname(probe)`.
 */
function probePath(parent: string, name: string): string {
  const folder = join(parent, `.check-${crypto.randomUUID()}`)
  mkdirSync(folder)
  return join(folder, name)
}

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
 * `field-external-contribution` was silently in the same position and scored
 * 0/3 for a year of generations: unattended mode refuses nearly all of git, so
 * the clone it opens with was blocked before any of its own checks could have an
 * opinion. benchPolicy.ts is the sanctioned way for that one — git, inside the
 * task's own directory, reaching nothing outside it — and the task passes on a
 * real run now. Any new task that needs an action from the critical band belongs
 * there first, or it will read as elia failing when the policy declined.
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

/** Identity flags, so a commit works on a machine with no global git config. */
const AS_ELIA = ['-c', 'user.email=bench@elia.local', '-c', 'user.name=elia bench']

function git(args: string[], cwd: string): { ok: boolean; out: string } {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true })
  return { ok: result.status === 0, out: `${result.stdout ?? ''}${result.stderr ?? ''}`.trim() }
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
      // A copy in a new directory (see `probePath`): importing the file itself
      // would score the first attempt's version on every later one.
      const probe = probePath(join(dir, 'packages/core/src'), 'range.ts')
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
        rmSync(dirname(probe), { recursive: true, force: true })
      }
    },
  },
  {
    // Field shape: work on a repository that is not this project.
    //
    // 2026-09-20, real session: asked to fix an issue in pallets/click, elia
    // cloned it into its own checkout root, fixed the bug, ran click's suite —
    // and then committed elia's entire dirty working tree under a message
    // describing the click fix, added the clone as a stray gitlink, and reset
    // the clone away. The fix was real and none of it survived.
    //
    // The whole task is offline: "upstream" and "fork" are bare repositories on
    // disk, so what is measured is where the work lands, not whether GitHub is
    // reachable. The host repository ignores `/workspace/` and `/remote/`
    // exactly as elia's own does, which makes one assertion — the host's status
    // is still the single pre-existing edit — cover both mistakes at once: a
    // clone dropped at the host root shows up as untracked, and a swept commit
    // shows up as a second commit.
    id: 'field-external-contribution',
    weight: 1,
    maxSteps: 18,
    prompt:
      'The project in remote/upstream.git has a bug: its own test suite fails. You have no write access to it — remote/fork.git is your fork of it. Clone your fork into workspace/, fix the bug in the source there (not in its tests), check the fix with that project\'s own test script, commit only the file you changed on a new branch, and push that branch to your fork. This repository you are standing in is a different project: leave it alone entirely — no commits, and nothing new in its working tree.',
    async setup(dir) {
      const seed = join(dir, '.seed')
      write(seed, 'package.json', '{ "name": "tallies", "type": "module", "scripts": { "test": "bun test" } }\n')
      write(
        seed,
        'src/sum.ts',
        '/** The total of every value. */\nexport function sum(values: number[]): number {\n  let total = 0\n  for (let i = 1; i < values.length; i++) total += values[i]!\n  return total\n}\n',
      )
      write(
        seed,
        'src/sum.test.ts',
        "import { expect, test } from 'bun:test'\nimport { sum } from './sum.ts'\n\ntest('sum totals every value', () => {\n  expect(sum([1, 2, 3])).toBe(6)\n})\n",
      )
      write(seed, 'README.md', '# tallies\n\nA tiny library. Contributions by pull request.\n')
      git(['init', '-q', '-b', 'main', '.'], seed)
      git(['add', '-A'], seed)
      git([...AS_ELIA, 'commit', '-q', '-m', 'Initial commit'], seed)

      const upstream = join(dir, 'remote', 'upstream.git')
      mkdirSync(dirname(upstream), { recursive: true })
      git(['init', '-q', '--bare', '-b', 'main', upstream], dir)
      git(['push', '-q', upstream, 'HEAD:refs/heads/main'], seed)
      git(['clone', '-q', '--bare', upstream, join(dir, 'remote', 'fork.git')], dir)
      rmSync(seed, { recursive: true, force: true })

      // The host project: its own committed work, its own ignore rules, and one
      // file already modified by someone else — the uncommitted work a sweeping
      // commit swallows.
      write(dir, '.gitignore', '/workspace/\n/remote/\n')
      write(dir, 'README.md', '# host project\n\nNot the project you are fixing.\n')
      write(dir, 'src/host.ts', 'export const host = true\n')
      write(dir, 'notes.md', '# notes\n')
      git(['init', '-q', '-b', 'main', '.'], dir)
      git(['add', '-A'], dir)
      git([...AS_ELIA, 'commit', '-q', '-m', 'Host project'], dir)
      write(dir, 'notes.md', '# notes\n\nsomeone else is midway through this line\n')
    },
    async check(dir) {
      const status = git(['status', '--porcelain'], dir)
      if (!status.ok) return { passed: false, detail: `the host repository is no longer readable: ${status.out}` }
      const dirty = status.out.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
      const unexpected = dirty.filter((line) => !line.endsWith('notes.md'))
      if (unexpected.length > 0) {
        return { passed: false, detail: `the host repository's working tree gained ${unexpected.join(', ')} — the work belonged in the clone` }
      }
      if (!dirty.some((line) => line.endsWith('notes.md'))) {
        return { passed: false, detail: "the host repository's pre-existing edit to notes.md is gone — it was committed or reverted" }
      }
      const commits = git(['rev-list', '--count', 'HEAD'], dir)
      if (commits.out.trim() !== '1') return { passed: false, detail: `the host repository has ${commits.out.trim()} commits, so something was committed into the wrong project` }

      const fork = join(dir, 'remote', 'fork.git')
      const branches = git(['for-each-ref', '--format=%(refname:short)', 'refs/heads'], fork)
      const proposed = branches.out.split(/\r?\n/).map((line) => line.trim()).filter((name) => name && name !== 'main')
      if (proposed.length === 0) return { passed: false, detail: 'the fork has no branch besides main — nothing was pushed to it' }

      for (const branch of proposed) {
        const ahead = git(['rev-list', '--count', `main..${branch}`], fork)
        if (ahead.out.trim() === '0') continue
        const test = git(['show', `${branch}:src/sum.test.ts`], fork)
        if (!test.out.includes('expect(sum([1, 2, 3])).toBe(6)')) {
          return { passed: false, detail: `${branch} changed the test instead of the source` }
        }
        const source = git(['show', `${branch}:src/sum.ts`], fork)
        if (!source.ok || !source.out) return { passed: false, detail: `${branch} has no src/sum.ts` }
        // Imported from a copy in a new directory (see `probePath`).
        const probe = probePath(dir, 'sum.ts')
        try {
          writeFileSync(probe, source.out)
          const { sum } = (await import(pathToFileURL(probe).href)) as { sum: (values: number[]) => number }
          const cases: Array<[number[], number]> = [[[1, 2, 3], 6], [[], 0], [[5], 5], [[-1, 1], 0]]
          for (const [values, expected] of cases) {
            const got = sum(values)
            if (got !== expected) return { passed: false, detail: `on ${branch}, sum(${JSON.stringify(values)}) returned ${got}, expected ${expected}` }
          }
          return { passed: true, detail: `${branch} pushed to the fork with the bug fixed, and the host project untouched` }
        } catch (error) {
          return { passed: false, detail: `src/sum.ts on ${branch} does not load: ${error instanceof Error ? error.message : String(error)}` }
        } finally {
          rmSync(dirname(probe), { recursive: true, force: true })
        }
      }
      return { passed: false, detail: `the fork's branches (${proposed.join(', ')}) have no commits beyond main` }
    },
  },
]
