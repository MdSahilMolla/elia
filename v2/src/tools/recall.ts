import type { Tool } from './types.ts'
import { getActiveLedgerSession, loadLedger, bumpRecall, markRecalled } from '../ledger.ts'
import { loadCheckpoints, peekCheckpointFile } from '../checkpoint.ts'
import { searchLedger } from '../recall.ts'

/**
 * The retrieval half of elia's episodic memory: compaction.ts keeps the live
 * prompt bounded by archiving old turns into the ledger instead of just deleting
 * them (see ledger.ts). This tool is how the model pulls one of those episodes
 * back when it needs something it can no longer see in the live window.
 */
export const recallTool: Tool = {
  name: 'recall',
  description:
    "Search elia's long-term episodic memory for this session — facts, decisions, files touched, and open threads from earlier parts of the conversation that were compacted out of the live context window to keep it fast. Nothing is actually lost when that happens: use this tool whenever you need something from earlier that you can no longer see. Pass `file` to also pull that file's exact content as it was at the point the best-matching episode happened.",
  input_schema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'What to recall — a topic, decision, file name, or symbol' },
      file: { type: 'string', description: "Optional: also retrieve this file's content as of the best-matching episode" },
      limit: { type: 'number', description: 'Max episodes to return (default 5)' },
    },
    required: ['query'],
  },
  async execute(input) {
    const session = getActiveLedgerSession()
    if (!session) return 'No archived session context available — recall only works inside an interactive elia session.'

    const query = typeof input.query === 'string' ? input.query.trim() : ''
    if (!query) return 'recall needs a query.'
    const limit = typeof input.limit === 'number' && input.limit > 0 ? Math.floor(input.limit) : 5

    const records = await loadLedger(session.id)
    if (records.length === 0) return 'Nothing archived yet for this session — the live context window still holds everything.'

    const hits = searchLedger(records, query, limit)
    if (hits.length === 0) return `No archived episode matched "${query}".`

    markRecalled(hits.map((hit) => hit.record))
    await bumpRecall(session.id, hits.map((hit) => hit.record.id))

    const lines = hits.map(({ record }) => {
      const parts = [`turn ${record.turn} — ${record.summary}`]
      if (record.decisions.length > 0) parts.push(`  decisions: ${record.decisions.join('; ')}`)
      if (record.filesTouched.length > 0) parts.push(`  files: ${record.filesTouched.join(', ')}`)
      if (record.symbols.length > 0) parts.push(`  symbols: ${record.symbols.join(', ')}`)
      if (record.openThreads.length > 0) parts.push(`  open: ${record.openThreads.join('; ')}`)
      return parts.join('\n')
    })

    const filePath = typeof input.file === 'string' ? input.file.trim() : undefined
    if (filePath) {
      const owner = hits.find((hit) => hit.record.filesTouched.includes(filePath))
      if (!owner) {
        lines.push(`\n(no matched episode touched "${filePath}")`)
      } else {
        const checkpoints = await loadCheckpoints(session.id)
        const checkpoint = checkpoints[owner.record.turn]
        const content = checkpoint ? peekCheckpointFile(checkpoint, filePath) : undefined
        if (content === undefined) {
          lines.push(`\n(no file snapshot for "${filePath}" at turn ${owner.record.turn})`)
        } else {
          lines.push(
            `\n--- ${filePath} as of turn ${owner.record.turn} ---\n${content === null ? '(did not exist yet)' : content}`,
          )
        }
      }
    }

    return lines.join('\n\n')
  },
}
