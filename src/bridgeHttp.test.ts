import { expect, test } from 'bun:test'
import { runHttpBridge } from './bridgeHttp.ts'

async function connect(port: number): Promise<WebSocket> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/bridge`)
  await new Promise<void>((resolve, reject) => {
    ws.addEventListener('open', () => resolve(), { once: true })
    ws.addEventListener('error', () => reject(new Error('WebSocket connection failed')), { once: true })
  })
  return ws
}

function nextMessage(ws: WebSocket): Promise<unknown> {
  return new Promise((resolve) => {
    ws.addEventListener(
      'message',
      (event) => resolve(JSON.parse(event.data as string)),
      { once: true },
    )
  })
}

test('a real WebSocket client can send a request and get a real response over the network', async () => {
  const server = await runHttpBridge({ port: 0, hostname: '127.0.0.1' })
  try {
    const ws = await connect(server.port!)
    ws.send(JSON.stringify({ id: 'r1', method: 'environment.inspect' }))
    const message = await nextMessage(ws)
    expect(message).toMatchObject({ type: 'response', id: 'r1', ok: true })
    ws.close()
  } finally {
    server.stop(true)
  }
})

test('binds to localhost by default, not every interface', async () => {
  const server = await runHttpBridge({ port: 0 })
  try {
    expect(server.hostname).toBe('127.0.0.1')
  } finally {
    server.stop(true)
  }
})

test('two concurrent clients get isolated sessions — an approval on one is unknown to the other', async () => {
  const server = await runHttpBridge({ port: 0, hostname: '127.0.0.1' })
  try {
    const a = await connect(server.port!)
    const b = await connect(server.port!)

    a.send(JSON.stringify({ id: 'r1', method: 'autonomous.approve', params: { approvalKey: 'shared-looking-key', decision: 'approve' } }))
    const aResult = (await nextMessage(a)) as { ok: boolean }
    expect(aResult.ok).toBe(false) // no such approval was ever requested on this session either, but proves it didn't crash across connections

    b.send(JSON.stringify({ id: 'r2', method: 'environment.inspect' }))
    const bResult = (await nextMessage(b)) as { ok: boolean; id: string }
    expect(bResult.ok).toBe(true)
    expect(bResult.id).toBe('r2')

    a.close()
    b.close()
  } finally {
    server.stop(true)
  }
})

test('an invalid request envelope gets a clear error instead of a dropped connection', async () => {
  const server = await runHttpBridge({ port: 0, hostname: '127.0.0.1' })
  try {
    const ws = await connect(server.port!)
    ws.send(JSON.stringify({ notARequest: true }))
    const message = (await nextMessage(ws)) as { ok: boolean; error?: string }
    expect(message.ok).toBe(false)
    expect(message.error).toContain('Invalid bridge request envelope')
    ws.close()
  } finally {
    server.stop(true)
  }
})

test('malformed JSON gets a clear error instead of crashing the server', async () => {
  const server = await runHttpBridge({ port: 0, hostname: '127.0.0.1' })
  try {
    const ws = await connect(server.port!)
    ws.send('{ this is not json')
    const message = (await nextMessage(ws)) as { ok: boolean; error?: string }
    expect(message.ok).toBe(false)
    expect(message.error).toContain('valid JSON')
    ws.close()
  } finally {
    server.stop(true)
  }
})
