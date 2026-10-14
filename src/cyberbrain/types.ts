/**
 * CyberBrain — the frozen interface shared by every part of the retrieval layer.
 *
 * This file is the contract. `store.ts` loads a corpus into {@link CyberCorpus},
 * `index.ts` ranks its chunks, `open.ts` renders a record, `canonicalize.ts`
 * normalizes taxonomy keys and `validate.ts` proves the corpus is well formed.
 * Nothing here reaches the network or mutates anything: retrieval is read-only
 * local BM25, matching elia's no-embeddings design (see src/bm25.ts).
 *
 * The shapes below mirror the delivered corpus exactly (schema_version 1):
 *  - a *record* is one CTF writeup or sanitized VAPT finding, with ordered steps,
 *    a controlled vulnerability class + CWE, and structured remediation;
 *  - a *chunk* is one of ten self-contained retrieval units derived from a
 *    record (context, vulnerability_discovery, exploitation, root_cause,
 *    detection, remediation, verification, defense, commands_payloads, dead_ends).
 */

export type ChunkType =
  | 'context'
  | 'vulnerability_discovery'
  | 'exploitation'
  | 'root_cause'
  | 'detection'
  | 'remediation'
  | 'verification'
  | 'defense'
  | 'commands_payloads'
  | 'dead_ends'

/** The ten chunk types, fixed order (it is the fan-out order and the render order). */
export const CHUNK_TYPES: ChunkType[] = [
  'context',
  'vulnerability_discovery',
  'exploitation',
  'root_cause',
  'detection',
  'remediation',
  'verification',
  'defense',
  'commands_payloads',
  'dead_ends',
]

export interface CyberStep {
  goal: string
  action: string
  command?: string
  expected_output?: string
  dead_end?: boolean
}

export interface CyberRemediation {
  finding_class: string
  control: string
  type?: string
  layer?: string
  effort?: string
  /** A concrete check that proves the control is in place. Mandatory per record in the corpus. */
  verification?: string
}

export interface CyberFailureMode {
  attempt: string
  why_it_fails: string
  source_url?: string
}

export interface CyberSource {
  url: string
  platform?: string
  event?: string
  year?: number
  author?: string
  team?: string
  type?: string
}

export interface CyberRecord {
  id: string
  schema_version: number
  title: string
  category: string
  artifact_types: string[]
  techniques: string[]
  vulnerability: string
  cwe: string
  technologies?: string[]
  tools?: string[]
  platform?: string
  platform_version?: string
  detect?: string[]
  prerequisites?: string[]
  steps: CyberStep[]
  attack_chain?: string[]
  payloads?: string[]
  commands?: string[]
  root_cause?: string
  impact?: string
  mitigation?: string
  remediation: CyberRemediation[]
  failure_modes: CyberFailureMode[]
  difficulty?: string
  difficulty_source?: string
  confidence?: number
  quality_score?: number
  source: CyberSource
  related_ids?: string[]
}

export interface CyberChunk {
  chunk_id: string
  chunk_type: ChunkType
  text: string
  record_id: string
  category: string
  artifact_types: string[]
  techniques: string[]
  vulnerability: string
  cwe: string
  remediation_classes: string[]
  tools: string[]
  platform?: string
  difficulty?: string
  source_url?: string
  quality_score?: number
}

export interface CyberManifest {
  schema_version?: number
  generated_at?: string
  record_count?: number
  chunk_count?: number
  target_records?: number
  min_chunks?: number
  floor_records?: number
  categories?: Record<string, number>
  floors_unmet?: { category: string; floor: number; gap: number; have: number }[]
  file_sha256?: Record<string, string>
  files?: string[]
  targets_met?: { chunks?: boolean; records_floor?: boolean; records_target?: boolean }
}

/** A loaded corpus: the parsed records, chunks, and the joins the tools need. */
export interface CyberCorpus {
  dir: string
  records: CyberRecord[]
  chunks: CyberChunk[]
  recordById: Map<string, CyberRecord>
  /** chunks grouped by record id — the 10-way fan-out, verified by validate.ts. */
  chunksByRecord: Map<string, CyberChunk[]>
  manifest: CyberManifest | null
  /** Per-category record counts, derived from the records (not the manifest). */
  categoryCounts: Map<string, number>
  loadedAt: number
}

export interface CyberSearchQuery {
  query: string
  category?: string
  technique?: string
  vulnerability?: string
  cwe?: string
  platform?: string
  artifactType?: string
  chunkType?: ChunkType
  limit?: number
}

export interface CyberHit {
  chunk: CyberChunk
  record: CyberRecord | undefined
  score: number
}

/** One line of the validation receipt: a named gate and whether it passed. */
export interface ValidationCheck {
  name: string
  ok: boolean
  detail: string
}

export interface ValidationReceipt {
  ok: boolean
  dir: string
  recordCount: number
  chunkCount: number
  manifestRecordCount?: number
  manifestChunkCount?: number
  checks: ValidationCheck[]
}

// ---------------------------------------------------------------------------
// Frozen function signatures. Implementations live in the sibling modules; this
// block exists so the parallel work agrees on names and arguments before any of
// it is written.
//
//   paths.ts
//     corpusDir(): string
//
//   store.ts
//     loadCorpus(opts?: { dir?: string; force?: boolean }): Promise<CyberCorpus>
//     resetCorpusCache(): void
//
//   index.ts
//     searchCorpus(corpus: CyberCorpus, q: CyberSearchQuery): CyberHit[]
//
//   open.ts
//     renderRecord(record: CyberRecord, maxChars?: number): string
//     openCyberReference(corpus: CyberCorpus, ref: string): string
//
//   canonicalize.ts
//     canonicalKey(key: string): string
//     canonicalizeKeys<T extends Record<string, unknown>>(obj: T): { value: Record<string, unknown>; merged: string[][]; collisions: string[] }
//
//   validate.ts
//     validateCorpus(dir: string): Promise<ValidationReceipt>
//     formatReceipt(receipt: ValidationReceipt): string
// ---------------------------------------------------------------------------
