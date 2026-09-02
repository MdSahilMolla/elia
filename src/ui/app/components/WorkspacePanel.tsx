import { Box, Text } from 'ink'
import { Spinner } from './Spinner.tsx'
import { palette, glyphs } from '../theme.ts'
import type { TodoItem } from '../../../autonomy/todoList.ts'
import type { TaskSession } from '../../../taskSessions.ts'

const TODO_MARK: Record<TodoItem['status'], string> = {
  pending: '□',
  in_progress: '◐',
  completed: '✓',
}

function agentGlyph(status: TaskSession['status']): string {
  if (status === 'done') return glyphs.ok
  if (status === 'failed' || status === 'needs-review') return glyphs.error
  return glyphs.running
}

/**
 * The live plan + subagent fleet. The plan comes from the agent's own todo_write
 * calls; the fleet from taskSessions. Kept to a bounded height and full width so
 * a long plan can't blow the panel out past the terminal edge.
 */
export function WorkspacePanel({ plan, agents, chats = [], artifacts = [] }: { plan: TodoItem[]; agents: TaskSession[]; chats?: string[]; artifacts?: string[] }) {
  const active = agents.filter((a) => a.role && a.role !== 'lead')
  if (plan.length === 0 && active.length === 0 && chats.length === 0 && artifacts.length === 0) return null

  // Show what's happening, not the whole backlog: done items + the current one +
  // a couple ahead.
  const current = Math.max(0, plan.findIndex((item) => item.status === 'in_progress'))
  const start = Math.max(0, Math.min(current - 1, plan.length - 6))
  const shown = plan.slice(start, start + 6)
  const doneCount = plan.filter((item) => item.status === 'completed').length

  return (
    <Box flexDirection="column" width="100%" marginTop={1} borderStyle="round" borderColor={palette.muted} paddingX={1}>
      {plan.length > 0 && (
        <Box flexDirection="column">
          <Text color={palette.muted}>
            PLAN {plan.length > 1 ? `· ${doneCount}/${plan.length}` : ''}
          </Text>
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

      {active.length > 0 && (
        <Box flexDirection="column" marginTop={plan.length > 0 ? 1 : 0}>
          <Text color={palette.muted}>SUBAGENTS</Text>
          {active.slice(0, 6).map((agent) => (
            <Box key={agent.id}>
              <Text color={agent.status === 'failed' ? palette.failure : agent.status === 'done' ? palette.success : palette.toolName}>
                {' '}
                {agent.status === 'running' || agent.status === 'pending' ? <Spinner /> : agentGlyph(agent.status)}{' '}
              </Text>
              <Text wrap="truncate-end">
                <Text bold>{agent.role}</Text>
                {agent.providerName && agent.model && <Text color={palette.muted}> · {agent.providerName}/{agent.model}</Text>}
                {agent.wave && <Text color={palette.muted}> · wave {agent.wave}</Text>}
                <Text color={palette.muted}> · {agent.action || agent.title}</Text>
              </Text>
            </Box>
          ))}
        </Box>
      )}

      {chats.length > 0 && (
        <Box flexDirection="column" marginTop={plan.length > 0 || active.length > 0 ? 1 : 0}>
          <Text color={palette.muted}>CHATS</Text>
          {chats.slice(0, 3).map((chat) => <Text key={chat} wrap="truncate-end">  {chat}</Text>)}
        </Box>
      )}

      {artifacts.length > 0 && (
        <Box flexDirection="column" marginTop={plan.length > 0 || active.length > 0 || chats.length > 0 ? 1 : 0}>
          <Text color={palette.muted}>ARTIFACTS</Text>
          {artifacts.slice(0, 4).map((artifact) => <Text key={artifact} wrap="truncate-end">  {artifact}</Text>)}
        </Box>
      )}
    </Box>
  )
}
