import { expect, test } from 'bun:test'
import { sportsTool } from './sports.ts'

test('sports team summary computes standings deterministically', async () => {
  const result = JSON.parse(await sportsTool.execute({
    action: 'team_summary',
    matches: [
      { team: 'Blue', goalsFor: 2, goalsAgainst: 0 },
      { team: 'Blue', goalsFor: 1, goalsAgainst: 1 },
      { team: 'Red', goalsFor: 0, goalsAgainst: 2 },
    ],
  })) as { teams: Array<{ team: string; points: number; goalDifference: number }>; invalidRows: string[] }
  expect(result.invalidRows).toEqual([])
  expect(result.teams[0]).toMatchObject({ team: 'Blue', points: 4, goalDifference: 2 })
  expect(result.teams[1]).toMatchObject({ team: 'Red', points: 0, goalDifference: -2 })
})

test('sports player comparison ranks the requested metric and excludes incomplete rows', async () => {
  const result = JSON.parse(await sportsTool.execute({
    action: 'player_compare',
    metric: 'goals',
    players: [{ name: 'A', goals: 8 }, { name: 'B', goals: 10 }, { name: 'Missing' }],
  })) as { comparison: Array<{ rank: number; name: string; metric: string; value: number }>; excludedRows: number }
  expect(result.comparison).toEqual([{ rank: 1, name: 'B', metric: 'goals', value: 10 }, { rank: 2, name: 'A', metric: 'goals', value: 8 }])
  expect(result.excludedRows).toBe(1)
})

test('sports validation reports missing identifiers without claiming source truth', async () => {
  const result = JSON.parse(await sportsTool.execute({ action: 'validate', matches: [{ goalsFor: 1 }] })) as { valid: boolean; warnings: string[]; note: string }
  expect(result.valid).toBe(false)
  expect(result.warnings[0]).toContain('team or name')
  expect(result.note).toContain('does not verify the truth')
})
