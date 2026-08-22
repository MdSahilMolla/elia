import { expect, test } from 'bun:test'
import { fitnessTool } from './fitness.ts'

test('fitness plan is bounded and includes conservative progression guidance', async () => {
  const result = JSON.parse(await fitnessTool.execute({ action: 'plan', goal: 'consistency', daysPerWeek: 99, minutesPerSession: 999, equipment: ['mat'] })) as { daysPerWeek: number; minutesPerSession: number; sessions: unknown[]; limitations: string[]; progression: string[] }
  expect(result.daysPerWeek).toBe(7)
  expect(result.minutesPerSession).toBe(180)
  expect(result.sessions).toHaveLength(7)
  expect(result.progression.join(' ')).toContain('Increase one variable at a time')
  expect(result.limitations.join(' ')).toContain('not individualized medical')
})

test('fitness progress summarizes completed activity only', async () => {
  const result = JSON.parse(await fitnessTool.execute({ action: 'progress', sessions: [
    { durationMin: 30, completed: true },
    { durationMin: 45, status: 'planned' },
    { durationMin: 20, status: 'completed' },
  ] })) as { completedSessions: number; adherenceRate: number; completedMinutes: number; invalidRows: number }
  expect(result.completedSessions).toBe(2)
  expect(result.adherenceRate).toBeCloseTo(0.667, 3)
  expect(result.completedMinutes).toBe(50)
  expect(result.invalidRows).toBe(0)
})

test('fitness validation rejects malformed activity rows without assessing health', async () => {
  const result = JSON.parse(await fitnessTool.execute({ action: 'validate', sessions: [{ durationMin: -5, completed: 'yes' }] })) as { valid: boolean; warnings: string[]; note: string }
  expect(result.valid).toBe(false)
  expect(result.warnings).toHaveLength(2)
  expect(result.note).toContain('does not assess health')
})
