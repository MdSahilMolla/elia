import { afterEach, expect, test } from 'bun:test'
import { otelEnabled, otelExportEvent, otelFlush, resetOtelStateForTests } from './otel.ts'
import type { JournalEvent } from './journal.ts'

const originalFetch = globalThis.fetch
const originalEndpoint = process.env.ELIA_OTEL_ENDPOINT

afterEach(() => {
  globalThis.fetch = originalFetch
  if (originalEndpoint === undefined) delete process.env.ELIA_OTEL_ENDPOINT
  else process.env.ELIA_OTEL_ENDPOINT = originalEndpoint
  resetOtelStateForTests()
})

function event(overrides: Partial<JournalEvent> = {}): JournalEvent {
  return { seq: 1, at: 1_700_000_000_000, kind: 'tool', data: { tool: 'read_file' }, ...overrides }
}

test('otelEnabled is false with no ELIA_OTEL_ENDPOINT set', () => {
  delete process.env.ELIA_OTEL_ENDPOINT
  expect(otelEnabled()).toBe(false)
})

test('otelExportEvent is a complete no-op when disabled — never touches fetch at all', () => {
  delete process.env.ELIA_OTEL_ENDPOINT
  let called = false
  globalThis.fetch = (async () => {
    called = true
    return new Response('{}')
  }) as unknown as typeof fetch
  otelExportEvent('run-1', event())
  otelFlush()
  expect(called).toBe(false)
})

test('otelFlush POSTs a well-formed OTLP/HTTP+JSON logs export request to <endpoint>/v1/logs', async () => {
  process.env.ELIA_OTEL_ENDPOINT = 'http://collector.internal:4318'
  let capturedUrl: string | undefined
  let capturedBody: unknown
  let resolveCapture: () => void
  const captured = new Promise<void>((resolve) => {
    resolveCapture = resolve
  })
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    capturedUrl = url
    capturedBody = JSON.parse(init.body as string)
    resolveCapture()
    return new Response('{}')
  }) as unknown as typeof fetch

  otelExportEvent('run-1', event({ seq: 1, kind: 'tool', data: { tool: 'read_file' } }))
  otelExportEvent('run-1', event({ seq: 2, kind: 'verdict', data: { verdict: 'pass' } }))
  otelFlush()
  await captured

  expect(capturedUrl).toBe('http://collector.internal:4318/v1/logs')
  const body = capturedBody as { resourceLogs: { scopeLogs: { logRecords: { attributes: { key: string; value: Record<string, unknown> }[] }[] }[] }[] }
  const records = body.resourceLogs[0]!.scopeLogs[0]!.logRecords
  expect(records).toHaveLength(2)
  const first = records[0]!
  expect(first.attributes.find((a) => a.key === 'run.id')?.value).toEqual({ stringValue: 'run-1' })
  expect(first.attributes.find((a) => a.key === 'event.kind')?.value).toEqual({ stringValue: 'tool' })
  expect(first.attributes.find((a) => a.key === 'elia.tool')?.value).toEqual({ stringValue: 'read_file' })
})

test('event data is redacted before export, the same as diagnostics.ts redacts before writing locally', async () => {
  process.env.ELIA_OTEL_ENDPOINT = 'http://collector.internal:4318'
  let capturedBody: unknown
  const captured = new Promise<void>((resolve) => {
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      capturedBody = JSON.parse(init.body as string)
      resolve()
      return new Response('{}')
    }) as unknown as typeof fetch
  })

  otelExportEvent('run-1', event({ data: { apiKey: 'sk-super-secret-1234567890', taskId: 'abc' } }))
  otelFlush()
  await captured

  const body = capturedBody as { resourceLogs: { scopeLogs: { logRecords: { attributes: { key: string; value: Record<string, unknown> }[] }[] }[] }[] }
  const attrs = body.resourceLogs[0]!.scopeLogs[0]!.logRecords[0]!.attributes
  expect(attrs.find((a) => a.key === 'elia.apiKey')?.value).toEqual({ stringValue: '[REDACTED]' })
  expect(attrs.find((a) => a.key === 'elia.taskId')?.value).toEqual({ stringValue: 'abc' })
})

test('a collector that is down or errors never throws back into the caller', () => {
  process.env.ELIA_OTEL_ENDPOINT = 'http://collector.internal:4318'
  globalThis.fetch = (async () => {
    throw new Error('ECONNREFUSED')
  }) as unknown as typeof fetch
  expect(() => {
    otelExportEvent('run-1', event())
    otelFlush()
  }).not.toThrow()
})

test('otelExportEvent batches instead of sending one request per event, up to the debounced flush', () => {
  process.env.ELIA_OTEL_ENDPOINT = 'http://collector.internal:4318'
  let callCount = 0
  globalThis.fetch = (async () => {
    callCount += 1
    return new Response('{}')
  }) as unknown as typeof fetch

  otelExportEvent('run-1', event({ seq: 1 }))
  otelExportEvent('run-1', event({ seq: 2 }))
  otelExportEvent('run-1', event({ seq: 3 }))
  expect(callCount).toBe(0) // still debounced, not yet flushed
  otelFlush()
  expect(callCount).toBe(1) // one batched request for all three
})
