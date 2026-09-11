import { describe, expect, it, beforeAll, afterAll } from 'bun:test'
import { runCodebaseMemory, scoreRelevance, loadMemory, saveMemory, getMemoryStorePath, type MemoryEntry } from './codebaseMemory.ts'
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const OLD = new Date(Date.now() - 90 * 86400000).toISOString()

function entry(partial: Partial<MemoryEntry> & { id: string; title: string }): MemoryEntry {
  return {
    timestamp: OLD,
    category: 'lesson',
    description: '',
    tags: [],
    confidence: 0.8,
    ...partial,
  }
}

describe('scoreRelevance', () => {
  const base = entry({ id: 'm1', title: 'Token leak in auth retry', category: 'bugfix', file: 'src/auth.ts', tags: ['token', 'retry'] })

  it('ranks title matches higher than description matches', () => {
    const titleHit = scoreRelevance(entry({ ...base, id: 'a', title: 'search token rotation' }), 'token')
    const descHit = scoreRelevance(entry({ ...base, id: 'b', title: 'general note', description: 'token rotation for search' }), 'token')
    expect(titleHit).toBeGreaterThan(descHit)
  })

  it('boosts file and tag matches', () => {
    const a = scoreRelevance(entry({ ...base, id: 'a', file: 'src/auth.ts' }), 'auth')
    const b = scoreRelevance(entry({ ...base, id: 'b', file: 'src/other.ts' }), 'auth')
    expect(a).toBeGreaterThan(b)
  })

  it('is deterministic for old entries', () => {
    expect(scoreRelevance(base, 'auth retry')).toBe(scoreRelevance(base, 'auth retry'))
  })
})

describe('runCodebaseMemory', () => {
  let cwd: string

  beforeAll(() => {
    cwd = mkdtempSync(join(tmpdir(), 'mem-test-'))
  })

  afterAll(() => {
    rmSync(cwd, { recursive: true, force: true })
  })

  it('records, queries, and persists memories', () => {
    const recorded = runCodebaseMemory({ action: 'record', title: 'Fixed ledger race', category: 'bugfix', file: 'src/ledger.ts', description: 'Two concurrent writers could corrupt the ledger', tags: 'race,ledger' }, cwd)
    expect(recorded).toContain('[BUGFIX] Fixed ledger race')

    expect(existsSync(getMemoryStorePath(cwd))).toBe(true)
    const persisted = loadMemory(cwd)
    expect(persisted.length).toBe(1)
    expect(persisted[0]!.file).toBe('src/ledger.ts')
    expect(persisted[0]!.tags).toEqual(['race', 'ledger'])
  })

  it('queries by relevance', () => {
    runCodebaseMemory({ action: 'record', title: 'Auth token refresh pattern', category: 'pattern', file: 'src/auth.ts', description: 'Refresh tokens before expiry instead of on 401', tags: 'auth,token' }, cwd)
    const results = runCodebaseMemory({ action: 'query', query: 'token', limit: 10 }, cwd)
    expect(results).toContain('Auth token refresh pattern')
  })

  it('filters by category', () => {
    const results = runCodebaseMemory({ action: 'query', category: 'bugfix' }, cwd)
    expect(results).toContain('Fixed ledger race')
    expect(results).not.toContain('Auth token refresh pattern')
  })

  it('updates a memory', () => {
    const [mem] = loadMemory(cwd)
    expect(mem).toBeDefined()
    const updated = runCodebaseMemory({ action: 'update', id: mem!.id, description: 'Reproduced in prod on 2026-09-01' }, cwd)
    expect(updated).toContain('updated successfully')
    const [after] = loadMemory(cwd)
    expect(after!.description).toContain('Reproduced in prod')
  })

  it('reports stats', () => {
    const stats = runCodebaseMemory({ action: 'stats' }, cwd)
    expect(stats).toContain('Total memories: 2')
    expect(stats).toContain('bugfix')
  })

  it('lists memories', () => {
    const listing = runCodebaseMemory({ action: 'list' }, cwd)
    expect(listing).toContain('Auth token refresh pattern')
  })

  it('deletes a memory', () => {
    const [mem] = loadMemory(cwd)
    expect(mem).toBeDefined()
    const deleted = runCodebaseMemory({ action: 'delete', id: mem!.id }, cwd)
    expect(deleted).toContain('deleted successfully')
    expect(loadMemory(cwd).length).toBe(1)
  })

  it('throws on unknown action and missing title', () => {
    expect(() => runCodebaseMemory({ action: 'bogus' }, cwd)).toThrow()
    expect(() => runCodebaseMemory({ action: 'record' }, cwd)).toThrow(/title is required/)
  })

  it('persists across reload', () => {
    const direct = saveMemory as (c: string, e: MemoryEntry[]) => void
    direct(cwd, [entry({ id: 'seed', title: 'Seed memory' })])
    expect(runCodebaseMemory({ action: 'list' }, cwd)).toContain('Seed memory')
  })
})