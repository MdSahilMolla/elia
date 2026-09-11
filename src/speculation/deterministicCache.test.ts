import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { withAgentIdentity } from '../autonomy/context.ts'
import { createDeterministicReadCacheForTests, readMemo } from './deterministicCache.ts'
import { runAgentLoop } from '../agentLoop.ts'
import { readFileTool } from '../tools/readFile.ts'
import { editFileTool } from '../tools/editFile.ts'
import { ZERO_USAGE } from '../usage.ts'
import type { Provider } from '../providers/types.ts'

let dir: string
const original = process.env.ELIA_NO_READ_MEMO

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'elia-detcache-'))
  delete process.env.ELIA_NO_READ_MEMO
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
  if (original === undefined) delete process.env.ELIA_NO_READ_MEMO
  else process.env.ELIA_NO_READ_MEMO = original
})

function inWorkspace<T>(fn: () => T): Promise<T> {
  return withAgentIdentity({ name: 'test', role: 'lead', cwd: dir }, async () => fn())
}

test('a put is returned by a later get for the unchanged file', async () => {
  const cache = createDeterministicReadCacheForTests()
  writeFileSync(join(dir, 'a.ts'), 'const x = 1\n')
  await inWorkspace(() => {
    cache.put({ path: 'a.ts' }, 'RENDERED A')
    expect(cache.get({ path: 'a.ts' })).toBe('RENDERED A')
  })
  expect(cache.stats().hits).toBe(1)
})

test('a file whose size changed on disk is a miss', async () => {
  const cache = createDeterministicReadCacheForTests()
  const file = join(dir, 'a.ts')
  writeFileSync(file, 'const x = 1\n')
  await inWorkspace(() => {
    cache.put({ path: 'a.ts' }, 'STALE')
    writeFileSync(file, 'const x = 1\nconst y = 2\n') // size changes
    expect(cache.get({ path: 'a.ts' })).toBeUndefined()
  })
})

test('a same-size rewrite that bumps mtime is still a miss', async () => {
  const cache = createDeterministicReadCacheForTests()
  const file = join(dir, 'a.ts')
  writeFileSync(file, 'return 2\n')
  await inWorkspace(() => cache.put({ path: 'a.ts' }, 'STALE return 2'))
  await Bun.sleep(12)
  writeFileSync(file, 'return 3\n') // identical length, later mtime
  await inWorkspace(() => expect(cache.get({ path: 'a.ts' })).toBeUndefined())
})

test('invalidatePath drops the entry even when the file on disk is byte-identical', async () => {
  const cache = createDeterministicReadCacheForTests()
  const file = join(dir, 'a.ts')
  writeFileSync(file, 'return 2\n')
  await inWorkspace(() => {
    cache.put({ path: 'a.ts' }, 'cached')
    cache.invalidatePath(join(dir, 'a.ts'))
    expect(cache.get({ path: 'a.ts' })).toBeUndefined()
  })
})

test('offset/limit windows are cached independently', async () => {
  const cache = createDeterministicReadCacheForTests()
  writeFileSync(join(dir, 'a.ts'), 'x\n')
  await inWorkspace(() => {
    cache.put({ path: 'a.ts', offset: 1, limit: 10 }, 'WINDOW 1-10')
    cache.put({ path: 'a.ts', offset: 20, limit: 10 }, 'WINDOW 20-30')
    expect(cache.get({ path: 'a.ts', offset: 1, limit: 10 })).toBe('WINDOW 1-10')
    expect(cache.get({ path: 'a.ts', offset: 20, limit: 10 })).toBe('WINDOW 20-30')
    expect(cache.get({ path: 'a.ts' })).toBeUndefined()
  })
})

test('ELIA_NO_READ_MEMO=1 turns the cache into a no-op', async () => {
  const cache = createDeterministicReadCacheForTests()
  writeFileSync(join(dir, 'a.ts'), 'x\n')
  process.env.ELIA_NO_READ_MEMO = '1'
  await inWorkspace(() => {
    cache.put({ path: 'a.ts' }, 'cached')
    expect(cache.get({ path: 'a.ts' })).toBeUndefined()
  })
})

test('two working directories with the same relative path and a coinciding mtime:size stamp never share a cache slot', async () => {
  const cache = createDeterministicReadCacheForTests()
  const dirA = mkdtempSync(join(tmpdir(), 'elia-detcache-worktree-a-'))
  const dirB = mkdtempSync(join(tmpdir(), 'elia-detcache-worktree-b-'))
  try {
    const fileA = join(dirA, 'a.ts')
    const fileB = join(dirB, 'a.ts')
    writeFileSync(fileA, 'export const n = 1\n') // identical byte length in both worktrees
    writeFileSync(fileB, 'export const n = 2\n')

    // Force the two files' mtime:size staleness stamps to coincide, simulating
    // a fresh `git worktree add` from the same commit at the same instant.
    const sharedMtime = statSync(fileA).mtime
    utimesSync(fileB, sharedMtime, sharedMtime)
    expect(statSync(fileA).size).toBe(statSync(fileB).size)

    await withAgentIdentity({ name: 'test', role: 'lead', cwd: dirA }, async () => {
      cache.put({ path: 'a.ts' }, 'RENDERED A')
    })

    // Worktree B never wrote this entry — despite the coinciding stamp, it must
    // be a miss, not a stale read of worktree A's cached result.
    await withAgentIdentity({ name: 'test', role: 'lead', cwd: dirB }, async () => {
      expect(cache.get({ path: 'a.ts' })).toBeUndefined()
    })

    // Worktree A's own entry is unaffected.
    await withAgentIdentity({ name: 'test', role: 'lead', cwd: dirA }, async () => {
      expect(cache.get({ path: 'a.ts' })).toBe('RENDERED A')
    })
  } finally {
    rmSync(dirA, { recursive: true, force: true })
    rmSync(dirB, { recursive: true, force: true })
  }
})

test('a file that does not exist is never cached', async () => {
  const cache = createDeterministicReadCacheForTests()
  await inWorkspace(() => {
    cache.put({ path: 'ghost.ts' }, 'nope')
    expect(cache.get({ path: 'ghost.ts' })).toBeUndefined()
  })
  expect(cache.stats().size).toBe(0)
})

/** Provider that replays a fixed list of assistant turns, one per streamTurn call. */
function scripted(turns: ContentBlockList[]): Provider {
  let call = 0
  return {
    async streamTurn(params) {
      const content = turns[Math.min(call++, turns.length - 1)]!
      for (const block of content) if (block.type === 'text') params.onText(block.text)
      return { content, usage: ZERO_USAGE }
    },
  }
}
type ContentBlockList = Array<{ type: 'text'; text: string } | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }>

test('the loop serves an unchanged re-read from the memo, and re-reads fresh after an edit', async () => {
  readMemo.clear()
  const file = join(dir, 'target.ts')
  writeFileSync(file, 'export const n = 2\n')

  const provider = scripted([
    [{ type: 'tool_use', id: 't1', name: 'read_file', input: { path: 'target.ts' } }],
    [{ type: 'tool_use', id: 't2', name: 'read_file', input: { path: 'target.ts' } }], // unchanged -> memo hit
    [{ type: 'tool_use', id: 't3', name: 'edit_file', input: { path: 'target.ts', old_string: 'n = 2', new_string: 'n = 3' } }],
    [{ type: 'tool_use', id: 't4', name: 'read_file', input: { path: 'target.ts' } }], // after edit -> fresh
    [{ type: 'text', text: 'done' }],
  ])

  await withAgentIdentity({ name: 'test', role: 'lead', cwd: dir }, () =>
    runAgentLoop({
      messages: [{ role: 'user', content: [{ type: 'text', text: 'go' }] }],
      systemPrompt: 'test',
      providerName: 'anthropic',
      model: 'memo-test',
      useAnimation: false,
      verbose: false,
      tools: [readFileTool, editFileTool],
      provider,
      maxSteps: 10,
    }),
  )

  const stats = readMemo.stats()
  expect(stats.hits).toBe(1) // the turn-2 re-read
  // turn-4 read after the edit missed (entry was flushed on edit_file), then re-cached.
  expect(stats.misses).toBeGreaterThanOrEqual(1)
  expect(await inWorkspace(() => readMemo.get({ path: 'target.ts' }))).toContain('n = 3')
})
