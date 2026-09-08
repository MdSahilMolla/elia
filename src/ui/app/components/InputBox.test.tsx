import { expect, test } from 'bun:test'
import { render } from 'ink-testing-library'
import { InputBox } from './InputBox.tsx'
import { waitForFrame } from '../testFixtures.ts'
import type { SlashCommand } from '../../slashPrompt.ts'

const noop = () => {}
const many: SlashCommand[] = Array.from({ length: 25 }, (_, i) => ({
  name: `/cmd${String(i).padStart(2, '0')}`,
  description: `command number ${i}`,
}))

function mount(commands: SlashCommand[]) {
  return render(
    <InputBox
      commands={commands}
      disabled={false}
      placeholder="type here"
      onSubmit={noop}
      onInterrupt={noop}
      onEof={noop}
      onTabEmpty={noop}
    />,
  )
}

test('typing "/" opens the completion menu with a scroll hint instead of clipping the list', async () => {
  const { stdin, lastFrame } = mount(many)
  stdin.write('/')
  const frame = await waitForFrame(lastFrame, /↓ \d+ more/)

  // First page of entries is visible...
  expect(frame).toContain('/cmd00')
  // ...and the rest is reachable, flagged rather than silently dropped.
  expect(frame).not.toContain('/cmd24') // not on the first page, but the hint says it exists
})

test('a short command list shows every entry with no scroll hints', async () => {
  const { stdin, lastFrame } = mount(many.slice(0, 4))
  stdin.write('/')
  const frame = await waitForFrame(lastFrame, '/cmd03')
  expect(frame).toContain('/cmd00')
  expect(frame).not.toContain('more')
})

const tick = () => new Promise((resolve) => setTimeout(resolve, 15))

/** ink-testing-library can coalesce back-to-back writes into one parse; feed keys one at a time. */
async function typeKeys(stdin: { write(data: string): void }, keys: string[]): Promise<void> {
  for (const k of keys) {
    stdin.write(k)
    await tick()
  }
}

const LEFT = '\x1B[D'

test('typing after moving the caret left inserts at the caret, not the end (issue #11)', async () => {
  const { stdin, lastFrame } = mount([])
  stdin.write('ac')
  await waitForFrame(lastFrame, 'ac')
  stdin.write('\x1B[D') // left arrow: caret now sits between "a" and "c"
  await tick()
  stdin.write('b')
  const frame = await waitForFrame(lastFrame, 'abc')
  expect(frame).toContain('abc')
  expect(frame).not.toContain('acb')
})

test('home/end move the caret across the whole buffer', async () => {
  const { stdin, lastFrame } = mount([])
  stdin.write('world')
  await waitForFrame(lastFrame, 'world')
  stdin.write('\x01') // Ctrl+A → home
  await tick()
  stdin.write('hello ')
  const frame = await waitForFrame(lastFrame, 'hello world')
  expect(frame).toContain('hello world')
})

test('backspace deletes at the caret, not the end', async () => {
  const { stdin, lastFrame } = mount([])
  stdin.write('axbc')
  await waitForFrame(lastFrame, 'axbc')
  await typeKeys(stdin, [LEFT, LEFT]) // caret between "x" and "b"
  stdin.write('\x7f') // backspace → removes "x"
  const frame = await waitForFrame(lastFrame, /❯ abc\b/)
  expect(frame).toContain('abc')
  expect(frame).not.toContain('axbc')
})
