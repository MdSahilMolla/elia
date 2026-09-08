/**
 * `elia workspace <command>` — the terminal surface for the collaborative
 * workspace.
 *
 * `serve` starts the coordination server; `init` bootstraps a workspace directly
 * against the local SQLite file. Every other command is a WebSocket RPC client:
 * it resolves a server (an explicit `--server`, `$ELIA_WORKSPACE_SERVER`, a
 * locally advertised server, or a freshly auto-spawned one) and a bearer token
 * (`--token` / `$ELIA_WORKSPACE_TOKEN`), then makes one call.
 */

import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { writeError, writeNotice } from '../ui/stream.ts'
import { table } from '../ui/layout.ts'
import { paths } from '../statePaths.ts'
import { machineReadable } from '../ui/runtime.ts'
import { WorkspaceStore } from './store.ts'
import { createWorkspace } from './admin.ts'
import { serveWorkspace, type WorkspaceServerInfo } from './server.ts'
import { WorkspaceClient } from './client.ts'
import type { WorkspaceRpcMethod } from './protocol.ts'
import type { PersistedEvent } from './events.ts'
import { MEMBER_ROLES } from './types.ts'

interface Parsed {
  positionals: string[]
  flags: Map<string, string>
  bools: Set<string>
}

function parse(args: string[]): Parsed {
  const positionals: string[] = []
  const flags = new Map<string, string>()
  const bools = new Set<string>()
  const valued = new Set([
    '--server', '--token', '--port', '--host', '--db', '--name', '--owner', '--repo', '--branch',
    '--role', '--paths', '--tools', '--max-tasks', '--topic', '--kind', '--to', '--objective',
    '--detail', '--since', '--reason', '--project',
  ])
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!
    if (arg.startsWith('--')) {
      const eq = arg.indexOf('=')
      if (eq !== -1) {
        flags.set(arg.slice(0, eq), arg.slice(eq + 1))
      } else if (valued.has(arg)) {
        flags.set(arg, args[++i] ?? '')
      } else {
        bools.add(arg)
      }
    } else {
      positionals.push(arg)
    }
  }
  return { positionals, flags, bools }
}

const HELP = `elia workspace — multi-user, multi-agent collaborative workspace

  elia workspace serve [--port N] [--host H] [--db PATH]   start the coordination server
  elia workspace init --name NAME [--owner WHO] [--repo P]  bootstrap a workspace (prints the owner token)

  elia workspace status [--json]                            counts, presence, pending approvals
  elia workspace whoami                                     the identity your token resolves to
  elia workspace member list
  elia workspace member add NAME --role ROLE                mint a member token
  elia workspace member remove ID
  elia workspace token revoke ID
  elia workspace agent list
  elia workspace agent register NAME --role ROLE [--paths g,g] [--max-tasks N]
  elia workspace agent remove ID
  elia workspace objective add "GOAL" [--project ID]        plan an objective into a task graph
  elia workspace objective list | show ID
  elia workspace approve OBJECTIVE_ID | reject ID --reason "..."
  elia workspace task list [--objective ID] | show ID
  elia workspace task add "TITLE" --objective ID --role ROLE [--paths g,g] [--detail "..."]
  elia workspace task comment ID "TEXT" | block ID [--reason ...] | unblock ID
  elia workspace message post "BODY" --topic T --kind K [--to ID] [--objective ID]
  elia workspace decision record "TITLE" --objective ID [--detail "..."]
  elia workspace feed [--follow] [--since SEQ] [--json]     the live activity stream
  elia workspace stop                                       ask the server to shut down

  Connection: --server ws://host:port/workspace or $ELIA_WORKSPACE_SERVER;
              --token TOKEN or $ELIA_WORKSPACE_TOKEN.
  Roles: ${MEMBER_ROLES.join(', ')} (members); worker roles (frontend, backend, tester, ...) for agents.`

export async function runWorkspace(rawArgs: string[]): Promise<void> {
  const { positionals, flags, bools } = parse(rawArgs)
  const command = positionals[0]

  if (!command || bools.has('--help') || command === 'help') {
    process.stdout.write(`${HELP}\n`)
    return
  }

  try {
    switch (command) {
      case 'serve':
        return await runServe(flags)
      case 'init':
        return runInit(flags)
      case 'status':
        return await runStatus()
      case 'whoami':
        return await withClient(async (client) => emit(client.hello?.caller))
      case 'member':
        return await runMember(positionals.slice(1), flags)
      case 'agent':
        return await runAgent(positionals.slice(1), flags)
      case 'token':
        return await runToken(positionals.slice(1))
      case 'objective':
        return await runObjective(positionals.slice(1), flags)
      case 'task':
        return await runTask(positionals.slice(1), flags)
      case 'approve':
        return await withClient(async (client) => emit(await client.call('objective.approve', { objectiveId: positionals[1] })))
      case 'reject':
        return await withClient(async (client) => emit(await client.call('objective.reject', { objectiveId: positionals[1], reason: flags.get('--reason') })))
      case 'message':
        return await runMessage(positionals.slice(1), flags)
      case 'decision':
        return await runDecision(positionals.slice(1), flags)
      case 'feed':
        return await runFeed(flags, bools)
      case 'stop':
        return await withClient(async (client) => emit(await client.call('shutdown')))
      default:
        writeError(`unknown workspace command: ${command}`)
        process.stdout.write(`${HELP}\n`)
        process.exitCode = 1
    }
  } catch (error) {
    writeError(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}

// --- serve / init ---

async function runServe(flags: Map<string, string>): Promise<void> {
  const portRaw = flags.get('--port')
  const port = portRaw === undefined ? undefined : Number(portRaw)
  if (portRaw !== undefined && (!Number.isInteger(port) || port! < 0 || port! > 65_535)) {
    throw new Error('--port must be an integer between 0 and 65535')
  }
  await serveWorkspace({ port, hostname: flags.get('--host'), dbPath: flags.get('--db') })
}

function runInit(flags: Map<string, string>): void {
  const name = flags.get('--name')
  if (!name) throw new Error('elia workspace init requires --name')
  const dbPath = flags.get('--db') ?? paths.workspaceDb
  if (existsSync(dbPath)) {
    const existing = WorkspaceStore.open(dbPath)
    const already = existing.workspace()
    existing.close()
    if (already) throw new Error(`a workspace ("${already.name}") already exists at ${dbPath}`)
  }
  const store = WorkspaceStore.open(dbPath)
  try {
    const created = createWorkspace(store, {
      name,
      ownerName: flags.get('--owner') ?? 'owner',
      repoRoot: flags.get('--repo'),
      branch: flags.get('--branch'),
    })
    if (machineReadable) {
      emit({ workspaceId: created.workspaceId, projectId: created.projectId, ownerMemberId: created.ownerMemberId, ownerToken: created.ownerToken.plaintext })
      return
    }
    writeNotice(`Workspace "${name}" created at ${dbPath}`)
    process.stdout.write(
      `\n  Owner token (shown once — save it now):\n\n    ${created.ownerToken.plaintext}\n\n` +
        `  Next:\n` +
        `    export ELIA_WORKSPACE_TOKEN=${created.ownerToken.plaintext}\n` +
        `    elia workspace serve &\n` +
        `    elia workspace status\n`,
    )
  } finally {
    store.close()
  }
}

// --- client commands ---

async function runStatus(): Promise<void> {
  await withClient(async (client) => {
    const status = await client.call<import('./protocol.ts').WorkspaceStatusResult>('workspace.status')
    if (machineReadable) return emit(status)
    const lines = [
      `Workspace : ${status.workspace?.name ?? '(none)'}`,
      `Members   : ${status.members}`,
      `Agents    : ${status.agents.total}${formatCounts(status.agents.byStatus)}`,
      `Objectives: ${status.objectives.total}${formatCounts(status.objectives.byStatus)}`,
      `Tasks     : ${status.tasks.total}${formatCounts(status.tasks.byStatus)}`,
      `Approvals : ${status.pendingApprovals} pending`,
      `Locks     : ${status.activeReservations} active reservations`,
      `Online    : ${status.presence.map((p) => `${p.name} (${p.kind})`).join(', ') || '(nobody)'}`,
      `Event seq : ${status.latestSeq}`,
    ]
    process.stdout.write(`${lines.join('\n')}\n`)
  })
}

async function runMember(sub: string[], flags: Map<string, string>): Promise<void> {
  await withClient(async (client) => {
    if (sub[0] === 'add') {
      const result = await client.call('member.add', { name: sub[1], role: flags.get('--role') })
      return afterMint(result, 'member')
    }
    if (sub[0] === 'remove') {
      return emit(await client.call('member.remove', { memberId: sub[1] }))
    }
    const members = await client.call<Array<Record<string, unknown>>>('member.list')
    if (machineReadable) return emit(members)
    printTable(['id', 'name', 'role', 'removed'], members.map((m) => [String(m.id), String(m.name), String(m.role), m.removedAt ? 'yes' : '']))
  })
}

async function runAgent(sub: string[], flags: Map<string, string>): Promise<void> {
  await withClient(async (client) => {
    if (sub[0] === 'register') {
      const result = await client.call('agent.register', {
        name: sub[1],
        role: flags.get('--role'),
        pathScopes: splitList(flags.get('--paths')),
        allowedTools: splitList(flags.get('--tools')),
        maxConcurrentTasks: flags.has('--max-tasks') ? Number(flags.get('--max-tasks')) : undefined,
      })
      return afterMint(result, 'agent')
    }
    if (sub[0] === 'remove') {
      return emit(await client.call('agent.remove', { identityId: sub[1] }))
    }
    const listing = await client.call<{ identities: Array<Record<string, unknown>>; runtimes: Array<Record<string, unknown>> }>('agent.list')
    if (machineReadable) return emit(listing)
    printTable(
      ['id', 'name', 'role', 'scopes', 'max'],
      listing.identities.map((a) => [String(a.id), String(a.name), String(a.role), (a.pathScopes as string[] ?? []).join(' ') || 'all', String(a.maxConcurrentTasks)]),
    )
    if (listing.runtimes.length) {
      process.stdout.write('\nRuntimes:\n')
      printTable(['id', 'name', 'status', 'task'], listing.runtimes.map((a) => [String(a.id), String(a.name), String(a.status), String(a.currentTaskId ?? '')]))
    }
  })
}

async function runObjective(sub: string[], flags: Map<string, string>): Promise<void> {
  await withClient(async (client) => {
    if (sub[0] === 'add') {
      if (!sub[1]) throw new Error('usage: elia workspace objective add "<goal>"')
      writeNotice('Planning the objective… (this runs the planner and can take a minute)')
      const result = await client.call<{ objectiveId: string; steps: Array<Record<string, unknown>>; waves: string[][] }>(
        'objective.add', { goal: sub[1], projectId: flags.get('--project') }, 300_000,
      )
      if (machineReadable) return emit(result)
      writeNotice(`Objective ${result.objectiveId} planned — ${result.steps.length} tasks, ${result.waves.length} waves. Approve it with:`)
      process.stdout.write(`\n    elia workspace approve ${result.objectiveId}\n\n`)
      printTable(['step', 'title', 'role', 'dependsOn'], result.steps.map((s) => [String(s.id), String(s.title), String(s.role), (s.dependsOn as string[] ?? []).join(', ')]))
      return
    }
    if (sub[0] === 'show') {
      const view = await client.call('objective.show', { objectiveId: sub[1] })
      return emit(view)
    }
    const list = await client.call<Array<Record<string, unknown>>>('objective.list')
    if (machineReadable) return emit(list)
    printTable(['id', 'status', 'tasks', 'goal'], list.map((o) => [String(o.id), String(o.status), String(o.taskCount), String(o.goal).slice(0, 60)]))
  })
}

async function runTask(sub: string[], flags: Map<string, string>): Promise<void> {
  await withClient(async (client) => {
    if (sub[0] === 'show') return emit(await client.call('task.show', { taskId: sub[1] }))
    if (sub[0] === 'add') {
      return emit(await client.call('task.add', {
        objectiveId: flags.get('--objective'),
        title: sub[1],
        role: flags.get('--role'),
        instructions: flags.get('--detail'),
        files: splitList(flags.get('--paths')),
      }))
    }
    if (sub[0] === 'comment') return emit(await client.call('task.comment', { taskId: sub[1], body: sub[2] }))
    if (sub[0] === 'block') return emit(await client.call('task.block', { taskId: sub[1], reason: flags.get('--reason') }))
    if (sub[0] === 'unblock') return emit(await client.call('task.unblock', { taskId: sub[1] }))
    const list = await client.call<Array<Record<string, unknown>>>('task.list', { objectiveId: flags.get('--objective') })
    if (machineReadable) return emit(list)
    printTable(
      ['id', 'status', 'role', 'wave', 'assignee', 'title'],
      list.map((t) => [String(t.id), String(t.status), String(t.role), String(t.wave ?? ''), String(t.assigneeId ?? ''), String(t.title).slice(0, 40)]),
    )
  })
}

async function runToken(sub: string[]): Promise<void> {
  if (sub[0] !== 'revoke' || !sub[1]) throw new Error('usage: elia workspace token revoke <tokenId>')
  await withClient(async (client) => emit(await client.call('token.revoke', { tokenId: sub[1] })))
}

async function runMessage(sub: string[], flags: Map<string, string>): Promise<void> {
  if (sub[0] !== 'post' || !sub[1]) throw new Error('usage: elia workspace message post "<body>" --topic T --kind K')
  await withClient(async (client) => emit(await client.call('message.post', {
    body: sub[1],
    topic: flags.get('--topic') ?? 'general',
    kind: flags.get('--kind') ?? 'info',
    toId: flags.get('--to'),
    objectiveId: flags.get('--objective'),
  })))
}

async function runDecision(sub: string[], flags: Map<string, string>): Promise<void> {
  if (sub[0] !== 'record' || !sub[1]) throw new Error('usage: elia workspace decision record "<title>" --objective ID')
  await withClient(async (client) => emit(await client.call('decision.record', {
    title: sub[1],
    objectiveId: flags.get('--objective'),
    detail: flags.get('--detail'),
  })))
}

async function runFeed(flags: Map<string, string>, bools: Set<string>): Promise<void> {
  const since = flags.has('--since') ? Number(flags.get('--since')) : 0
  const follow = bools.has('--follow')
  let backlogSeq = since
  let streaming = false
  await withClient(async (client) => {
    const backlog = await client.call<PersistedEvent[]>('events.query', { sinceSeq: since, limit: 500 })
    for (const event of backlog) {
      printEvent(event)
      backlogSeq = Math.max(backlogSeq, event.seq)
    }
    if (!follow) return
    streaming = true
    process.stdout.write(machineReadable ? '' : '— following (Ctrl+C to stop) —\n')
    await new Promise<void>((resolve) => {
      process.on('SIGINT', () => {
        client.close()
        resolve()
      })
    })
  }, {
    // Suppress live events until the backlog has printed, then only show new ones.
    onEvent: (event) => {
      if (streaming && event.seq > backlogSeq) printEvent(event)
    },
  })
}

// --- connection plumbing ---

interface ClientExtras {
  onEvent?: (event: PersistedEvent) => void
}

async function withClient(fn: (client: WorkspaceClient) => Promise<void>, extras: ClientExtras = {}): Promise<void> {
  const token = process.env.ELIA_WORKSPACE_TOKEN?.trim() || flagFromArgv('--token')
  if (!token) throw new Error('a workspace token is required — set $ELIA_WORKSPACE_TOKEN or pass --token')
  const { url, spawned } = await resolveServer()
  const client = await WorkspaceClient.connect({ url, token, onEvent: extras.onEvent })
  try {
    await fn(client)
  } finally {
    client.close()
    if (spawned) writeNotice(`(auto-started workspace server is still running at ${url}; "elia workspace stop" to end it)`)
  }
}

async function resolveServer(): Promise<{ url: string; spawned: boolean }> {
  const explicit = flagFromArgv('--server') || process.env.ELIA_WORKSPACE_SERVER?.trim()
  if (explicit) return { url: normalizeUrl(explicit), spawned: false }

  const advertised = readServerInfo()
  if (advertised) return { url: advertised.url, spawned: false }

  // Auto-spawn a local server and wait for it to advertise its address.
  const entry = fileURLToPath(new URL('../../bin/elia.ts', import.meta.url))
  const child = Bun.spawn([process.execPath, entry, 'workspace', 'serve'], {
    stdin: 'ignore', stdout: 'ignore', stderr: 'ignore', detached: true,
    env: { ...process.env, NO_COLOR: '1' },
  })
  child.unref()
  const deadline = Date.now() + 8_000
  while (Date.now() < deadline) {
    const info = readServerInfo()
    if (info) return { url: info.url, spawned: true }
    await Bun.sleep(120)
  }
  throw new Error('auto-started workspace server did not come up within 8s; start it with "elia workspace serve"')
}

function readServerInfo(): WorkspaceServerInfo | undefined {
  if (!existsSync(paths.workspaceServerInfo)) return undefined
  try {
    const info = JSON.parse(readFileSync(paths.workspaceServerInfo, 'utf8')) as WorkspaceServerInfo
    return typeof info.url === 'string' && info.url.startsWith('ws') ? info : undefined
  } catch {
    return undefined
  }
}

function normalizeUrl(raw: string): string {
  const trimmed = raw.trim()
  if (trimmed.startsWith('ws://') || trimmed.startsWith('wss://')) return trimmed.includes('/workspace') ? trimmed : `${trimmed.replace(/\/$/, '')}/workspace`
  return `ws://${trimmed.replace(/\/$/, '')}/workspace`
}

// --- output helpers ---

function emit(value: unknown): void {
  if (value === undefined) return
  process.stdout.write(machineReadable ? `${JSON.stringify(value)}\n` : `${typeof value === 'string' ? value : JSON.stringify(value, null, 2)}\n`)
}

function afterMint(result: unknown, kind: 'member' | 'agent'): void {
  const record = result as { token?: string; tokenId?: string; memberId?: string; identityId?: string }
  if (machineReadable) return emit(record)
  const id = record.memberId ?? record.identityId
  writeNotice(`${kind} created: ${id}`)
  if (record.token && record.token.startsWith('wst_')) {
    process.stdout.write(`\n  Token (shown once):\n\n    ${record.token}\n\n`)
  } else {
    process.stdout.write(`  ${record.token ?? '(existing token unchanged)'}\n`)
  }
}

function formatCounts(byStatus: Record<string, number>): string {
  const parts = Object.entries(byStatus).map(([status, n]) => `${status}:${n}`)
  return parts.length ? `  (${parts.join(', ')})` : ''
}

function printTable(headers: string[], rows: string[][]): void {
  const columns = headers.map((header) => ({ header, align: 'left' as const }))
  for (const line of table(columns, rows)) process.stdout.write(`${line}\n`)
}

function printEvent(event: PersistedEvent): void {
  if (machineReadable) {
    process.stdout.write(`${JSON.stringify(event)}\n`)
    return
  }
  const time = event.at.slice(11, 19)
  const scope = event.taskId ? ` task=${event.taskId}` : event.objectiveId ? ` obj=${event.objectiveId}` : ''
  const detail = summarisePayload(event)
  process.stdout.write(`${time}  #${String(event.seq).padStart(4)}  ${event.type.padEnd(22)} ${event.actorId}${scope}${detail ? `  ${detail}` : ''}\n`)
}

function summarisePayload(event: PersistedEvent): string {
  const p = event.payload
  if (event.type === 'AgentMessageCreated') return `[${String(p.kind)}] ${String(p.topic)}: ${String(p.body).slice(0, 120)}`
  if (event.type === 'DecisionRecorded') return `"${String(p.title)}"`
  if (event.type === 'TaskCreated') return `${String(p.title)} (${String(p.role)})`
  if (event.type.startsWith('Task') && p.status) return `-> ${String(p.status)}`
  if (event.type === 'MemberAdded') return `${String(p.name)} as ${String(p.role)}`
  if (event.type === 'AgentIdentityRegistered') return `${String(p.name)} (${String(p.role)})`
  return ''
}

function splitList(value: string | undefined): string[] | undefined {
  if (!value) return undefined
  return value.split(',').map((item) => item.trim()).filter(Boolean)
}

/** The workspace CLI is invoked as `elia workspace ...`; read a flag straight from argv. */
function flagFromArgv(name: string): string | undefined {
  const argv = process.argv.slice(2)
  const index = argv.indexOf(name)
  if (index !== -1 && argv[index + 1] && !argv[index + 1]!.startsWith('--')) return argv[index + 1]
  const inline = argv.find((arg) => arg.startsWith(`${name}=`))
  return inline ? inline.slice(name.length + 1) : undefined
}

// Referenced only for its type in a couple of casts above.
export type { WorkspaceRpcMethod }
