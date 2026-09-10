import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { appendHistory, loadHistory, searchHistory } from './history.ts'

function tmpFile(): string {
  return join(mkdtempSync(join(tmpdir(), 'elia-hist-')), 'prompt-history')
}

test('append then load round-trips, newest last', () => {
  const path = tmpFile()
  try {
    appendHistory('first prompt', path)
    appendHistory('second prompt', path)
    expect(loadHistory(path)).toEqual(['first prompt', 'second prompt'])
  } finally {
    rmSync(join(path, '..'), { recursive: true, force: true })
  }
})

test('skips blanks, slash and shell commands, and immediate repeats', () => {
  const path = tmpFile()
  try {
    appendHistory('real one', path)
    appendHistory('real one', path) // repeat
    appendHistory('/model', path) // slash
    appendHistory('!ls', path) // shell
    appendHistory('   ', path) // blank
    expect(loadHistory(path)).toEqual(['real one'])
  } finally {
    rmSync(join(path, '..'), { recursive: true, force: true })
  }
})

test('a missing file loads as empty rather than throwing', () => {
  expect(loadHistory(join(tmpdir(), 'does-not-exist-elia', 'x'))).toEqual([])
})

test('searchHistory matches case-insensitively, newest first, deduped', () => {
  const history = ['add retry to scheduler', 'fix the menu', 'add retry budget', 'add retry to scheduler']
  expect(searchHistory('RETRY', history)).toEqual(['add retry to scheduler', 'add retry budget'])
  expect(searchHistory('', history)).toEqual([])
})
