import { expect, test } from 'bun:test'
import { COPY_CHECK_NOTE, createCopyCheckGuard } from './copyCheck.ts'

const write = (path: string) => ({ name: 'write_file', input: { path, content: 'x' } })

test('a copy of a named site, written but never compared, is sent back once to be measured', () => {
  const guard = createCopyCheckGuard('i want the exact design of their website', 'go through meatusindia.com\ni want the exact design of their website', true)
  guard.observe([write('meat-us-site/index.html'), write('meat-us-site/styles.css')])
  expect(guard.beforeFinish()).toBe(COPY_CHECK_NOTE)
  expect(guard.beforeFinish()).toBeUndefined()
})

test('a copy that was compared finishes normally', () => {
  const guard = createCopyCheckGuard('copy them exactly', 'see https://example.com', true)
  guard.observe([write('site/index.html')])
  guard.observe([{ name: 'compare_page', input: { original: 'https://example.com', copy: 'site/index.html' } }])
  expect(guard.beforeFinish()).toBeUndefined()
})

test('left alone: no site named, no web file written, not a copy request, or no compare_page', () => {
  const unnamed = createCopyCheckGuard('recreate their website', 'recreate their website', true)
  unnamed.observe([write('index.html')])
  expect(unnamed.beforeFinish()).toBeUndefined()

  const noWeb = createCopyCheckGuard('copy them exactly', 'example.com', true)
  noWeb.observe([write('notes.md')])
  expect(noWeb.beforeFinish()).toBeUndefined()

  const own = createCopyCheckGuard('create a website for my shop', 'myshop.com', true)
  own.observe([write('index.html')])
  expect(own.beforeFinish()).toBeUndefined()

  const cannot = createCopyCheckGuard('copy them exactly', 'example.com', false)
  cannot.observe([write('index.html')])
  expect(cannot.beforeFinish()).toBeUndefined()
})
