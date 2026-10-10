import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { canonicalizeKeys } from './canonicalize.ts'
import { CORPUS_FILES } from './paths.ts'
import { CHUNK_TYPES, type CyberManifest, type ValidationCheck, type ValidationReceipt } from './types.ts'

/**
 * Fail-closed checks for a CyberBrain corpus on disk.
 *
 * The corpus is a scraped release asset, not code: nothing guarantees a chunk
 * still points at a record, that the manifest counts what shipped, or that the
 * taxonomy is free of the case-variant keys that make a strict parser reject
 * the file. Every gate below is a named {@link ValidationCheck} so a loader can
 * refuse a bad corpus and a human can read exactly which gate broke. Optional
 * files (manifest, coverage, taxonomy) are skipped when absent; the required
 * records/chunks JSONL are not.
 */

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function check(name: string, ok: boolean, detail: string): ValidationCheck {
  return { name, ok, detail }
}

async function exists(path: string): Promise<boolean> {
  try {
    await fs.stat(path)
    return true
  } catch {
    return false
  }
}

/** A required JSONL file: present, non-empty, and every non-blank line valid JSON. */
async function readJsonl(path: string): Promise<{ ok: boolean; detail: string; rows: unknown[] }> {
  let text: string
  try {
    text = await fs.readFile(path, 'utf8')
  } catch (error) {
    return { ok: false, detail: `unreadable: ${errorMessage(error)}`, rows: [] }
  }
  const lines = text.split(/\r?\n/).filter((line) => line.trim().length > 0)
  if (lines.length === 0) return { ok: false, detail: 'file is empty', rows: [] }

  const rows: unknown[] = []
  let firstBad: string | null = null
  for (const [index, line] of lines.entries()) {
    try {
      rows.push(JSON.parse(line))
    } catch (error) {
      firstBad ??= `line ${index + 1} does not parse: ${errorMessage(error)}`
    }
  }
  if (firstBad !== null) return { ok: false, detail: `${rows.length} of ${lines.length} line(s) parse; ${firstBad}`, rows }
  return { ok: true, detail: `${rows.length} line(s) parse`, rows }
}

/** A JSON file that must strict-parse into an object — JSON.parse collapses exact duplicate keys silently, so case-variant keys are caught afterwards by canonicalizeKeys, not by a parse error. */
async function readJsonObject(path: string): Promise<{ ok: boolean; detail: string; value: Record<string, unknown> | null }> {
  let text: string
  try {
    text = await fs.readFile(path, 'utf8')
  } catch (error) {
    return { ok: false, detail: `unreadable: ${errorMessage(error)}`, value: null }
  }
  try {
    const parsed: unknown = JSON.parse(text)
    if (!isPlainObject(parsed)) return { ok: false, detail: 'not a JSON object', value: null }
    return { ok: true, detail: 'parses', value: parsed }
  } catch (error) {
    return { ok: false, detail: `does not parse: ${errorMessage(error)}`, value: null }
  }
}

/** Strict-parses each file and rejects any whose top-level keys collide after canonicalization. */
async function checkKeyCollisions(files: { name: string; path: string }[], emptyDetail: string): Promise<{ ok: boolean; detail: string }> {
  if (files.length === 0) return { ok: true, detail: emptyDetail }
  const problems: string[] = []
  for (const file of files) {
    const read = await readJsonObject(file.path)
    if (!read.ok || read.value === null) {
      problems.push(`${file.name}: ${read.detail}`)
      continue
    }
    const { merged, collisions } = canonicalizeKeys(read.value)
    if (collisions.length > 0) {
      const shown = collisions.slice(0, 4).join(', ')
      problems.push(`${file.name}: ${merged.length} key group(s) collide (${shown}${collisions.length > 4 ? ', …' : ''})`)
    }
  }
  if (problems.length > 0) {
    const shown = problems.slice(0, 3).join('; ')
    return { ok: false, detail: problems.length > 3 ? `${shown}; +${problems.length - 3} more` : shown }
  }
  return { ok: true, detail: `${files.length} file(s) strict-parse with no colliding keys` }
}

async function checkDigests(dir: string, digests: Record<string, string> | undefined): Promise<ValidationCheck> {
  if (digests === undefined) return check(CHECK_NAMES.manifestDigests, true, 'no file_sha256 block — skipped')
  const entries = Object.entries(digests)
  if (entries.length === 0) return check(CHECK_NAMES.manifestDigests, true, 'file_sha256 lists no files')

  const problems: string[] = []
  for (const [relative, expected] of entries) {
    if (typeof expected !== 'string') {
      problems.push(`${relative}: digest is not a string`)
      continue
    }
    try {
      const actual = createHash('sha256').update(await fs.readFile(join(dir, relative))).digest('hex')
      if (actual !== expected.trim().toLowerCase()) problems.push(`${relative}: sha256 mismatch`)
    } catch (error) {
      problems.push(`${relative}: ${errorMessage(error)}`)
    }
  }
  if (problems.length > 0) {
    const shown = problems.slice(0, 3).join('; ')
    return check(CHECK_NAMES.manifestDigests, false, problems.length > 3 ? `${shown}; +${problems.length - 3} more` : shown)
  }
  return check(CHECK_NAMES.manifestDigests, true, `${entries.length} file digest(s) match`)
}

const CHECK_NAMES = {
  records: 'records.jsonl parses',
  chunks: 'chunks.jsonl parses',
  recordRefs: 'chunk record references',
  chunkTypes: 'chunk types',
  manifestCounts: 'manifest counts',
  manifestDigests: 'manifest sha256',
  taxonomyKeys: 'taxonomy keys',
  coverageKeys: 'coverage keys',
  vulnerabilityVocab: 'vulnerability vocabulary',
  artifactTypes: 'artifact types',
  remediationVerification: 'remediation verification',
  failureModes: 'failure modes',
} as const

/** Rows that are not objects fail every row-shaped gate below rather than being skipped. */
function countFailing(rows: unknown[], ok: (row: Record<string, unknown>) => boolean): number {
  return rows.filter((row) => !(isPlainObject(row) && ok(row))).length
}

export async function validateCorpus(dir: string): Promise<ValidationReceipt> {
  const checks: ValidationCheck[] = []

  const records = await readJsonl(join(dir, CORPUS_FILES.records))
  checks.push(check(CHECK_NAMES.records, records.ok, records.detail))
  const recordRows = records.rows

  const chunks = await readJsonl(join(dir, CORPUS_FILES.chunks))
  checks.push(check(CHECK_NAMES.chunks, chunks.ok, chunks.detail))
  const chunkRows = chunks.rows

  const recordIds = new Set(recordRows.filter(isPlainObject).map((row) => row.id))
  if (chunkRows.length === 0) {
    checks.push(check(CHECK_NAMES.recordRefs, false, 'no parsed chunk line to resolve'))
  } else {
    const unresolved = countFailing(chunkRows, (row) => recordIds.has(row.record_id))
    checks.push(
      unresolved === 0
        ? check(CHECK_NAMES.recordRefs, true, `${chunkRows.length} chunk(s) resolve to a record`)
        : check(CHECK_NAMES.recordRefs, false, `${unresolved} of ${chunkRows.length} chunk(s) reference a record id with no record`),
    )
  }

  const chunkTypeSet = new Set<string>(CHUNK_TYPES)
  if (chunkRows.length === 0) {
    checks.push(check(CHECK_NAMES.chunkTypes, false, 'no parsed chunk line to check'))
  } else {
    const unknown = countFailing(chunkRows, (row) => typeof row.chunk_type === 'string' && chunkTypeSet.has(row.chunk_type))
    checks.push(
      unknown === 0
        ? check(CHECK_NAMES.chunkTypes, true, `all ${chunkRows.length} chunk(s) use one of the ${CHUNK_TYPES.length} chunk types`)
        : check(CHECK_NAMES.chunkTypes, false, `${unknown} chunk(s) with a chunk_type outside CHUNK_TYPES`),
    )
  }

  const manifestPath = join(dir, CORPUS_FILES.manifest)
  let manifest: CyberManifest | null = null
  if (!(await exists(manifestPath))) {
    checks.push(check(CHECK_NAMES.manifestCounts, true, 'no manifest.json — skipped'))
    checks.push(check(CHECK_NAMES.manifestDigests, true, 'no manifest.json — skipped'))
  } else {
    const read = await readJsonObject(manifestPath)
    if (!read.ok || read.value === null) {
      checks.push(check(CHECK_NAMES.manifestCounts, false, `manifest.json ${read.detail}`))
      checks.push(check(CHECK_NAMES.manifestDigests, false, 'manifest.json unreadable, digests not checked'))
    } else {
      manifest = read.value as CyberManifest

      const compared: string[] = []
      const mismatches: string[] = []
      if (typeof manifest.record_count === 'number') {
        compared.push('record_count')
        if (manifest.record_count !== recordRows.length) mismatches.push(`record_count ${manifest.record_count} ≠ actual ${recordRows.length}`)
      }
      if (typeof manifest.chunk_count === 'number') {
        compared.push('chunk_count')
        if (manifest.chunk_count !== chunkRows.length) mismatches.push(`chunk_count ${manifest.chunk_count} ≠ actual ${chunkRows.length}`)
      }
      checks.push(
        mismatches.length > 0
          ? check(CHECK_NAMES.manifestCounts, false, mismatches.join('; '))
          : check(CHECK_NAMES.manifestCounts, true, compared.length === 0 ? 'no count fields present' : `${compared.join(' and ')} match actual (${recordRows.length} records, ${chunkRows.length} chunks)`),
      )

      checks.push(await checkDigests(dir, manifest.file_sha256))
    }
  }

  const taxonomyDir = join(dir, CORPUS_FILES.taxonomyDir)
  const taxonomyPresent = await exists(taxonomyDir)
  if (!taxonomyPresent) {
    checks.push(check(CHECK_NAMES.taxonomyKeys, true, 'no taxonomy/ — skipped'))
  } else {
    const entries = await fs.readdir(taxonomyDir, { withFileTypes: true })
    const files = entries
      .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
      .map((entry) => ({ name: entry.name, path: join(taxonomyDir, entry.name) }))
      .sort((a, b) => a.name.localeCompare(b.name))
    const result = await checkKeyCollisions(files, 'no *.json files in taxonomy/')
    checks.push(check(CHECK_NAMES.taxonomyKeys, result.ok, result.detail))
  }

  const coveragePath = join(dir, CORPUS_FILES.coverage)
  if (!(await exists(coveragePath))) {
    checks.push(check(CHECK_NAMES.coverageKeys, true, 'no coverage.json — skipped'))
  } else {
    const result = await checkKeyCollisions([{ name: 'coverage.json', path: coveragePath }], 'no files')
    checks.push(check(CHECK_NAMES.coverageKeys, result.ok, result.detail))
  }

  const vocabPath = join(taxonomyDir, 'vulnerabilities.json')
  if (!(await exists(vocabPath))) {
    checks.push(check(CHECK_NAMES.vulnerabilityVocab, true, 'no taxonomy/vulnerabilities.json — skipped'))
  } else {
    const read = await readJsonObject(vocabPath)
    if (!read.ok || read.value === null) {
      checks.push(check(CHECK_NAMES.vulnerabilityVocab, false, `vulnerabilities.json ${read.detail}`))
    } else {
      const vocab = new Set(Object.keys(read.value))
      const outside = countFailing(recordRows, (row) => typeof row.vulnerability === 'string' && vocab.has(row.vulnerability))
      checks.push(
        recordRows.length === 0
          ? check(CHECK_NAMES.vulnerabilityVocab, false, 'no record line to check against the vocabulary')
          : outside === 0
            ? check(CHECK_NAMES.vulnerabilityVocab, true, `all ${recordRows.length} record(s) use one of ${vocab.size} taxonomy key(s)`)
            : check(CHECK_NAMES.vulnerabilityVocab, false, `${outside} record(s) with a vulnerability outside the taxonomy (${vocab.size} keys)`),
      )
    }
  }

  checks.push(
    rowGate(CHECK_NAMES.artifactTypes, recordRows, (row) => Array.isArray(row.artifact_types) && row.artifact_types.length > 0, 'artifact_types'),
    rowGate(
      CHECK_NAMES.remediationVerification,
      recordRows,
      (row) => Array.isArray(row.remediation) && row.remediation.some((item) => isPlainObject(item) && typeof item.verification === 'string' && item.verification.trim().length > 0),
      'a remediation item with a non-empty verification',
    ),
    rowGate(CHECK_NAMES.failureModes, recordRows, (row) => Array.isArray(row.failure_modes) && row.failure_modes.length > 0, 'failure_modes'),
  )

  return {
    ok: checks.every((item) => item.ok),
    dir,
    recordCount: recordRows.length,
    chunkCount: chunkRows.length,
    ...(typeof manifest?.record_count === 'number' ? { manifestRecordCount: manifest.record_count } : {}),
    ...(typeof manifest?.chunk_count === 'number' ? { manifestChunkCount: manifest.chunk_count } : {}),
    checks,
  }
}

function rowGate(name: string, rows: unknown[], ok: (row: Record<string, unknown>) => boolean, what: string): ValidationCheck {
  if (rows.length === 0) return check(name, false, 'no record line to check')
  const failing = countFailing(rows, ok)
  return failing === 0
    ? check(name, true, `all ${rows.length} record(s) have ${what}`)
    : check(name, false, `${failing} of ${rows.length} record(s) missing ${what}`)
}

export function formatReceipt(receipt: ValidationReceipt): string {
  const counts = [`records=${receipt.recordCount} chunks=${receipt.chunkCount}`]
  if (receipt.manifestRecordCount !== undefined) counts.push(`manifest records=${receipt.manifestRecordCount}`)
  if (receipt.manifestChunkCount !== undefined) counts.push(`manifest chunks=${receipt.manifestChunkCount}`)
  const failed = receipt.checks.filter((item) => !item.ok).length
  return [
    `CyberBrain corpus: ${receipt.dir}`,
    counts.join('  '),
    ...receipt.checks.map((item) => `${item.ok ? 'PASS' : 'FAIL'}  ${item.name}: ${item.detail}`),
    receipt.ok ? `RESULT: OK (${receipt.checks.length} checks)` : `RESULT: FAILED (${failed} of ${receipt.checks.length} checks failed)`,
  ].join('\n')
}
