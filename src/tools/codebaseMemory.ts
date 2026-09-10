import type { Tool } from './types.ts'
import { optionalString } from './args.ts'
import { runShell } from '../shell.ts'
import { resolveWorkspacePath } from '../autonomy/context.ts'
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

const SHELL_TIMEOUT_MS = 15_000
const MAX_RESULTS = 50

interface MemoryEntry {
  id: string
  timestamp: string
  category: 'decision' | 'bugfix' | 'pattern' | 'architecture' | 'lesson'
  file?: string
  title: string
  description: string
  tags: string[]
  confidence: number
}

function getMemoryStorePath(cwd: string): string {
  return join(cwd, '.elia', 'memory.json')
}

function loadMemory(cwd: string): MemoryEntry[] {
  const path = getMemoryStorePath(cwd)
  if (!existsSync(path)) return []
  try {
    const data = readFileSync(path, 'utf-8')
    return JSON.parse(data) as MemoryEntry[]
  } catch {
    return []
  }
}

function saveMemory(cwd: string, entries: MemoryEntry[]): void {
  const dir = join(cwd, '.elia')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  writeFileSync(getMemoryStorePath(cwd), JSON.stringify(entries, null, 2))
}

function generateId(): string {
  return `mem_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
}

function scoreRelevance(entry: MemoryEntry, query: string): number {
  const queryLower = query.toLowerCase()
  const terms = queryLower.split(/\s+/).filter((t) => t.length > 2)
  let score = 0
  const titleLower = entry.title.toLowerCase()
  const descLower = entry.description.toLowerCase()
  const tagStr = entry.tags.join(' ').toLowerCase()

  for (const term of terms) {
    if (titleLower.includes(term)) score += 3
    if (descLower.includes(term)) score += 1
    if (tagStr.includes(term)) score += 2
  }
  if (entry.file) {
    const fileLower = entry.file.toLowerCase()
    for (const term of terms) {
      if (fileLower.includes(term)) score += 2
    }
  }
  score += entry.confidence * 0.5
  const age = Date.now() - new Date(entry.timestamp).getTime()
  const dayMs = 86400000
  if (age < dayMs * 7) score += 2
  else if (age < dayMs * 30) score += 1
  return score
}

function formatEntry(entry: MemoryEntry): string {
  const parts = [`[${entry.category.toUpperCase()}] ${entry.title}`]
  if (entry.file) parts.push(`File: ${entry.file}`)
  parts.push(entry.description)
  if (entry.tags.length > 0) parts.push(`Tags: ${entry.tags.join(', ')}`)
  parts.push(`Confidence: ${Math.round(entry.confidence * 100)}% | ${entry.timestamp}`)
  return parts.join('\n  ')
}

function formatReport(action: string, data: unknown): string {
  const lines: string[] = []
  lines.push(`=== Codebase Memory (${action}) ===`)
  lines.push('')

  if (action === 'query' && Array.isArray(data)) {
    if (data.length === 0) {
      lines.push('No matching memories found.')
    } else {
      lines.push(`Found ${data.length} matching memor${data.length === 1 ? 'y' : 'ies'}:`)
      for (const entry of data) {
        lines.push('')
        lines.push(formatEntry(entry as MemoryEntry))
      }
    }
  } else if (action === 'record') {
    const entry = data as MemoryEntry
    lines.push('Recorded new memory:')
    lines.push(formatEntry(entry))
  } else if (action === 'update') {
    lines.push(`Updated memory: ${data}`)
  } else if (action === 'stats') {
    const stats = data as { total: number; byCategory: Record<string, number>; recentDays: number }
    lines.push(`Total memories: ${stats.total}`)
    lines.push(`By category: ${Object.entries(stats.byCategory).map(([k, v]) => `${k}: ${v}`).join(', ')}`)
    lines.push(`Memories from last 7 days: ${stats.recentDays}`)
  } else if (action === 'list') {
    const entries = data as MemoryEntry[]
    lines.push(`All memories (${entries.length}):`)
    for (const entry of entries) {
      lines.push(`  - [${entry.category}] ${entry.title} (${entry.file ?? 'no file'})`)
    }
  }

  return lines.join('\n')
}

export const codebaseMemoryTool: Tool = {
  name: 'codebase_memory',
  description:
    'Persistent semantic memory for the codebase. Record decisions, bug fixes, patterns, architectural choices, and lessons. Query memories by keyword, category, file, or time range. Maintains a local JSON store in .elia/memory.json.',
  input_schema: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        description: 'Action: query (search), record (add), update (modify), delete (remove), stats (overview), list (all)',
        enum: ['query', 'record', 'update', 'delete', 'stats', 'list'],
      },
      query: { type: 'string', description: 'Search terms for query action' },
      category: { type: 'string', description: 'Memory category: decision, bugfix, pattern, architecture, lesson' },
      file: { type: 'string', description: 'Associated file path' },
      title: { type: 'string', description: 'Title for record/update actions' },
      description: { type: 'string', description: 'Description for record/update actions' },
      tags: { type: 'string', description: 'Comma-separated tags for record/update actions' },
      id: { type: 'string', description: 'Memory ID for update/delete actions' },
      limit: { type: 'number', description: `Max results for query/list (1-${MAX_RESULTS}, default 10)` },
    },
    required: ['action'],
  },
  async execute(input) {
    const action = optionalString(input.action, 'action') ?? 'query'
    const cwd = resolveWorkspacePath('.')
    const entries = loadMemory(cwd)

    switch (action) {
      case 'query': {
        const query = optionalString(input.query, 'query') ?? ''
        const category = optionalString(input.category, 'category')
        const file = optionalString(input.file, 'file')
        const limit = Math.min(Math.max(typeof input.limit === 'number' ? input.limit : 10, 1), MAX_RESULTS)

        let filtered = entries
        if (category) filtered = filtered.filter((e) => e.category === category)
        if (file) filtered = filtered.filter((e) => e.file?.includes(file))

        if (query) {
          const scored = filtered.map((e) => ({ entry: e, score: scoreRelevance(e, query) }))
          scored.sort((a, b) => b.score - a.score)
          return formatReport('query', scored.slice(0, limit).map((s) => s.entry))
        }
        return formatReport('query', filtered.slice(0, limit))
      }

      case 'record': {
        const title = optionalString(input.title, 'title')
        if (!title) throw new Error('title is required for record action')
        const description = optionalString(input.description, 'description') ?? ''
        const category = (optionalString(input.category, 'category') as MemoryEntry['category']) ?? 'pattern'
        const file = optionalString(input.file, 'file')
        const tags = optionalString(input.tags, 'tags')?.split(',').map((t) => t.trim()) ?? []

        const entry: MemoryEntry = {
          id: generateId(),
          timestamp: new Date().toISOString(),
          category,
          file,
          title,
          description,
          tags,
          confidence: 0.8,
        }
        entries.push(entry)
        saveMemory(cwd, entries)
        return formatReport('record', entry)
      }

      case 'update': {
        const id = optionalString(input.id, 'id')
        if (!id) throw new Error('id is required for update action')
        const idx = entries.findIndex((e) => e.id === id)
        if (idx === -1) throw new Error(`Memory not found: ${id}`)
        const entry = entries[idx]!
        const title = optionalString(input.title, 'title')
        if (title) entry.title = title
        const description = optionalString(input.description, 'description')
        if (description) entry.description = description
        const category = optionalString(input.category, 'category') as MemoryEntry['category'] | undefined
        if (category) entry.category = category
        const file = optionalString(input.file, 'file')
        if (file) entry.file = file
        const tags = optionalString(input.tags, 'tags')
        if (tags) entry.tags = tags.split(',').map((t) => t.trim())
        saveMemory(cwd, entries)
        return formatReport('update', `Memory ${id} updated successfully`)
      }

      case 'delete': {
        const id = optionalString(input.id, 'id')
        if (!id) throw new Error('id is required for delete action')
        const before = entries.length
        const filtered = entries.filter((e) => e.id !== id)
        if (filtered.length === before) throw new Error(`Memory not found: ${id}`)
        saveMemory(cwd, filtered)
        return formatReport('delete', `Memory ${id} deleted successfully`)
      }

      case 'stats': {
        const byCategory: Record<string, number> = {}
        const weekAgo = Date.now() - 7 * 86400000
        let recentDays = 0
        for (const e of entries) {
          byCategory[e.category] = (byCategory[e.category] ?? 0) + 1
          if (new Date(e.timestamp).getTime() > weekAgo) recentDays++
        }
        return formatReport('stats', { total: entries.length, byCategory, recentDays })
      }

      case 'list': {
        const limit = Math.min(Math.max(typeof input.limit === 'number' ? input.limit : MAX_RESULTS, 1), MAX_RESULTS)
        return formatReport('list', entries.slice(-limit))
      }

      default:
        throw new Error(`Unknown action: ${action}. Use query, record, update, delete, stats, or list.`)
    }
  },
}
