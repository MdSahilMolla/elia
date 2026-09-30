import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { KNOWN_KEY_FORMATS } from '../secretFormats.ts'
import { kindOf, type ChangedFile } from '../world/twin.ts'

/**
 * What a candidate's *code* has to be, checked on the diff before a single
 * benchmark task is paid for.
 *
 * A benchmark says a change is not worse. It cannot say the change is good
 * code, and a loop that promotes on the score alone will, given long enough,
 * promote a working edit that silenced the type checker to get there. So a
 * candidate is read the way a reviewer would read it, mechanically:
 *
 *   - it may not switch off a check (`@ts-ignore`, `oxlint-disable`, more
 *     `any` than it started with), or leave a debugger in;
 *   - it may not carry a credential;
 *   - it stays one change: a bounded number of files and lines, because a
 *     change that cannot be attributed cannot be learned from (RRSI's budget
 *     on bundled edits, and the reason the proposer is told to change one
 *     thing);
 *   - a change to logic ships a test for it, and that test must be one that
 *     could have failed (failToPass.ts). Existing tests stay untouched — they
 *     are immutable — but a *new* test file next to the code it covers is the
 *     one addition a candidate may make, and is held to the rules below so it
 *     cannot be used to weaken the suite it joins.
 *
 * Immutable to the loop (sandbox.ts): a candidate that could edit this could
 * approve itself.
 */

export interface Finding {
  rule: string
  file?: string
  detail: string
}

export interface QualityReview {
  ok: boolean
  findings: Finding[]
  /** New test files the diff adds next to code it changes. */
  newTests: string[]
  /** True when the diff changes logic that a test should cover. */
  needsTest: boolean
}

export interface QualityOptions {
  maxFiles?: number
  maxChangedLines?: number
}

/** One change, not a rewrite. */
export const MAX_FILES = 8
export const MAX_CHANGED_LINES = 400

const ESCAPE_HATCHES = /@ts-(?:ignore|expect-error|nocheck)|eslint-disable|oxlint-disable|biome-ignore/g
const ANY = /(?::\s*any\b|\bas\s+any\b|<any>)/g
const DEBUGGER = /^\s*debugger\s*;?\s*$/gm
const FORBIDDEN_IN_NEW_TESTS: Array<{ pattern: RegExp; why: string }> = [
  { pattern: /\.(?:skip|only|todo)\s*\(|\b(?:xit|xtest|xdescribe|fit|fdescribe)\s*\(/, why: 'skips or isolates tests, so the suite around it runs less' },
  { pattern: /\bmock\.module\s*\(/, why: 'replaces a module for every test file in the same process, which is how one file can weaken another' },
  { pattern: /\bprocess\.exit\s*\(/, why: 'ends the whole test run early' },
]

function count(text: string | undefined, pattern: RegExp): number {
  return text ? (text.match(pattern)?.length ?? 0) : 0
}

function lines(text: string | undefined): string[] {
  // Blank lines are layout, not change.
  return text === undefined ? [] : text.split('\n').map((line) => line.trim()).filter((line) => line !== '')
}

/** Lines added plus lines removed, as a multiset difference: moving a block around costs nothing, rewriting it does. */
export function changedLines(before: string | undefined, after: string | undefined): number {
  const remaining = new Map<string, number>()
  for (const line of lines(before)) remaining.set(line, (remaining.get(line) ?? 0) + 1)
  let added = 0
  for (const line of lines(after)) {
    const left = remaining.get(line) ?? 0
    if (left > 0) remaining.set(line, left - 1)
    else added += 1
  }
  let removed = 0
  for (const left of remaining.values()) removed += left
  return added + removed
}

const isTestPath = (path: string) => /\.test\.[cm]?[jt]sx?$/.test(path)

/** `foo.test.ts` and `foo.<anything>.test.ts` beside `foo.ts` cover it. */
export function coversSource(testPath: string, sourcePath: string): boolean {
  const test = testPath.replace(/\\/g, '/')
  const source = sourcePath.replace(/\\/g, '/')
  if (dirname(test) !== dirname(source)) return false
  const stem = basename(source).replace(/\.[cm]?[jt]sx?$/, '')
  const testStem = basename(test).replace(/\.test\.[cm]?[jt]sx?$/, '')
  return testStem === stem || testStem.startsWith(`${stem}.`)
}

/**
 * A test file the diff adds beside source it changes. The one edit to the test
 * suite a candidate may make, and only if the file is new — an existing test is
 * never editable. The name may carry a suffix (`readFile.newBehavior.test.ts`),
 * because the obvious file (`readFile.test.ts`) usually exists already, and is
 * the one thing the candidate is not allowed to touch.
 */
export function isNewTestForChange(path: string, changedPaths: readonly string[], existsInLive: (path: string) => boolean): boolean {
  const normalized = path.replace(/\\/g, '/')
  if (!isTestPath(normalized) || existsInLive(normalized)) return false
  return changedPaths.some((other) => !isTestPath(other) && coversSource(normalized, other))
}

export function reviewDiff(changed: readonly ChangedFile[], options: QualityOptions = {}): QualityReview {
  const findings: Finding[] = []
  const add = (rule: string, detail: string, file?: string) => findings.push({ rule, detail, ...(file ? { file } : {}) })
  const paths = changed.map((file) => file.path)
  const isNew = (file: ChangedFile) => file.before === undefined

  const maxFiles = options.maxFiles ?? MAX_FILES
  const maxLines = options.maxChangedLines ?? MAX_CHANGED_LINES
  const sourceFiles = changed.filter((file) => !isTestPath(file.path))
  if (changed.length > maxFiles) add('one-change', `changes ${changed.length} files; a change that cannot be attributed cannot be learned from — keep it to ${maxFiles} or fewer`)
  const total = sourceFiles.reduce((sum, file) => sum + changedLines(file.before, file.after), 0)
  if (total > maxLines) add('one-change', `changes ${total} lines of source; keep one change under ${maxLines}`)

  const newTests: string[] = []
  for (const file of changed) {
    if (count(file.after, ESCAPE_HATCHES) > count(file.before, ESCAPE_HATCHES)) add('disabled-check', 'adds a suppression comment (a type or lint check switched off, not satisfied)', file.path)
    if (count(file.after, ANY) > count(file.before, ANY)) add('any', 'adds an `any`; type the value instead', file.path)
    if (count(file.after, DEBUGGER) > count(file.before, DEBUGGER)) add('debugger', 'leaves a debugger statement in', file.path)
    for (const format of KNOWN_KEY_FORMATS) {
      if (format.pattern.test(file.after ?? '') && !format.pattern.test(file.before ?? '')) add('secret', `adds what looks like ${format.name}`, file.path)
    }

    if (isTestPath(file.path)) {
      if (!isNew(file)) {
        add('existing-test', 'edits an existing test, which candidates may never do', file.path)
        continue
      }
      newTests.push(file.path)
      const after = file.after ?? ''
      for (const rule of FORBIDDEN_IN_NEW_TESTS) if (rule.pattern.test(after)) add('weak-test', `a new test that ${rule.why}`, file.path)
      if (!/\bexpect\s*\(/.test(after)) add('weak-test', 'a new test with no assertion proves nothing', file.path)
      if (!paths.some((other) => !isTestPath(other) && coversSource(file.path, other))) {
        add('stray-test', 'a new test must sit beside a source file this change touches, named after it (foo.ts → foo.test.ts or foo.something.test.ts)', file.path)
      }
    }
  }

  const logic = changed.filter((file) => !isTestPath(file.path) && kindOf(file) === 'logic' && file.path.startsWith('src/'))
  const needsTest = logic.length > 0
  if (needsTest && newTests.length === 0) {
    add('needs-test', `changes logic in ${logic.map((file) => file.path).slice(0, 3).join(', ')} without a test: add a new file beside it (${dirname(logic[0]!.path)}/${basename(logic[0]!.path).replace(/(\.[cm]?[jt]s)$/, '.<change>.test$1')}) whose tests fail without the change`)
  }

  return { ok: findings.length === 0, findings, newTests, needsTest }
}

export function renderFindings(findings: readonly Finding[]): string {
  return findings.map((finding) => `- ${finding.rule}${finding.file ? ` (${finding.file})` : ''}: ${finding.detail}`).join('\n')
}

type Runner = typeof spawnSync

/**
 * Lint errors oxlint reports for `files` as they stand under `cwd`. Undefined
 * when the linter cannot run: a check that cannot run is not a reason to reject.
 * The binary is the live tree's — a candidate sandbox has no node_modules of its
 * own, it inherits them by living inside the live root.
 */
export function lintErrors(liveRoot: string, cwd: string, files: readonly string[], run: Runner = spawnSync): number | undefined {
  const targets = files.filter((file) => /\.[cm]?[jt]sx?$/.test(file) && !isTestPath(file) && existsSync(join(cwd, file)))
  if (targets.length === 0) return 0
  const result = run(join(liveRoot, 'node_modules', '.bin', 'oxlint'), targets, { cwd, encoding: 'utf8', windowsHide: true })
  if (result.error || (result.status !== 0 && result.status !== 1)) return undefined
  return `${result.stdout}\n${result.stderr}`.split('\n').filter((line) => / error /.test(line)).length
}

/**
 * Whether the candidate added lint errors to the files it touched. The tree is
 * not required to be clean — other work leaves errors behind, and a gate that
 * rejects on those would reject everything — only not to be made worse.
 */
export function lintFinding(liveRoot: string, candidateRoot: string, files: readonly string[], run: Runner = spawnSync): Finding | undefined {
  const before = lintErrors(liveRoot, liveRoot, files, run)
  const after = lintErrors(liveRoot, candidateRoot, files, run)
  if (before === undefined || after === undefined || after <= before) return undefined
  return { rule: 'lint', detail: `adds ${after - before} lint error(s) to the files it changes (${before} → ${after})` }
}
