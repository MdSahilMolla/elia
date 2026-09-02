import { expect, test } from 'bun:test'
import { renderToString } from 'ink'
import { visibleWidth } from '../../layout.ts'
import { AssistantMessage } from './AssistantMessage.tsx'

// ink colours the output when stdout looks like a TTY (and npm forces colour on
// when it runs the publish gate). These tests are about text content and wrap
// width, not colour, so drop SGR codes before matching — same approach as
// src/ui/markdown.test.ts.
const strip = (text: string) => text.replace(/\x1b\[[0-9;]*m/g, '')

test('renders rich blocks without raw markdown syntax', () => {
  const output = renderToString(
    <AssistantMessage
      streaming={false}
      text={[
        '# Result',
        '',
        '- **fast** path',
        '- [x] tested',
        '- [ ] deploy',
        '',
        '> Keep this visible.',
        '',
        '| Name | Value |',
        '|---|---:|',
        '| latency | 12ms |',
        '',
        '```ts',
        'const ok = true',
        '```',
        '',
        '[Open docs](https://example.com)',
      ].join('\n')}
    />,
    { columns: 48 },
  )
  const plain = strip(output)

  expect(plain).toContain('━━ Result')
  expect(plain).toContain('• fast path')
  expect(plain).toContain('✓ tested')
  expect(plain).toContain('□ deploy')
  expect(plain).toContain('│ Keep this visible.')
  expect(plain).toContain('Name')
  expect(plain).toContain('latency')
  expect(plain).toContain('const ok = true')
  expect(plain).toContain('Open docs (https://example.com)')
  expect(plain).not.toContain('**')
  expect(plain).not.toContain('```')
})

test('wraps prose, tables, code, and links within a narrow terminal', () => {
  const output = renderToString(
    <AssistantMessage
      streaming={false}
      text={'A long explanatory sentence that must wrap cleanly.\n\n| Topic | Detail |\n|---|---|\n| terminal | another long explanation |\n\n```txt\nan-unusually-long-code-token\n```\n\n[documentation](https://example.com/long/path)'}
    />,
    { columns: 28 },
  )
  const plain = strip(output)

  expect(output.split('\n').every((line) => visibleWidth(line) <= 28)).toBe(true)
  expect(plain).toContain('another')
  expect(plain).toContain('an-unusually-long-code')
  expect(plain.replace(/\n\s*/g, '')).toContain('https://example.com')
})

test('renders incomplete streaming text and keeps the cursor visible', () => {
  const output = strip(renderToString(<AssistantMessage text={'```sh\nbun test'} streaming />, { columns: 40 }))
  expect(output).toContain('sh …')
  expect(output).toContain('bun test▏')
})
