import { expect, test } from 'bun:test'
import { renderToString } from 'ink'
import { visibleWidth } from '../../layout.ts'
import { AssistantMessage } from './AssistantMessage.tsx'

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

  expect(output).toContain('━━ Result')
  expect(output).toContain('• fast path')
  expect(output).toContain('✓ tested')
  expect(output).toContain('□ deploy')
  expect(output).toContain('│ Keep this visible.')
  expect(output).toContain('Name')
  expect(output).toContain('latency')
  expect(output).toContain('const ok = true')
  expect(output).toContain('Open docs (https://example.com)')
  expect(output).not.toContain('**')
  expect(output).not.toContain('```')
})

test('wraps prose, tables, code, and links within a narrow terminal', () => {
  const output = renderToString(
    <AssistantMessage
      streaming={false}
      text={'A long explanatory sentence that must wrap cleanly.\n\n| Topic | Detail |\n|---|---|\n| terminal | another long explanation |\n\n```txt\nan-unusually-long-code-token\n```\n\n[documentation](https://example.com/long/path)'}
    />,
    { columns: 28 },
  )

  expect(output.split('\n').every((line) => visibleWidth(line) <= 28)).toBe(true)
  expect(output).toContain('another')
  expect(output).toContain('an-unusually-long-code')
  expect(output.replace(/\n\s*/g, '')).toContain('https://example.com')
})

test('renders incomplete streaming text and keeps the cursor visible', () => {
  const output = renderToString(<AssistantMessage text={'```sh\nbun test'} streaming />, { columns: 40 })
  expect(output).toContain('sh …')
  expect(output).toContain('bun test▏')
})
