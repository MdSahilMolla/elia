import { afterEach, beforeAll, expect, mock, test } from 'bun:test'
import { mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSessionBus } from '../session/bus.ts'
import { makeSessionId, makeSessionName, type QuickchatContext } from '../session/types.ts'
import { QUICKCHAT_TIMEOUT_MS } from './overlay.ts'

interface TierFixture {
  provider: object
  providerName: string
  model: string
  label: string
}

function makeTier(providerName: string, model: string): TierFixture {
  return { provider: { kind: providerName }, providerName, model, label: `${providerName} (${model})` }
}

interface ConfigShim {
  model: string
  providerName: string
  tiers: { deep: TierFixture; fast: TierFixture }
}

const FAST_TIER = makeTier('fast-provider', 'fast-model')
const DEEP_TIER = makeTier('deep-provider', 'deep-model')

const configShim: ConfigShim = {
  model: DEEP_TIER.model,
  providerName: DEEP_TIER.providerName,
  tiers: { deep: DEEP_TIER, fast: FAST_TIER },
}

interface CapturedLoopArgs {
  provider: object
  providerName: string
  model: string
  tools: unknown[]
  maxSteps: number
  useAnimation: boolean
  verbose: boolean
  signal?: AbortSignal
  systemPrompt?: string
}

let capturedLoop: CapturedLoopArgs | undefined

mock.module('../config.ts', () => ({ config: configShim }))
mock.module('../agentLoop.ts', () => ({
  runAgentLoop(opts: CapturedLoopArgs): undefined {
    capturedLoop = opts
    return undefined
  },
  lastAssistantText(): string {
    return 'MOCKED_ANSWER'
  },
}))

let runQuickchat: typeof import('./quickchat.ts').runQuickchat
let resolveFastResponder: typeof import('./quickchat.ts').resolveFastResponder

beforeAll(async () => {
  const mod = await import('./quickchat.ts')
  runQuickchat = mod.runQuickchat
  resolveFastResponder = mod.resolveFastResponder
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
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function tempLogDir(): string {
  const dir = join(tmpdir(), `quickchat-routing-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
  mkdirSync(dir, { recursive: true })
  tempDirs.push(dir)
  return dir
}

test('resolveFastResponder picks the configured fast tier and never the primary model', async () => {
  configShim.model = DEEP_TIER.model
  configShim.providerName = DEEP_TIER.providerName
  configShim.tiers.deep = DEEP_TIER
  configShim.tiers.fast = FAST_TIER
  capturedLoop = undefined

  const responder = await resolveFastResponder()
  expect(typeof responder).toBe('function')

  const signal = new AbortController().signal
  const answer = await responder(FIXTURE_CONTEXT, 'is the build green?', signal)

  expect(answer).toBe('MOCKED_ANSWER')
  expect(capturedLoop).toBeDefined()
  expect(capturedLoop!.provider).toBe(configShim.tiers.fast.provider)
  expect(capturedLoop!.providerName).toBe(configShim.tiers.fast.providerName)
  expect(capturedLoop!.model).toBe(configShim.tiers.fast.model)
  expect(capturedLoop!.model).not.toBe(configShim.model)
  expect(capturedLoop!.providerName).not.toBe(configShim.providerName)
  expect(capturedLoop!.tools).toEqual([])
  expect(capturedLoop!.maxSteps).toBe(1)
  expect(capturedLoop!.signal).toBe(signal)
})

test('resolveFastResponder without a distinct fast tier aliases the primary tier, per the config fallback', async () => {
  const aliased = makeTier('deep-provider', 'deep-model')
  configShim.model = aliased.model
  configShim.providerName = aliased.providerName
  configShim.tiers.deep = aliased
  configShim.tiers.fast = aliased
  capturedLoop = undefined

  const responder = await resolveFastResponder()
  const answer = await responder(FIXTURE_CONTEXT, 'ping', new AbortController().signal)

  expect(answer).toBe('MOCKED_ANSWER')
  expect(capturedLoop!.providerName).toBe('deep-provider')
  expect(capturedLoop!.model).toBe('deep-model')
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