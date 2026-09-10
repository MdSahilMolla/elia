import { expect, test } from 'bun:test'
import { render } from 'ink-testing-library'
import { Text } from 'ink'
import { ErrorBoundary } from './ErrorBoundary.tsx'

function Bomb({ boom }: { boom: boolean }): React.ReactElement {
  if (boom) throw new Error('kaboom')
  return <Text>alive</Text>
}

test('renders children normally when nothing throws', () => {
  const { lastFrame } = render(
    <ErrorBoundary area="transcript">
      <Bomb boom={false} />
    </ErrorBoundary>,
  )
  expect(lastFrame()).toContain('alive')
})

test('a child throw is caught: fallback shows the area + message, onError fires', () => {
  let seen: { message: string; area: string } | undefined
  const { lastFrame } = render(
    <ErrorBoundary area="transcript" onError={(e, area) => { seen = { message: e.message, area } }}>
      <Bomb boom />
    </ErrorBoundary>,
  )
  const frame = lastFrame() ?? ''
  expect(frame).toContain('transcript hit a render error')
  expect(frame).toContain('kaboom')
  expect(seen).toEqual({ message: 'kaboom', area: 'transcript' })
})

test('a sibling boundary keeps working when another throws', () => {
  const { lastFrame } = render(
    <>
      <ErrorBoundary area="a"><Bomb boom /></ErrorBoundary>
      <ErrorBoundary area="b"><Text>b still here</Text></ErrorBoundary>
    </>,
  )
  const frame = lastFrame() ?? ''
  expect(frame).toContain('a hit a render error')
  expect(frame).toContain('b still here')
})
