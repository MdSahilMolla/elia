import { expect, test } from 'bun:test'
import { join } from 'node:path'
import { describeInterruptedTurn } from './interruptedTurn.ts'

const cwd = join('/', 'work', 'site')
const at = (name: string) => join(cwd, name)

test('a turn that touched nothing has nothing to report', () => {
  expect(describeInterruptedTurn({ ending: 'failed', touched: [], rewindIndex: 3, cwd })).toBeUndefined()
})

test('a failed turn names what it changed and the exact rewind that undoes it', () => {
  const line = describeInterruptedTurn({ ending: 'failed', touched: [at('index.html'), at('style.css')], rewindIndex: 4, cwd })!
  expect(line).toContain('This turn failed after changing 2 files (index.html, style.css)')
  expect(line).toContain('nothing verified them')
  expect(line).toContain('`/rewind 4`')
  expect(line).toContain('`continue`')
})

test('a stopped turn says it was stopped, and long lists are cut short', () => {
  const touched = ['a', 'b', 'c', 'd', 'e', 'f'].map((name) => at(`${name}.ts`))
  const line = describeInterruptedTurn({ ending: 'stopped', touched, rewindIndex: 0, cwd })!
  expect(line).toStartWith('This turn was stopped after changing 6 files (a.ts, b.ts, c.ts, d.ts, … 2 more)')
})

test('a file the turn left unparseable is named', () => {
  const broken = at('app.ts')
  const line = describeInterruptedTurn({
    ending: 'failed',
    touched: [broken, at('ok.ts')],
    rewindIndex: 1,
    cwd,
    structural: { checked: [], skipped: [], broken: [{ file: broken, ok: false, reason: 'Unexpected }' }] },
  })!
  expect(line).toContain('app.ts does not parse — it was left mid-edit')
})

test('a path outside the project stays absolute, and one file is "it"', () => {
  const outside = join('/', 'elsewhere', 'x.ts')
  const line = describeInterruptedTurn({ ending: 'failed', touched: [outside], rewindIndex: 0, cwd })!
  expect(line).toContain(`changing 1 file (${outside}), and nothing verified it.`)
})
