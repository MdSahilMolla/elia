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
