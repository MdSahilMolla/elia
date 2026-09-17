import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MIN_RESOLVED, inBackground, predict, predictLabelled, readLedger, resolvePrediction, settleSystemOne, summarize, type Prediction, type Resolution } from './systemOne.ts'

const originalFetch = globalThis.fetch
const saved = { key: process.env.ELIA_JEV_API_KEY, alt: process.env.TYPESAFE_API_KEY, mode: process.env.ELIA_JEV_MODE }
let dir: string

function restore(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name]
  else process.env[name] = value
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'elia-system-one-'))
  process.env.ELIA_JEV_API_KEY = 'test-key'
  delete process.env.TYPESAFE_API_KEY
  delete process.env.ELIA_JEV_MODE
})

afterEach(() => {
  globalThis.fetch = originalFetch
  restore('ELIA_JEV_API_KEY', saved.key)
  restore('TYPESAFE_API_KEY', saved.alt)
  restore('ELIA_JEV_MODE', saved.mode)
  rmSync(dir, { recursive: true, force: true })
})

const Q = { instructions: 'The change is correct.' }

function jevSays(pYes: number): void {
  globalThis.fetch = (async () => new Response(JSON.stringify({ answers: { outcome: { type: 'noul', noul: pYes } } }))) as unknown as typeof fetch
}

/** A ledger where Jev and elia each answered `n` decisions with the given hit rates. */
function history(n: number, jevRight: number, localRight: number, failures: number): Array<Prediction | Resolution> {
  const lines: Array<Prediction | Resolution> = []
  for (let i = 0; i < n; i += 1) {
    const actual = i >= failures
    const id = `p${i}`
    lines.push({
      type: 'predict', id, at: '', kind: 'turn-verify', latencyMs: 100,
      local: i < localRight ? actual : !actual,
      jev: { pYes: (i < jevRight ? actual : !actual) ? 0.9 : 0.1 },
    })
    lines.push({ type: 'resolve', id, at: '', actual })
  }
  return lines
}

test('with no key, predict is undefined and writes nothing — elia runs exactly as before', async () => {
  delete process.env.ELIA_JEV_API_KEY
  expect(await predict('turn-verify', 's', Q, { dir })).toBeUndefined()
  expect(readLedger(dir)).toEqual([])
})

test('a prediction and its outcome are both recorded and joined', async () => {
  jevSays(0.1)
  const result = await predict('turn-verify', 's', Q, { dir, local: true })
  expect(result).toMatchObject({ ok: false, pYes: 0.1, actionable: false })
  resolvePrediction(result!.id, false, dir)
  const [summary] = summarize(readLedger(dir))
  expect(summary).toMatchObject({ kind: 'turn-verify', answered: 1, resolved: 1, jevAccuracy: 1, localAccuracy: 0, jevFailureRecall: 1, promoted: false })
})

test('a failed call is recorded as an error and never counts as an answer', async () => {
  globalThis.fetch = (async () => new Response('down', { status: 503 })) as unknown as typeof fetch
  const result = await predict('turn-verify', 's', Q, { dir })
  expect(result).toEqual({ id: expect.any(String), actionable: false })
  expect(summarize(readLedger(dir))[0]).toMatchObject({ answered: 0, errors: 1 })
})

test('the question goes out as a noul, and a malformed answer is an error, not a guess', async () => {
  let sent: Record<string, unknown> | undefined
  globalThis.fetch = (async (_url: string, init: RequestInit) => {
    sent = JSON.parse(String(init.body))
    return new Response(JSON.stringify({ answers: { outcome: { type: 'noul', noul: 'maybe' } } }))
  }) as unknown as typeof fetch
  expect((await predict('turn-verify', { diff: 'x' }, { instructions: 'q', criteria: { true: 't', false: 'f' } }, { dir }))?.ok).toBeUndefined()
  expect(sent?.questions).toEqual({ outcome: { type: 'noul', instructions: 'q', criteria: { true: 't', false: 'f' } } })
  expect(sent?.state).toEqual({ diff: 'x' })
  expect(summarize(readLedger(dir))[0]).toMatchObject({ answered: 0, errors: 1 })
})

test('no decision is promoted on too few outcomes, however good they look', () => {
  const [summary] = summarize(history(MIN_RESOLVED - 1, MIN_RESOLVED - 1, 0, 5))
  expect(summary!.promoted).toBe(false)
  expect(summary!.why).toContain('too few')
})

test('Jev is not promoted when it merely matches elia', () => {
  const [summary] = summarize(history(30, 25, 25, 10))
  expect(summary!.promoted).toBe(false)
  expect(summary!.why).toContain('does not beat')
})

test('Jev is not promoted when no failure was ever seen', () => {
  const [summary] = summarize(history(30, 30, 20, 0))
  expect(summary!.promoted).toBe(false)
  expect(summary!.why).toContain('no failures')
})

test('Jev is promoted once it clearly beats elia on enough outcomes', () => {
  const [summary] = summarize(history(30, 28, 20, 10))
  expect(summary).toMatchObject({ promoted: true, resolved: 30 })
})

test('auto mode acts only on a promoted decision, and only when confident', async () => {
  jevSays(0.05)
  expect((await predict('turn-verify', 's', Q, { dir }))!.actionable).toBe(false)

  const { appendFileSync } = await import('node:fs')
  appendFileSync(join(dir, 'system-one.ndjson'), history(30, 28, 20, 10).map((line) => JSON.stringify(line)).join('\n') + '\n')
  expect((await predict('turn-verify', 's', Q, { dir }))!.actionable).toBe(true)
  // A different decision has its own record, and this one has none.
  expect((await predict('run-complete', 's', Q, { dir }))!.actionable).toBe(false)

  jevSays(0.4)
  expect((await predict('turn-verify', 's', Q, { dir }))!.actionable).toBe(false)
})

test('shadow mode never acts; always mode acts without a record', async () => {
  jevSays(0.05)
  process.env.ELIA_JEV_MODE = 'shadow'
  const { appendFileSync } = await import('node:fs')
  appendFileSync(join(dir, 'system-one.ndjson'), history(30, 28, 20, 10).map((line) => JSON.stringify(line)).join('\n') + '\n')
  expect((await predict('turn-verify', 's', Q, { dir }))!.actionable).toBe(false)
  process.env.ELIA_JEV_MODE = 'always'
  expect((await predict('run-complete', 's', Q, { dir }))!.actionable).toBe(true)
})

test('predictLabelled scores a benchmark answer immediately', async () => {
  jevSays(0.8)
  await predictLabelled('critic-defect', 's', Q, false, { dir })
  expect(summarize(readLedger(dir)).find((s) => s.kind === 'critic-defect')).toMatchObject({ resolved: 1, jevAccuracy: 0 })
})

test('settleSystemOne waits for background predictions', async () => {
  let finished = false
  inBackground(async () => {
    await new Promise((resolve) => setTimeout(resolve, 30))
    finished = true
  })
  inBackground(async () => {
    throw new Error('ignored')
  })
  await settleSystemOne()
  expect(finished).toBe(true)
})
