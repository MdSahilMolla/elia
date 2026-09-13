import { describe, expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { detectExportStyle, generateTestCode, generateRegressionTest } from './regressionTest.ts'
import type { RootCauseCandidate, SemanticDiff } from './types.ts'

const candidate: RootCauseCandidate = {
  nodeId: 'n1',
  commitHash: 'abc12345',
  label: 'broken behavior',
  confidence: 0.8,
  level: 'high',
  scoringBreakdown: [],
  explanation: 'regression source',
  causalChain: ['n1'],
  counterfactualVerified: false,
}

test('detectExportStyle returns the real exported symbol names, not the filename', () => {
  const dir = mkdtempSync(join(tmpdir(), 'elia-regstyle-'))
  try {
    const target = 'scanner.ts'
    writeFileSync(join(dir, target), 'export function analyzeThings() {}\nexport const VERSION = 1\n')
    const style = detectExportStyle(target, dir)
    expect(style.kind).toBe('named')
    expect(style.moduleName).toBe('scanner')
    expect(style.exportNames).toEqual(['analyzeThings', 'VERSION'])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('detectExportStyle treats default-export and missing files correctly', () => {
  const dir = mkdtempSync(join(tmpdir(), 'elia-regstyle2-'))
  try {
    const target = 'plugin.ts'
    writeFileSync(join(dir, target), 'export default function boot() {}\n')
    expect(detectExportStyle(target, dir).kind).toBe('default')
    expect(detectExportStyle('missing.ts', dir)).toEqual({ kind: 'none', moduleName: 'missing', exportNames: [] })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('generateTestCode imports the actual export name, not the module filename', () => {
  const code = generateTestCode({
    framework: 'bun:test',
    conventions: { describe: 'describe', it: 'it', expect: 'expect' },
    targetFile: 'scanner.ts',
    candidate,
    testFileExists: false,
    exportStyle: { kind: 'named', moduleName: 'scanner', exportNames: ['analyzeThings', 'VERSION'] },
  })
  expect(code).toContain("import { analyzeThings } from './scanner'")
  expect(code).not.toContain("import { scanner } from './scanner'")
  expect(code).toContain('analyzeThings(...)')
})

test('generateRegressionTest embeds the detected export name into the generated test', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'elia-reggen-'))
  try {
    const target = 'src/util/geo.ts'
    mkdirSync(join(dir, 'src/util'), { recursive: true })
    writeFileSync(join(dir, target), 'export function haversineKm(a: number): number { return a }\n')
    const diff: SemanticDiff = {
      filePath: target,
      commitHash: 'abc12345',
      categories: ['return_value'],
      behavioralSummary: 'return value changed',
      behavioralChanges: [],
      affectedSymbols: ['haversineKm'],
    }
    const reg = await generateRegressionTest(candidate, target, [diff], dir)
    expect(reg.filePath).toBe('src/util/geo.test.ts')
    expect(reg.framework).toBe('bun:test')
    expect(reg.code).toContain("import { haversineKm } from './geo'")
    expect(reg.code).not.toContain("import { geo } from './geo'")
    expect(reg.invariant).toContain('return the expected value')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})