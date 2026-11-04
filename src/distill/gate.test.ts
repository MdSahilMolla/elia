import { expect, test } from 'bun:test'
import { foreignSourceRuns } from './gate.ts'

test('a fragment is only trusted when every source run has a row in this machine\'s own trajectory log', () => {
  const rows = [{ corr: 'run-local-1' }, { corr: 'run-local-2' }]
  expect(foreignSourceRuns({ sourceRunIds: ['run-local-1', 'run-local-2'] }, rows)).toEqual([])
  // a receipt committed into a repository has no trajectory row here
  expect(foreignSourceRuns({ sourceRunIds: ['run-local-1', 'run-from-repo'] }, rows)).toEqual(['run-from-repo'])
  expect(foreignSourceRuns({ sourceRunIds: ['run-from-repo'] }, [])).toEqual(['run-from-repo'])
})
