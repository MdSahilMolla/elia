import { expect, test } from 'bun:test'
import { changedLines, coversSource, isNewTestForChange, lintFinding, reviewDiff, renderFindings } from './quality.ts'
import type { ChangedFile } from '../world/twin.ts'

const edit = (path: string, before: string, after: string): ChangedFile => ({ path, before, after })
const added = (path: string, after: string): ChangedFile => ({ path, after })
const rules = (files: ChangedFile[], options = {}) => reviewDiff(files, options).findings.map((finding) => finding.rule)

const TEST = "import { expect, test } from 'bun:test'\ntest('x', () => { expect(1).toBe(1) })\n"

test('a small, typed, tested change to logic is clean', () => {
  const review = reviewDiff([edit('src/tools/grep.ts', 'const a = 1\n', 'const a = 2\n'), added('src/tools/grep.newLimit.test.ts', TEST)])
  expect(review.findings).toEqual([])
  expect(review.ok).toBe(true)
  expect(review.newTests).toEqual(['src/tools/grep.newLimit.test.ts'])
})

test('wording alone needs no test, because there is no behaviour to test', () => {
  const review = reviewDiff([edit('src/tools/grep.ts', "export const d = 'long text here'\n", "export const d = 'short'\n")])
  expect(review.ok).toBe(true)
  expect(review.needsTest).toBe(false)
})

test('a change to logic with no test is refused, and says what to add', () => {
  const review = reviewDiff([edit('src/agentLoop.ts', 'const a = 1\n', 'const a = 2\n')])
  expect(review.ok).toBe(false)
  expect(review.findings[0]!.rule).toBe('needs-test')
  expect(review.findings[0]!.detail).toContain('src/agentLoop.<change>.test.ts')
})

test('a check switched off is not a check satisfied', () => {
  for (const line of ['// @ts-ignore', '// @ts-expect-error', '/* eslint-disable */', '// oxlint-disable-next-line', '// biome-ignore lint: x']) {
    expect(rules([edit('src/a.ts', 'const a = 1\n', `${line}\nconst a = 2\n`), added('src/a.x.test.ts', TEST)])).toContain('disabled-check')
  }
  // Keeping one that was already there is not adding one.
  expect(rules([edit('src/a.ts', '// @ts-ignore\nconst a = 1\n', '// @ts-ignore\nconst a = 2\n'), added('src/a.x.test.ts', TEST)])).not.toContain('disabled-check')
})

test('more `any` than it started with is refused, the same amount is not', () => {
  const withAny = edit('src/a.ts', 'const a: number = 1\n', 'const a: any = 1\nconst b = a as any\n')
  expect(rules([withAny, added('src/a.x.test.ts', TEST)])).toContain('any')
  expect(rules([edit('src/a.ts', 'const a: any = 1\n', 'const a: any = 2\n'), added('src/a.x.test.ts', TEST)])).not.toContain('any')
})

test('a debugger statement and a credential are refused', () => {
  expect(rules([edit('src/a.ts', 'run()\n', 'debugger\nrun()\n'), added('src/a.x.test.ts', TEST)])).toContain('debugger')
  const key = `const key = '${'sk-ant-'}${'a1b2c3d4e5f6a7b8c9'}'\n`
  const review = reviewDiff([edit('src/a.ts', 'run()\n', `${key}run()\n`), added('src/a.x.test.ts', TEST)])
  expect(review.findings.find((finding) => finding.rule === 'secret')?.detail).toContain('Anthropic API key')
})

test('it stays one change: a bounded number of files and of lines', () => {
  const many = Array.from({ length: 9 }, (_, i) => edit(`src/f${i}.ts`, "const a = 'x'\n", "const a = 'y'\n"))
  expect(rules(many)).toContain('one-change')
  const big = edit('src/big.ts', 'a\n', Array.from({ length: 500 }, (_, i) => `const v${i} = ${i}`).join('\n'))
  expect(rules([big, added('src/big.x.test.ts', TEST)])).toContain('one-change')
  expect(rules([big, added('src/big.x.test.ts', TEST)], { maxChangedLines: 1000 })).not.toContain('one-change')
})

test('moving a block is free, rewriting it is not', () => {
  expect(changedLines('a\nb\nc\n', 'c\na\nb\n')).toBe(0)
  expect(changedLines('a\nb\nc\n', 'a\nb\nd\n')).toBe(2)
  expect(changedLines(undefined, 'a\nb\n')).toBe(2)
  expect(changedLines('a\nb\n', undefined)).toBe(2)
})

test('a candidate may add a test but never edit one, and the new one cannot weaken the suite', () => {
  expect(rules([edit('src/a.test.ts', TEST, `${TEST}\n`), edit('src/a.ts', 'a\n', 'b\n')])).toContain('existing-test')
  for (const body of ["test.skip('x', () => { expect(1).toBe(1) })", "test.only('x', () => { expect(1).toBe(1) })", "mock.module('../a.ts', () => ({})); test('x', () => { expect(1).toBe(1) })", "test('x', () => { expect(1).toBe(1); process.exit(0) })"]) {
    expect(rules([edit('src/a.ts', 'a\n', 'b\n'), added('src/a.x.test.ts', body)])).toContain('weak-test')
  }
  expect(rules([edit('src/a.ts', 'a\n', 'b\n'), added('src/a.x.test.ts', "test('x', () => {})")])).toContain('weak-test')
})

test('a new test has to sit beside a file the change touches', () => {
  expect(rules([edit('src/a.ts', 'a\n', 'b\n'), added('src/elsewhere.test.ts', TEST)])).toContain('stray-test')
  expect(coversSource('src/tools/readFile.newBehavior.test.ts', 'src/tools/readFile.ts')).toBe(true)
  expect(coversSource('src/tools/readFile.test.ts', 'src/tools/readFile.ts')).toBe(true)
  expect(coversSource('src/tools/readFileExtra.test.ts', 'src/tools/readFile.ts')).toBe(false)
  expect(coversSource('src/other/readFile.test.ts', 'src/tools/readFile.ts')).toBe(false)
})

test('the engine may let a new test through the immutable check, only when it is new and covers the change', () => {
  const existing = new Set(['src/tools/readFile.test.ts'])
  const has = (path: string) => existing.has(path)
  const changed = ['src/tools/readFile.ts', 'src/tools/readFile.newBehavior.test.ts', 'src/tools/readFile.test.ts']
  expect(isNewTestForChange('src/tools/readFile.newBehavior.test.ts', changed, has)).toBe(true)
  expect(isNewTestForChange('src/tools/readFile.test.ts', changed, has)).toBe(false)
  expect(isNewTestForChange('src/tools/unrelated.test.ts', changed, has)).toBe(false)
  expect(isNewTestForChange('src/tools/readFile.ts', changed, has)).toBe(false)
})

test('findings are readable', () => {
  expect(renderFindings(reviewDiff([edit('src/agentLoop.ts', 'a\n', 'b\n')]).findings)).toMatch(/^- needs-test: /)
})

test('lint: a candidate may not add errors, but an already-dirty file is not its fault', async () => {
  const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const live = mkdtempSync(join(tmpdir(), 'lint-live-'))
  const cand = mkdtempSync(join(tmpdir(), 'lint-cand-'))
  try {
    for (const root of [live, cand]) {
      mkdirSync(join(root, 'src'), { recursive: true })
      writeFileSync(join(root, 'src/a.ts'), 'export const a = 1\n')
    }
    // A fake linter that reports a fixed number of errors per working directory.
    const linter = (errors: Record<string, number>) =>
      ((_bin: string, _args: readonly string[], options: { cwd?: string }) => {
        const n = errors[options.cwd ?? ''] ?? 0
        return { status: n ? 1 : 0, stdout: Array.from({ length: n }, (_, i) => `src/a.ts:${i}:1: error rule: bad`).join('\n'), stderr: '', error: undefined }
      }) as never
    expect(lintFinding(live, cand, ['src/a.ts'], linter({ [live]: 2, [cand]: 3 }))?.detail).toBe('adds 1 lint error(s) to the files it changes (2 → 3)')
    // Already dirty and no dirtier: not the candidate's fault.
    expect(lintFinding(live, cand, ['src/a.ts'], linter({ [live]: 2, [cand]: 2 }))).toBeUndefined()
    expect(lintFinding(live, cand, ['src/a.ts'], linter({ [live]: 2, [cand]: 0 }))).toBeUndefined()
    // A test file is not linted, and a file the live tree lacks starts from zero.
    expect(lintFinding(live, cand, ['src/a.test.ts'], linter({ [live]: 0, [cand]: 9 }))).toBeUndefined()
    // A linter that cannot run is never a reason to reject.
    expect(lintFinding(live, cand, ['src/a.ts'], (() => ({ status: null, stdout: '', stderr: '', error: new Error('x') })) as never)).toBeUndefined()
  } finally {
    rmSync(live, { recursive: true, force: true })
    rmSync(cand, { recursive: true, force: true })
  }
})
