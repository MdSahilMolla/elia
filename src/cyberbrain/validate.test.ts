import { afterAll, afterEach, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { writeFixtureCorpus, type FixtureCorpus, type FixtureOptions } from './fixture.ts'
import type { CyberRecord, ValidationCheck, ValidationReceipt } from './types.ts'
import { formatReceipt, validateCorpus } from './validate.ts'

const seed = writeFixtureCorpus()
afterAll(() => rmSync(seed.dir, { recursive: true, force: true }))

const created: string[] = []

function fixture(options?: FixtureOptions): FixtureCorpus {
  const corpus = writeFixtureCorpus(options)
  created.push(corpus.dir)
  return corpus
}

afterEach(() => {
  for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** Deep-copies the seed records so each test can corrupt one without touching the next. */
function mutatedRecords(mutate: (records: CyberRecord[]) => void): CyberRecord[] {
  const records = seed.records.map((record) => structuredClone(record))
  mutate(records)
  return records
}

function named(receipt: ValidationReceipt, name: string): ValidationCheck {
  const found = receipt.checks.find((item) => item.name === name)
  if (!found) throw new Error(`no check named "${name}" in ${receipt.checks.map((item) => item.name).join(', ')}`)
  return found
}

test('the fixture corpus passes every gate', async () => {
  const corpus = fixture()
  const receipt = await validateCorpus(corpus.dir)
  expect(receipt.ok).toBe(true)
  expect(receipt.checks.filter((item) => !item.ok)).toEqual([])
  expect(receipt.recordCount).toBe(2)
  expect(receipt.chunkCount).toBe(20)
  expect(receipt.manifestRecordCount).toBe(2)
  expect(receipt.manifestChunkCount).toBe(20)
  expect(named(receipt, 'coverage keys').detail).toContain('skipped')
  expect(named(receipt, 'manifest sha256').detail).toContain('skipped')
  expect(named(receipt, 'manifest counts').detail).toContain('match actual')
})

test('formatReceipt prints one PASS/FAIL line per check with its detail', async () => {
  const corpus = fixture()
  const receipt = await validateCorpus(corpus.dir)
  const lines = formatReceipt(receipt).split('\n')
  const verdicts = lines.filter((line) => line.startsWith('PASS') || line.startsWith('FAIL'))
  expect(verdicts).toHaveLength(receipt.checks.length)
  expect(verdicts.every((line) => /: .+/.test(line))).toBe(true)
  expect(formatReceipt(receipt)).toContain('RESULT: OK')

  const broken = fixture({ records: mutatedRecords((records) => { records[0]!.artifact_types = [] }) })
  const failed = formatReceipt(await validateCorpus(broken.dir))
  expect(failed).toContain('FAIL  artifact types:')
  expect(failed).toContain('RESULT: FAILED')
})

test('a record with empty artifact_types fails the artifact types gate', async () => {
  const corpus = fixture({ records: mutatedRecords((records) => { records[0]!.artifact_types = [] }) })
  const receipt = await validateCorpus(corpus.dir)
  expect(receipt.ok).toBe(false)
  expect(named(receipt, 'artifact types').ok).toBe(false)
  expect(named(receipt, 'artifact types').detail).toContain('1 of 2')
  expect(named(receipt, 'chunk types').ok).toBe(true)
})

test('a taxonomy file with case-variant keys fails the taxonomy keys gate', async () => {
  const corpus = fixture()
  writeFileSync(
    join(corpus.dir, 'taxonomy', 'techniques.json'),
    JSON.stringify(
      {
        'Insecure Deserialization': { count: 3 },
        'Insecure deserialization': { count: 4 },
        'Buffer Over-read': { count: 1 },
        'Buffer Over-Read': { count: 2 },
      },
      null,
      1,
    ),
  )
  const receipt = await validateCorpus(corpus.dir)
  expect(receipt.ok).toBe(false)
  const gate = named(receipt, 'taxonomy keys')
  expect(gate.ok).toBe(false)
  expect(gate.detail).toContain('techniques.json')
  expect(gate.detail).toContain('2 key group(s) collide')
  expect(named(receipt, 'coverage keys').ok).toBe(true)
})

test('coverage.json with case-variant keys fails the coverage keys gate', async () => {
  const corpus = fixture()
  writeFileSync(join(corpus.dir, 'coverage.json'), JSON.stringify({ 'Buffer Over-read': { count: 1 }, 'Buffer Over-Read': { count: 2 } }, null, 1))
  const receipt = await validateCorpus(corpus.dir)
  expect(receipt.ok).toBe(false)
  expect(named(receipt, 'coverage keys').ok).toBe(false)
})

test('a manifest whose record_count is wrong fails the manifest counts gate', async () => {
  const corpus = fixture()
  const manifestPath = join(corpus.dir, 'manifest.json')
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>
  manifest.record_count = 99
  writeFileSync(manifestPath, JSON.stringify(manifest))
  const receipt = await validateCorpus(corpus.dir)
  expect(receipt.ok).toBe(false)
  expect(named(receipt, 'manifest counts').ok).toBe(false)
  expect(named(receipt, 'manifest counts').detail).toContain('record_count 99')
  expect(receipt.manifestRecordCount).toBe(99)
})

test('a chunk with an unknown chunk_type fails the chunk types gate', async () => {
  const corpus = fixture()
  const chunkPath = join(corpus.dir, 'chunks', 'chunks.jsonl')
  const lines = readFileSync(chunkPath, 'utf8').trim().split('\n')
  const first = JSON.parse(lines[0]!) as Record<string, unknown>
  first.chunk_type = 'made_up_type'
  lines[0] = JSON.stringify(first)
  writeFileSync(chunkPath, lines.join('\n') + '\n')
  const receipt = await validateCorpus(corpus.dir)
  expect(receipt.ok).toBe(false)
  expect(named(receipt, 'chunk types').ok).toBe(false)
  expect(named(receipt, 'chunk record references').ok).toBe(true)
})

test('a chunk pointing at a record that does not exist fails the record references gate', async () => {
  const corpus = fixture()
  const chunkPath = join(corpus.dir, 'chunks', 'chunks.jsonl')
  const lines = readFileSync(chunkPath, 'utf8').trim().split('\n')
  const first = JSON.parse(lines[0]!) as Record<string, unknown>
  first.record_id = 'r_does_not_exist'
  lines[0] = JSON.stringify(first)
  writeFileSync(chunkPath, lines.join('\n') + '\n')
  const receipt = await validateCorpus(corpus.dir)
  expect(receipt.ok).toBe(false)
  expect(named(receipt, 'chunk record references').ok).toBe(false)
})

test('the sha gate verifies digests when manifest.file_sha256 is present', async () => {
  const corpus = fixture()
  const manifestPath = join(corpus.dir, 'manifest.json')
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>
  const recordsPath = join(corpus.dir, 'records.jsonl')
  const digest = createHash('sha256').update(readFileSync(recordsPath)).digest('hex')

  manifest.file_sha256 = { 'records.jsonl': '0'.repeat(64) }
  writeFileSync(manifestPath, JSON.stringify(manifest))
  expect(named(await validateCorpus(corpus.dir), 'manifest sha256').ok).toBe(false)

  manifest.file_sha256 = { 'records.jsonl': digest, 'chunks/chunks.jsonl': digest }
  writeFileSync(manifestPath, JSON.stringify(manifest))
  const receipt = await validateCorpus(corpus.dir)
  expect(named(receipt, 'manifest sha256').ok).toBe(false)
  expect(named(receipt, 'manifest sha256').detail).toContain('chunks/chunks.jsonl')

  manifest.file_sha256 = { 'records.jsonl': digest }
  writeFileSync(manifestPath, JSON.stringify(manifest))
  const fixed = await validateCorpus(corpus.dir)
  expect(named(fixed, 'manifest sha256').ok).toBe(true)
  expect(fixed.ok).toBe(true)
})

test('a vulnerability outside the taxonomy fails the vocabulary gate and counts the offenders', async () => {
  const corpus = fixture()
  writeFileSync(join(corpus.dir, 'taxonomy', 'vulnerabilities.json'), JSON.stringify({ 'Buffer Overflow': { count: 1 } }, null, 1))
  const receipt = await validateCorpus(corpus.dir)
  expect(receipt.ok).toBe(false)
  const gate = named(receipt, 'vulnerability vocabulary')
  expect(gate.ok).toBe(false)
  expect(gate.detail).toContain('1 record(s)')
  expect(gate.detail).toContain('1 keys')
})

test('a record whose remediation has no verification fails the remediation gate', async () => {
  const corpus = fixture({
    records: mutatedRecords((records) => {
      records[0]!.remediation[0]!.verification = '   '
    }),
  })
  const receipt = await validateCorpus(corpus.dir)
  expect(receipt.ok).toBe(false)
  expect(named(receipt, 'remediation verification').ok).toBe(false)
  expect(named(receipt, 'failure modes').ok).toBe(true)
})

test('a record with no failure_modes fails the failure modes gate', async () => {
  const corpus = fixture({
    records: mutatedRecords((records) => {
      records[0]!.failure_modes = []
    }),
  })
  const receipt = await validateCorpus(corpus.dir)
  expect(receipt.ok).toBe(false)
  expect(named(receipt, 'failure modes').ok).toBe(false)
  expect(named(receipt, 'artifact types').ok).toBe(true)
})

test('a missing records.jsonl fails the records gate instead of being skipped', async () => {
  const corpus = fixture()
  rmSync(join(corpus.dir, 'records.jsonl'))
  const receipt = await validateCorpus(corpus.dir)
  expect(receipt.ok).toBe(false)
  expect(named(receipt, 'records.jsonl parses').ok).toBe(false)
})

test('absent optional files are skipped, not failed', async () => {
  const corpus = fixture({ noManifest: true, noTaxonomy: true })
  const receipt = await validateCorpus(corpus.dir)
  expect(receipt.ok).toBe(true)
  expect(named(receipt, 'manifest counts').detail).toContain('skipped')
  expect(named(receipt, 'manifest sha256').detail).toContain('skipped')
  expect(named(receipt, 'taxonomy keys').detail).toContain('skipped')
  expect(named(receipt, 'vulnerability vocabulary').detail).toContain('skipped')
  expect(named(receipt, 'coverage keys').detail).toContain('skipped')
  expect(receipt.manifestRecordCount).toBeUndefined()
})
