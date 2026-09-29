import { expect, test } from 'bun:test'
import { predictEffect, screenEffect, assess, kindOf, type ChangedFile } from './twin.ts'
import type { Calibration } from './kernel.ts'
import type { PrefixSizes } from './probe.ts'

const NEUTRAL: Calibration = { n: 0, k: 1, sdScale: 1, coverage: undefined }
/** 19 tasks, 6 steps each, 3 attempts: the shape of the built-in suite. */
const baseline = Array.from({ length: 19 }, (_, i) => ({ taskId: `t${i}`, steps: 6, attempts: 3, totalTokens: 331_000 }))
const T0 = 19 * 331_000

const sizes = (promptChars: number): PrefixSizes => ({ promptChars, tools: [{ name: 'a', chars: 60_000 }] })
const wording = (before: string, after: string, path = 'src/tools/readFile.ts'): ChangedFile => ({ path, before: `export const d = '${before}'\n`, after: `export const d = '${after}'\n` })
const logic = (path = 'src/agentLoop.ts'): ChangedFile => ({ path, before: 'const a = 1\n', after: 'const a = 2\n' })

/** The live tree sends 100,000 characters (40,000 of prompt, 60,000 of tools) before any conversation; `candidateChars` is the candidate's total. */
function effectOf(changed: ChangedFile[], candidateChars: number, calibration = NEUTRAL) {
  return predictEffect({ changed, live: sizes(40_000), candidate: sizes(candidateChars - 60_000), baseline, calibration })
}

test('kinds: tests and documents are not run, wording is priced, logic is a gamble', () => {
  expect(kindOf({ path: 'src/a.test.ts', before: 'x', after: 'y' })).toBe('test')
  expect(kindOf({ path: 'README.md', before: 'x', after: 'y' })).toBe('docs')
  expect(kindOf(wording('a', 'b'))).toBe('text')
  expect(kindOf(logic())).toBe('logic')
  expect(kindOf({ path: 'src/autonomy/roles.ts', before: 'const a = 1', after: 'const a = 2' })).toBe('dormant')
  expect(kindOf({ path: 'src/new.ts', after: 'export const a = 1\n' })).toBe('logic')
})

test('the arithmetic: fewer tokens on every call, times every call, over what the suite spends', () => {
  // 10,000 fewer chars = 2,500 fewer tokens per call; 342 calls; 855k of 6.29M tokens is 13.6%.
  const effect = effectOf([wording('long long long', 'short')], 90_000)
  expect(effect.surface).toBe('prefix')
  expect(effect.calls).toBe(19 * 6 * 3)
  expect(effect.prefixDelta).toBeCloseTo(-2500, 5)
  expect(Math.exp(effect.raw) - 1).toBeCloseTo((-2500 * 342) / T0, 6)
  expect(effect.belief.sd).toBe(0.03)
})

test('a diff that changes only tests, documents and dormant code is inert, and is stopped as unmeasurable', () => {
  const effect = effectOf([{ path: 'src/a.test.ts', before: 'x', after: 'y' }, { path: 'src/autonomy/roles.ts', before: 'a', after: 'b' }, { path: 'docs/x.md', before: 'a', after: 'b' }], 100_000)
  expect(effect.surface).toBe('inert')
  const screen = screenEffect(effect, { failingReachable: true })
  expect(screen.proceed).toBe(false)
  expect(screen.unmeasurable).toBe(true)
  // The wording judgementOf reads: a diff nothing measures is not evidence against its idea.
  expect(screen.reason).toMatch(/could not be measured/)
})

test('rewording that never reaches the prompt is not inert: it changes what tools tell the model', () => {
  const effect = effectOf([wording('old error text', 'new error text', 'src/tools/grep.ts')], 100_000)
  expect(effect.surface).toBe('other')
  expect(screenEffect(effect, { failingReachable: false }).proceed).toBe(true)
})

test('a large exactly-priced saving is worth measuring', () => {
  const screen = screenEffect(effectOf([wording('long long long', 'short')], 90_000), { failingReachable: false })
  expect(screen.proceed).toBe(true)
  expect(screen.winProbability).toBeGreaterThan(0.95)
})

test('a saving too small to clear the gate is stopped, with the arithmetic and what would be enough', () => {
  // 800 chars = 200 tokens per call = about 1.1% of the suite.
  const screen = screenEffect(effectOf([wording('a bit longer', 'shorter')], 99_200), { failingReachable: false })
  expect(screen.proceed).toBe(false)
  expect(screen.unmeasurable).toBe(false)
  expect(screen.reason).toContain('predicted saving 1.1%')
  expect(screen.reason).toContain('200 fewer tokens on every call')
  const more = Number(screen.reason.match(/cut about (\d+) more tokens/)![1])
  // Removing that many more makes the saving worth measuring.
  const enough = screenEffect(effectOf([wording('a', 'b')], 100_000 - (200 + more) * 4), { failingReachable: false })
  expect(enough.winProbability).toBeGreaterThan(0.58)
  expect(enough.proceed).toBe(true)
})

test('a saving too small is still measured when a failing task might be fixed by it', () => {
  const screen = screenEffect(effectOf([wording('a bit longer', 'shorter')], 99_200), { failingReachable: true })
  expect(screen.proceed).toBe(true)
})

test('text added to every call, with nothing failing to fix, is stopped', () => {
  const screen = screenEffect(effectOf([wording('short', 'a rule that is much much longer')], 110_000), { failingReachable: false })
  expect(screen.proceed).toBe(false)
  expect(screen.reason).toContain('adds 2500 tokens to every call')
  // A small addition is a gamble on fewer steps, and is allowed.
  expect(screenEffect(effectOf([wording('short', 'slightly longer')], 100_400), { failingReachable: false }).proceed).toBe(true)
})

test('logic is priced wide and left to the benchmark, whatever it does to the prompt', () => {
  const alone = effectOf([logic()], 100_000)
  expect(alone.surface).toBe('other')
  expect(alone.belief.sd).toBe(0.15)
  const mixed = effectOf([logic(), wording('a', 'b')], 90_000)
  expect(mixed.surface).toBe('mixed')
  expect(screenEffect(mixed, { failingReachable: false }).proceed).toBe(true)
})

test('an unreadable prompt size is never a reason to stop a candidate', () => {
  const effect = predictEffect({ changed: [wording('a', 'b')], live: sizes(40_000), candidate: undefined, baseline, calibration: NEUTRAL })
  expect(effect.surface).toBe('other')
  expect(screenEffect(effect, { failingReachable: false }).proceed).toBe(true)
})

test('calibration scales the prediction and its width, so the ledger moves the model', () => {
  const plain = effectOf([wording('a', 'b')], 90_000)
  const calibrated = effectOf([wording('a', 'b')], 90_000, { n: 5, k: 0.5, sdScale: 2, coverage: 0.4 })
  expect(calibrated.belief.mean).toBeCloseTo(plain.belief.mean * 0.5, 9)
  expect(calibrated.belief.sd).toBeCloseTo(plain.belief.sd * 2, 9)
  expect(calibrated.raw).toBe(plain.raw)
})

test('unmeasured baseline rows are not part of what a saving is a fraction of', () => {
  const effect = predictEffect({ changed: [wording('a', 'b')], live: sizes(40_000), candidate: sizes(30_000), baseline: [...baseline, { taskId: 'x', steps: 99, attempts: 3, totalTokens: 9e9, unmeasured: true }], calibration: NEUTRAL })
  expect(effect.baselineTokens).toBe(T0)
})

test('assess reads both trees and screens, with the prompt sizes injected', async () => {
  const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const live = mkdtempSync(join(tmpdir(), 'twin-live-'))
  const cand = mkdtempSync(join(tmpdir(), 'twin-cand-'))
  try {
    for (const [root, text] of [[live, 'a long long description of what this does'], [cand, 'reads a file']] as const) {
      mkdirSync(join(root, 'src/tools'), { recursive: true })
      writeFileSync(join(root, 'src/tools/readFile.ts'), `export const d = '${text}'\n`)
    }
    const screen = await assess({
      liveRoot: live,
      candidateRoot: cand,
      changed: ['src/tools/readFile.ts'],
      baseline,
      calibration: NEUTRAL,
      failingReachable: false,
      prefix: async (root) => (root === live ? sizes(40_000) : sizes(30_000)),
    })
    expect(screen.effect.surface).toBe('prefix')
    expect(screen.proceed).toBe(true)
  } finally {
    rmSync(live, { recursive: true, force: true })
    rmSync(cand, { recursive: true, force: true })
  }
})
