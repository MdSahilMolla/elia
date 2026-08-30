import { expect, test } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { bumpBrainConfirmed, bumpBrainRecalled, loadRelevance, relevanceBoost } from './relevance.ts'

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
