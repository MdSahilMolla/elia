import { expect, test } from 'bun:test'
import { colorizeDiffBlock, foldText, isDiffResult } from './render.ts'

test('foldText leaves short text untouched', () => {
  const r = foldText('a\nb\nc')
  expect(r.hiddenLines).toBe(0)
  expect(r.text).toBe('a\nb\nc')
})

test('foldText trims to headLines and reports the hidden count', () => {
  const text = Array.from({ length: 50 }, (_, i) => `line ${i}`).join('\n')
  const r = foldText(text, { headLines: 10, expandHint: '/expand' })
  expect(r.hiddenLines).toBe(40)
  expect(r.text).toContain('+40 lines — /expand')
  expect(r.text.split('\n')).toHaveLength(11) // 10 kept + footer
})

test('foldText folds on the byte ceiling even under the line limit', () => {
  const text = `${'x'.repeat(5_000)}\nsecond line`
  const r = foldText(text, { headLines: 100, maxBytes: 1_000 })
  expect(r.hiddenLines).toBeGreaterThan(0)
})

test('colorizeDiffBlock is a no-op without a diff fence', () => {
  expect(colorizeDiffBlock('just some text')).toBe('just some text')
})

test('isDiffResult recognizes the file-mutation tools', () => {
  expect(isDiffResult('edit_file')).toBe(true)
  expect(isDiffResult('write_file')).toBe(true)
  expect(isDiffResult('read_file')).toBe(false)
})
