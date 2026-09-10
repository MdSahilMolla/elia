import type { Tool } from './types.ts'
import { optionalString } from './args.ts'
import { runShell } from '../shell.ts'
import { resolveWorkspacePath } from '../autonomy/context.ts'
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

const SHELL_TIMEOUT_MS = 15_000
const MAX_RESULTS = 20

interface FederatedPattern {
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

interface FederationStore {
  patterns: FederatedPattern[]
  nodeId: string
  lastBroadcast: string
  lastReceive: string
}

function getStorePath(cwd: string): string {
  return join(cwd, '.elia', 'federation.json')
}

function loadStore(cwd: string): FederationStore {
  const path = getStorePath(cwd)
  if (!existsSync(path)) return { patterns: [], nodeId: generateNodeId(), lastBroadcast: '', lastReceive: '' }
  try {
    return JSON.parse(readFileSync(path, 'utf-8')) as FederationStore
  } catch {
    return { patterns: [], nodeId: generateNodeId(), lastBroadcast: '', lastReceive: '' }
  }
}

function saveStore(cwd: string, store: FederationStore): void {
  const dir = join(cwd, '.elia')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  writeFileSync(getStorePath(cwd), JSON.stringify(store, null, 2))
}

function generateNodeId(): string {
  return `node_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`
}

function anonymizePattern(pattern: FederatedPattern): FederatedPattern {
  return {
    ...pattern,
    sourceProject: 'anonymous',
    id: `anon_${pattern.id}`,
    anonymized: true,
  }
}

function scoreRelevance(pattern: FederatedPattern, query: string): number {
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

export const federatedCollabTool: Tool = {
  name: 'federated_collab',
  description:
    'Federated pattern sharing across Elia instances. Broadcast anonymized patterns to the federation and receive patterns from other projects. Enables network-effect learning where every Elia user benefits from others discoveries. All shared patterns are anonymized by default.',
  input_schema: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        description: 'Action: query (search federation), share (broadcast pattern), receive (fetch new patterns), stats (federation overview)',
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
    const action = optionalString(input.action, 'action') ?? 'query'
    const cwd = resolveWorkspacePath('.')
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
        store.lastReceive = new Date().toISOString()
        saveStore(cwd, store)
        const newPatterns = store.patterns.filter(
          (p) => new Date(p.timestamp).getTime() > Date.now() - 86400000,
        ).length
        return [
          '=== Federation Receive ===',
          `Node: ${store.nodeId}`,
          `Total patterns in store: ${store.patterns.length}`,
          `New patterns (last 24h): ${newPatterns}`,
          `Last receive: ${store.lastReceive}`,
          '',
          'In a full implementation, this would connect to federation peers',
          'and merge new anonymized patterns. Currently operating in local-only mode.',
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
  },
}

function formatQueryResults(patterns: FederatedPattern[], total: number): string {
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

function formatShareResult(pattern: FederatedPattern, anonymized: boolean): string {
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
