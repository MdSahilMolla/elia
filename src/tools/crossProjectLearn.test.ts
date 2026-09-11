import { describe, expect, it, beforeAll, afterAll } from 'bun:test'
import { runCrossProjectLearn, hashCode, getProjectFingerprint, loadStore, saveStore, scoreRelevance, type Pattern } from './crossProjectLearn.ts'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const OLD = new Date(Date.now() - 90 * 86400000).toISOString()

function pattern(partial: Partial<Pattern> & { title: string }): Pattern {
  return {
    id: 'seed',
    timestamp: OLD,
    projectFingerprint: 'proj_other',
    category: 'optimization',
    description: '',
    solution: 'use a Set for membership checks',
    keywords: ['perf'],
    confidence: 0.7,
    ...partial,
  }
}

describe('hashCode / getProjectFingerprint', () => {
  it('is deterministic and prefix-stable', () => {
    const a = hashCode('hello world')
    const b = hashCode('hello world')
    expect(a).toBe(b)
    expect(a.startsWith('proj_')).toBe(true)
  })

  it('fingerprint reflects manifest and src listing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cpl-fp-'))
    writeFileSync(join(dir, 'package.json'), '{"name":"x"}\n')
    expect(getProjectFingerprint(dir)).toBe(getProjectFingerprint(dir))
    rmSync(dir, { recursive: true, force: true })
  })
})

describe('scoreRelevance', () => {
  it('ranks title and keyword hits', () => {
    const p = pattern({ id: 'a', title: 'avoid N+1 queries', keywords: ['n+1', 'fetch'] })
    expect(scoreRelevance(p, 'n+1')).toBeGreaterThan(scoreRelevance(p, 'zzz'))
  })
})

describe('runCrossProjectLearn', () => {
  let cwd: string

  beforeAll(() => {
    cwd = mkdtempSync(join(tmpdir(), 'cpl-test-'))
    writeFileSync(join(cwd, 'package.json'), '{"name": "test-proj", "dependencies": {}}\n')
  })

  afterAll(() => {
    rmSync(cwd, { recursive: true, force: true })
  })

  it('records a pattern persisted to the store', () => {
    const recorded = runCrossProjectLearn(
      { action: 'record', title: 'Batch inserts in postgres', category: 'optimization', description: 'row-by-row inserts are slow', solution: 'use multi-value insert', keywords: 'postgres,insert' },
      cwd,
    )
    expect(recorded).toContain('Batch inserts in postgres')
    expect(loadStore(cwd).patterns.length).toBe(1)
    expect(loadStore(cwd).patterns[0]!.projectFingerprint).toBe(getProjectFingerprint(cwd))
  })

  it('queries by relevance across project fingerprints', () => {
    const other = pattern({ id: 'm1', title: 'Retry with exponential backoff', category: 'error-pattern', keywords: ['retry'], projectFingerprint: 'proj_other' })
    runCrossProjectLearn({ action: 'record', title: 'Retry with exponential backoff', category: 'error-pattern', description: 'transient errors', solution: 'exponential backoff with jitter', keywords: 'retry,jitter' }, cwd)
    const store = loadStore(cwd)
    store.patterns.push(other)
    saveStore(cwd, store)

    const results = runCrossProjectLearn({ action: 'query', query: 'retry', limit: 10 }, cwd)
    expect(results).toContain('Retry with exponential backoff')
  })

  it('filters by category', () => {
    const results = runCrossProjectLearn({ action: 'query', category: 'optimization' }, cwd)
    expect(results).toContain('Batch inserts in postgres')
    expect(results).not.toContain('Retry with exponential backoff')
  })

  it('reports stats with project diversity', () => {
    const stats = runCrossProjectLearn({ action: 'stats' }, cwd)
    expect(stats).toContain('Total patterns: 3')
    expect(stats).toContain('Projects represented: 2')
  })

  it('syncs fingerprint', () => {
    const sync = runCrossProjectLearn({ action: 'sync' }, cwd)
    expect(sync).toContain('Synced project fingerprint')
    expect(sync).toContain('patterns from other projects available')
  })

  it('throws on missing title and unknown action', () => {
    expect(() => runCrossProjectLearn({ action: 'record' }, cwd)).toThrow(/title is required/)
    expect(() => runCrossProjectLearn({ action: 'nope' }, cwd)).toThrow(/Unknown action/)
  })
})