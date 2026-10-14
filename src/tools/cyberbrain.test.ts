import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { writeFixtureCorpus } from '../cyberbrain/fixture.ts'
import { resetCorpusCache } from '../cyberbrain/store.ts'
import { cyberBrainTool } from './cyberbrain.ts'

/**
 * The tool is read-only over a fixture corpus, so every assertion runs with no
 * network and no real install. The corpus is pointed at by env var and the
 * store cache is dropped between tests, because the store keys its cache by
 * directory and a test that changes the env var must not read a stale corpus.
 */

const previousDir = process.env.ELIA_CYBERBRAIN_DIR
const fixture = writeFixtureCorpus()
process.env.ELIA_CYBERBRAIN_DIR = fixture.dir

beforeEach(() => {
  resetCorpusCache()
})

afterAll(() => {
  resetCorpusCache()
  if (previousDir === undefined) delete process.env.ELIA_CYBERBRAIN_DIR
  else process.env.ELIA_CYBERBRAIN_DIR = previousDir
})

describe('the tool surface', () => {
  test('is named cyberbrain and declares the action and chunkType enums', () => {
    expect(cyberBrainTool.name).toBe('cyberbrain')
    expect(cyberBrainTool.input_schema.properties.action).toMatchObject({ type: 'string', enum: ['search', 'open', 'taxonomy', 'stats'] })
    expect(cyberBrainTool.input_schema.properties.chunkType).toMatchObject({ type: 'string' })
  })
})

describe('search', () => {
  test('returns a hit with the expected category and an openable record ref', async () => {
    const out = await cyberBrainTool.execute({ action: 'search', query: 'ret2libc' })
    expect(out).toContain('CyberBrain search')
    expect(out).toContain('[exploitation] pwn')
    expect(out).toContain('[open: record:r_pwn1]')
  })

  test('a filter narrows the hits to one category', async () => {
    const out = await cyberBrainTool.execute({ action: 'search', query: 'ret2libc', category: 'web' })
    expect(out).toContain('No CyberBrain chunk matched')
    expect(out).not.toContain('[open: record:')
  })

  test('an unknown chunkType is a real mistake, not silently ignored', async () => {
    await expect(cyberBrainTool.execute({ action: 'search', query: 'x', chunkType: 'nope' })).rejects.toThrow(/chunkType must be one of/)
  })
})

describe('open', () => {
  test('resolves a record: ref to the rendered writeup', async () => {
    const out = await cyberBrainTool.execute({ action: 'open', ref: 'record:r_pwn1' })
    expect(out).toContain('# ret2libc on pwn challenge')
    expect(out).toContain('- id: r_pwn1')
    expect(out).toContain('## Remediation')
  })

  test('a missing ref asks for one instead of throwing', async () => {
    const out = await cyberBrainTool.execute({ action: 'open' })
    expect(out).toContain('needs a ref')
  })
})

describe('taxonomy and stats', () => {
  test('taxonomy lists each category with a count and a coverage note', async () => {
    const out = await cyberBrainTool.execute({ action: 'taxonomy' })
    expect(out).toContain('- pwn: 1')
    expect(out).toContain('- web: 1')
    expect(out).toContain('sample, not a census')
  })

  test('stats reports the corpus counts and the thin categories', async () => {
    const out = await cyberBrainTool.execute({ action: 'stats' })
    expect(out).toContain('- records: 2')
    expect(out).toContain('- chunks: 20')
    expect(out).toContain('- categories: 2')
    expect(out).toContain('- distinct vulnerabilities: 2')
    expect(out).toContain('Thin categories')
  })
})

describe('a corpus that was never installed', () => {
  test('yields an honest not-installed message naming the directory', async () => {
    const absent = join(tmpdir(), 'elia-cyberbrain-absent-test')
    process.env.ELIA_CYBERBRAIN_DIR = absent
    resetCorpusCache()
    try {
      const out = await cyberBrainTool.execute({ action: 'search', query: 'anything' })
      expect(out).toContain('not installed')
      expect(out).toContain(absent)
      expect(out).toContain('elia cyberbrain install')
    } finally {
      process.env.ELIA_CYBERBRAIN_DIR = fixture.dir
      resetCorpusCache()
    }
  })
})
