import { existsSync, readFileSync } from 'node:fs'

/**
 * What the agent did on a benchmark task that failed, as the proposer reads it.
 *
 * The proposer is asked to find the weakest link from the failures, and until
 * this existed it was shown the check's one-line verdict and a temporary
 * directory. The first full sweep on this machine made the cost of that plain:
 * `field-external-contribution` failed 0/3 with "nothing was pushed", which
 * reads like a git or policy problem, while the directory showed the fix made
 * and never committed and the outcome said `step-budget`. The agent ran out of
 * steps — and no one could see what it spent them on. And once the baseline
 * cache served a failure, not even the directory was left: it lives in the
 * system temp dir, and the cache does not keep its path.
 *
 * So `benchTask.ts` writes one redacted line per tool call and per stretch of
 * the agent's own text to `TRACE_OUT_ENV`, and a failing attempt keeps a
 * rendering of it on its outcome — which the baseline cache stores and the
 * proposer's brief prints. Held-out failures never reach the brief, so neither
 * do their traces (split.ts).
 *
 * Rendering happens here, in the parent, and never in a task: a benchmark child
 * only appends lines. Immutable to the loop (sandbox.ts) for the reason
 * fieldEvidence.ts is — what a later generation is shown is part of how it
 * searches, and a candidate must not be able to choose it.
 */

/** Read by `benchTask.ts`, which spells it out rather than importing this module into every task. */
export const TRACE_OUT_ENV = 'ELIA_BENCH_TRACE_OUT'

export interface TraceEvent {
  tool?: string
  input?: string
  ok?: boolean
  result?: string
  decision?: string
  say?: string
}

export function readTrace(path: string): TraceEvent[] {
  if (!existsSync(path)) return []
  try {
    return readFileSync(path, 'utf8')
      .split('\n')
      .filter((line) => line.trim())
      .flatMap((line) => {
        try {
          const parsed = JSON.parse(line) as TraceEvent
          return parsed && typeof parsed === 'object' ? [parsed] : []
        } catch {
          return []
        }
      })
  } catch {
    return []
  }
}

const clip = (text: string | undefined, max: number): string => {
  const flat = (text ?? '').replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

function renderEvent(event: TraceEvent): string {
  if (event.say !== undefined) return `said: ${clip(event.say, 160)}`
  const verdict = event.decision ? `${event.decision.toUpperCase()} by the governor` : event.ok ? 'ok' : 'ERROR'
  return `${event.tool ?? '?'} ${clip(event.input, 110)} → ${verdict}: ${clip(event.result, 110)}`
}

/**
 * Numbered, one line per event, bounded. A long run keeps its opening and its
 * end and says how much was cut from the middle: how a run started shows the
 * plan, and how it ended shows where it ran out.
 */
export function renderTrace(events: TraceEvent[], maxLines = 24): string {
  if (events.length === 0) return ''
  const lines = events.map((event, index) => `${index + 1}. ${renderEvent(event)}`)
  if (lines.length <= maxLines) return lines.join('\n')
  const head = Math.floor(maxLines / 3)
  const tail = maxLines - head
  return [...lines.slice(0, head), `… ${lines.length - maxLines} event(s) not shown …`, ...lines.slice(-tail)].join('\n')
}
