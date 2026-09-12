import { expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { bumpBrainConfirmed, bumpBrainRecalled, compactRelevance, loadRelevance, relevanceBoost } from './relevance.ts'

function tmpFile(): string {
  return join(mkdtempSync(join(tmpdir(), 'elia-rel-')), 'relevance.jsonl')
}

test('recalled and confirmed events fold into counts on load', () => {
  const path = tmpFile()
  bumpBrainRecalled(['lesson:a', 'lesson:b'], path)
  bumpBrainRecalled(['lesson:a'], path)
  bumpBrainConfirmed('lesson:a', path)

  const counts = loadRelevance(path)
  expect(counts.get('lesson:a')).toEqual({ recalled: 2, confirmed: 1 })
  expect(counts.get('lesson:b')).toEqual({ recalled: 1, confirmed: 0 })
})

test('relevanceBoost rewards a confirmed item more than a merely recalled one', () => {
  const counts = new Map([
    ['recalled-only', { recalled: 3, confirmed: 0 }],
    ['confirmed', { recalled: 3, confirmed: 3 }],
  ])
  expect(relevanceBoost(counts, 'confirmed')).toBeGreaterThan(relevanceBoost(counts, 'recalled-only'))
  expect(relevanceBoost(counts, 'unknown-key')).toBe(1)
})

test('loadRelevance on a missing file is empty', () => {
  expect(loadRelevance(join(tmpdir(), 'nope-elia', 'r.jsonl')).size).toBe(0)
})

test('compactRelevance folds repeated per-hit lines into one row per (key, kind) without losing counts', () => {
  const path = tmpFile()
  for (let i = 0; i < 10; i += 1) bumpBrainRecalled(['lesson:a'], path)
  bumpBrainConfirmed('lesson:a', path)
  bumpBrainConfirmed('lesson:a', path)
  bumpBrainRecalled(['lesson:b'], path)

  const before = loadRelevance(path)
  const linesBefore = readFileSync(path, 'utf8').split('\n').filter(Boolean).length
  expect(linesBefore).toBe(13)

  const result = compactRelevance(path)
  expect(result.linesBefore).toBe(13)
  // One row per (key, kind) that actually has hits: a/recalled, a/confirmed, b/recalled.
  expect(result.rowsAfter).toBe(3)

  // The folded counts must exactly match what loadRelevance saw before compaction.
  const after = loadRelevance(path)
  expect(after.get('lesson:a')).toEqual(before.get('lesson:a'))
  expect(after.get('lesson:b')).toEqual(before.get('lesson:b'))
  expect(after.get('lesson:a')).toEqual({ recalled: 10, confirmed: 2 })
})

test('compactRelevance on a missing file is a no-op', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'elia-rel-')), 'missing.jsonl')
  expect(compactRelevance(path)).toEqual({ linesBefore: 0, rowsAfter: 0 })
})

test('append triggers compaction once the file grows past the size threshold, bounding unbounded growth', () => {
  const path = tmpFile()
  // Seed a file already well over the 512KB compaction threshold with repeat
  // hits on one key, one line per hit — exactly the unbounded-growth shape the
  // bug reported (relevance.jsonl growing one line per brain-search hit forever).
  const lines: string[] = []
  for (let i = 0; i < 15_000; i += 1) lines.push(JSON.stringify({ key: 'lesson:hot', kind: 'recalled', at: i }))
  writeFileSync(path, `${lines.join('\n')}\n`)
  const before = statSync(path).size
  expect(before).toBeGreaterThan(512 * 1024)

  // The next bump's opportunistic size check should trigger a compaction pass
  // before writing its own new line.
  bumpBrainRecalled(['lesson:cold'], path)

  // Folded to a couple of rows instead of thousands of individual hit lines,
  // while the counts survive the fold.
  const counts = loadRelevance(path)
  expect(counts.get('lesson:hot')?.recalled).toBe(15_000)
  expect(counts.get('lesson:cold')?.recalled).toBe(1)
  expect(statSync(path).size).toBeLessThan(before)
})
