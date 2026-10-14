/**
 * A read-only window onto the local CyberBrain corpus.
 *
 * CyberBrain is the scraped CTF/VAPT knowledge base: prior art for a technique,
 * a vulnerability class, or a dead end someone already hit. The retrieval layer
 * (src/cyberbrain/*) is deliberately split from the tool so the ranker can be
 * tested without the tool and the tool can stay a thin renderer. This file is
 * that renderer: it loads the corpus once (the store caches it), searches or
 * opens a reference, and reports the shape of what is installed.
 *
 * Two honesty rules shape every branch. A machine without the corpus installed
 * gets "not installed" naming the exact directory, never an empty result that
 * reads like "no knowledge exists". And the stats view names the thin
 * categories on purpose — the corpus is a sample of the world, so a missing hit
 * is not evidence the technique is unknown, and the tool must not let the model
 * conclude otherwise.
 */

import type { Tool } from './types.ts'
import { optionalString } from './args.ts'
import { loadCorpus } from '../cyberbrain/store.ts'
import { searchCorpus } from '../cyberbrain/index.ts'
import { openCyberReference } from '../cyberbrain/open.ts'
import { corpusDir } from '../cyberbrain/paths.ts'
import { CHUNK_TYPES } from '../cyberbrain/types.ts'
import type { ChunkType, CyberCorpus, CyberSearchQuery } from '../cyberbrain/types.ts'

const ACTIONS = ['search', 'open', 'taxonomy', 'stats'] as const
type CyberAction = (typeof ACTIONS)[number]

/** The release targets, used when the manifest does not carry its own. */
const TARGET_RECORDS = 6000
const TARGET_MIN_CHUNKS = 24000
/** Below this a category is too thin to treat as covered by the corpus. */
const THIN_CATEGORY_FLOOR = 5
const EXCERPT_CHARS = 240

function isAction(value: string): value is CyberAction {
  return (ACTIONS as readonly string[]).includes(value)
}

/**
 * A model fills an optional numeric field with an empty string as readily as it
 * omits it, so both read as absent; a non-numeric value is a real mistake.
 */
function numberOrUndefined(value: unknown, name: string): number | undefined {
  if (value === undefined || value === null || value === '') return undefined
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`${name} must be a finite number when provided`)
  return value
}

/** Collapse whitespace so an excerpt stays the one or two lines the header promises. */
function excerpt(text: string, max: number = EXCERPT_CHARS): string {
  const collapsed = text.replace(/\s+/g, ' ').trim()
  return collapsed.length <= max ? collapsed : collapsed.slice(0, max - 1).trimEnd() + '…'
}

function notInstalled(): string {
  return `CyberBrain corpus not installed — no records found in ${corpusDir()}. Run \`elia cyberbrain install <path-or-url>\`.`
}

function buildQuery(input: Record<string, unknown>): CyberSearchQuery {
  const chunkType = optionalString(input.chunkType, 'chunkType')
  if (chunkType !== undefined && !(CHUNK_TYPES as readonly string[]).includes(chunkType)) {
    throw new Error(`chunkType must be one of: ${CHUNK_TYPES.join(', ')} — got "${chunkType}"`)
  }

  const query: CyberSearchQuery = { query: optionalString(input.query, 'query') ?? '' }
  const category = optionalString(input.category, 'category')
  if (category !== undefined) query.category = category
  const technique = optionalString(input.technique, 'technique')
  if (technique !== undefined) query.technique = technique
  const vulnerability = optionalString(input.vulnerability, 'vulnerability')
  if (vulnerability !== undefined) query.vulnerability = vulnerability
  const cwe = optionalString(input.cwe, 'cwe')
  if (cwe !== undefined) query.cwe = cwe
  const platform = optionalString(input.platform, 'platform')
  if (platform !== undefined) query.platform = platform
  const artifactType = optionalString(input.artifactType, 'artifactType')
  if (artifactType !== undefined) query.artifactType = artifactType
  if (chunkType !== undefined) query.chunkType = chunkType as ChunkType
  const limit = numberOrUndefined(input.limit, 'limit')
  if (limit !== undefined) query.limit = limit
  return query
}

function filterSummary(query: CyberSearchQuery): string[] {
  const parts: string[] = []
  if (query.category) parts.push(`category=${query.category}`)
  if (query.technique) parts.push(`technique=${query.technique}`)
  if (query.vulnerability) parts.push(`vulnerability=${query.vulnerability}`)
  if (query.cwe) parts.push(`cwe=${query.cwe}`)
  if (query.platform) parts.push(`platform=${query.platform}`)
  if (query.artifactType) parts.push(`artifactType=${query.artifactType}`)
  if (query.chunkType) parts.push(`chunkType=${query.chunkType}`)
  return parts
}

function renderSearch(corpus: CyberCorpus, query: CyberSearchQuery): string {
  const hits = searchCorpus(corpus, query)
  const filters = filterSummary(query)
  const lines: string[] = [
    '# CyberBrain search',
    `Corpus: ${corpus.records.length} record(s), ${corpus.chunks.length} chunk(s), ${corpus.categoryCounts.size} categor(y/ies)`,
    query.query.trim().length > 0 ? `Query: ${query.query}` : 'Query: (browse — no terms)',
    filters.length > 0 ? `Filters: ${filters.join(', ')}` : 'Filters: none',
    '',
  ]

  if (hits.length === 0) {
    lines.push('No CyberBrain chunk matched. This is an absence of a hit, not evidence the technique is unknown —')
    lines.push('the corpus is a sample, and `stats` lists the categories that are thin. Do not invent a record.')
    return lines.join('\n')
  }

  hits.forEach((hit, index) => {
    const chunk = hit.chunk
    lines.push(`${index + 1}. [${chunk.chunk_type}] ${chunk.category} · ${chunk.vulnerability} (${chunk.cwe})`)
    if (chunk.techniques.length > 0) lines.push(`   techniques: ${chunk.techniques.join(', ')}`)
    lines.push(`   ${excerpt(chunk.text)}`)
    lines.push(`   [open: record:${chunk.record_id}]`)
    lines.push('')
  })
  return lines.join('\n').trimEnd()
}

function renderTaxonomy(corpus: CyberCorpus): string {
  if (corpus.categoryCounts.size === 0) {
    return `CyberBrain taxonomy is available only in the corpus files under ${corpusDir()} (taxonomy/). No categories are in the loaded view — check that the corpus is installed there and readable.`
  }

  const entries = [...corpus.categoryCounts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
  const lines: string[] = [
    '# CyberBrain taxonomy — categories',
    `${entries.length} categor(y/ies) across ${corpus.records.length} record(s).`,
    '',
  ]
  for (const [category, count] of entries) lines.push(`- ${category}: ${count}`)
  lines.push('')
  lines.push('Coverage note: these counts are the records installed here, so an absent or thin category is not')
  lines.push('evidence the world lacks it — treat the corpus as a sample, not a census.')
  if (corpus.manifest?.categories) lines.push(`Manifest lists ${Object.keys(corpus.manifest.categories).length} category/ies.`)
  return lines.join('\n')
}

function renderStats(corpus: CyberCorpus): string {
  const vulnerabilities = new Set(corpus.records.map((record) => record.vulnerability).filter((value) => value.length > 0))
  const targetRecords = corpus.manifest?.target_records ?? TARGET_RECORDS
  const minChunks = corpus.manifest?.min_chunks ?? TARGET_MIN_CHUNKS
  const thin = [...corpus.categoryCounts.entries()]
    .filter(([, count]) => count < THIN_CATEGORY_FLOOR)
    .sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0]))

  return [
    '# CyberBrain stats',
    `- records: ${corpus.records.length}`,
    `- chunks: ${corpus.chunks.length}`,
    `- categories: ${corpus.categoryCounts.size}`,
    `- distinct vulnerabilities: ${vulnerabilities.size}`,
    `- manifest: ${corpus.manifest ? 'present' : 'absent'}`,
    `- record target (${targetRecords}): ${corpus.records.length >= targetRecords ? 'met' : `not met (${corpus.records.length}/${targetRecords})`}`,
    `- min chunks (${minChunks}): ${corpus.chunks.length >= minChunks ? 'met' : `not met (${corpus.chunks.length}/${minChunks})`}`,
    '',
    `Thin categories (< ${THIN_CATEGORY_FLOOR} records): ${thin.length === 0 ? 'none' : thin.map(([category, count]) => `${category} (${count})`).join(', ')}`,
    'Do not read completeness into these counts: a thin or absent category means retrieval has less to draw on there.',
  ].join('\n')
}

export async function reportCyberBrain(input: Record<string, unknown>): Promise<string> {
  const actionValue = optionalString(input.action, 'action') ?? 'search'
  if (!isAction(actionValue)) {
    throw new Error(`action must be one of: ${ACTIONS.join(', ')} — got "${actionValue}"`)
  }

  // Validated before the load so a bad argument is a real mistake, while a
  // failure to read the corpus is reported as data rather than thrown.
  const ref = actionValue === 'open' ? optionalString(input.ref, 'ref') : undefined
  const query = actionValue === 'search' ? buildQuery(input) : undefined

  let corpus: CyberCorpus
  try {
    corpus = await loadCorpus()
  } catch (error) {
    return `CyberBrain could not load its corpus at ${corpusDir()}: ${error instanceof Error ? error.message : String(error)}. Nothing was retrieved.`
  }

  if (corpus.records.length === 0) return notInstalled()

  if (actionValue === 'open') {
    if (ref === undefined) {
      return 'CyberBrain open needs a ref — pass `ref` as `record:<id>` or `chunk:<chunk_id>` (search prints the record ref for every hit).'
    }
    return openCyberReference(corpus, ref)
  }
  if (actionValue === 'taxonomy') return renderTaxonomy(corpus)
  if (actionValue === 'stats') return renderStats(corpus)
  return renderSearch(corpus, query!)
}

export const cyberBrainTool: Tool = {
  name: 'cyberbrain',
  description:
    'Read-only local security knowledge base of CTF writeups and sanitized VAPT findings, ranked with BM25 over a scraped corpus. Call it before improvising a technique: it returns prior art — the chunk kind, category, vulnerability/CWE, techniques, and a short excerpt — and every hit names a `record:<id>` you can open for the full writeup (steps, remediation with its verification check, and the failure modes). Actions: `search` (default; filters: query, category, technique, vulnerability, cwe, platform, artifactType, chunkType, limit), `open` (ref: `record:<id>` or `chunk:<chunk_id>`), `taxonomy` (categories with counts), `stats` (corpus size and whether the release targets are met). It reads only the locally installed corpus and never the network, reports an empty corpus as "not installed" rather than inventing hits, and names the thin categories so a missing hit is never read as proof a technique is unknown.',
  input_schema: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: [...ACTIONS], description: 'What to do (default: search).' },
      query: { type: 'string', description: 'Free-text search terms, scored with BM25.' },
      category: { type: 'string', description: 'Filter to one category, e.g. pwn, web, crypto.' },
      technique: { type: 'string', description: 'Filter to a technique (substring match), e.g. ret2libc.' },
      vulnerability: { type: 'string', description: 'Filter to a vulnerability class (substring match), e.g. overflow.' },
      cwe: { type: 'string', description: 'Filter to an exact CWE id, e.g. CWE-120.' },
      platform: { type: 'string', description: 'Filter to an exact platform, e.g. linux.' },
      artifactType: { type: 'string', description: 'Filter to one artifact type, e.g. elf, html, pcap.' },
      chunkType: { type: 'string', enum: [...CHUNK_TYPES], description: 'Filter to one chunk kind.' },
      ref: { type: 'string', description: 'For action=open: "record:<id>" or "chunk:<chunk_id>".' },
      limit: { type: 'number', description: 'Maximum hits for search (default 8).' },
    },
  },
  async execute(input) {
    return reportCyberBrain(input)
  },
}
