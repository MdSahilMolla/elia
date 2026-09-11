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

// Regression: the scan only ever walked `paths.workspace`, so a page written
// anywhere else - portfolio-demo/, nikhil-website/, the repo root - was
// invisible and the turn offered nothing rather than a preview.
test('finds a page written outside the workspace root', () => {
  const workspace = scratch()
  const elsewhere = scratch()
  const page = join(elsewhere, 'index.html')
  writeFileSync(page, '<h1>portfolio</h1>')
  // The workspace scan alone sees nothing here.
  expect(findFreshPreviewTarget(Date.now() - 5_000, workspace)).toBeUndefined()
  // With the turn's written-file list, it is found.
  expect(findFreshPreviewTarget(Date.now() - 5_000, workspace, [page])).toBe(page)
})

test('a written path that never landed on disk is not offered', () => {
  const workspace = scratch()
  const ghost = join(scratch(), 'index.html')
  expect(findFreshPreviewTarget(Date.now() - 5_000, workspace, [ghost])).toBeUndefined()
})

test('a written page outranks an equally fresh one merely found by the scan', () => {
  const workspace = scratch()
  writeFileSync(join(workspace, 'other.html'), '<h1>other</h1>')
  const written = join(scratch(), 'index.html')
  writeFileSync(written, '<h1>the one</h1>')
  expect(findFreshPreviewTarget(Date.now() - 5_000, workspace, [written])).toBe(written)
})

test('a page found by both routes is only considered once', () => {
  const workspace = scratch()
  const page = join(workspace, 'index.html')
  writeFileSync(page, '<h1>hi</h1>')
  expect(findFreshPreviewTarget(Date.now() - 5_000, workspace, [page])).toBe(page)
})

test('non-HTML writes are ignored', () => {
  const workspace = scratch()
  const script = join(scratch(), 'app.ts')
  writeFileSync(script, 'export const a = 1')
  expect(findFreshPreviewTarget(Date.now() - 5_000, workspace, [script])).toBeUndefined()
})
