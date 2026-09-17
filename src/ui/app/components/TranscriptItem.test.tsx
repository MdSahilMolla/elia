import { expect, test } from 'bun:test'
import { render } from 'ink-testing-library'
import type { Item } from '../store.ts'
import { FrameWidth } from '../wrap.ts'
import { shellView, TranscriptItemView } from './TranscriptItem.tsx'

const view = (item: Item, width = 60) =>
  render(
    <FrameWidth.Provider value={width}>
      <TranscriptItemView item={item} expanded={false} />
    </FrameWidth.Provider>,
  ).lastFrame() ?? ''

test('the header carries the wordmark, the model and where the session runs', () => {
  const frame = view({ id: 'h', kind: 'header', version: '1.2.3', greeting: 'dev mode', location: '~/code/app', model: 'mercury-2.5', lessons: 3 })
  expect(frame).toContain('✦ elia v1.2.3 · dev mode')
  expect(frame).toContain('mercury-2.5 · ~/code/app')
  expect(frame).toContain('3 lessons carried from past runs · /lessons')
})

test('a message you sent sits on a band as wide as the frame, wrapped inside it', () => {
  const frame = view({ id: 'u', kind: 'user', text: 'fix the average and median functions so the tests pass again' }, 40)
  const rows = frame.split('\n').filter((row) => row.trim())
  expect(rows[0]).toStartWith('❯ fix the average')
  // Wrapped inside the band, continuation rows indented under the text. (The
  // padding that carries the band's colour to the edge is trailing space, which
  // a colourless test frame trims.)
  for (const row of rows) expect(Bun.stringWidth(row)).toBeLessThanOrEqual(40)
  expect(rows.length).toBe(2)
  expect(rows[1]).toStartWith('  ')
})

test('a finished turn closes with its receipt', () => {
  const frame = view({ id: 'r', kind: 'receipt', text: 'Worked for 23s · edited 1 file · ↓ 2.9k tokens' })
  expect(frame).toContain('✧ Worked for 23s · edited 1 file · ↓ 2.9k tokens')
})

test('a notice keeps its status mark', () => {
  expect(view({ id: 'n', kind: 'notice', text: '✓ verified — tests pass' })).toContain('✓ verified — tests pass')
  expect(view({ id: 'l', kind: 'notice', text: '✦ learned: use relative paths' })).toContain('✦ learned: use relative paths')
})

test('a shell escape drops the result framing and only reports an exit worth reading', () => {
  expect(shellView('$ git status\nexit code: 0\nstdout:\nOn branch master\n')).toEqual({
    command: '$ git status',
    output: ['On branch master'],
    exit: '',
  })
  expect(shellView('$ false\nexit code: 1')).toEqual({ command: '$ false', output: [], exit: 'exit 1' })
  const frame = view({ id: 's', kind: 'shell', text: '$ ls nope\nexit code: 2\nstderr:\nls: cannot access nope' })
  expect(frame).toContain('$ ls nope')
  expect(frame).toContain('⎿ ls: cannot access nope')
  expect(frame).toContain('exit 2')
  expect(frame).not.toContain('stderr:')
})
