import { Box, Text } from 'ink'
import { Spinner } from './Spinner.tsx'
import { palette } from '../theme.ts'
import type { TodoItem } from '../../../autonomy/todoList.ts'
import type { TaskSession } from '../../../taskSessions.ts'

const TODO_MARK: Record<TodoItem['status'], string> = {
  pending: '□',
  in_progress: '◐',
  completed: '✓',
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
}: {
  plan: TodoItem[]
  agents: TaskSession[]
  since?: number
  /** The current REPL/run session. When set, only workers stamped with it are shown. */
  sessionId?: string
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
  const finished = workers.filter((a) => !LIVE_STATUS.has(a.status))
  const doneCount = finished.filter((a) => a.status === 'done').length
  const reviewCount = finished.filter((a) => a.status === 'needs-review').length
  const failedCount = finished.filter((a) => a.status === 'failed' || a.status === 'paused').length

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
    <Box flexDirection="column" width="100%" marginTop={1} borderStyle="round" borderColor={palette.muted} paddingX={1}>
      {plan.length > 0 && (
        <Box flexDirection="column">
          <Text color={palette.muted}>PLAN {plan.length > 1 ? `· ${planDone}/${plan.length}` : ''}</Text>
          {start > 0 && <Text color={palette.muted}>  … {start} done</Text>}
          {shown.map((item, i) => (
            <Text
              key={start + i}
              wrap="truncate-end"
              color={item.status === 'completed' ? palette.muted : item.status === 'in_progress' ? palette.accent : undefined}
            >
              {' '}
              {TODO_MARK[item.status]} {item.content}
            </Text>
          ))}
          {start + shown.length < plan.length && <Text color={palette.muted}>  … {plan.length - start - shown.length} more</Text>}
        </Box>
      )}

      {live.length > 0 && (
        <Box flexDirection="column" marginTop={plan.length > 0 ? 1 : 0}>
          <Text color={palette.muted}>SUBAGENTS · {live.length} active</Text>
          {live.slice(0, 6).map((agent) => (
            <Box key={agent.id}>
              <Text color={palette.toolName}>
                {' '}
                <Spinner />{' '}
              </Text>
              <Text wrap="truncate-end">
                <Text bold>{agent.role}</Text>
                {agent.providerName && agent.model && (
                  <Text color={palette.muted}>
                    {' '}
                    · {agent.providerName}/{agent.model}
                  </Text>
                )}
                {agent.wave && <Text color={palette.muted}> · wave {agent.wave}</Text>}
                {agent.attempts > 1 && <Text color={palette.muted}> · try {agent.attempts}</Text>}
                <Text color={palette.muted}> · {agent.action || agent.title}</Text>
              </Text>
            </Box>
          ))}
          {live.length > 6 && <Text color={palette.muted}>  … {live.length - 6} more</Text>}
        </Box>
      )}

      {live.length === 0 && finished.length > 0 && receipt && (
        <Box marginTop={plan.length > 0 ? 1 : 0}>
          <Text color={reviewCount > 0 || failedCount > 0 ? palette.failure : palette.success}>
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
