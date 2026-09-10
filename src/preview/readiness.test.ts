import { expect, test } from 'bun:test'
import { checkRendered, waitForHttp } from './readiness.ts'

function serve(handler: (req: Request) => Response): { url: string; stop: () => void } {
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: handler })
  return { url: `http://127.0.0.1:${server.port}/`, stop: () => server.stop(true) }
}

test('waitForHttp resolves once the server answers', async () => {
  const s = serve(() => new Response('ok'))
  try {
    expect((await waitForHttp(s.url, 2_000)).ok).toBe(true)
  } finally {
    s.stop()
  }
})

test('waitForHttp times out for a dead address', async () => {
  const res = await waitForHttp('http://127.0.0.1:9/', 600)
  expect(res.ok).toBe(false)
  expect(res.reason).toContain('did not respond')
})

test('checkRendered passes a real HTML page', async () => {
  const s = serve(() => new Response('<!doctype html><h1>Educational XSS demo</h1>', { headers: { 'content-type': 'text/html' } }))
  try {
    expect((await checkRendered(s.url)).ok).toBe(true)
  } finally {
    s.stop()
  }
})

test('checkRendered flags a raw Vite source index as blank', async () => {
  const s = serve(
    () =>
      new Response('<!doctype html><html><body><div id="root"></div><script type="module" src="/src/main.tsx"></script></body></html>', {
        headers: { 'content-type': 'text/html' },
      }),
  )
  try {
    const res = await checkRendered(s.url)
    expect(res.ok).toBe(false)
    expect(res.reason).toContain('unbuilt bundler app')
  } finally {
    s.stop()
  }
})

test('checkRendered flags an empty body and an error status', async () => {
  const empty = serve(() => new Response('', { headers: { 'content-type': 'text/html' } }))
  try {
    expect((await checkRendered(empty.url)).ok).toBe(false)
  } finally {
    empty.stop()
  }
  const boom = serve(() => new Response('nope', { status: 500 }))
  try {
    const res = await checkRendered(boom.url)
    expect(res.ok).toBe(false)
    expect(res.reason).toContain('HTTP 500')
  } finally {
    boom.stop()
  }
})
