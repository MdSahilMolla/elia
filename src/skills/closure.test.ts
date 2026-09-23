import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SkillCandidate } from './detector.ts'
import { compressionQueue, compressOnce, encodingRefusal, roundTripsSaved } from './closure.ts'
import { lessonElasticity } from '../compounding/growth.ts'
import { readLibrary } from '../autonomy/certifiedLibrary.ts'
import { bootstrappingFit, readClosureLog, recordToolConstruction, type ClosureRecord } from './toolLog.ts'
import { seededRandom } from '../compounding/stats.ts'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'elia-closure-'))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

const habit = (pattern: string, count: number, kind: SkillCandidate['kind'] = 'command'): SkillCandidate => ({ kind, pattern, count, examples: [] })

test('habits that must never become tools automatically', () => {
  expect(encodingRefusal(habit('powershell', 105))).toContain('too general')
  expect(encodingRefusal(habit('node -e', 50))).toContain('arbitrary code')
  expect(encodingRefusal(habit('git push', 30))).toContain("person's decision")
  expect(encodingRefusal(habit('npm publish', 30))).toContain("person's decision")
  expect(encodingRefusal(habit('git diff', 53))).toBeUndefined()
  // A read-only lookup can come back in one call; an edit is the model's decision about what it read.
  expect(encodingRefusal(habit('grep → read_file → read_file', 49, 'sequence'))).toBeUndefined()
  expect(encodingRefusal(habit('grep → read_file → edit_file', 49, 'sequence'))).toContain('ordinary editing')
  // The governor once recommended building a tool for this, elia's top "safe" habit.
  expect(encodingRefusal(habit('read_file → edit_file → edit_file', 28, 'sequence'))).toContain('ordinary editing')
  // The top habit in elia's real stats: a routine of "run whatever, then write".
  expect(encodingRefusal(habit('run_command → run_command → write_file', 44, 'sequence'))).toContain('arbitrary shell')
  expect(roundTripsSaved(habit('grep → read_file → edit_file', 1, 'sequence'))).toBe(2)
})

test("script runners and installers are the command governor's call, not a tool's", () => {
  expect(encodingRefusal(habit('npm run', 26))).toContain('whatever script')
  expect(encodingRefusal(habit('uv run', 23))).toContain('whatever script')
  expect(encodingRefusal(habit('npx vite', 10))).toContain('arbitrary code')
  expect(encodingRefusal(habit('npm install', 29))).toContain('registry')
  expect(encodingRefusal(habit('pip install', 12))).toContain('registry')
  expect(encodingRefusal(habit('npm test', 13))).toBeUndefined()
})

test('the queue ranks by round-trips saved and skips recorded dead ends', () => {
  const library = join(dir, 'library.jsonl')
  recordToolConstruction({ pattern: 'git log', ok: false, reason: 'test failed', tokens: 900, bytes: 400 }, { logPath: join(dir, 'closure.jsonl'), libraryFile: library })
  const queue = compressionQueue(
    [habit('powershell', 105), habit('git diff', 53), habit('grep → read_file → read_file', 49, 'sequence'), habit('git log', 80)],
    readLibrary(library),
  )
  expect(queue.queued.map((entry) => entry.candidate.pattern)).toEqual(['grep → read_file → read_file', 'git diff'])
  expect(queue.refused.map((entry) => entry.pattern).sort()).toEqual(['git log', 'powershell'])
})

test('compressOnce builds the top of the queue and nothing else', async () => {
  const built: string[] = []
  const result = await compressOnce(compressionQueue([habit('git diff', 53), habit('git status', 20)], new Map()), async (candidate) => {
    built.push(candidate.pattern)
    return { ok: true, toolName: 'git_diff_summary', detail: 'ok' }
  })
  expect(built).toEqual(['git diff'])
  expect(result.attempted).toBe('git diff')
  expect((await compressOnce(compressionQueue([habit('powershell', 9)], new Map()), async () => ({ ok: true, detail: '' }))).skipped).toContain('refused')
})

test('a built tool is a certified skill; a failure is a dead-end record', () => {
  const library = join(dir, 'library.jsonl')
  const logPath = join(dir, 'closure.jsonl')
  recordToolConstruction({ pattern: 'git diff', ok: true, reason: 'built', tokens: 1200, bytes: 900, toolName: 'git_diff_summary', testPassed: true, loaded: true }, { logPath, libraryFile: library })
  recordToolConstruction({ pattern: 'git show', ok: true, reason: 'built', tokens: 800, bytes: 500, toolName: 'git_show', loaded: true }, { logPath, libraryFile: library })
  const artifacts = readLibrary(library)
  expect(artifacts.get('skill:git_diff_summary')!.status).toBe('admitted')
  // No test was written: one check, so it waits on probation.
  expect(artifacts.get('skill:git_show')!.status).toBe('probation')
  expect(readClosureLog(logPath)).toHaveLength(2)
})

test('Conjecture 1: the fit tells exponential from polynomial construction cost', () => {
  const base = { pattern: 'p', ok: true, reason: '', at: 0 }
  const lengths = [500, 1000, 2000, 4000, 8000, 16000, 32000]
  const poly: ClosureRecord[] = lengths.map((bytes) => ({ ...base, bytes, tokens: Math.round(3 * bytes ** 1.2) }))
  expect(bootstrappingFit(poly).verdict).toBe('polynomial')
  const exp: ClosureRecord[] = [500, 1000, 1500, 2000, 2500, 3000, 3500].map((bytes) => ({ ...base, bytes, tokens: Math.round(200 * Math.exp(bytes / 400)) }))
  expect(bootstrappingFit(exp).verdict).toBe('exponential')
  expect(bootstrappingFit(poly.slice(0, 3)).detail).toContain('needs')
})

test('γ from the holdout coin: recovers a real effect, and reports none when there is none', () => {
  const random = seededRandom(3)
  const withEffect = Array.from({ length: 4000 }, () => {
    const heldOut = random() < 0.5 ? 10 : 0
    const shown = 20 - heldOut
    const clean = random() < 0.4 + 0.3 * (shown / 20)
    return { lessonKeys: Array(shown).fill('k'), heldOutKeys: Array(heldOut).fill('h'), clean }
  })
  const estimate = lessonElasticity(withEffect)
  expect(estimate.gamma!).toBeGreaterThan(0)
  expect(estimate.detail).toContain('raises')

  const none = withEffect.map((line) => ({ ...line, clean: random() < 0.6 }))
  expect(lessonElasticity(none).detail).toContain('indistinguishable from zero')
  expect(lessonElasticity([]).detail).toContain('needs')
})
