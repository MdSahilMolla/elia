import { relative } from 'node:path'
import type { StructuralOutcome } from '../reason/structural.ts'

/**
 * What a turn that ended early left behind, said where the person will see it.
 *
 * A turn that dies mid-work — every provider route out of credit, a context
 * overflow, the person pressing Esc — has often already written files. Those
 * writes were never verified: the gate that checks and repairs a change runs
 * after the model finishes, and this turn never finished. The recorded history
 * shows it: 10 of the 19 file-changing turns that ended unverified or failing
 * were stopped or crashed, and one crashed turn had written ten pages of a site.
 * Nothing said so, and those turns had no rewind point either, so `/rewind`
 * could not undo them.
 *
 * `structural` is the in-process parse of the touched files — free, no model,
 * no network — so a file the turn left half-written is named rather than found
 * later.
 */
export interface InterruptedTurn {
  /** How the turn ended: `failed` threw, `stopped` was cancelled. */
  ending: 'failed' | 'stopped'
  /** Absolute paths the turn changed, created or deleted. */
  touched: string[]
  /** The rewind point this turn was recorded as — `/rewind <n>` restores the files as they were before it. */
  rewindIndex: number
  structural?: StructuralOutcome
  cwd: string
}

export function describeInterruptedTurn(turn: InterruptedTurn): string | undefined {
  if (turn.touched.length === 0) return undefined
  const count = `${turn.touched.length} file${turn.touched.length === 1 ? '' : 's'}`
  const how = turn.ending === 'failed' ? 'This turn failed' : 'This turn was stopped'
  const shown = turn.touched.slice(0, 4).map((path) => displayPath(path, turn.cwd))
  const more = turn.touched.length > shown.length ? `, … ${turn.touched.length - shown.length} more` : ''
  const broken = turn.structural?.broken ?? []
  const damage = broken.length > 0
    ? ` ${broken.length === 1 ? `${displayPath(broken[0]!.file, turn.cwd)} does not parse` : `${broken.length} of them do not parse`} — it was left mid-edit.`
    : ''
  return `${how} after changing ${count} (${shown.join(', ')}${more}), and nothing verified ${turn.touched.length === 1 ? 'it' : 'them'}.${damage} \`continue\` picks the work up; \`/rewind ${turn.rewindIndex}\` puts the files back as they were.`
}

function displayPath(path: string, cwd: string): string {
  const rel = relative(cwd, path)
  return rel && !rel.startsWith('..') ? rel.replaceAll('\\', '/') : path
}
