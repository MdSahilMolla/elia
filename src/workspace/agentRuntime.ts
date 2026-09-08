/**
 * An autonomous agent runtime — the process behind `elia workspace agent run`.
 *
 * It connects to the workspace server with its service token, announces itself,
 * and then works one assigned task at a time: claim it (which yields a scoped
 * context pack), run it in an isolated git worktree, heartbeat while it runs,
 * merge the result back, and report. The orchestrator on the server does the
 * assigning; this side never decides what to work on.
 *
 * The executor is injectable so tests drive the full lifecycle without a model
 * or a real repository.
 */

import { join } from 'node:path'
import { runSubAgent } from '../subagent.ts'
import { withAgentIdentity } from '../autonomy/context.ts'
import { createWorktree, mergeWorktreeIntoCwd, removeWorktree, runGit } from '../autonomy/worktree.ts'
import { paths } from '../statePaths.ts'
import { writeNotice } from '../ui/stream.ts'
import { WorkspaceClient } from './client.ts'
import { HEARTBEAT_INTERVAL_MS } from './types.ts'
import type { ContextPack } from './coordination.ts'
import type { TaskRecord } from './types.ts'
import type { RoleName } from '../autonomy/types.ts'
import type { PersistedEvent } from './events.ts'

export interface AgentJob {
  task: TaskRecord
  pack: ContextPack
  repoRoot: string
  role: RoleName
  signal: AbortSignal
  /** Report mid-task progress; also renews the task lease server-side. */
  progress: (note?: string) => Promise<void>
}

export interface AgentJobResult {
  ok: boolean
  report: string
  filesChanged?: string[]
}

export type AgentExecutor = (job: AgentJob) => Promise<AgentJobResult>

export interface AgentRuntimeOptions {
  serverUrl: string
  token: string
  executor?: AgentExecutor
  signal?: AbortSignal
  /** Claim one task and exit (tests / batch mode). */
  once?: boolean
  onIdle?: () => void
}

/** The default executor: run the role's sub-agent in an isolated worktree, merge back. */
export const worktreeExecutor: AgentExecutor = async (job) => {
  const runId = `ws-${job.task.id}`.replace(/[^A-Za-z0-9._-]/g, '-').slice(0, 60)
  const worktree = await createWorktree(runId, 0, job.repoRoot, paths.state)
  try {
    const prompt = `${job.pack.briefing}\n\n# Your task: ${job.task.title}\n\n${job.task.instructions}\n\nWork only inside your reserved files. Report exactly what you changed.`
    const result = await withAgentIdentity(
      { name: `agent:${job.role}`, role: job.role, cwd: worktree.path, signal: job.signal },
      () => runSubAgent({ prompt, role: job.role, name: `agent:${job.role}`, cwd: worktree.path, signal: job.signal }),
    )
    const status = await runGit(['status', '--porcelain'], worktree.path)
    const filesChanged = status.stdout.split('\n').map((line) => line.slice(3).trim()).filter(Boolean)
    const merged = await mergeWorktreeIntoCwd(worktree, job.repoRoot)
    return {
      ok: result.ok,
      report: `${result.report}\n\nFiles merged back: ${merged.join(', ') || '(none)'}`,
      filesChanged: filesChanged.length ? filesChanged : merged,
    }
  } finally {
    await removeWorktree(worktree, job.repoRoot)
  }
}

export async function runAgentRuntime(options: AgentRuntimeOptions): Promise<void> {
  const executor = options.executor ?? worktreeExecutor
  const controller = new AbortController()
  if (options.signal) {
    if (options.signal.aborted) controller.abort()
    else options.signal.addEventListener('abort', () => controller.abort(), { once: true })
  }

  let busy = false
  let stopped = false
  let pendingClaim = false
  let agentId = ''

  const client = await WorkspaceClient.connect({
    url: options.serverUrl,
    token: options.token,
    onEvent: (event: PersistedEvent) => {
      if (event.type === 'TaskAssigned' && agentId && event.payload.assigneeId === agentId) void claimNext()
    },
    onClose: () => {
      stopped = true
      controller.abort()
    },
  })

  const connected = await client.call<{ agentId: string }>('agent.connect', {})
  agentId = connected.agentId
  writeNotice(`agent ${client.hello?.caller.name} runtime attached as ${agentId}`)

  async function claimNext(): Promise<void> {
    if (busy || stopped) {
      pendingClaim = true
      return
    }
    busy = true
    try {
      const claim = await client.call<{ task: TaskRecord | null; pack: ContextPack; repoRoot: string }>('agent.claim', {})
      if (!claim.task) {
        options.onIdle?.()
        return
      }
      await runOne(claim.task, claim.pack, claim.repoRoot)
    } catch (error) {
      writeNotice(`agent claim failed: ${error instanceof Error ? error.message : String(error)}`)
    } finally {
      busy = false
      if (pendingClaim && !stopped) {
        pendingClaim = false
        void claimNext()
      }
    }
  }

  async function runOne(task: TaskRecord, pack: ContextPack, repoRoot: string): Promise<void> {
    const heartbeat = setInterval(() => {
      void client.call('agent.progress', { taskId: task.id }).catch(() => {})
    }, HEARTBEAT_INTERVAL_MS)
    try {
      const result = await executor({
        task,
        pack,
        repoRoot,
        role: task.role,
        signal: controller.signal,
        progress: async (note) => {
          await client.call('agent.progress', { taskId: task.id, note }).catch(() => {})
        },
      })
      await client.call('agent.complete', {
        taskId: task.id,
        ok: result.ok,
        report: result.report.slice(0, 8_000),
        filesChanged: result.filesChanged ?? [],
      })
    } catch (error) {
      await client.call('agent.complete', {
        taskId: task.id,
        ok: false,
        report: `runtime error: ${error instanceof Error ? error.message : String(error)}`,
      }).catch(() => {})
    } finally {
      clearInterval(heartbeat)
    }
  }

  // Poll as a safety net behind the event-driven claim.
  const poll = setInterval(() => void claimNext(), Math.max(2_000, HEARTBEAT_INTERVAL_MS / 3))

  await claimNext()
  if (options.once) {
    clearInterval(poll)
    client.close()
    return
  }

  await new Promise<void>((resolve) => {
    const finish = () => {
      clearInterval(poll)
      client.close()
      resolve()
    }
    controller.signal.addEventListener('abort', finish, { once: true })
    process.once('SIGINT', finish)
  })
}

/** Where a runtime's worktrees live, for cleanup tooling. */
export function agentWorktreeRoot(taskId: string): string {
  return join(paths.state, 'worktrees', `ws-${taskId}`)
}
