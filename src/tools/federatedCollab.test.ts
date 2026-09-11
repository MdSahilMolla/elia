import { describe, expect, it, beforeAll, afterAll } from 'bun:test'
import { runFederatedCollab, sanitizeInboundPattern, receiveFromInbox, loadStore, type FederatedPattern } from './federatedCollab.ts'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

describe('sanitizeInboundPattern', () => {
  it('accepts a well-formed payload and drops unknown fields', () => {
    const pattern = sanitizeInboundPattern({
      id: 'p1',
      sourceProject: 'peer-node',
      timestamp: '2026-09-01T00:00:00.000Z',
      category: 'performance',
      title: 'Use streaming for large JSON',
      description: 'full docs slow',
      solution: 'stream with iteratee',
      keywords: ['json', 'stream', 'perf', 'EVIL_TAG_EXECUTED'],
      confidence: 0.9,
      dangerousExtra: { shell: 'rm -rf /' },
    })
    expect(pattern).not.toBeNull()
    expect(pattern!.keywords).toEqual(['json', 'stream', 'perf', 'EVIL_TAG_EXECUTED'])
    expect((pattern as unknown as Record<string, unknown>)['dangerousExtra']).toBeUndefined()
  })

  it('rejects payloads missing id, title, or solution', () => {
    const valid = { id: 'p1', title: 't', solution: 's', timestamp: '2026-09-01T00:00:00.000Z', category: 'testing' }
    expect(sanitizeInboundPattern(valid)).not.toBeNull()
    expect(sanitizeInboundPattern({ ...valid, id: undefined })).toBeNull()
    expect(sanitizeInboundPattern({ ...valid, title: undefined })).toBeNull()
    expect(sanitizeInboundPattern({ ...valid, solution: undefined })).toBeNull()
  })

  it('rejects null, non-objects, bad timestamps, and unknown categories', () => {
    expect(sanitizeInboundPattern(null)).toBeNull()
    expect(sanitizeInboundPattern('string')).toBeNull()
    expect(sanitizeInboundPattern({ id: 'p', title: 't', solution: 's', timestamp: 'not-a-date' })).toBeNull()
    expect(sanitizeInboundPattern({ id: 'p', title: 't', solution: 's', timestamp: '2026-09-01T00:00:00.000Z', category: 'unknown' })).toBeNull()
  })

  it('caps field lengths and keyword counts', () => {
    const pattern = sanitizeInboundPattern({
      id: 'x'.repeat(500),
      title: 't'.repeat(5000),
      solution: 's',
      timestamp: '2026-09-01T00:00:00.000Z',
      category: 'testing',
      keywords: Array.from({ length: 20 }, (_, i) => `kw${i}`),
    })
    expect(pattern).toBeNull() // id over cap
    const long = sanitizeInboundPattern({
      id: 'p',
      title: 't'.repeat(5000),
      solution: 's',
      timestamp: '2026-09-01T00:00:00.000Z',
      category: 'testing',
      keywords: Array.from({ length: 20 }, (_, i) => `kw${i}`),
    })
    expect(long).not.toBeNull()
    expect(long!.title.length).toBeLessThanOrEqual(2000)
    expect(long!.keywords.length).toBeLessThanOrEqual(8)
  })
})

describe('runFederatedCollab + local-only receive', () => {
  let cwd: string

  beforeAll(() => {
    cwd = mkdtempSync(join(tmpdir(), 'fed-test-'))
  })

  afterAll(() => {
    rmSync(cwd, { recursive: true, force: true })
  })

  it('shares an anonymized pattern by default', () => {
    const shared = runFederatedCollab(
      { action: 'share', title: 'Cache with file lock', category: 'performance', description: 'thundering herd', solution: 'per-process lock + ttl', keywords: 'cache,lock' },
      cwd,
    )
    expect(shared).toContain('Anonymized: Yes')
    expect(loadStore(cwd).patterns[0]!.sourceProject).toBe('anonymous')
  })

  it('shares named when anonymize is false', () => {
    runFederatedCollab({ action: 'share', title: 'Named pattern', solution: 's', anonymize: false }, cwd)
    const store = loadStore(cwd)
    expect(store.patterns.some((p) => p.title === 'Named pattern' && p.sourceProject !== 'anonymous')).toBe(true)
  })

  it('receive imports sanitized inbound payloads from the inbox', () => {
    mkdirSync(join(cwd, '.elia', 'inbox'), { recursive: true })
    writeFileSync(
      join(cwd, '.elia', 'inbox', 'peer-1.json'),
      JSON.stringify({
        id: 'peer_p1',
        sourceProject: 'peer-node',
        timestamp: '2026-09-10T10:00:00.000Z',
        category: 'security',
        title: 'Validate redirect targets',
        description: 'open redirect risk',
        solution: 'allowlist + relative paths',
        keywords: ['redirect', 'security'],
        confidence: 0.95,
      }),
    )
    const result = runFederatedCollab({ action: 'receive' }, cwd)
    expect(result).toContain('Imported from inbox: 1')
    expect(loadStore(cwd).patterns.some((p) => p.id === 'peer_p1')).toBe(true)
  })

  it('receive skips malformed and duplicate payloads without crashing', () => {
    rmSync(join(cwd, '.elia', 'inbox', 'peer-1.json'), { force: true })
    writeFileSync(join(cwd, '.elia', 'inbox', 'bad.json'), '{ not json')
    writeFileSync(join(cwd, '.elia', 'inbox', 'dupe.json'), JSON.stringify({ id: 'peer_p1', title: 't', solution: 's', timestamp: '2026-09-10T10:00:00.000Z', category: 'testing' }))
    writeFileSync(join(cwd, '.elia', 'inbox', 'evil.json'), JSON.stringify({ evil: true }))
    const { imported, skipped } = receiveFromInbox(cwd)
    expect(imported.length).toBe(0)
    expect(skipped.length).toBe(3)
  })

  it('queries and filters the merged store', () => {
    const results = runFederatedCollab({ action: 'query', query: 'redirect' }, cwd)
    expect(results).toContain('Validate redirect targets')
  })

  it('stats report node id and sources', () => {
    const stats = runFederatedCollab({ action: 'stats' }, cwd)
    expect(stats).toContain('Node ID:')
    expect(stats).toContain('Unique sources:')
  })

  it('throws on unknown action and missing title', () => {
    expect(() => runFederatedCollab({ action: 'nope' }, cwd)).toThrow(/Unknown action/)
    expect(() => runFederatedCollab({ action: 'share' }, cwd)).toThrow(/title is required/)
  })
})