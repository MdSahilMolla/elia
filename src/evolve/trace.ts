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
  /** When the child wrote it. */
  at?: number
  /** Pairs a tool's start with its result. */
  id?: string
  /** A tool call began; its result arrives as a later `tool` event. */
  start?: string
  /** The model was still streaming at `at`. */
  beat?: boolean
  tool?: string
  input?: string
  ok?: boolean
  result?: string
  decision?: string
  say?: string
}

/** How long a model may send nothing before a run killed at its timeout counts as the provider's stall. */
export const MODEL_SILENCE_MS = 60_000

/**
 * Whether a run stopped at its timeout was waiting on the model rather than on
 * itself.
 *
 * A hang is normally the agent's own fault — a command that never exits, a loop
 * that never ends — and it has to be able to score as one. But the first sweep
 * with traces had a `precise-edit` attempt read, edit correctly and re-read in
 * seconds, then wait five minutes for a final answer the provider never sent,
 * and the harness scored it as elia failing. So: a tool that started and never
 * finished is the agent's; a model that had sent nothing for
 * `MODEL_SILENCE_MS` when the run was stopped is the provider's.
 */
export function waitingOnModel(events: TraceEvent[], spawnedAt: number, stoppedAt: number, silenceMs = MODEL_SILENCE_MS): boolean {
  const finished = new Set(events.flatMap((event) => (event.tool !== undefined && event.id ? [event.id] : [])))
  if (events.some((event) => event.start !== undefined && (!event.id || !finished.has(event.id)))) return false
  const lastHeard = Math.max(spawnedAt, ...events.map((event) => event.at ?? 0))
  return stoppedAt - lastHeard >= silenceMs
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
  if (event.start !== undefined) return `${event.start} started and never finished`
  const verdict = event.decision ? `${event.decision.toUpperCase()} by the governor` : event.ok ? 'ok' : 'ERROR'
  return `${event.tool ?? '?'} ${clip(event.input, 110)} → ${verdict}: ${clip(event.result, 110)}`
}

/**
 * Numbered, one line per event, bounded. A long run keeps its opening and its
 * end and says how much was cut from the middle: how a run started shows the
 * plan, and how it ended shows where it ran out.
 */
export function renderTrace(events: TraceEvent[], maxLines = 24): string {
  const finished = new Set(events.flatMap((event) => (event.tool !== undefined && event.id ? [event.id] : [])))
  // Beats and the starts of tools that finished are bookkeeping; a start with
  // no result is the one that matters — it is where the run was stuck.
  const shown = events.filter((event) => !event.beat && (event.start === undefined || !event.id || !finished.has(event.id)))
  if (shown.length === 0) return ''
  const lines = shown.map((event, index) => `${index + 1}. ${renderEvent(event)}`)
  if (lines.length <= maxLines) return lines.join('\n')
  const head = Math.floor(maxLines / 3)
  const tail = maxLines - head
  return [...lines.slice(0, head), `… ${lines.length - maxLines} event(s) not shown …`, ...lines.slice(-tail)].join('\n')
}
