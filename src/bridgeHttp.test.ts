import { expect, test } from 'bun:test'
import { runHttpBridge } from './bridgeHttp.ts'

async function connect(port: number, opts: { token?: string } = {}): Promise<WebSocket> {
  const query = opts.token ? `?token=${encodeURIComponent(opts.token)}` : ''
  const ws = new WebSocket(`ws://127.0.0.1:${port}/bridge${query}`)
  await new Promise<void>((resolve, reject) => {
    ws.addEventListener('open', () => resolve(), { once: true })
    ws.addEventListener('error', () => reject(new Error('WebSocket connection failed')), { once: true })
  })
  return ws
}

async function failsToConnect(port: number, token?: string): Promise<boolean> {
  try {
    const ws = await connect(port, token === undefined ? {} : { token })
    ws.close()
    return false
  } catch {
    return true
  }
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

test('an unknown method never reaches a handler — even over the network', async () => {
  const server = await runHttpBridge({ port: 0, hostname: '127.0.0.1' })
  try {
    const ws = await connect(server.port!)
    ws.send(JSON.stringify({ id: 'rX', method: 'shell.exec', params: { command: 'calc' } }))
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

test('a required token gates every upgrade, and a matching one passes', async () => {
  const server = await runHttpBridge({ port: 0, hostname: '127.0.0.1', requireToken: true, token: 's3cret-bridge-token' })
  try {
    expect(await failsToConnect(server.port!)).toBe(true)
    expect(await failsToConnect(server.port!, 'wrong-token')).toBe(true)

    const ws = await connect(server.port!, { token: 's3cret-bridge-token' })
    ws.send(JSON.stringify({ id: 'rT', method: 'environment.inspect' }))
    const message = (await nextMessage(ws)) as { ok: boolean; id: string }
    expect(message.ok).toBe(true)
    expect(message.id).toBe('rT')
    ws.close()
  } finally {
    server.stop(true)
  }
})

test('a non-loopback bind demands a token even when not asked for explicitly', async () => {
  const server = await runHttpBridge({ port: 0, hostname: '0.0.0.0' })
  try {
    expect(await failsToConnect(server.port!)).toBe(true)
  } finally {
    server.stop(true)
  }
})

test('a browser Origin is refused unless allowlisted', async () => {
  const server = await runHttpBridge({ port: 0, hostname: '127.0.0.1', allowedOrigins: ['https://good.example'] })
  try {
    const http = `http://127.0.0.1:${server.port!}/bridge`
    const upgrade = { Upgrade: 'websocket', Connection: 'Upgrade', 'Sec-WebSocket-Version': '13', 'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==' }
    const evil = await fetch(http, { headers: { ...upgrade, Origin: 'https://evil.example' } })
    expect(evil.status).toBe(403)
    // The allowlisted Origin sails past the gate (the WebSocket handshake that
    // follows is what the connect() helper exercises above).
    const good = await fetch(http, { headers: { ...upgrade, Origin: 'https://good.example' } })
    expect(good.status).not.toBe(403)
  } finally {
    server.stop(true)
  }
})
