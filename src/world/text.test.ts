import { expect, test } from 'bun:test'
import { isTextOnlyEdit, maskText } from './text.ts'

const wrap = (body: string) => `export const tool = {\n  name: 'read_file',\n  description: ${body},\n  run(x: number) { return x + 1 },\n}\n`

test('rewording a description is a text-only edit, however long the new one is', () => {
  expect(isTextOnlyEdit(wrap("'Read a file from disk. Use when you need its contents.'"), wrap("'Read a file.'"))).toBe(true)
  expect(isTextOnlyEdit(wrap('`multi\nline ${1 + 1} text`'), wrap('`short ${1 + 1}`'))).toBe(true)
})

test('comments are wording too, and whitespace never counts', () => {
  const a = 'const x = 1 // old note\nconst y = 2\n'
  const b = 'const x = 1\n\n/* a rewritten\n   note */\nconst   y = 2\n'
  expect(isTextOnlyEdit(a, b)).toBe(true)
})

test('any change to logic is not a text-only edit', () => {
  const before = wrap("'Read a file.'")
  expect(isTextOnlyEdit(before, before.replace('x + 1', 'x + 2'))).toBe(false)
  expect(isTextOnlyEdit(before, before.replace('return', 'throw'))).toBe(false)
  expect(isTextOnlyEdit(before, before.replace("name: 'read_file'", "name: 'read_file', extra: true"))).toBe(false)
})

test('an identical file is not an edit at all', () => {
  expect(isTextOnlyEdit('const a = 1\n', 'const a = 1\n')).toBe(false)
})

test('a changed import specifier or require target is logic, not wording', () => {
  expect(isTextOnlyEdit("import { a } from './a.ts'\n", "import { a } from './b.ts'\n")).toBe(false)
  expect(isTextOnlyEdit("const a = require('./a')\n", "const a = require('./b')\n")).toBe(false)
  expect(isTextOnlyEdit("const a = await import('./a')\n", "const a = await import('./b')\n")).toBe(false)
})

test('a regular expression keeps its source, and a division is not mistaken for one', () => {
  expect(isTextOnlyEdit('const r = /a+b/g\n', 'const r = /a+c/g\n')).toBe(false)
  expect(isTextOnlyEdit("if (/[/]x/.test(s)) run('a')\n", "if (/[/]x/.test(s)) run('b')\n")).toBe(true)
  // `a / b … 'x' … c / d` must not be read as a regex swallowing the middle.
  expect(isTextOnlyEdit("const q = a / b + 'x' + c / d\n", "const q = a / b + 'y' + c / d\n")).toBe(true)
  expect(isTextOnlyEdit("const q = a / b + 'x' + c / d\n", "const q = a / e + 'x' + c / d\n")).toBe(false)
})

test('anything it cannot read with confidence is not text-only', () => {
  expect(maskText("const a = 'unterminated\n")).toBeUndefined()
  expect(maskText('const a = /* never closed')).toBeUndefined()
  expect(maskText('const a = `never closed')).toBeUndefined()
  expect(isTextOnlyEdit("const a = 'x\n", "const a = 'y\n")).toBe(false)
})

test('nested templates and braces inside an expression are lexed as code', () => {
  const a = 'const s = `a ${ fn({ k: `inner ${v} text` }) } b`\n'
  const b = 'const s = `zzz ${ fn({ k: `other ${v}` }) } yyy`\n'
  expect(isTextOnlyEdit(a, b)).toBe(true)
  expect(isTextOnlyEdit(a, 'const s = `a ${ fn({ k: `inner ${w} text` }) } b`\n')).toBe(false)
})
