import { expect, test } from 'bun:test'
import { render } from 'ink-testing-library'
import { Text } from 'ink'
import { QuickchatOverlay, useQuickchatOverlay } from './QuickchatOverlay.tsx'
import { createQuickchatOverlayStore, type QuickchatOverlayStore } from './quickchatOverlayStore.ts'
import { waitForFrame } from './testFixtures.ts'

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

test('overlay renders the question and streams the answer, and closes on Escape', async () => {
  const store = createQuickchatOverlayStore({ idleMs: 500 })
  const { lastFrame, unmount } = render(<QuickchatOverlay store={store} />)
  try {
    await sleep(40)
    expect(lastFrame() ?? '').not.toContain('quickchat')

    store.open('how is the build?', 'feat/rate-limit')
    let frame = await waitForFrame(lastFrame, 'how is the build?', 2000)
    expect(frame).toContain('quickchat')

    // Only the literal escape key closes the overlay — everything else passes.
    expect(store.handleEscape('x')).toEqual({ consumed: false })

    store.appendText('all green, 14 tests pass.')
    await waitForFrame(lastFrame, 'all green, 14 tests pass.', 2000)
    expect(store.getSnapshot().status).toBe('open')

    const escaped = store.handleEscape('esc')
    expect(escaped.consumed).toBe(true)
    expect(store.getSnapshot().status).toBe('closed')
    await sleep(40)
    expect(lastFrame() ?? '').not.toContain('all green')
  } finally {
    unmount()
  }
})

test('a closed overlay does not consume Escape', () => {
  const store = createQuickchatOverlayStore({ idleMs: 500 })
  expect(store.handleEscape('esc')).toEqual({ consumed: false })
  store.requestClose()
  expect(store.getSnapshot().status).toBe('closed')
})

test('the overlay auto-closes after an idle timeout without appends', async () => {
  const store = createQuickchatOverlayStore({ idleMs: 40 })
  store.open('q')
  expect(store.getSnapshot().status).toBe('open')
  await sleep(150)
  expect(store.getSnapshot().status).toBe('closed')
})

test('streamed appends keep the overlay open past the idle window', async () => {
  const store = createQuickchatOverlayStore({ idleMs: 40 })
  store.open('q')
  for (let i = 0; i < 5; i += 1) {
    await sleep(30)
    store.appendText(`chunk ${i} `)
  }
  expect(store.getSnapshot().status).toBe('open')
  expect(store.getSnapshot().answer).toContain('chunk 4')
  await sleep(150)
  expect(store.getSnapshot().status).toBe('closed')
})

test('useQuickchatOverlay follows the store snapshot', async () => {
  const store: QuickchatOverlayStore = createQuickchatOverlayStore({ idleMs: 500 })

  function Probe() {
    const snap = useQuickchatOverlay(store)
    return <Text>{snap.status}|{snap.question}|{snap.answer}</Text>
  }

  store.open('q1', 'sess')
  const { lastFrame, unmount } = render(<Probe />)
  try {
    await waitForFrame(lastFrame, 'open|q1|', 2000)
    store.appendText('a1')
    await waitForFrame(lastFrame, 'open|q1|a1', 2000)
    store.requestClose()
    await waitForFrame(lastFrame, 'closed|q1|a1', 2000)
  } finally {
    unmount()
  }
})