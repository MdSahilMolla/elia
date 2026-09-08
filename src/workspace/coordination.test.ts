import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { WorkspaceStore } from './store.ts'
import { createWorkspace } from './admin.ts'
import { buildContextPack } from './coordination.ts'

const dirs: string[] = []
const stores: WorkspaceStore[] = []
afterEach(() => {
  for (const store of stores.splice(0)) {
    try {
      store.close()
    } catch {
      /* closed */
    }
  }
  for (const dir of dirs.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      /* windows lock */
    }
  }
})

function bootstrap() {
  const dir = mkdtempSync(join(tmpdir(), 'elia-ws-ctx-'))
  dirs.push(dir)
  const store = WorkspaceStore.open(join(dir, 'workspace.sqlite'))
  stores.push(store)
  const created = createWorkspace(store, { name: 'demo' })
  const objectiveId = 'obj_1'
  store.append({ type: 'ObjectiveCreated', actorKind: 'member', actorId: created.ownerMemberId, objectiveId, payload: { id: objectiveId, workspaceId: store.workspace()!.id, projectId: created.projectId, goal: 'Build auth', runId: 'r' } })
  const mk = (id: string, role: string, deps: string[], files: string[]) =>
    store.append({ type: 'TaskCreated', actorKind: 'member', actorId: created.ownerMemberId, objectiveId, payload: { id, objectiveId, projectId: created.projectId, title: id, role, dependsOn: deps, files, acceptanceCriteria: ['login works'], verificationCommands: ['bun test'], maxAttempts: 2 } })
  mk('api', 'backend', [], ['api/auth.ts'])
  mk('ui', 'frontend', ['api'], ['ui/Login.tsx'])
  return { store, objectiveId, ownerId: created.ownerMemberId }
}

test('a context pack is scoped: dependency reports, addressed messages, decisions, held files — not the whole workspace', () => {
  const { store, objectiveId, ownerId } = bootstrap()

  // The API task completes with a report.
  store.append({ type: 'ObjectiveStatusChanged', actorKind: 'member', actorId: ownerId, objectiveId, payload: { status: 'awaiting-approval' } })
  store.append({ type: 'ObjectiveStatusChanged', actorKind: 'member', actorId: ownerId, objectiveId, payload: { status: 'active', approvedBy: ownerId } })
  store.append({ type: 'TaskAssigned', actorKind: 'system', actorId: 'orchestrator', objectiveId, taskId: 'api', payload: { assigneeKind: 'agent', assigneeId: 'agt_be' } })
  store.append({ type: 'TaskStarted', actorKind: 'agent', actorId: 'agt_be', objectiveId, taskId: 'api', payload: {} })
  store.append({ type: 'TaskCompleted', actorKind: 'agent', actorId: 'agt_be', objectiveId, taskId: 'api', payload: { report: 'POST /login returns a JWT; token TTL is 15m' } })

  // A decision, a message to the ui agent, a message to someone else, noise on another topic.
  store.append({ type: 'DecisionRecorded', actorKind: 'member', actorId: ownerId, objectiveId, payload: { title: 'Session store', detail: 'Redis, 15m TTL' } })
  store.append({ type: 'AgentMessageCreated', actorKind: 'agent', actorId: 'agt_be', objectiveId, payload: { toId: 'agt_fe', topic: 'auth', kind: 'handoff', body: 'the login endpoint is /api/login', refs: {} } })
  store.append({ type: 'AgentMessageCreated', actorKind: 'agent', actorId: 'agt_be', objectiveId, payload: { toId: 'agt_other', topic: 'auth', kind: 'info', body: 'not for the ui agent', refs: {} } })

  store.append({ type: 'TaskAssigned', actorKind: 'system', actorId: 'orchestrator', objectiveId, taskId: 'ui', payload: { assigneeKind: 'agent', assigneeId: 'agt_fe' } })

  const pack = buildContextPack(store, 'ui', 'agt_fe')

  expect(pack.objectiveGoal).toBe('Build auth')
  expect(pack.dependencyReports).toHaveLength(1)
  expect(pack.dependencyReports[0]!.report).toContain('JWT')
  expect(pack.decisions.map((d) => d.title)).toContain('Session store')
  expect(pack.messages.map((m) => m.body)).toContain('the login endpoint is /api/login')
  expect(pack.messages.map((m) => m.body)).not.toContain('not for the ui agent')
  expect(pack.briefing).toContain('Build auth')
  expect(pack.briefing).toContain('Decisions already made')
})

test('review notes are surfaced when a task comes back with changes requested', () => {
  const { store, objectiveId } = bootstrap()
  store.append({ type: 'ObjectiveStatusChanged', actorKind: 'member', actorId: 'm', objectiveId, payload: { status: 'awaiting-approval' } })
  store.append({ type: 'ObjectiveStatusChanged', actorKind: 'member', actorId: 'm', objectiveId, payload: { status: 'active', approvedBy: 'm' } })
  store.append({ type: 'TaskAssigned', actorKind: 'system', actorId: 'orchestrator', objectiveId, taskId: 'api', payload: { assigneeKind: 'agent', assigneeId: 'agt_be' } })
  store.append({ type: 'TaskStarted', actorKind: 'agent', actorId: 'agt_be', objectiveId, taskId: 'api', payload: {} })
  store.append({ type: 'ReviewRequested', actorKind: 'agent', actorId: 'agt_be', objectiveId, taskId: 'api', payload: {} })
  store.append({ type: 'ReviewCompleted', actorKind: 'member', actorId: 'm', objectiveId, taskId: 'api', payload: { passed: false, notes: 'hash the password with argon2, not sha256' } })

  const pack = buildContextPack(store, 'api', 'agt_be')
  expect(pack.task.reviewNotes).toContain('argon2')
  expect(pack.briefing).toContain('A reviewer asked for changes')
})
