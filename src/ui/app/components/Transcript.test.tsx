import { expect, test } from 'bun:test'
import { render } from 'ink-testing-library'
import type { Item } from '../store.ts'
import { Transcript } from './Transcript.tsx'

const strip = (s: string): string => s.replace(/\[[0-9;]*m/g, '')
const notice = (id: string, text: string): Item => ({ id, kind: 'notice', text })

test('no trim marker when the live region fits', () => {
  const { lastFrame } = render(<Transcript committed={[]} live={[notice('n', 'working')]} expandedAll={false} />)
  expect(strip(lastFrame() ?? '')).toContain('working')
  expect(strip(lastFrame() ?? '')).not.toContain('earlier row')
})

test('the trim marker says where the trimmed rows went', () => {
  const { lastFrame } = render(
    <Transcript committed={[]} live={[notice('n', 'working')]} expandedAll={false} hiddenRows={12} />,
  )
  const frame = strip(lastFrame() ?? '')
  expect(frame).toContain('↑ 12 earlier rows')
  expect(frame).toContain('printed to scrollback as they finish')
  // The marker sits above the live items, where the trimmed content used to be.
  expect(frame.indexOf('earlier rows')).toBeLessThan(frame.indexOf('working'))
})

test('the marker is singular for a single trimmed row', () => {
  const { lastFrame } = render(<Transcript committed={[]} live={[]} expandedAll={false} hiddenRows={1} />)
  expect(strip(lastFrame() ?? '')).toContain('↑ 1 earlier row —')
})
