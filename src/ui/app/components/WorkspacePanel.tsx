import { useEffect, useState } from 'react'
import { Box, Text } from 'ink'
import { Spinner } from './Spinner.tsx'
import { blendable, palette } from '../theme.ts'
import { motionReduced, useAnimationClock } from '../animation.tsx'
import { mixColor } from '../motion.ts'
import type { TodoItem } from '../../../autonomy/todoList.ts'
import type { TaskSession } from '../../../taskSessions.ts'

/** One step of an escalated run's approved plan. */
export interface RunStep {
  id: string
  title: string
}

/**
 * An approved run plan as a checklist, each step's state read off the worker
 * that carries its id (fleet workers are created with `stepId` = the plan
 * step's id). The latest attempt wins, so a retried step shows its retry.
 * A step whose worker finished — even one flagged for review — is done here;
 * the review verdict lands in scrollback.
 */
export function runPlanFromWorkers(steps: readonly RunStep[], agents: readonly TaskSession[], sessionId?: string): TodoItem[] {
  return steps.map((step) => {
    let latest: TaskSession | undefined
    for (const agent of agents) {
      if (agent.stepId !== step.id) continue
      if (sessionId && agent.sessionId !== sessionId) continue
      if (!latest || agent.updatedAt >= latest.updatedAt) latest = agent
    }
    const status: TodoItem['status'] = !latest
      ? 'pending'
      : latest.status === 'done' || latest.status === 'needs-review'
        ? 'completed'
        : latest.status === 'running'
          ? 'in_progress'
          : 'pending'
    return { content: step.title, status }
  })
}

/** Re-render once a second while something is running, so elapsed times move on their own. */
function useTicker(active: boolean): void {
  const [, setTick] = useState(0)
  useEffect(() => {
    if (!active) return
    const timer = setInterval(() => setTick((n) => n + 1), 1_000)
    return () => clearInterval(timer)
  }, [active])
}

/**
 * What a worker is doing, in words: its task, plus how far along it is. The
 * `action` field is just the last tool that *finished* ("list_files"), which
 * sat unchanged while the model thought — it read as a frozen row.
 */
function workerLabel(agent: TaskSession): string {
  const steps = agent.stepsCompleted > 0 ? ` · ${agent.stepsCompleted} step${agent.stepsCompleted === 1 ? '' : 's'}` : ''
  return `${agent.title || agent.action}${steps}`
}

/** What proved a plan step, and when elia ticked it. */
export interface StepProof {
  text: string
  at: number
}

/** A step's identity across rewrites — the model often drops backticks or quotes when it copies a step back. */
export function stepEvidenceKey(content: string): string {
  return content.replace(/[`'"*]/g, '').replace(/\s+/g, ' ').trim().toLowerCase()
}

/** A tick on evidence lands bright and settles into the plain success green over this long. */
export const TICK_FLASH_MS = 700

function flashColor(sinceMs: number): string | undefined {
  if (!blendable || motionReduced) return palette.success
  return mixColor(palette.brandShimmer, palette.success, Math.min(1, Math.max(0, sinceMs / TICK_FLASH_MS)))
}

/** The ✓ of a step that was just proven — mounted only while it is still settling, so an idle plan costs no frames. */
function FlashingTick({ at }: { at: number }) {
  const now = useAnimationClock()
  return (
    <Text color={flashColor(now - at)} bold>
      ✓
    </Text>
  )
}

const TODO_MARK: Record<TodoItem['status'], string> = {
  pending: '□',
  in_progress: '◐',
  completed: '✓',
}

/** A short bar after the plan's count — how far along it is, at a glance. */
function ProgressBar({ done, total, width = 12 }: { done: number; total: number; width?: number }) {
  const filled = total > 0 ? Math.round((done / total) * width) : 0
  return (
    <Text>
      {'  '}
      <Text color={palette.success}>{'━'.repeat(filled)}</Text>
      <Text color={palette.subtle}>{'─'.repeat(width - filled)}</Text>
    </Text>
  )
}

/** `m:ss` since a worker started — the panel re-renders on every task update, so this ticks forward on its own. */
function elapsed(agent: TaskSession): string {
  const from = agent.startedAt ?? agent.createdAt
  if (!from) return ''
  const secs = Math.max(0, Math.round((Date.now() - from) / 1000))
  if (secs < 1) return ''
  return secs < 60 ? `${secs}s` : `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`
}

/**
 * How far one wave of the fleet has got: workers in it that finished (done or
 * handed over for review) out of all of them. Undefined for a wave of one —
 * a bar over a single worker says nothing its own row does not.
 */
export function waveProgress(workers: readonly TaskSession[], wave: number): { done: number; total: number } | undefined {
  const inWave = workers.filter((worker) => worker.wave === wave)
  if (inWave.length < 2) return undefined
  return { done: inWave.filter((worker) => worker.status === 'done' || worker.status === 'needs-review').length, total: inWave.length }
}

/** Genuinely-active states — the only ones that stay in the live panel across refreshes. */
const LIVE_STATUS = new Set<TaskSession['status']>(['running', 'pending'])

/**
 * What elia is doing *right now*: the live plan + the subagents working this
 * run. The plan comes from the agent's own todo_write calls; the workers from
 * taskSessions, filtered to the current session.
 *
 * Deliberately not a dashboard — finished workers collapse to a one-line
 * receipt, history lives in /sessions and /task, and a worker from a previous
 * process never appears here (it carries an older sessionId). A fresh chat
 * shows nothing at all.
 */
export function WorkspacePanel({
  plan,
  agents,
  since = 0,
  sessionId,
  expanded = false,
  evidence,
}: {
  plan: TodoItem[]
  agents: TaskSession[]
  since?: number
  /** The current REPL/run session. When set, only workers stamped with it are shown. */
  sessionId?: string
  /** Ctrl+O: show each live worker's task and last few tool calls. */
  expanded?: boolean
  /** Steps elia ticked on evidence (keyed by `stepEvidenceKey`), and what proved each. */
  evidence?: ReadonlyMap<string, StepProof>
}) {
  // A worker belongs to this run if it carries this session's id. `tasks.json`
  // is reloaded on every startup, so without this check a `needs-review` or
  // `paused` worker from yesterday's run would sit here with a live spinner.
  // The `since` fallback keeps older, unstamped records working the way they
  // did before session ids existed.
  const mine = (a: TaskSession): boolean => {
    if (!a.role || a.role === 'lead') return false
    if (sessionId) return a.sessionId === sessionId
    return a.sessionId === undefined && (a.finishedAt ?? a.updatedAt) >= since
  }

  // Collapse retries of the same plan step into their latest attempt, so two
  // "builder" rows don't appear when one is a retry of the other.
  const latestByStep = new Map<string, TaskSession>()
  const stepOrder: string[] = []
  for (const a of agents) {
    if (!mine(a)) continue
    const key = a.stepId ?? a.id
    const prev = latestByStep.get(key)
    if (!prev) stepOrder.push(key)
    if (!prev || a.updatedAt >= prev.updatedAt) latestByStep.set(key, a)
  }
  const workers = stepOrder.map((key) => latestByStep.get(key)!)
  const live = workers.filter((a) => LIVE_STATUS.has(a.status))
  const liveWaves = [...new Set(live.map((a) => a.wave).filter((w): w is number => typeof w === 'number'))].sort((a, b) => a - b)
  const finished = workers.filter((a) => !LIVE_STATUS.has(a.status))
  const doneCount = finished.filter((a) => a.status === 'done').length
  const reviewCount = finished.filter((a) => a.status === 'needs-review').length
  const failedCount = finished.filter((a) => a.status === 'failed' || a.status === 'paused').length
  // One wave under way: how far through it the fleet is, at a glance.
  const wave = liveWaves.length === 1 ? waveProgress(workers, liveWaves[0]!) : undefined
  useTicker(live.length > 0)

  if (plan.length === 0 && live.length === 0 && finished.length === 0) return null

  // Show what's happening, not the whole backlog: done items + the current one +
  // a couple ahead.
  const current = Math.max(0, plan.findIndex((item) => item.status === 'in_progress'))
  const start = Math.max(0, Math.min(current - 1, plan.length - 6))
  const shown = plan.slice(start, start + 6)
  const planDone = plan.filter((item) => item.status === 'completed').length

  const receipt = [
    doneCount > 0 ? `${doneCount} done` : '',
    reviewCount > 0 ? `${reviewCount} need review` : '',
    failedCount > 0 ? `${failedCount} stopped` : '',
  ]
    .filter(Boolean)
    .join(' · ')

  return (
    <Box flexDirection="column" width="100%" marginTop={1}>
      {plan.length > 0 && (
        <Box flexDirection="column">
          <Text>
            <Text bold>Plan</Text>
            {plan.length > 1 ? <Text color={palette.muted}> · {planDone}/{plan.length}</Text> : null}
            {plan.length > 1 ? <ProgressBar done={planDone} total={plan.length} /> : null}
          </Text>
          {start > 0 && <Text color={palette.muted}>  … {start} done</Text>}
          {shown.map((item, i) => {
            // Proven by something elia watched run, not just marked done by the
            // model: say what proved it, and let the tick land.
            const proof = item.status === 'completed' ? evidence?.get(stepEvidenceKey(item.content)) : undefined
            const settling = proof !== undefined && Date.now() - proof.at < TICK_FLASH_MS
            return (
              <Text key={start + i} wrap="truncate-end">
                {'  '}
                {settling ? (
                  <FlashingTick at={proof.at} />
                ) : (
                  <Text color={item.status === 'completed' ? palette.success : item.status === 'in_progress' ? palette.brand : palette.muted} bold={proof !== undefined}>
                    {TODO_MARK[item.status]}
                  </Text>
                )}{' '}
                <Text
                  bold={item.status === 'in_progress'}
                  strikethrough={item.status === 'completed'}
                  color={item.status === 'in_progress' ? undefined : palette.muted}
                >
                  {item.content}
                </Text>
                {proof ? <Text color={palette.muted}> · {proof.text}</Text> : null}
              </Text>
            )
          })}
          {start + shown.length < plan.length && <Text color={palette.muted}>  … {plan.length - start - shown.length} more</Text>}
        </Box>
      )}

      {live.length > 0 && (
        <Box flexDirection="column" marginTop={plan.length > 0 ? 1 : 0}>
          <Text>
            <Text bold>Subagents</Text>
            <Text color={palette.muted}>
              {' '}· {live.length} running
              {liveWaves.length > 0 ? ` · wave ${liveWaves.join(', ')}` : ''}
            </Text>
            {wave ? <ProgressBar done={wave.done} total={wave.total} width={8} /> : null}
            {wave ? <Text color={palette.muted}> {wave.done}/{wave.total}</Text> : null}
          </Text>
          {live.slice(0, 6).map((agent) => (
            <Box key={agent.id} flexDirection="column">
            <Box>
              <Text>{'  '}</Text>
              <Box width={2} flexShrink={0}>
                <Spinner />
              </Box>
              <Text wrap="truncate-end">
                <Text>{agent.role}</Text>
                {agent.attempts > 1 && <Text color={palette.muted}> · try {agent.attempts}</Text>}
                <Text color={palette.muted}> · {workerLabel(agent)}</Text>
                {elapsed(agent) ? <Text color={palette.muted}> · {elapsed(agent)}</Text> : null}
              </Text>
            </Box>
            {expanded && (
              <Box flexDirection="column" marginLeft={6}>
                <Text color={palette.muted} wrap="truncate-end">task: {agent.title}</Text>
                {(agent.recentSteps ?? []).length === 0 ? (
                  <Text color={palette.muted}>no tool calls yet</Text>
                ) : (
                  (agent.recentSteps ?? []).map((step, i) => (
                    <Text key={i} color={palette.muted} wrap="truncate-end">{step}</Text>
                  ))
                )}
              </Box>
            )}
            </Box>
          ))}
          {live.length > 6 && <Text color={palette.muted}>  … {live.length - 6} more</Text>}
        </Box>
      )}

      {live.length === 0 && finished.length > 0 && receipt && (
        <Box marginTop={plan.length > 0 ? 1 : 0}>
          <Text color={reviewCount > 0 || failedCount > 0 ? palette.warning : palette.success}>
            {reviewCount > 0 || failedCount > 0 ? '!' : '✓'}{' '}
          </Text>
          <Text color={palette.muted}>
            {finished.length} worker{finished.length === 1 ? '' : 's'} · {receipt}
          </Text>
        </Box>
      )}
    </Box>
  )
}
