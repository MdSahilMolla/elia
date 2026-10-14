import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { writeFixtureCorpus } from './fixture.ts'
import { INSTALL_RECEIPT_FILE, installCorpus, type InstallReceipt } from './install.ts'
import { corpusDir } from './paths.ts'
import { validateCorpus } from './validate.ts'

/**
 * Installing is the one place a bad corpus could be mistaken for a good one, so
 * the tests pin both outcomes: a clean fixture installs and is provably valid,
 * and a corpus that fails a gate is reported FAILED with the gate named rather
 * than rounded up to success.
 */
const originalDir = process.env.ELIA_CYBERBRAIN_DIR
const cleanup: string[] = []

function temp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  cleanup.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of cleanup.splice(0)) rmSync(dir, { recursive: true, force: true })
  if (originalDir === undefined) delete process.env.ELIA_CYBERBRAIN_DIR
  else process.env.ELIA_CYBERBRAIN_DIR = originalDir
})

test('installCorpus copies a directory, validates it, and writes a receipt', async () => {
  const source = writeFixtureCorpus()
  cleanup.push(source.dir)
  const target = temp('elia-cyberbrain-install-')
  process.env.ELIA_CYBERBRAIN_DIR = target

  const summary = await installCorpus(source.dir)
  expect(summary).toContain('OK:')
  expect(summary).toContain('records=2')
  // Honesty: the summary states the manifest digest gate, not just "done".
  expect(summary).toContain('manifest sha256:')

  expect(corpusDir()).toBe(target)
  const receipt = JSON.parse(readFileSync(join(target, INSTALL_RECEIPT_FILE), 'utf8')) as InstallReceipt
  expect(receipt.ok).toBe(true)
  expect(receipt.source).toBe(source.dir)
  expect(receipt.recordCount).toBe(2)
  expect(receipt.chunkCount).toBe(20)
  expect(typeof receipt.installedAt).toBe('string')

  expect((await validateCorpus(target)).ok).toBe(true)
})

test('installCorpus reports FAILED, not success, when a gate fails', async () => {
  const seed = writeFixtureCorpus()
  cleanup.push(seed.dir)
  const badRecords = seed.records.map((record) => structuredClone({ ...record, artifact_types: [] }))
  const source = writeFixtureCorpus({ records: badRecords })
  cleanup.push(source.dir)
  const target = temp('elia-cyberbrain-install-bad-')
  process.env.ELIA_CYBERBRAIN_DIR = target

  const summary = await installCorpus(source.dir)
  expect(summary).toContain('FAILED')
  expect(summary).toContain('artifact types')

  // The files are kept for inspection, and the receipt records the failure.
  const receipt = JSON.parse(readFileSync(join(target, INSTALL_RECEIPT_FILE), 'utf8')) as InstallReceipt
  expect(receipt.ok).toBe(false)

  const validation = await validateCorpus(target)
  expect(validation.ok).toBe(false)
  expect(validation.checks.find((check) => check.name === 'artifact types')?.ok).toBe(false)
})
