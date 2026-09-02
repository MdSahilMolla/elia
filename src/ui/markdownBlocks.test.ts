import { expect, test } from 'bun:test'
import { parseInline, parseMarkdownBlocks, sanitizeTerminalText } from './markdownBlocks.ts'

test('parses the terminal markdown block vocabulary', () => {
  const blocks = parseMarkdownBlocks([
    '# Result',
    '',
    '- first',
    '1. second',
    '- [x] verified',
    '- [ ] pending',
    '',
    '> quoted **detail**',
    '',
    '---',
    '',
    '| Area | Score |',
    '|:-----|------:|',
    '| UI | `9` |',
    '',
    '```ts',
    'const ready = true',
    '```',
  ].join('\n'))

  expect(blocks.map((block) => block.kind)).toEqual(['heading', 'list', 'quote', 'rule', 'table', 'code'])
  expect(blocks[1]).toMatchObject({
    kind: 'list',
    items: [{ marker: '-' }, { marker: '1.' }, { checked: true }, { checked: false }],
  })
  expect(blocks[4]).toMatchObject({ kind: 'table', align: ['left', 'right'] })
  expect(blocks[5]).toMatchObject({ kind: 'code', language: 'ts', lines: ['const ready = true'], complete: true })
})

test('keeps incomplete streaming constructs visible', () => {
  expect(parseInline('waiting for **the rest')).toEqual([{ kind: 'text', text: 'waiting for **the rest' }])
  expect(parseMarkdownBlocks('```sh\nbun test')).toEqual([
    { kind: 'code', language: 'sh', lines: ['bun test'], complete: false },
  ])
  expect(parseMarkdownBlocks('| not | a finished |')).toEqual([
    { kind: 'paragraph', content: [{ kind: 'text', text: '| not | a finished |' }] },
  ])
})

test('shows safe link destinations and leaves unsafe markdown literal', () => {
  expect(parseInline('[docs](https://example.com)')).toEqual([
    { kind: 'link', text: 'docs', url: 'https://example.com' },
  ])
  expect(parseInline('[run](javascript:alert(1))')).toEqual([
    { kind: 'text', text: '[run](javascript:alert(1))' },
  ])
})

test('strips terminal escape and control sequences from model text', () => {
  expect(sanitizeTerminalText('\x1b[31mred\x1b[0m\x00safe')).toBe('redsafe')
  expect(sanitizeTerminalText('\x1b]8;;https://bad.example\x07label\x1b]8;;\x07')).toBe('label')
})
