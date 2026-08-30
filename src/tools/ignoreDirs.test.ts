import { expect, test } from 'bun:test'
import { isIgnored, SKIP_DIRS } from './ignoreDirs.ts'

test('ignores the usual build/vcs directories anywhere in the path', () => {
  expect(isIgnored('node_modules/foo/index.js')).toBe(true)
  expect(isIgnored('src/.git/config')).toBe(true)
  expect(isIgnored('dist/bundle.js')).toBe(true)
  expect(isIgnored('src/app.ts')).toBe(false)
})

test('ignores Windows system directories that break a drive-root scan', () => {
  expect(isIgnored('System Volume Information/tracking.log')).toBe(true)
  expect(isIgnored('$RECYCLE.BIN/S-1-5-21/file')).toBe(true)
  expect(isIgnored('Config.Msi/x.rbf')).toBe(true)
  expect(isIgnored('$WinREAgent/scratch')).toBe(true)
})

test('ignores root-level lock files like DumpStack.log.tmp and pagefile.sys', () => {
  expect(isIgnored('DumpStack.log.tmp')).toBe(true)
  expect(isIgnored('pagefile.sys')).toBe(true)
  expect(isIgnored('src/pagefile.sys.notes.md')).toBe(false)
})

test('the skip list still includes the originals', () => {
  expect(SKIP_DIRS).toContain('node_modules')
  expect(SKIP_DIRS).toContain('.git')
})
