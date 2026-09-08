/**
 * The `/eliaspace` panel — a read-only glance at the collaborative workspace
 * from inside the Elia REPL.
 *
 * It connects to whichever server is already reachable ($ELIA_WORKSPACE_SERVER
 * or a locally advertised one), authenticating with $ELIA_WORKSPACE_TOKEN, and
 * renders status plus a few drill-down views. It never mints tokens, starts a
 * server, or mutates the workspace — those stay in `elia workspace ...`.
 */

import { box } from '../ui/layout.ts'
import { bold, cyan, dim, gold } from '../ui/theme.ts'
import { openWorkspaceClient, resolveServer, workspaceTokenFromEnv, type ResolvedServer } from './connection.ts'
import type { WorkspaceStatusResult } from './protocol.ts'
import type { PersistedEvent } from './events.ts'

export interface EliaspaceSnapshot {
  /** A token is set — the minimum for the panel to try connecting. */
  configured: boolean
  server: ResolvedServer
  reachable: boolean
  error?: string
  caller?: { kind: string; id: string; name: string; role: string }
  status?: WorkspaceStatusResult
  recent?: PersistedEvent[]
}

export async function collectEliaspaceSnapshot(): Promise<EliaspaceSnapshot> {
  const configured = workspaceTokenFromEnv() !== undefined
  const server = await resolveServer()
  if (!configured || server.source === 'none') {
    return { configured, server, reachable: false }
  }
  try {
    const { client } = await openWorkspaceClient()
    try {
      const [status, recent] = await Promise.all([
        client.call<WorkspaceStatusResult>('workspace.status'),
        client.call<PersistedEvent[]>('events.query', { limit: 6 }),
      ])
      return { configured, server, reachable: true, caller: client.hello?.caller, status, recent }
    } finally {
      client.close()
    }
  } catch (error) {
    return { configured, server, reachable: false, error: error instanceof Error ? error.message : String(error) }
  }
}

export function renderEliaspacePanel(snap: EliaspaceSnapshot): string {
  const lines: string[] = []

  if (!snap.configured) {
    lines.push(
      dim('No workspace token in this shell. To create or join one:'),
      '',
      `  ${cyan('elia workspace init --name "<name>" --owner <you>')}   ${dim('# prints a one-time owner token')}`,
      `  ${cyan('export ELIA_WORKSPACE_TOKEN=wst_…')}`,
      `  ${cyan('elia workspace serve &')}                              ${dim('# start the coordination server')}`,
      '',
      dim('Already have a token? Set ELIA_WORKSPACE_TOKEN (and ELIA_WORKSPACE_SERVER'),
      dim('if the server is on another machine), then run /eliaspace again.'),
    )
    return box(lines, { title: 'elia workspace', borderColor: cyan })
  }

  if (!snap.reachable) {
    lines.push(
      `${dim('server')}  ${snap.server.url}`,
      `${dim('state ')}  ${gold('not reachable')}`,
    )
    if (snap.error) lines.push(`${dim('why   ')}  ${snap.error}`)
    lines.push(
      '',
      dim('Start it, or point at a running one:'),
      `  ${cyan('elia workspace serve')}`,
      `  ${cyan('export ELIA_WORKSPACE_SERVER=ws://<host>:<port>/workspace')}`,
    )
    return box(lines, { title: 'elia workspace', borderColor: cyan })
  }

  const s = snap.status!
  const presence = s.presence.length
    ? s.presence.map((p) => `${p.name} (${p.kind})`).join(', ')
    : dim('nobody online')
  lines.push(
    `${bold(s.workspace?.name ?? '(unnamed workspace)')}  ${dim(`seq ${s.latestSeq}`)}`,
    snap.caller ? dim(`connected as ${snap.caller.name} · ${snap.caller.role} (${snap.caller.kind})`) : '',
    dim(`via ${snap.server.url}  [${snap.server.source}]`),
    '',
    `${dim('members     ')} ${s.members}`,
    `${dim('agents      ')} ${s.agents.total}${counts(s.agents.byStatus)}`,
    `${dim('objectives  ')} ${s.objectives.total}${counts(s.objectives.byStatus)}`,
    `${dim('tasks       ')} ${s.tasks.total}${counts(s.tasks.byStatus)}`,
    `${dim('approvals   ')} ${s.pendingApprovals} pending`,
    `${dim('locks       ')} ${s.activeReservations} active reservation${s.activeReservations === 1 ? '' : 's'}`,
    `${dim('online      ')} ${presence}`,
  )
  if (snap.recent && snap.recent.length) {
    lines.push('', cyan('RECENT'))
    for (const event of snap.recent.slice(-5)) lines.push(`  ${formatEvent(event)}`)
  }
  lines.push('', dim('Drill into feed · members · agents · objectives · tasks below.'))
  return box(lines.filter((line) => line !== ''), { title: 'elia workspace', borderColor: cyan })
}

/** One of the picker drill-downs, rendered as plain text. */
export type EliaspaceView = 'feed' | 'members' | 'agents' | 'objectives' | 'tasks' | 'connection'

export async function renderEliaspaceView(view: EliaspaceView): Promise<string> {
  if (view === 'connection') return renderConnectionHelp()
  try {
    const { client } = await openWorkspaceClient()
    try {
      switch (view) {
        case 'feed': {
          const events = await client.call<PersistedEvent[]>('events.query', { limit: 40 })
          return events.length ? events.map(formatEvent).join('\n') : 'No activity yet.'
        }
        case 'members': {
          const members = await client.call<Array<Record<string, unknown>>>('member.list')
          return members.length
            ? members.map((m) => `${String(m.id).padEnd(22)} ${String(m.name).padEnd(18)} ${String(m.role)}${m.removedAt ? dim(' · removed') : ''}`).join('\n')
            : 'No members yet.'
        }
        case 'agents': {
          const listing = await client.call<{ identities: Array<Record<string, unknown>>; runtimes: Array<Record<string, unknown>> }>('agent.list')
          const ids = listing.identities.map((a) => `${String(a.id).padEnd(22)} ${String(a.name).padEnd(16)} ${String(a.role).padEnd(10)} ${((a.pathScopes as string[]) ?? []).join(' ') || 'all paths'}`)
          const runtimes = listing.runtimes.map((a) => `  ${String(a.name).padEnd(16)} ${String(a.status).padEnd(10)} ${String(a.currentTaskId ?? '')}`)
          const out = [ids.length ? ids.join('\n') : 'No agent identities registered.']
          if (runtimes.length) out.push('', 'Runtimes:', runtimes.join('\n'))
          return out.join('\n')
        }
        case 'objectives': {
          const list = await client.call<Array<Record<string, unknown>>>('objective.list')
          return list.length
            ? list.map((o) => `${String(o.id).padEnd(22)} ${String(o.status).padEnd(11)} ${String(o.taskCount)} task(s)  ${String(o.goal).slice(0, 60)}`).join('\n')
            : 'No objectives yet. Plan one with: elia workspace objective add "<goal>"'
        }
        case 'tasks': {
          const list = await client.call<Array<Record<string, unknown>>>('task.list', {})
          return list.length
            ? list.map((t) => `${String(t.id).padEnd(22)} ${String(t.status).padEnd(11)} ${String(t.role).padEnd(9)} ${String(t.assigneeId ?? '—').padEnd(14)} ${String(t.title).slice(0, 44)}`).join('\n')
            : 'No tasks yet.'
        }
      }
    } finally {
      client.close()
    }
  } catch (error) {
    return `Can't reach the workspace: ${error instanceof Error ? error.message : String(error)}`
  }
  return ''
}

function renderConnectionHelp(): string {
  const token = workspaceTokenFromEnv()
  const server = process.env.ELIA_WORKSPACE_SERVER?.trim()
  return [
    'Connecting to the workspace:',
    '',
    `  ${dim('token ')} ${token ? `set (${token.slice(0, 8)}…)` : gold('unset')} — export ELIA_WORKSPACE_TOKEN=wst_…`,
    `  ${dim('server')} ${server ? server : dim('auto (locally advertised server)')} — export ELIA_WORKSPACE_SERVER=ws://host:port/workspace`,
    '',
    'Mint a token for someone else:',
    '  elia workspace member add <name> --role maintainer',
    '  elia workspace agent register <name> --role frontend --paths "src/ui/**"',
    '',
    'Live views from a terminal:',
    '  elia workspace watch          # board that refreshes',
    '  elia workspace feed --follow  # streaming event log',
  ].join('\n')
}

function counts(byStatus: Record<string, number>): string {
  const parts = Object.entries(byStatus).map(([status, n]) => `${status}:${n}`)
  return parts.length ? dim(`  (${parts.join(', ')})`) : ''
}

function formatEvent(event: PersistedEvent): string {
  const time = event.at.slice(11, 19)
  const scope = event.taskId ? ` task=${event.taskId}` : event.objectiveId ? ` obj=${event.objectiveId}` : ''
  return `${dim(time)}  #${String(event.seq).padStart(4)}  ${event.type.padEnd(22)} ${event.actorId}${dim(scope)}`
}
