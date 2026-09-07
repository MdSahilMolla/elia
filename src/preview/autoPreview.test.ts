import { expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { findFreshPreviewTarget } from './autoPreview.ts'

function scratch(): string {
  return mkdtempSync(join(tmpdir(), 'elia-autopreview-'))
}

test('picks up an HTML file written after the turn started', () => {
  const root = scratch()
  const site = join(root, 'egg-benefits')
  mkdirSync(site)
  const page = join(site, 'index.html')
  writeFileSync(page, '<h1>eggs</h1>')
  expect(findFreshPreviewTarget(Date.now() - 5_000, root)).toBe(page)
})

test('ignores HTML that predates the turn', () => {
  const root = scratch()
  const page = join(root, 'old.html')
  writeFileSync(page, 'old')
  const longAgo = Date.now() / 1000 - 3_600
  utimesSync(page, longAgo, longAgo)
  expect(findFreshPreviewTarget(Date.now() - 5_000, root)).toBeUndefined()
})

test('prefers index.html over a sibling page written in the same window', () => {
  const root = scratch()
  const site = join(root, 'site')
  mkdirSync(site)
  writeFileSync(join(site, 'about.html'), 'about')
  const index = join(site, 'index.html')
  writeFileSync(index, 'index')
  expect(findFreshPreviewTarget(Date.now() - 5_000, root)).toBe(index)
})

test('returns undefined for a missing root', () => {
  expect(findFreshPreviewTarget(0, join(tmpdir(), 'definitely-not-here-elia'))).toBeUndefined()
})

test('skips node_modules', () => {
  const root = scratch()
  const nm = join(root, 'node_modules', 'pkg')
  mkdirSync(nm, { recursive: true })
  writeFileSync(join(nm, 'index.html'), 'dep page')
  expect(findFreshPreviewTarget(Date.now() - 5_000, root)).toBeUndefined()
})
