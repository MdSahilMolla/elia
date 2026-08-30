import { existsSync, readFileSync } from 'node:fs'
import { paths } from '../config.ts'
import { getActiveLedgerSession, listLedgerSessionIds } from '../ledger.ts'
import { loadBrainItems } from './store.ts'
import { searchBrain } from './search.ts'
import { loadRelevance } from './relevance.ts'
import { consolidateBrain } from './consolidate.ts'

/**
 * Backs the `/brain` slash command: no argument shows what the project brain
 * holds, `/brain consolidate` runs the tidy-up pass, anything else is a search.
 */
export async function runBrainCommand(arg: string): Promise<string> {
  const query = arg.trim()

  if (query === 'consolidate') {
    const result = await consolidateBrain({ force: true })
    if (!result.changed) return `Brain consolidation: ${result.reason}.`
    return `Brain consolidated: lessons ${result.lessonsBefore} → ${result.lessonsAfter}, ${result.notesRemoved} redundant note(s) dropped.`
  }

  const items = await loadBrainItems({ currentSessionId: getActiveLedgerSession()?.id })

  if (!query) {
    const counts = { episode: 0, lesson: 0, rationale: 0, note: 0 }
    for (const item of items) counts[item.kind] += 1
    const sessions = listLedgerSessionIds().length
    const lines = [
      `Project brain — ${items.length} item(s):`,
      `  ${counts.episode} episode(s) across ${sessions} session(s)`,
      `  ${counts.lesson} lesson(s) · ${counts.rationale} rationale note(s) · ${counts.note} saved note(s)`,
    ]
    if (existsSync(paths.brainConsolidatedAt)) {
      try {
        const at = Number.parseInt(readFileSync(paths.brainConsolidatedAt, 'utf8').trim(), 10)
        if (Number.isFinite(at)) lines.push(`  last consolidated ${new Date(at).toISOString().slice(0, 16).replace('T', ' ')}`)
      } catch {
        // no-op — the timestamp is informational
      }
    }
    lines.push('', 'Search it with /brain <query>, tidy it with /brain consolidate.')
    return lines.join('\n')
  }

  if (items.length === 0) return 'The project brain is empty — nothing has been recorded here yet.'

  const hits = searchBrain(items, query, { relevance: loadRelevance(), limit: 8 })
  if (hits.length === 0) return `Nothing in the project brain matched "${query}".`
  return hits.map((hit) => hit.item.render).join('\n\n')
}
