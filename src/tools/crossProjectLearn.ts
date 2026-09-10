import type { Tool } from './types.ts'
import { optionalString } from './args.ts'
import { runShell } from '../shell.ts'
import { resolveWorkspacePath } from '../autonomy/context.ts'
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

const SHELL_TIMEOUT_MS = 15_000
const MAX_RESULTS = 20

interface Pattern {
  id: string
  timestamp: string
  projectFingerprint: string
  category: 'error-pattern' | 'optimization' | 'architecture' | 'testing' | 'security'
  title: string
  description: string
  solution: string
  keywords: string[]
  confidence: number
}

interface CrossProjectStore {
  patterns: Pattern[]
  lastSync: string
}

function getStorePath(cwd: string): string {
  return join(cwd, '.elia', 'cross-project-patterns.json')
}

function loadStore(cwd: string): CrossProjectStore {
  const path = getStorePath(cwd)
  if (!existsSync(path)) return { patterns: [], lastSync: '' }
  try {
    return JSON.parse(readFileSync(path, 'utf-8')) as CrossProjectStore
  } catch {
    return { patterns: [], lastSync: '' }
  }
}

function saveStore(cwd: string, store: CrossProjectStore): void {
  const dir = join(cwd, '.elia')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  writeFileSync(getStorePath(cwd), JSON.stringify(store, null, 2))
}

async function getProjectFingerprint(cwd: string): Promise<string> {
  const result = await runShell(
    'cat package.json 2>/dev/null | head -5; ls src/ 2>/dev/null | head -10; cat tsconfig.json 2>/dev/null | head -3',
    SHELL_TIMEOUT_MS,
    cwd,
  )
  let hash = 0
  const str = result.stdout
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) - hash + str.charCodeAt(i)) | 0
  }
  return `proj_${Math.abs(hash).toString(36)}`
}

function scoreRelevance(pattern: Pattern, query: string): number {
  const queryLower = query.toLowerCase()
  const terms = queryLower.split(/\s+/).filter((t) => t.length > 2)
  let score = 0
  for (const term of terms) {
    if (pattern.title.toLowerCase().includes(term)) score += 3
    if (pattern.description.toLowerCase().includes(term)) score += 1
    if (pattern.solution.toLowerCase().includes(term)) score += 2
    if (pattern.keywords.some((k) => k.includes(term))) score += 2
  }
  score += pattern.confidence * 0.3
  return score
}

export const crossProjectLearnTool: Tool = {
  name: 'cross_project_learn',
  description:
    'Transfer knowledge across projects. Record patterns, solutions, and optimizations from one project and query them when working on similar problems in other projects. Uses a shared pattern store with project fingerprints to match relevant solutions.',
  input_schema: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        description: 'Action: query (search patterns), record (add pattern), sync (update fingerprint), stats (overview)',
        enum: ['query', 'record', 'sync', 'stats'],
      },
      query: { type: 'string', description: 'Search terms for query action' },
      category: { type: 'string', description: 'Pattern category: error-pattern, optimization, architecture, testing, security' },
      title: { type: 'string', description: 'Pattern title for record action' },
      description: { type: 'string', description: 'Problem description for record action' },
      solution: { type: 'string', description: 'Solution description for record action' },
      keywords: { type: 'string', description: 'Comma-separated keywords for record action' },
      limit: { type: 'number', description: `Max results (1-${MAX_RESULTS}, default 10)` },
    },
    required: ['action'],
  },
  async execute(input) {
    const action = optionalString(input.action, 'action') ?? 'query'
    const cwd = resolveWorkspacePath('.')
    const store = loadStore(cwd)
    const fingerprint = await getProjectFingerprint(cwd)

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

      case 'record': {
        const title = optionalString(input.title, 'title')
        if (!title) throw new Error('title is required for record action')
        const description = optionalString(input.description, 'description') ?? ''
        const solution = optionalString(input.solution, 'solution') ?? ''
        const category = (optionalString(input.category, 'category') as Pattern['category']) ?? 'optimization'
        const keywords = optionalString(input.keywords, 'keywords')?.split(',').map((k) => k.trim()) ?? []

        const pattern: Pattern = {
          id: `pat_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
          timestamp: new Date().toISOString(),
          projectFingerprint: fingerprint,
          category,
          title,
          description,
          solution,
          keywords,
          confidence: 0.7,
        }
        store.patterns.push(pattern)
        store.lastSync = new Date().toISOString()
        saveStore(cwd, store)
        return formatRecordResult(pattern)
      }

      case 'sync': {
        const updated = store.patterns.filter((p) => p.projectFingerprint !== fingerprint).length
        store.lastSync = new Date().toISOString()
        saveStore(cwd, store)
        return `Synced project fingerprint: ${fingerprint}. ${store.patterns.length} patterns in store. ${updated} patterns from other projects available.`
      }

      case 'stats': {
        const byCategory: Record<string, number> = {}
        const projects = new Set(store.patterns.map((p) => p.projectFingerprint))
        for (const p of store.patterns) {
          byCategory[p.category] = (byCategory[p.category] ?? 0) + 1
        }
        return [
          '=== Cross-Project Learning Stats ===',
          `Total patterns: ${store.patterns.length}`,
          `Projects represented: ${projects.size}`,
          `Current project: ${fingerprint}`,
          `By category: ${Object.entries(byCategory).map(([k, v]) => `${k}: ${v}`).join(', ')}`,
          `Last sync: ${store.lastSync || 'never'}`,
        ].join('\n')
      }

      default:
        throw new Error(`Unknown action: ${action}. Use query, record, sync, or stats.`)
    }
  },
}

function formatQueryResults(patterns: Pattern[], total: number): string {
  const lines: string[] = []
  lines.push(`=== Cross-Project Patterns (showing ${patterns.length} of ${total}) ===`)
  if (patterns.length === 0) {
    lines.push('No matching patterns found. Try recording patterns from other projects first.')
    return lines.join('\n')
  }
  for (const p of patterns) {
    lines.push('')
    lines.push(`[${p.category.toUpperCase()}] ${p.title}`)
    lines.push(`  From: ${p.projectFingerprint} | Confidence: ${Math.round(p.confidence * 100)}%`)
    if (p.description) lines.push(`  Problem: ${p.description}`)
    if (p.solution) lines.push(`  Solution: ${p.solution}`)
    if (p.keywords.length > 0) lines.push(`  Keywords: ${p.keywords.join(', ')}`)
  }
  return lines.join('\n')
}

function formatRecordResult(pattern: Pattern): string {
  return [
    '=== Pattern Recorded ===',
    `ID: ${pattern.id}`,
    `Category: ${pattern.category}`,
    `Title: ${pattern.title}`,
    `Project: ${pattern.projectFingerprint}`,
    `Keywords: ${pattern.keywords.join(', ')}`,
    pattern.description ? `Description: ${pattern.description}` : '',
    pattern.solution ? `Solution: ${pattern.solution}` : '',
  ]
    .filter((l) => l.length > 0)
    .join('\n')
}
