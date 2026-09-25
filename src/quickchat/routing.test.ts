import { afterEach, beforeAll, expect, test } from 'bun:test'
import { mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSessionBus } from '../session/bus.ts'
import { makeSessionId, makeSessionName, type QuickchatContext } from '../session/types.ts'
import { QUICKCHAT_TIMEOUT_MS } from './overlay.ts'
import { setFastLoopOverrideForTests, type FastLoopCall, type FastTier } from './quickchat.ts'

function makeTier(providerName: string, model: string): FastTier {
  return { provider: {} as FastTier['provider'], providerName, model, label: `${providerName} (${model})` }
}

const FAST_TIER = makeTier('fast-provider', 'fast-model')
const DEEP_TIER = makeTier('deep-provider', 'deep-model')

/**
 * These tests avoid `mock.module('../agentLoop.ts')` / `mock.module('../config.ts')`:
 * bun registers module mocks in the process-wide loader, so co-resident suites
 * that import those real modules (e.g. bench/correctness/agentBehaviour) would
 * get the stub and collapse. Still, `resolveFastResponder` may not fire a real
 * model call — that is what the in-process `setFastLoopOverrideForTests` seam
 * is for.
 */
let capturedLoop: FastLoopCall | undefined

beforeAll(() => {
  setFastLoopOverrideForTests((opts: FastLoopCall) => {
    capturedLoop = opts
    return Promise.resolve('MOCKED_ANSWER')
  })
})

let runQuickchat: typeof import('./quickchat.ts').runQuickchat
let resolveFastResponder: typeof import('./quickchat.ts').resolveFastResponder
let selectFastTier: typeof import('./quickchat.ts').selectFastTier
let fastTierNote: typeof import('./quickchat.ts').fastTierNote

beforeAll(async () => {
  const mod = await import('./quickchat.ts')
  runQuickchat = mod.runQuickchat
  resolveFastResponder = mod.resolveFastResponder
  selectFastTier = mod.selectFastTier
  fastTierNote = mod.fastTierNote
})

const FIXTURE_CONTEXT: QuickchatContext = {
  sessionId: makeSessionId('qc-fixture'),
  sessionName: makeSessionName('fixture/session'),
  planSteps: [],
  recentAgentOutputs: [],
  filesModified: [],
  pendingReviews: [],
  memorySlice: { lessons: [], projectNotes: [], localLessons: [], localNotes: [] },
  currentErrors: [],
}

const tempDirs: string[] = []

afterEach(() => {
  capturedLoop = undefined
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function tempLogDir(): string {
  const dir = join(tmpdir(), `quickchat-routing-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
  mkdirSync(dir, { recursive: true })
  tempDirs.push(dir)
  return dir
}

test('selectFastTier picks the configured fast tier and never the primary model', () => {
  const tier = selectFastTier({ tiers: { deep: DEEP_TIER, fast: FAST_TIER } })
  expect(tier).toBe(FAST_TIER)
  expect(tier.model).not.toBe(DEEP_TIER.model)
  expect(tier.providerName).not.toBe(DEEP_TIER.providerName)
})

test('selectFastTier without a distinct fast tier mirrors the config fallback onto the primary tier', () => {
  const aliased = makeTier('deep-provider', 'deep-model')
  const tier = selectFastTier({ tiers: { deep: aliased, fast: aliased } })
  expect(tier).toBe(aliased)
  expect(tier.providerName).toBe('deep-provider')
  expect(tier.model).toBe('deep-model')
})

test('fastTierNote flags an aliased fast tier and stays quiet for a distinct one', () => {
  const distinct = { tiers: { deep: DEEP_TIER, fast: FAST_TIER }, cascadeEnabled: true }
  expect(fastTierNote(distinct)).toBeUndefined()

  const aliased = { tiers: { deep: DEEP_TIER, fast: DEEP_TIER }, cascadeEnabled: false }
  const note = fastTierNote(aliased)
  expect(note).toContain('no distinct fast tier is configured')
  expect(note).toContain(DEEP_TIER.label)
  expect(note).toContain('ELIA_FAST_PROVIDER')
})

test('resolveFastResponder sends one tool-less maxSteps-1 call to the fast tier, honouring the abort signal', async () => {
  capturedLoop = undefined

  const responder = await resolveFastResponder()
  expect(typeof responder).toBe('function')

  const signal = new AbortController().signal
  const answer = await responder(FIXTURE_CONTEXT, 'is the build green?', signal)

  expect(typeof answer).toBe('string')
  expect(capturedLoop).toBeDefined()
  expect(capturedLoop!.tools).toEqual([])
  expect(capturedLoop!.maxSteps).toBe(1)
  expect(capturedLoop!.useAnimation).toBe(false)
  expect(capturedLoop!.verbose).toBe(false)
  expect(capturedLoop!.signal).toBe(signal)
})

test('runQuickchat invokes the injected fastResponder seam and lands its output in the answer', async () => {
  const bus = createSessionBus()
  const session = bus.create(makeSessionName('route/me'))
  const logDir = tempLogDir()
  const calls: Array<{ ctx: QuickchatContext; question: string }> = []

  const outcome = await runQuickchat({
    sessionRef: session.id,
    question: 'what is failing?',
    bus,
    logDir,
    async fastResponder(ctx, question) {
      calls.push({ ctx, question })
      return 'SEAM_ANSWER'
    },
  })

  expect(calls).toHaveLength(1)
  expect(calls[0]!.question).toBe('what is failing?')
  expect(calls[0]!.ctx.sessionId).toBe(session.id)
  expect(outcome.answer).toBe('SEAM_ANSWER')
  expect(outcome.overlay.buffer).toBe('SEAM_ANSWER')
  expect(outcome.overlay.contextLabel).toContain('route/me')
  expect(outcome.overlay.status).toBe('closed')
})

test('runQuickchat fails cleanly, without hanging, when the fast tier overruns the timeout ceiling', async () => {
  expect(QUICKCHAT_TIMEOUT_MS).toBe(60_000)

  const bus = createSessionBus()
  const session = bus.create(makeSessionName('slow/tier'))
  const logDir = tempLogDir()
  let seenSignal: AbortSignal | undefined
  const started = performance.now()

  const outcome = await runQuickchat({
    sessionRef: session.id,
    question: 'hurry?',
    bus,
    logDir,
    timeoutMs: 50,
    async fastResponder(_ctx, _question, signal) {
      seenSignal = signal
      return new Promise<string>((resolve) => {
        signal.addEventListener('abort', () => resolve('too late'), { once: true })
      })
    },
  })

  const elapsed = performance.now() - started
  expect(outcome.answer).toContain('timed out after')
  expect(outcome.overlay.buffer).toContain('timed out after')
  expect(outcome.overlay.status).toBe('closed')
  expect(seenSignal?.aborted).toBe(true)
  expect(elapsed).toBeLessThan(2_000)
})