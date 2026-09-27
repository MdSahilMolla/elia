import { expect, test } from 'bun:test'
import { render } from 'ink-testing-library'
import { checkMark, checksWidth, fitDetails, WorkingIndicator, type TurnProgress } from './WorkingIndicator.tsx'
import { waitForFrame } from '../testFixtures.ts'

const ref = (value: TurnProgress) => ({ current: value })

test('the working line says what is happening, for how long, and how to stop it', async () => {
  const { lastFrame, unmount } = render(<WorkingIndicator startedAt={Date.now() - 12_000} label="Reading stats.ts" />)
  try {
    const frame = await waitForFrame(lastFrame, 'Reading stats.ts…')
    expect(frame).toContain('12s')
    expect(frame).toContain('esc to interrupt')
    // Nothing streamed yet: no token count to show.
    expect(frame).not.toContain('tokens')
  } finally {
    unmount()
  }
})

test('streamed tokens roll up into the line', async () => {
  const progress = ref({ tokens: 1_234, lastAt: Date.now() })
  const { lastFrame, unmount } = render(<WorkingIndicator startedAt={Date.now()} label="Writing" progress={progress} />)
  try {
    await waitForFrame(lastFrame, '↓ 1.2k tokens', 10_000)
  } finally {
    unmount()
  }
})

test('reasoning is named once, not twice', async () => {
  const thinking = render(<WorkingIndicator startedAt={Date.now()} label="Fixing the bug" thinking />)
  const labelled = render(<WorkingIndicator startedAt={Date.now()} label="Thinking" thinking />)
  try {
    expect(await waitForFrame(thinking.lastFrame, 'Fixing the bug…')).toContain('· thinking ·')
    expect(await waitForFrame(labelled.lastFrame, 'Thinking…')).not.toContain('· thinking')
  } finally {
    thinking.unmount()
    labelled.unmount()
  }
})

test('a silent model is called out; a long-running tool is not', async () => {
  const quiet = ref({ tokens: 10, lastAt: Date.now() - 45_000 })
  const stalled = render(<WorkingIndicator startedAt={Date.now() - 60_000} label="Weaving" progress={quiet} waitingOnModel />)
  const testing = render(<WorkingIndicator startedAt={Date.now() - 60_000} label="Running bun test" progress={quiet} waitingOnModel={false} />)
  try {
    expect(await waitForFrame(stalled.lastFrame, 'no output for 45s')).toContain('esc to interrupt')
    expect(await waitForFrame(testing.lastFrame, 'Running bun test…')).not.toContain('no output')
  } finally {
    stalled.unmount()
    testing.unmount()
  }
})

test('queued steering and a tip ride along', async () => {
  const { lastFrame, unmount } = render(
    <WorkingIndicator startedAt={Date.now()} label="Working" steeringPending={2} tip="ctrl+o expands every tool result" />,
  )
  try {
    const frame = await waitForFrame(lastFrame, 'Tip:')
    expect(frame).toContain('2 steering queued')
    expect(frame).toContain('⎿ Tip: ctrl+o expands every tool result')
  } finally {
    unmount()
  }
})

test('on a narrow terminal the details give way, least important first, and the clock stays', () => {
  const details = [
    { key: 'clock', text: '19s' },
    { key: 'tokens', text: '↓ 1.8k tokens' },
    { key: 'steering', text: '1 steering queued' },
    { key: 'esc', text: 'esc to interrupt' },
  ]
  expect(fitDetails(details, 30, Number.POSITIVE_INFINITY)).toEqual(['19s', '↓ 1.8k tokens', '1 steering queued', 'esc to interrupt'])
  expect(fitDetails(details, 30, 120)).toEqual(['19s', '↓ 1.8k tokens', '1 steering queued', 'esc to interrupt'])
  expect(fitDetails(details, 30, 64)).toEqual(['19s', '↓ 1.8k tokens', 'esc to interrupt'])
  expect(fitDetails(details, 30, 48)).toEqual(['19s', 'esc to interrupt'])
  expect(fitDetails(details, 30, 30)).toEqual(['19s', 'esc'])
})

test('the spark moves between frames', async () => {
  const { frames, lastFrame, unmount } = render(<WorkingIndicator startedAt={Date.now()} label="Working" />)
  try {
    await waitForFrame(lastFrame, 'Working…')
    await new Promise((resolve) => setTimeout(resolve, 400))
    const sparks = new Set(frames.map((frame) => frame.trimStart().slice(0, 1)))
    expect(sparks.size).toBeGreaterThan(1)
  } finally {
    unmount()
  }
})

test('verification checks land on the line as they finish', async () => {
  const checks = [
    { command: 'bunx tsc --noEmit', label: 'tsc', state: 'passed' as const },
    { command: 'bun test', label: 'tests', state: 'failed' as const },
    { command: 'bun run build', label: 'build', state: 'queued' as const },
  ]
  const { lastFrame, unmount } = render(<WorkingIndicator startedAt={Date.now()} label="Verifying" checks={checks} />)
  try {
    const frame = await waitForFrame(lastFrame, 'Verifying…')
    expect(frame).toContain('tsc ✓')
    expect(frame).toContain('tests ✗')
    expect(frame).toContain('build ·')
  } finally {
    unmount()
  }
})

test('the checks give way on a narrow line instead of wrapping it', () => {
  const checks = [{ command: 'bun test', label: 'tests', state: 'running' as const }]
  expect(checksWidth(checks)).toBe(Bun.stringWidth('  tests ●'))
  expect(checksWidth([])).toBe(0)
  // A running check is the pulsing dot a running tool gets, not a second spinner.
  expect(checkMark(checks[0]!)).toBe('●')
})
