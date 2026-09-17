import { expect, test } from 'bun:test'
import { EventEmitter } from 'node:events'
import { render } from 'ink-testing-library'
import { Text } from 'ink'
import { NARROW_COLUMNS, readTerminalSize, useTerminalSize } from './useTerminalSize.ts'
import { waitForFrame } from './testFixtures.ts'

/** A stdout stand-in that can be resized and that records its listeners. */
class FakeStream extends EventEmitter {
  columns: number
  rows: number
  constructor(columns: number, rows: number) {
    super()
    this.columns = columns
    this.rows = rows
  }
  resize(columns: number, rows: number): void {
    this.columns = columns
    this.rows = rows
    this.emit('resize')
  }
}

const stream = (columns: number, rows: number) => new FakeStream(columns, rows) as unknown as NodeJS.WriteStream

function Probe({ from }: { from: NodeJS.WriteStream }) {
  const size = useTerminalSize(from)
  return <Text>{`${size.columns}x${size.rows}${size.narrow ? ' narrow' : ''}`}</Text>
}

test('readTerminalSize falls back to 80x24 when the stream reports no geometry', () => {
  expect(readTerminalSize(stream(0, 0))).toEqual({ columns: 80, rows: 24, narrow: false })
  expect(readTerminalSize({ columns: undefined, rows: undefined } as unknown as NodeJS.WriteStream)).toEqual({
    columns: 80,
    rows: 24,
    narrow: false,
  })
})

test('narrow is set below the 80-column threshold and not at it', () => {
  expect(readTerminalSize(stream(NARROW_COLUMNS, 24)).narrow).toBe(false)
  expect(readTerminalSize(stream(NARROW_COLUMNS - 1, 24)).narrow).toBe(true)
})

/** A resize arrives outside React's batching, so let the scheduled render land. */
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

test('the hook re-renders with the new geometry on a resize', async () => {
  const fake = new FakeStream(120, 40)
  const { lastFrame, unmount } = render(<Probe from={fake as unknown as NodeJS.WriteStream} />)
  expect(lastFrame()).toBe('120x40')

  fake.resize(60, 20)
  await flush()
  // Ink throttles its writes; on a loaded machine the frame can land a tick later.
  await waitForFrame(lastFrame, '60x20 narrow')
  expect(lastFrame()).toBe('60x20 narrow')

  unmount()
})

test('the resize subscription is torn down on unmount', () => {
  const fake = new FakeStream(100, 30)
  const { unmount } = render(<Probe from={fake as unknown as NodeJS.WriteStream} />)
  expect(fake.listenerCount('resize')).toBe(1)
  unmount()
  expect(fake.listenerCount('resize')).toBe(0)
})

test('a resize that changes nothing does not churn the frame', async () => {
  const fake = new FakeStream(100, 30)
  const { lastFrame, frames, unmount } = render(<Probe from={fake as unknown as NodeJS.WriteStream} />)
  const before = lastFrame()
  const painted = frames.length
  fake.resize(100, 30)
  await flush()
  expect(lastFrame()).toBe(before as string)
  expect(frames.length).toBe(painted)
  unmount()
})
