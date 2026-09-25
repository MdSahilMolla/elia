import { expect, test } from 'bun:test'
import { render } from 'ink-testing-library'
import { Text } from 'ink'
import { QuickchatOverlay, foldQuickchatAnswer, useQuickchatOverlay } from './QuickchatOverlay.tsx'
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

// The idle window used to start at open, so a slow model's answer arrived
// after the panel had closed itself and was dropped. It starts when the answer lands.
test('a panel waiting on its answer never idles out; the window starts once the answer lands', async () => {
  const store = createQuickchatOverlayStore({ idleMs: 40 })
  store.open('q')
  await sleep(150)
  expect(store.getSnapshot().status).toBe('open')
  store.appendText('the answer')
  expect(store.getSnapshot().answer).toBe('the answer')
  await sleep(150)
  expect(store.getSnapshot().status).toBe('closed')
})

test('the panel shows a working spark while waiting, and folds a long answer', async () => {
  const store = createQuickchatOverlayStore({ idleMs: 5_000 })
  const { lastFrame, unmount } = render(<QuickchatOverlay store={store} />)
  try {
    store.open('summarise the run', 'main')
    let frame = await waitForFrame(lastFrame, 'Thinking…', 2000)
    expect(frame).toContain('quickchat · main')
    expect(frame).toContain('❯ summarise the run')
    // No drawn box: side borders smear on narrow and Windows terminals.
    expect(frame).not.toMatch(/[│┃|]\s*$/m)

    store.appendText(Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join('\n'))
    frame = await waitForFrame(lastFrame, 'line 1', 2000)
    expect(frame).not.toContain('line 30')
    expect(frame).toMatch(/… \d+ more lines · esc closes and prints the whole answer/)
  } finally {
    store.requestClose()
    unmount()
  }
})

test('a failed quickchat reads as an error, not as an answer', async () => {
  const store = createQuickchatOverlayStore({ idleMs: 5_000 })
  const { lastFrame, unmount } = render(<QuickchatOverlay store={store} />)
  try {
    store.open('q')
    store.appendText('quickchat failed: the fast tier timed out after 60s')
    const frame = await waitForFrame(lastFrame, 'the fast tier timed out', 2000)
    expect(frame).toContain('✗ the fast tier timed out after 60s')
    expect(frame).not.toContain('quickchat failed:')
  } finally {
    store.requestClose()
    unmount()
  }
})

test('foldQuickchatAnswer keeps whole lines, closes a cut code fence, and clips one huge line', () => {
  expect(foldQuickchatAnswer('a\nb', 40)).toEqual({ text: 'a\nb', hiddenLines: 0 })
  const fenced = ['intro', '```ts', ...Array.from({ length: 20 }, (_, i) => `const x${i} = ${i}`), '```'].join('\n')
  const folded = foldQuickchatAnswer(fenced, 40, 6)
  expect(folded.text.split('\n').at(-1)).toBe('```')
  expect(folded.hiddenLines).toBeGreaterThan(0)
  const huge = foldQuickchatAnswer('x'.repeat(5_000), 20, 3)
  expect(Bun.stringWidth(huge.text)).toBeLessThanOrEqual(60)
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