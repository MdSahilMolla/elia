import type { Tool } from './types.ts'
import { optionalString } from './args.ts'
import { resolveWorkspacePath } from '../autonomy/context.ts'
import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const MAX_RESULTS = 20
const MAX_FIELD_LENGTH = 2000
const MAX_KEYWORDS = 8
const MAX_KEYWORD_LENGTH = 64
const INBOX_DIR = '.elia/inbox'

export interface FederatedPattern {
  id: string
  sourceProject: string
  timestamp: string
  category: 'performance' | 'security' | 'architecture' | 'testing' | 'tooling'
  title: string
  description: string
  solution: string
  keywords: string[]
  anonymized: boolean
  confidence: number
}

export interface FederationStore {
  patterns: FederatedPattern[]
  nodeId: string
  lastBroadcast: string
  lastReceive: string
}

const CATEGORIES: FederatedPattern['category'][] = ['performance', 'security', 'architecture', 'testing', 'tooling']

export function getStorePath(cwd: string): string {
  return join(cwd, '.elia', 'federation.json')
}

export function loadStore(cwd: string): FederationStore {
  const path = getStorePath(cwd)
  if (!existsSync(path)) return { patterns: [], nodeId: generateNodeId(), lastBroadcast: '', lastReceive: '' }
  try {
    return JSON.parse(readFileSync(path, 'utf-8')) as FederationStore
  } catch {
    return { patterns: [], nodeId: generateNodeId(), lastBroadcast: '', lastReceive: '' }
  }
}

export function saveStore(cwd: string, store: FederationStore): void {
  const dir = join(cwd, '.elia')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  writeFileSync(getStorePath(cwd), JSON.stringify(store, null, 2))
}

export function generateNodeId(): string {
  return `node_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`
}

export function anonymizePattern(pattern: FederatedPattern): FederatedPattern {
  return {
    ...pattern,
    sourceProject: 'anonymous',
    id: `anon_${pattern.id}`,
    anonymized: true,
  }
}

export function scoreRelevance(pattern: FederatedPattern, query: string): number {
  const terms = query.toLowerCase().split(/\s+/).filter((t) => t.length > 2)
  let score = 0
  for (const term of terms) {
    if (pattern.title.toLowerCase().includes(term)) score += 3
    if (pattern.description.toLowerCase().includes(term)) score += 1
    if (pattern.solution.toLowerCase().includes(term)) score += 2
    if (pattern.keywords.some((k) => k.toLowerCase().includes(term))) score += 2
  }
  score += pattern.confidence * 0.3
  return score
}

function asTrimmedString(value: unknown, max = MAX_FIELD_LENGTH, truncate = true): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  if (trimmed.length === 0) return undefined
  if (trimmed.length > max) return truncate ? trimmed.slice(0, max) : undefined
  return trimmed
}

/**
 * Validate and sanitize an inbound federated pattern. Only documented string
 * fields are accepted, lengths are capped, unknown fields are dropped, and the
 * result is deterministically shaped. Returns null when the payload is unsafe
 * or malformed — callers skip rather than crash.
 */
export function sanitizeInboundPattern(raw: unknown): FederatedPattern | null {
  if (typeof raw !== 'object' || raw === null) return null
  const obj = raw as Record<string, unknown>

  const id = asTrimmedString(obj.id, 128, false)
  const title = asTrimmedString(obj.title)
  const solution = asTrimmedString(obj.solution)
  if (!id || !title || !solution) return null

  const timestamp = asTrimmedString(obj.timestamp, 128, false)
  if (!timestamp || Number.isNaN(new Date(timestamp).getTime())) return null

  const category = obj.category
  if (typeof category !== 'string' || !CATEGORIES.includes(category as FederatedPattern['category'])) return null

  const keywords: string[] = []
  if (Array.isArray(obj.keywords)) {
    for (const kw of obj.keywords.slice(0, MAX_KEYWORDS)) {
      if (typeof kw !== 'string') continue
      const k = kw.trim().slice(0, MAX_KEYWORD_LENGTH)
      if (k.length > 0 && !keywords.includes(k)) keywords.push(k)
    }
  }

  const confidence = typeof obj.confidence === 'number' && Number.isFinite(obj.confidence)
    ? Math.min(1, Math.max(0, obj.confidence))
    : 0.5

  const source = asTrimmedString(obj.sourceProject, 128) ?? 'anonymous'

  return {
    id,
    sourceProject: source === 'anonymous' ? 'anonymous' : 'peer',
    timestamp,
    category: category as FederatedPattern['category'],
    title,
    description: asTrimmedString(obj.description) ?? '',
    solution,
    keywords: keywords.slice(0, MAX_KEYWORDS),
    anonymized: obj.anonymized === true || source === 'anonymous',
    confidence,
  }
}

/** Import sanitized payloads from the local-only inbox, skipping duplicates. */
export function receiveFromInbox(cwd: string): { imported: FederatedPattern[]; skipped: string[] } {
  const inbox = join(cwd, INBOX_DIR)
  if (!existsSync(inbox)) return { imported: [], skipped: [] }

  const store = loadStore(cwd)
  const known = new Set(store.patterns.map((p) => p.id))
  const imported: FederatedPattern[] = []
  const skipped: string[] = []

  let files: string[]
  try {
    files = readdirSync(inbox).filter((f) => f.endsWith('.json')).sort()
  } catch {
    return { imported: [], skipped: [] }
  }

  for (const file of files) {
    let raw: unknown
    try {
      raw = JSON.parse(readFileSync(join(inbox, file), 'utf-8'))
    } catch {
      skipped.push(file)
      continue
    }
    const pattern = sanitizeInboundPattern(raw)
    if (!pattern || known.has(pattern.id)) {
      skipped.push(file)
      continue
    }
    store.patterns.push(pattern)
    known.add(pattern.id)
    imported.push(pattern)
  }

  store.lastReceive = new Date().toISOString()
  saveStore(cwd, store)
  return { imported, skipped }
}

export function formatQueryResults(patterns: FederatedPattern[], total: number): string {
  const lines: string[] = []
  lines.push(`=== Federated Patterns (showing ${patterns.length} of ${total}) ===`)
  if (patterns.length === 0) {
    lines.push('No matching patterns in the federation store.')
    return lines.join('\n')
  }
  for (const p of patterns) {
    lines.push('')
    lines.push(`[${p.category.toUpperCase()}] ${p.title}`)
    lines.push(`  Source: ${p.anonymized ? '(anonymized)' : p.sourceProject} | Confidence: ${Math.round(p.confidence * 100)}%`)
    if (p.description) lines.push(`  Problem: ${p.description}`)
    if (p.solution) lines.push(`  Solution: ${p.solution}`)
    if (p.keywords.length > 0) lines.push(`  Keywords: ${p.keywords.join(', ')}`)
  }
  return lines.join('\n')
}

export function formatShareResult(pattern: FederatedPattern, anonymized: boolean): string {
  return [
    '=== Pattern Shared to Federation ===',
    `ID: ${pattern.id}`,
    `Category: ${pattern.category}`,
    `Title: ${pattern.title}`,
    `Anonymized: ${anonymized ? 'Yes' : 'No'}`,
    `Keywords: ${pattern.keywords.join(', ')}`,
    pattern.description ? `Description: ${pattern.description}` : '',
    pattern.solution ? `Solution: ${pattern.solution}` : '',
    '',
    'In a full implementation, this pattern would be broadcast to connected federation peers.',
  ]
    .filter((l) => l.length > 0)
    .join('\n')
}

/** Deterministic entry point; `cwd` is injected so tests never touch the real workspace. */
export function runFederatedCollab(input: Record<string, unknown>, cwd: string): string {
  const action = optionalString(input.action, 'action') ?? 'query'
  const store = loadStore(cwd)

  switch (action) {
    case 'query': {
      const query = optionalString(input.query, 'query') ?? ''
      const category = optionalString(input.category, 'category')
      const limit = Math.min(Math.max(typeof input.limit === 'number' ? input.limit : 10, 1), MAX_RESULTS)

      let filtered = store.patterns
      if (category) filtered = filtered.filter((p) => p.category === category)

      if (query) {
        const scored = filtered.map((p) => ({ pattern: p, score: scoreRelevance(p, query) }))
        scored.sort((a, b) => b.score - a.score)
        return formatQueryResults(scored.slice(0, limit).map((s) => s.pattern), store.patterns.length)
      }
      return formatQueryResults(filtered.slice(0, limit), store.patterns.length)
    }

    case 'share':
    case 'broadcast': {
      const title = optionalString(input.title, 'title')
      if (!title) throw new Error('title is required for share action')
      const description = optionalString(input.description, 'description') ?? ''
      const solution = optionalString(input.solution, 'solution') ?? ''
      const category = (optionalString(input.category, 'category') as FederatedPattern['category']) ?? 'tooling'
      const keywords = optionalString(input.keywords, 'keywords')?.split(',').map((k) => k.trim()) ?? []
      const anonymize = input.anonymize !== false

      let pattern: FederatedPattern = {
        id: `fp_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        sourceProject: store.nodeId,
        timestamp: new Date().toISOString(),
        category,
        title,
        description,
        solution,
        keywords,
        anonymized: false,
        confidence: 0.7,
      }

      if (anonymize) pattern = anonymizePattern(pattern)

      store.patterns.push(pattern)
      store.lastBroadcast = new Date().toISOString()
      saveStore(cwd, store)

      return formatShareResult(pattern, anonymize)
    }

    case 'receive': {
      const { imported, skipped } = receiveFromInbox(cwd)
      const fresh = loadStore(cwd)
      return [
        '=== Federation Receive (local-only) ===',
        `Node: ${fresh.nodeId}`,
        `Total patterns in store: ${fresh.patterns.length}`,
        `Imported from inbox: ${imported.length}`,
        `Skipped (malformed/duplicate): ${skipped.length}`,
        `Last receive: ${fresh.lastReceive || 'never'}`,
        '',
        'Inbound payloads are validated, sanitized, and never executed.',
        'In a full implementation this would connect to federation peers.',
      ].join('\n')
    }

    case 'stats': {
      const byCategory: Record<string, number> = {}
      const sources = new Set(store.patterns.map((p) => p.sourceProject))
      const anonymized = store.patterns.filter((p) => p.anonymized).length
      for (const p of store.patterns) {
        byCategory[p.category] = (byCategory[p.category] ?? 0) + 1
      }
      return [
        '=== Federation Stats ===',
        `Node ID: ${store.nodeId}`,
        `Total patterns: ${store.patterns.length}`,
        `Anonymized: ${anonymized}`,
        `Unique sources: ${sources.size}`,
        `By category: ${Object.entries(byCategory).map(([k, v]) => `${k}: ${v}`).join(', ')}`,
        `Last broadcast: ${store.lastBroadcast || 'never'}`,
        `Last receive: ${store.lastReceive || 'never'}`,
      ].join('\n')
    }

    default:
      throw new Error(`Unknown action: ${action}. Use query, share, receive, or stats.`)
  }
}

export const federatedCollabTool: Tool = {
  name: 'federated_collab',
  description:
    'Federated pattern sharing across Elia instances. Broadcast anonymized patterns to the federation and receive patterns from other projects over a local-only inbox. All shared patterns are anonymized by default; inbound payloads are validated and sanitized on receive.',
  input_schema: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        description: 'Action: query (search federation), share (broadcast pattern), receive (import from local inbox), stats (federation overview)',
        enum: ['query', 'share', 'receive', 'stats', 'broadcast'],
      },
      query: { type: 'string', description: 'Search terms for query action' },
      category: { type: 'string', description: 'Pattern category: performance, security, architecture, testing, tooling' },
      title: { type: 'string', description: 'Pattern title for share action' },
      description: { type: 'string', description: 'Pattern description for share action' },
      solution: { type: 'string', description: 'Solution for share action' },
      keywords: { type: 'string', description: 'Comma-separated keywords for share action' },
      anonymize: { type: 'boolean', description: 'Anonymize the pattern before sharing (default true)' },
      limit: { type: 'number', description: `Max results (1-${MAX_RESULTS}, default 10)` },
    },
    required: ['action'],
  },
  async execute(input) {
    return runFederatedCollab(input as Record<string, unknown>, resolveWorkspacePath('.'))
  },
}