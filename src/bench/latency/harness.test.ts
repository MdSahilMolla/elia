import { expect, test } from 'bun:test'
import { createScriptedProvider } from './scriptedProvider.ts'
import { runLatencyHarness, type LatencyReport } from './harness.ts'
import { compareLatency } from './report.ts'
import { LATENCY_SCENARIOS } from './scenarios.ts'

test('the scripted provider serves turns in order, streams text, and fires onToolBlock mid-turn', async () => {
  const provider = createScriptedProvider([
    { text: 'first', toolCalls: [{ name: 'read_file', input: { path: 'a.ts' } }] },
    { text: 'second' },
  ])

  const streamed: string[] = []
  const toolBlocks: string[] = []
  const first = await provider.streamTurn({
    system: '',
    messages: [],
    tools: [],
    onText: (delta) => streamed.push(delta),
    onToolBlock: (block) => {
      if (block.type === 'tool_use') toolBlocks.push(block.name)
    },
  })
  expect(streamed.join('')).toBe('first')
  expect(toolBlocks).toEqual(['read_file'])
  expect(first.content.some((block) => block.type === 'tool_use')).toBe(true)

  const second = await provider.streamTurn({ system: '', messages: [], tools: [], onText: () => {} })
  expect(second.content).toEqual([{ type: 'text', text: 'second' }])
  expect(provider.calls).toBe(2)

  // Exhausted script degrades to a bare done. turn rather than hanging.
  const third = await provider.streamTurn({ system: '', messages: [], tools: [], onText: () => {} })
  expect(third.content).toEqual([{ type: 'text', text: 'done.' }])
})

test('every scenario meets its structural expectations when run through the real loop', async () => {
  const report = await runLatencyHarness({ runsPerScenario: 1, skipColdStart: true })
  expect(report.scenarios.map((scenario) => scenario.id).sort()).toEqual(LATENCY_SCENARIOS.map((scenario) => scenario.id).sort())
  for (const scenario of report.scenarios) {
    expect({ id: scenario.id, ok: scenario.structuralOk, notes: scenario.notes }).toEqual({ id: scenario.id, ok: true, notes: [] })
  }
}, 60_000)

test('speculative dispatch shows up as pre-run reads in the parallel-reads scenario', async () => {
  const report = await runLatencyHarness({ runsPerScenario: 1, only: ['parallel-reads'], skipColdStart: true })
  const scenario = report.scenarios[0]!
  expect(scenario.toolCalls).toBe(6)
  expect(scenario.cachedToolCalls).toBe(6) // all six reads served from the speculative cache
  expect(scenario.roundTrips).toBe(2)
}, 30_000)

function baselineFixture(): LatencyReport {
  return {
    generatedAt: '2026-01-01T00:00:00.000Z',
    live: false,
    model: 'scripted',
    coldStartMsMedian: 400,
    modelPacing: { ttftMs: 0, tokenMs: 0 },
    scenarios: [
      { id: 'parallel-reads', description: '', runs: 3, wallMsMedian: 10, wallMsMin: 9, firstTokenMsMedian: 0.1, roundTrips: 2, toolCalls: 6, cachedToolCalls: 6, speculativeHits: 6, speculativeMisses: 0, outputTokensMedian: 0, tokensPerSecMedian: 0, structuralOk: true, notes: [] },
    ],
  }
}

test('compareLatency flags a lost speculative hit as a hard regression', () => {
  const current = baselineFixture()
  current.scenarios[0]!.cachedToolCalls = 3
  const comparison = compareLatency(baselineFixture(), current)
  expect(comparison.ok).toBe(false)
  expect(comparison.regressions[0]).toContain('speculative tool hits 6 → 3')
})

test('compareLatency flags an extra round-trip as a hard regression', () => {
  const current = baselineFixture()
  current.scenarios[0]!.roundTrips = 3
  const comparison = compareLatency(baselineFixture(), current)
  expect(comparison.ok).toBe(false)
  expect(comparison.regressions[0]).toContain('round-trips 2 → 3')
})

test('compareLatency treats a wall-time increase as a warning, not a failure, unless strict', () => {
  const current = baselineFixture()
  current.scenarios[0]!.wallMsMedian = 40 // 4x, well over the ratio and floor

  const lenient = compareLatency(baselineFixture(), current)
  expect(lenient.ok).toBe(true)
  expect(lenient.warnings.some((line) => line.includes('wall'))).toBe(true)

  const strict = compareLatency(baselineFixture(), current, { strict: true })
  expect(strict.ok).toBe(false)
})

test('compareLatency is clean when nothing moved', () => {
  const comparison = compareLatency(baselineFixture(), baselineFixture())
  expect(comparison).toMatchObject({ ok: true, regressions: [], warnings: [] })
})
