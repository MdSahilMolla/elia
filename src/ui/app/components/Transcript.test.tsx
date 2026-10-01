import { expect, test } from 'bun:test'
import { render } from 'ink-testing-library'
import type { Item } from '../store.ts'
import { Transcript } from './Transcript.tsx'
import { FrameWidth } from '../wrap.ts'

const strip = (s: string): string => s.replace(/\[[0-9;]*m/g, '')
const notice = (id: string, text: string): Item => ({ id, kind: 'notice', text })

test('no trim marker when the live region fits', () => {
  const { lastFrame } = render(<Transcript committed={[]} live={[notice('n', 'working')]} expandedAll={false} />)
  expect(strip(lastFrame() ?? '')).toContain('working')
  expect(strip(lastFrame() ?? '')).not.toContain('above')
})

test('the trim marker says where the trimmed rows went', () => {
  const { lastFrame } = render(
    <Transcript committed={[]} live={[notice('n', 'working')]} expandedAll={false} hiddenRows={12} />,
  )
  const frame = strip(lastFrame() ?? '')
  expect(frame).toContain('… 12 lines above, printed in full once finished')
  // The marker sits above the live items, where the trimmed content used to be.
  expect(frame.indexOf('lines above')).toBeLessThan(frame.indexOf('working'))
})

test('the marker is singular for a single trimmed row', () => {
  const { lastFrame } = render(<Transcript committed={[]} live={[]} expandedAll={false} hiddenRows={1} />)
  expect(strip(lastFrame() ?? '')).toContain('… 1 line above')
})

test('on a narrow frame, the marker wraps without dropping its indent (#1293)', () => {
  const { lastFrame } = render(
    <FrameWidth.Provider value={40}>
      <Transcript committed={[]} live={[]} expandedAll={false} hiddenRows={12} />
    </FrameWidth.Provider>,
  )
  const lines = strip(lastFrame() ?? '').split('\n').filter((l) => l.trim())
  // Every wrapped continuation keeps the same 2-space indent as the first line —
  // none of them starts flush at column 0 next to the content above it.
  for (const line of lines) expect(line.startsWith('  ')).toBe(true)
})
