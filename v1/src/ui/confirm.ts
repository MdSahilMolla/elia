import { writeNotice } from './stream.ts'

/**
 * The shared one-shot approval gate: yes, no, or an amendment. Used both by
 * `elia auto`'s plan approval and by the interactive REPL's per-command
 * confirmation — same y/n/e-edit UX either way, so a user only has to learn it
 * once. `e <feedback>` sends the thing back for rework rather than forcing a
 * reject-and-retype.
 */
export type ConfirmResult =
  | { action: 'approve' }
  | { action: 'reject' }
  | { action: 'amend'; feedback: string }

/** The subset of readline.Interface / SlashPromptHandle this needs — just ask a question, get a line back (or null on EOF). */
export interface Asker {
  question(label: string): Promise<string | null>
}

export async function confirmOnce(asker: Asker, promptLabel: string): Promise<ConfirmResult> {
  while (true) {
    const raw = await asker.question(promptLabel)
    if (raw === null) return { action: 'reject' } // stdin closed mid-prompt — safest is to not run it

    const answer = raw.trim()
    const lower = answer.toLowerCase()

    if (lower === 'y' || lower === 'yes') return { action: 'approve' }
    if (lower === 'n' || lower === 'no') return { action: 'reject' }

    if (lower === 'e' || lower === 'edit') {
      const feedbackRaw = await asker.question('What should change? ')
      const feedback = feedbackRaw?.trim() ?? ''
      if (feedback) return { action: 'amend', feedback }
      continue
    }
    if (lower.startsWith('e ')) return { action: 'amend', feedback: answer.slice(2).trim() }

    // A real sentence at this prompt obviously means "change this" — but
    // anything shorter and ambiguous (like "ok") gets an explicit nudge
    // instead of silently re-prompting with no explanation.
    if (answer.length > 3) return { action: 'amend', feedback: answer }
    writeNotice(`"${answer}" isn't y/n/e — type y, n, or "e <what to change>".`)
  }
}
