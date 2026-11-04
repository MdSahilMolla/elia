import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CHUNK_TYPES, type ChunkType, type CyberManifest, type CyberRecord } from './types.ts'

/**
 * A tiny, complete CyberBrain corpus for tests — two records, twenty chunks,
 * a minimal taxonomy and manifest. It is deliberately *valid* under every
 * `validate.ts` gate so the happy path is exercised end to end, and small enough
 * that a test builds it in milliseconds.
 *
 * Shared by store/index/open/validate tests. Nothing here is production code.
 */

function record(id: string, category: string, vulnerability: string, cwe: string, technique: string): CyberRecord {
  return {
    id,
    schema_version: 1,
    title: `${technique} on ${category} challenge`,
    category,
    artifact_types: category === 'pwn' ? ['elf'] : ['html'],
    techniques: [technique],
    vulnerability,
    cwe,
    technologies: [],
    tools: [],
    platform: 'linux',
    platform_version: '',
    detect: [`suspicious ${vulnerability} signal`],
    prerequisites: [],
    steps: [
      { goal: 'recon', action: `identify ${vulnerability}`, command: 'file ./chall', expected_output: 'an ELF', dead_end: false },
      { goal: 'exploit', action: `trigger ${vulnerability}`, command: '', expected_output: 'shell', dead_end: false },
    ],
    attack_chain: ['recon', 'exploit'],
    payloads: [],
    commands: ['file ./chall'],
    root_cause: `unchecked input enables ${vulnerability}`,
    impact: 'code execution',
    mitigation: 'bounds-check input',
    remediation: [
      {
        finding_class: vulnerability,
        control: 'validate input with explicit bounds',
        type: 'preventive',
        layer: 'code',
        effort: 'medium',
        verification: 'fuzz the parser and confirm the crash no longer reproduces',
      },
    ],
    failure_modes: [{ attempt: 'short payload', why_it_fails: 'never reaches the return address', source_url: 'https://example.test/w' }],
    difficulty: 'beginner',
    difficulty_source: 'inferred',
    confidence: 0.8,
    quality_score: 80,
    source: { url: 'https://example.test/w', platform: 'github', event: 'TestCTF 2024', year: 2024, author: 'a', team: '', type: 'writeup' },
    related_ids: [],
  }
}

function chunk(r: CyberRecord, type: ChunkType, n: number) {
  return {
    chunk_id: `${r.id}_${type}`,
    chunk_type: type,
    text: `${r.title} ${r.vulnerability} ${r.cwe} ${type} ${r.techniques.join(' ')}`,
    record_id: r.id,
    category: r.category,
    artifact_types: r.artifact_types,
    techniques: r.techniques,
    vulnerability: r.vulnerability,
    cwe: r.cwe,
    remediation_classes: [r.vulnerability],
    tools: r.tools ?? [],
    platform: r.platform,
    difficulty: r.difficulty,
    source_url: r.source.url,
    quality_score: r.quality_score,
    _n: n,
  }
}

export interface FixtureOptions {
  /** Override the records written (e.g. a record with an empty artifact_types, to test a failing gate). */
  records?: CyberRecord[]
  /** Skip writing the manifest (tests the "manifest optional" path). */
  noManifest?: boolean
  /** Skip writing taxonomy (tests the "taxonomy optional" path). */
  noTaxonomy?: boolean
}

export interface FixtureCorpus {
  dir: string
  records: CyberRecord[]
  chunkCount: number
}

/** Writes a valid corpus to a fresh temp dir and returns it. */
export function writeFixtureCorpus(options: FixtureOptions = {}): FixtureCorpus {
  const dir = mkdtempSync(join(tmpdir(), 'elia-cyberbrain-fixture-'))
  const records = options.records ?? [
    record('r_pwn1', 'pwn', 'Buffer Overflow', 'CWE-120', 'ret2libc'),
    record('r_web1', 'web', 'XSS', 'CWE-79', 'Stored XSS'),
  ]

  mkdirSync(join(dir, 'chunks'), { recursive: true })
  writeFileSync(join(dir, 'records.jsonl'), records.map((r) => JSON.stringify(r)).join('\n') + '\n')

  const chunks: unknown[] = []
  records.forEach((r) => CHUNK_TYPES.forEach((type, i) => chunks.push(chunk(r, type, i))))
  writeFileSync(join(dir, 'chunks/chunks.jsonl'), chunks.map((c) => JSON.stringify(c)).join('\n') + '\n')

  if (!options.noManifest) {
    const manifest: CyberManifest = {
      schema_version: 1,
      generated_at: '2024-01-01T00:00:00+00:00',
      record_count: records.length,
      chunk_count: chunks.length,
      target_records: 6000,
      min_chunks: 24000,
      floor_records: 5000,
      categories: records.reduce<Record<string, number>>((acc, r) => ({ ...acc, [r.category]: (acc[r.category] ?? 0) + 1 }), {}),
    }
    writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest, null, 1))
  }

  if (!options.noTaxonomy) {
    mkdirSync(join(dir, 'taxonomy'), { recursive: true })
    const vulns = [...new Set(records.map((r) => r.vulnerability))]
    writeFileSync(join(dir, 'taxonomy/vulnerabilities.json'), JSON.stringify(Object.fromEntries(vulns.map((v) => [v, { count: 1 }])), null, 1))
    const cats = [...new Set(records.map((r) => r.category))]
    writeFileSync(join(dir, 'taxonomy/categories.json'), JSON.stringify(Object.fromEntries(cats.map((c) => [c, 1])), null, 1))
  }

  return { dir, records, chunkCount: chunks.length }
}
