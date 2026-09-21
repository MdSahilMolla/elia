import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Tool } from '../tools/types.ts'

process.env.ANTHROPIC_API_KEY ??= 'test-key-for-isolation-test'

const { diffDigest, EVALUATOR_FILES, isolationChecks, redactHeldOut, sealedReadTools } = await import('./isolation.ts')
const { isImmutablePath } = await import('../evolve/sandbox.ts')

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'elia-vde-isolation-'))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

const echo = (name: string): Tool => ({
  name,
  description: name,
  input_schema: { type: 'object', properties: {} },
  async execute(input) {
    return String(input.path ?? input.cwd)
  },
})

test('I2: the proposer cannot read past its sandbox and the evidence it was handed', async () => {
  const sandbox = join(dir, 'sandbox')
  const kept = join(dir, 'kept-run')
  mkdirSync(sandbox)
  mkdirSync(kept)
  const [read, list, grep] = sealedReadTools([echo('read_file'), echo('list_files'), echo('grep'), echo('write_file')], [sandbox, kept])
  expect([read, list, grep].map((tool) => tool!.name)).toEqual(['read_file', 'list_files', 'grep']) // write_file never passes through

  expect(await read!.execute({ path: 'src/evolve/suite.ts' })).toBe(join(sandbox, 'src', 'evolve', 'suite.ts'))
  expect(await read!.execute({ path: join(kept, 'out.txt') })).toBe(join(kept, 'out.txt'))
  expect(await list!.execute({})).toBe(sandbox)
  // The ledger and bench history live outside both roots.
  await expect(read!.execute({ path: join(dir, '.evolution', 'ledger.jsonl') })).rejects.toThrow('outside what the proposer may read')
  await expect(read!.execute({ path: '../.elia/bench/history.ndjson' })).rejects.toThrow('outside')
  await expect(grep!.execute({ path: join(sandbox, '..') })).rejects.toThrow('outside')
})

test('I2: held-out task ids never reach the proposer through the ledger summary', () => {
  const ledger = '- gen 3: tighten edits → rejected: regressed on hist-042, hist-04 — a task that passed before now fails'
  const redacted = redactHeldOut(ledger, ['hist-04', 'hist-042'])
  expect(redacted).not.toContain('hist-04')
  expect(redacted).toContain('regressed on a held-out task, a held-out task')
  expect(redactHeldOut(ledger, [])).toBe(ledger)
})

test('I3: the diff digest is about content, and a deletion is not an empty file', () => {
  mkdirSync(join(dir, 'src'))
  writeFileSync(join(dir, 'src', 'a.ts'), 'one')
  const first = diffDigest(dir, ['src/a.ts'])
  expect(diffDigest(dir, ['src/a.ts'])).toBe(first)
  writeFileSync(join(dir, 'src', 'a.ts'), 'two')
  expect(diffDigest(dir, ['src/a.ts'])).not.toBe(first)
  writeFileSync(join(dir, 'src', 'a.ts'), '')
  const emptied = diffDigest(dir, ['src/a.ts'])
  rmSync(join(dir, 'src', 'a.ts'))
  expect(diffDigest(dir, ['src/a.ts'])).not.toBe(emptied)
})

test('I1: every evaluator, auditor and governor file is immutable to evolve candidates', () => {
  const mutable = EVALUATOR_FILES.filter((file) => !isImmutablePath(file))
  expect(mutable).toEqual([])
  expect(isImmutablePath('src/vde/acceptance.ts')).toBe(true)
  const checks = isolationChecks(isImmutablePath, false)
  expect(checks.find((check) => check.id === 'I1')!.ok).toBe(true)
  expect(checks.find((check) => check.id === 'I3')!.ok).toBe(false)
  expect(isolationChecks(() => false, true).find((check) => check.id === 'I1')!.evidence).toContain('could rewrite')
})
