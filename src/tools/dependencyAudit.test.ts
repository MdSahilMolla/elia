import { describe, expect, it } from 'bun:test'
import { analyzeDependency, buildDependencyReport, compareVersions, detectPackageManager, isVolatileRange, parsePackageJson } from './dependencyAudit.ts'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

describe('compareVersions', () => {
  it('compares dotted versions', () => {
    expect(compareVersions('1.0.0', '1.0.1')).toBe(true)
    expect(compareVersions('1.2.0', '1.1.9')).toBe(false)
    expect(compareVersions('2.0.0', '1.9.9')).toBe(false)
    expect(compareVersions('1.0.0', '1.0.0')).toBe(false)
    expect(compareVersions('0.5', '0.5.1')).toBe(true)
  })
})

describe('isVolatileRange / splitSpec', () => {
  it('flags floating and comparator ranges', () => {
    expect(isVolatileRange('*')).toBe(true)
    expect(isVolatileRange('latest')).toBe(true)
    expect(isVolatileRange('>=1.2.0')).toBe(true)
    expect(isVolatileRange('<2.0.0')).toBe(true)
    expect(isVolatileRange('~1.2.0')).toBe(true)
    expect(isVolatileRange('1.2.0 || 1.3.0')).toBe(true)
    expect(isVolatileRange('^1.2.0')).toBe(false)
    expect(isVolatileRange('1.2.0')).toBe(false)
  })
})

describe('parsePackageJson', () => {
  it('merges dependencies and devDependencies, stripping specifiers', () => {
    const deps = parsePackageJson(
      JSON.stringify({ dependencies: { a: '^1.0.0' }, devDependencies: { b: '~2.3.4' } }),
    )
    expect(deps).toContainEqual({ name: 'a', currentVersion: '1.0.0', range: '^1.0.0' })
    expect(deps).toContainEqual({ name: 'b', currentVersion: '2.3.4', range: '~2.3.4' })
  })

  it('tolerates invalid JSON', () => {
    expect(parsePackageJson('nope')).toEqual([])
  })
})

describe('analyzeDependency', () => {
  it('flags vulnerabilities as critical risk', () => {
    const info = analyzeDependency({ name: 'left-pad', currentVersion: '1.0.0', range: '1.0.0' }, { isVulnerable: true })
    expect(info.isVulnerable).toBe(true)
    expect(info.risk.level).toBe('critical')
    expect(info.risk.score).toBeGreaterThanOrEqual(75)
  })

  it('flags deprecated packages as high risk', () => {
    const info = analyzeDependency({ name: 'old', currentVersion: '1.0.0', range: '1.0.0' }, { deprecated: true })
    expect(info.deprecated).toBe(true)
    expect(info.risk.level).toBe('high')
    expect(info.deprecationMessage).toBeDefined()
  })

  it('flags volatile ranges as at least medium', () => {
    const info = analyzeDependency({ name: 'float', currentVersion: '1.0.0', range: 'latest' })
    expect(info.isVolatile).toBe(true)
    expect(info.risk.score).toBeGreaterThanOrEqual(25)
  })

  it('marks outdated when latest is newer', () => {
    const info = analyzeDependency({ name: 'pkg', currentVersion: '1.0.0', range: '1.0.0' }, { latestVersion: '2.0.0' })
    expect(info.isOutdated).toBe(true)
    expect(info.latestVersion).toBe('2.0.0')
  })

  it('stays low risk when clean', () => {
    const info = analyzeDependency({ name: 'clean', currentVersion: '1.5.0', range: '1.5.0' })
    expect(info.risk.level).toBe('low')
    expect(info.evidence.length).toBeGreaterThan(0)
  })
})

describe('buildDependencyReport', () => {
  it('aggregates totals and recommends remediation', () => {
    const report = buildDependencyReport([
      analyzeDependency({ name: 'a', currentVersion: '1.0.0', range: '1.0.0' }, { isVulnerable: true }),
      analyzeDependency({ name: 'b', currentVersion: '2.0.0', range: '2.0.0' }, { deprecated: true, deprecationMessage: 'moved to x' }),
      analyzeDependency({ name: 'c', currentVersion: '3.0.0', range: '*' }),
      analyzeDependency({ name: 'd', currentVersion: '4.0.0', range: '4.0.0' }),
    ])
    expect(report.totalDependencies).toBe(4)
    expect(report.vulnerable).toBe(1)
    expect(report.deprecated).toBe(1)
    expect(report.volatile).toBe(1)
    expect(report.recommendations.length).toBeGreaterThan(0)
    expect(report.dependencies[0]!.name).toBe('a')
    expect(report.summary).toContain('1 vulnerable')
  })

  it('reports a clean bill when nothing is wrong', () => {
    const report = buildDependencyReport([analyzeDependency({ name: 'd', currentVersion: '4.0.0', range: '4.0.0' })])
    expect(report.vulnerable).toBe(0)
    expect(report.recommendations[0]).toBe('No manifest-level dependency issues detected offline.')
  })
})

describe('detectPackageManager', () => {
  it('detects by lockfile presence', () => {
    const dir = mkdtempSync(join(tmpdir(), 'depaudit-'))
    expect(detectPackageManager(dir)).toBe('unknown')
    writeFileSync(join(dir, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n')
    expect(detectPackageManager(dir)).toBe('pnpm')
    writeFileSync(join(dir, 'bun.lock'), 'lock\n')
    expect(detectPackageManager(dir)).toBe('bun')
    mkdirSync(join(dir, 'sub'))
    writeFileSync(join(dir, 'sub', 'Cargo.toml'), '[package]\n')
    expect(detectPackageManager(join(dir, 'sub'))).toBe('cargo')
  })
})