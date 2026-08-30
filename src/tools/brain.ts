import type { Tool } from './types.ts'
import { getActiveLedgerSession } from '../ledger.ts'
import { loadBrainItems } from '../brain/store.ts'
import { searchBrain } from '../brain/search.ts'
import { buildCard } from '../brain/cards.ts'
import { appendNote } from '../brain/notes.ts'
import { bumpBrainRecalled, loadRelevance, markBrainRecalled } from '../brain/relevance.ts'

/**
 * elia's second brain: durable, cross-session project knowledge in one place.
 *
 * `recall` reaches back into *this* conversation's compacted history. `brain`
 * reaches across *every* session that has ever worked this project — the
 * episodes they archived, the lessons they learned, the rationale they
 * recorded, and free-form notes — ranked together. Use it at the start of a
 * task to see what past sessions already figured out, and `brain` with
 * `action: "save"` to leave a durable fact for the next one.
 */
export const brainTool: Tool = {
  name: 'brain',
  description:
    `Search or add to elia's long-term, cross-session memory for this project.

action "search" (default): find what any past session learned — archived episodes, lessons, recorded rationale, and saved notes — ranked against your query. Use this before starting a task, or whenever you suspect this ground has been covered before. Optionally pass "file" to bias results toward a path you are working on, or "kind" to restrict to one of episode/lesson/rationale/note.

action "save": record a durable fact about how this project or its dependencies actually behave — something a future session would want to know that is not a "before you start" instruction (that is note_lesson) and not a per-file design decision (that is record_rationale). Pass "text", and optionally "paths" it concerns and "tags".

action "card": return everything the brain knows about one "file".`,
  input_schema: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['search', 'save', 'card'], description: 'Defaults to "search".' },
      query: { type: 'string', description: 'search: what to look for' },
      file: { type: 'string', description: 'search: bias toward this path · card: the path to summarise' },
      kind: { type: 'string', enum: ['episode', 'lesson', 'rationale', 'note'], description: 'search: restrict to one kind' },
      limit: { type: 'number', description: 'search: max results (default 6)' },
      text: { type: 'string', description: 'save: the durable fact' },
      paths: { type: 'array', items: { type: 'string' }, description: 'save: repo-relative paths the fact concerns' },
      tags: { type: 'array', items: { type: 'string' }, description: 'save: free tags' },
    },
  },
  async execute(input) {
    const action = typeof input.action === 'string' ? input.action : 'search'
    const currentSessionId = getActiveLedgerSession()?.id

    if (action === 'save') {
      const text = typeof input.text === 'string' ? input.text.trim() : ''
      if (!text) return 'brain save needs "text".'
      const paths = Array.isArray(input.paths) ? input.paths.filter((p): p is string => typeof p === 'string') : []
      const tags = Array.isArray(input.tags) ? input.tags.filter((t): t is string => typeof t === 'string') : []
      const note = appendNote({ text, paths, tags }, undefined)
      return note ? `Saved to the project brain: "${note.text}"` : 'Not saved — that fact is already in the brain (or was empty).'
    }

    const items = await loadBrainItems({ currentSessionId })
    if (items.length === 0) return 'The project brain is empty — no past session has recorded anything here yet.'

    if (action === 'card') {
      const file = typeof input.file === 'string' ? input.file.trim() : ''
      if (!file) return 'brain card needs "file".'
      const card = buildCard(items, file)
      return card ? `What the brain knows about ${card.path}:\n${card.lines.join('\n')}` : `The brain has nothing recorded about "${file}".`
    }

    const query = typeof input.query === 'string' ? input.query.trim() : ''
    if (!query) return 'brain search needs "query".'
    const file = typeof input.file === 'string' ? input.file.trim() : undefined
    const kind = typeof input.kind === 'string' ? (input.kind as 'episode' | 'lesson' | 'rationale' | 'note') : undefined
    const limit = typeof input.limit === 'number' && input.limit > 0 ? Math.floor(input.limit) : 6

    const hits = searchBrain(items, query, {
      limit,
      activePaths: file ? [file] : [],
      relevance: loadRelevance(),
      kinds: kind ? [kind] : undefined,
    })
    if (hits.length === 0) return `Nothing in the project brain matched "${query}".`

    markBrainRecalled(hits.map((hit) => ({ key: hit.item.key, paths: hit.item.paths })))
    bumpBrainRecalled(hits.map((hit) => hit.item.key))

    return hits.map((hit) => hit.item.render).join('\n\n')
  },
}
