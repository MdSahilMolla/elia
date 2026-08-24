import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ChatMessage, ContentBlock } from './providers/types.ts'

// config.ts resolves a provider at import time and fails fast without a key —
// set a placeholder before importing so the module loads; tests stub the fast
// tier's provider below so no real network call ever happens.
process.env.ANTHROPIC_API_KEY ??= 'test-key-for-ledger-test'

const { config } = await import('./config.ts')
const {
  loadLedger,
  countEpisodes,
  bumpRecall,
  bumpConfirmed,
  setActiveLedgerSession,
  getActiveLedgerSession,
  markRecalled,
  noteToolUse,
  resetPendingRecalls,
  flushPendingConfirmations,
  archiveEpisode,
} = await import('./ledger.ts')

let testDir: string

beforeAll(() => {
  testDir = mkdtempSync(join(tmpdir(), 'elia-ledger-test-'))
})

afterAll(() => {
  rmSync(testDir, { recursive: true, force: true })
})

afterEach(() => {
  setActiveLedgerSession(undefined)
  resetPendingRecalls()
})

function userText(text: string): ChatMessage {
  return { role: 'user', content: [{ type: 'text', text }] }
}

function stubProvider(response: string) {
  config.tiers.fast.provider = {
    async streamTurn({ onText }) {
      onText(response)
      return {
        content: [{ type: 'text', text: response }] as ContentBlock[],
        usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
      }
    },
  }
}

test('setActiveLedgerSession/getActiveLedgerSession round-trip', () => {
  expect(getActiveLedgerSession()).toBeUndefined()
  setActiveLedgerSession({ id: 'sess-x', turn: 3 })
  expect(getActiveLedgerSession()).toEqual({ id: 'sess-x', turn: 3 })
})

test('loadLedger returns an empty array for an unknown session', async () => {
  expect(await loadLedger('does-not-exist', testDir)).toEqual([])
})

test('archiveEpisode with no active session returns a summary but persists nothing', async () => {
  stubProvider('{"summary":"did stuff","decisions":["chose X"],"filesTouched":["a.ts"],"symbols":["foo"],"openThreads":["bar"]}')
  const summary = await archiveEpisode([userText('hello')], testDir)
  expect(summary).toBe('did stuff')
  expect(await loadLedger('no-session', testDir)).toEqual([])
})

test('archiveEpisode with an active session persists a structured episode', async () => {
  stubProvider('{"summary":"fixed the bug","decisions":["used a cache"],"filesTouched":["src/x.ts"],"symbols":["run"],"openThreads":["tests"]}')
  setActiveLedgerSession({ id: 'sess-1', turn: 2 })

  const summary = await archiveEpisode([userText('do the thing')], testDir)
  expect(summary).toBe('fixed the bug')

  const records = await loadLedger('sess-1', testDir)
  expect(records.length).toBe(1)
  expect(records[0]).toMatchObject({
    turn: 2,
    summary: 'fixed the bug',
    decisions: ['used a cache'],
    filesTouched: ['src/x.ts'],
    symbols: ['run'],
    openThreads: ['tests'],
    recallCount: 0,
    confirmedUseCount: 0,
  })
})

test('archiveEpisode falls back to raw text as the summary when the response is not JSON', async () => {
  stubProvider('plain prose summary, not json')
  setActiveLedgerSession({ id: 'sess-2', turn: 0 })

  const summary = await archiveEpisode([userText('hi')], testDir)
  expect(summary).toBe('plain prose summary, not json')

  const records = await loadLedger('sess-2', testDir)
  expect(records[0]).toMatchObject({ summary: 'plain prose summary, not json', decisions: [], filesTouched: [] })
})

test('archiveEpisode returns undefined and persists nothing when the provider fails', async () => {
  config.tiers.fast.provider = {
    async streamTurn() {
      throw new Error('provider down')
    },
  }
  setActiveLedgerSession({ id: 'sess-3', turn: 0 })

  const summary = await archiveEpisode([userText('hi')], testDir)
  expect(summary).toBeUndefined()
  expect(await loadLedger('sess-3', testDir)).toEqual([])
})

test('bumpRecall and bumpConfirmed fold onto the matching episode by id', async () => {
  stubProvider('{"summary":"episode one","decisions":[],"filesTouched":["f.ts"],"symbols":[],"openThreads":[]}')
  setActiveLedgerSession({ id: 'sess-4', turn: 0 })
  await archiveEpisode([userText('hi')], testDir)

  const [episode] = await loadLedger('sess-4', testDir)
  expect(episode).toBeDefined()

  await bumpRecall('sess-4', [episode!.id], testDir)
  await bumpRecall('sess-4', [episode!.id], testDir)
  await bumpConfirmed('sess-4', episode!.id, testDir)

  const updated = await loadLedger('sess-4', testDir)
  expect(updated[0]).toMatchObject({ recallCount: 2, confirmedUseCount: 1 })
  expect(await countEpisodes('sess-4', testDir)).toBe(1)
})

test('a malformed line in the ledger file is skipped without breaking the rest', async () => {
  stubProvider('{"summary":"good episode","decisions":[],"filesTouched":[],"symbols":[],"openThreads":[]}')
  setActiveLedgerSession({ id: 'sess-5', turn: 0 })
  await archiveEpisode([userText('hi')], testDir)

  await Bun.write(join(testDir, 'sess-5.ledger.jsonl'), `${await Bun.file(join(testDir, 'sess-5.ledger.jsonl')).text()}not json at all\n`)

  const records = await loadLedger('sess-5', testDir)
  expect(records.length).toBe(1)
  expect(records[0]!.summary).toBe('good episode')
})

test('markRecalled + noteToolUse marks a confirmed use when a recalled file is touched again', async () => {
  stubProvider('{"summary":"touched thing.ts","decisions":[],"filesTouched":["src/thing.ts"],"symbols":[],"openThreads":[]}')
  setActiveLedgerSession({ id: 'sess-6', turn: 0, dir: testDir })
  await archiveEpisode([userText('hi')], testDir)
  const [episode] = await loadLedger('sess-6', testDir)
  expect(episode).toBeDefined()

  markRecalled([episode!])
  noteToolUse({ path: 'src/thing.ts' })
  await flushPendingConfirmations()

  const records = await loadLedger('sess-6', testDir)
  expect(records[0]?.confirmedUseCount).toBe(1)
})

test('noteToolUse is a no-op with nothing pending', () => {
  expect(() => noteToolUse({ path: 'whatever.ts' })).not.toThrow()
})
