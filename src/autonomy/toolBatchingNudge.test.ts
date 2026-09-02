import { expect, test } from 'bun:test'
import { createRedundantReadTracker, isLoneBatchableRead, serialReadNudge, SERIAL_READ_NUDGE_THRESHOLD } from './toolBatchingNudge.ts'

test('isLoneBatchableRead is true only for a single read_file / grep / list_files call', () => {
  expect(isLoneBatchableRead(['read_file'])).toBe(true)
  expect(isLoneBatchableRead(['grep'])).toBe(true)
  expect(isLoneBatchableRead(['list_files'])).toBe(true)

  expect(isLoneBatchableRead(['read_file', 'read_file'])).toBe(false) // already batched
  expect(isLoneBatchableRead(['edit_file'])).toBe(false) // not a read
  expect(isLoneBatchableRead(['run_command'])).toBe(false)
  expect(isLoneBatchableRead([])).toBe(false)
})

test('serialReadNudge stays quiet until the streak crosses the threshold, then names the count', () => {
  for (let streak = 0; streak < SERIAL_READ_NUDGE_THRESHOLD; streak++) {
    expect(serialReadNudge(streak)).toBeUndefined()
  }
  const nudge = serialReadNudge(SERIAL_READ_NUDGE_THRESHOLD)
  expect(nudge).toBeDefined()
  expect(nudge).toContain(String(SERIAL_READ_NUDGE_THRESHOLD))
  expect(nudge).toContain('SINGLE response')
})

test('redundant-read tracker stays quiet on first reads and fires on a re-read of an unchanged file', () => {
  const tracker = createRedundantReadTracker()
  expect(tracker.observe([{ name: 'read_file', path: 'src/a.ts' }, { name: 'read_file', path: 'src/b.ts' }])).toBeUndefined()
  // re-reading a.ts, no write in between
  const nudge = tracker.observe([{ name: 'read_file', path: './src/a.ts' }])
  expect(nudge).toBeDefined()
  expect(nudge).toContain('src/a.ts')
  expect(nudge).toContain("don't re-read")
})

test('redundant-read tracker allows a re-read after the file was edited', () => {
  const tracker = createRedundantReadTracker()
  tracker.observe([{ name: 'read_file', path: 'src/a.ts' }])
  tracker.observe([{ name: 'edit_file', path: 'src/a.ts' }])
  expect(tracker.observe([{ name: 'read_file', path: 'src/a.ts' }])).toBeUndefined()
})
