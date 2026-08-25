import { expect, test } from 'bun:test'
import { createBridgeSession } from './vscodeBridge.ts'
import type { BridgeMessage, BridgeRequest } from './vscodeBridgeProtocol.ts'

function collectingSession(onShutdown?: () => void) {
  const messages: BridgeMessage[] = []
  const session = createBridgeSession({ output: (message) => messages.push(message), onShutdown })
  return { session, messages }
}

test('environment.inspect returns a successful response', async () => {
  const { session, messages } = collectingSession()
  await session.handleRequest({ id: 'r1', method: 'environment.inspect' } as BridgeRequest)
  expect(messages).toHaveLength(1)
  expect(messages[0]).toMatchObject({ type: 'response', id: 'r1', ok: true })
})

test('an unknown method fails with a clear error instead of throwing out of handleRequest', async () => {
  const { session, messages } = collectingSession()
  await session.handleRequest({ id: 'r1', method: 'not.a.real.method' } as unknown as BridgeRequest)
  expect(messages).toHaveLength(1)
  expect(messages[0]).toMatchObject({ type: 'response', id: 'r1', ok: false })
  expect((messages[0] as { error?: string }).error).toContain('Unknown bridge method')
})

test('runs.inspect rejects a malformed runId instead of touching the filesystem with it', async () => {
  const { session, messages } = collectingSession()
  await session.handleRequest({ id: 'r1', method: 'runs.inspect', params: { runId: '../../etc/passwd' } } as BridgeRequest)
  expect(messages[0]).toMatchObject({ type: 'response', id: 'r1', ok: false })
})

test('two sessions never share state — an approval registered on one is unknown to the other', async () => {
  const a = collectingSession()
  const b = collectingSession()
  await a.session.handleRequest({ id: 'r1', method: 'autonomous.approve', params: { approvalKey: 'x', decision: 'approve' } } as unknown as BridgeRequest)
  await b.session.handleRequest({ id: 'r2', method: 'autonomous.approve', params: { approvalKey: 'x', decision: 'approve' } } as unknown as BridgeRequest)
  expect(a.messages[0]).toMatchObject({ ok: false })
  expect(b.messages[0]).toMatchObject({ ok: false })
})

test('a shutdown request fires onShutdown once in-flight work drains', async () => {
  let shutdownCalls = 0
  const { session, messages } = collectingSession(() => {
    shutdownCalls += 1
  })
  await session.handleRequest({ id: 'r1', method: 'shutdown' } as BridgeRequest)
  expect(messages[0]).toMatchObject({ type: 'response', id: 'r1', ok: true })
  expect(session.isShuttingDown()).toBe(true)
  expect(shutdownCalls).toBe(1)
})

test('after shutdown, isShuttingDown reports true so a transport can stop accepting new requests', async () => {
  const { session } = collectingSession()
  expect(session.isShuttingDown()).toBe(false)
  await session.handleRequest({ id: 'r1', method: 'shutdown' } as BridgeRequest)
  expect(session.isShuttingDown()).toBe(true)
})
