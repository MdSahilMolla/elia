import { afterAll, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { dataScienceTool } from './dataScience.ts'

const testDir = mkdtempSync(join('/tmp', 'elia-data-science-'))
const datasetPath = join(testDir, 'events.csv')
mkdirSync(testDir, { recursive: true })
writeFileSync(datasetPath, 'id,region,revenue\n1,East,100\n2,West,50\n2,West,70\n3,East,80\n')

test('data science profile reports schema, missingness, duplicates, and numeric summaries', async () => {
  const result = JSON.parse(await dataScienceTool.execute({ action: 'profile', path: datasetPath })) as { dataset: { rows: number; columns: string[] }; columns: Array<{ name: string; inferredType: string; missing: number; unique: number }>; duplicateRows: number; qualityStatus: string }
  expect(result.dataset.rows).toBe(4)
  expect(result.dataset.columns).toEqual(['id', 'region', 'revenue'])
  expect(result.columns.find((column) => column.name === 'revenue')?.inferredType).toBe('number')
  expect(result.columns.find((column) => column.name === 'region')?.missing).toBe(0)
  expect(result.duplicateRows).toBe(0)
  expect(result.qualityStatus).toBe('pass')
})

test('data science validation catches missing, non-numeric, and duplicate-key violations', async () => {
  const result = JSON.parse(await dataScienceTool.execute({ action: 'validate', path: datasetPath, requiredColumns: ['id', 'region', 'revenue'], uniqueColumns: ['id'], notNullColumns: ['region'], numericColumns: ['revenue'], minRows: 5 })) as { status: string; issues: Array<{ rule: string; column?: string }> }
  expect(result.status).toBe('review')
  expect(result.issues.map((issue) => issue.rule)).toEqual(expect.arrayContaining(['minimum-rows', 'unique']))
})

test('data science grouped summaries and correlation are deterministic', async () => {
  const grouped = JSON.parse(await dataScienceTool.execute({ action: 'group_summary', path: datasetPath, groupBy: 'region', measure: 'revenue' })) as { groups: Array<{ group: string; sum: number; count: number; mean: number | null; median: number | null; min: number | null; max: number | null }> }
  expect(grouped.groups[0]).toEqual({ group: 'East', count: 2, sum: 180, mean: 90, median: 90, min: 80, max: 100 })
  const correlated = JSON.parse(await dataScienceTool.execute({ action: 'correlation', path: datasetPath, xColumn: 'id', yColumn: 'revenue' })) as { completePairs: number; pearsonR: number }
  expect(correlated.completePairs).toBe(4)
  expect(correlated.pearsonR).toBeCloseTo(-0.392232, 5)
  const regression = JSON.parse(await dataScienceTool.execute({ action: 'linear_regression', path: datasetPath, xColumn: 'id', yColumn: 'revenue' })) as { completePairs: number; coefficients: { slope: number; intercept: number }; metrics: { rSquared: number }; interpretation: string }
  expect(regression.completePairs).toBe(4)
  expect(regression.coefficients.slope).toBeCloseTo(-10, 5)
  expect(regression.coefficients.intercept).toBeCloseTo(95, 5)
  expect(regression.metrics.rSquared).toBeCloseTo(0.153846, 5)
  expect(regression.interpretation).toContain('do not establish causation')
})

test('data science validates actions and required paths', async () => {
  await expect(dataScienceTool.execute({ action: 'profile' })).rejects.toThrow('path is required')
  await expect(dataScienceTool.execute({ action: 'unknown', path: datasetPath })).rejects.toThrow('action must be profile')
})

afterAll(() => rmSync(testDir, { recursive: true, force: true }))
