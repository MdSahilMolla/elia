import { expect, test } from 'bun:test'
import { renderWorkspaceBoard, type WorkspaceBoardState } from './workspaceBoard.ts'
import type { WorkspaceStatusResult } from '../workspace/protocol.ts'

function state(overrides: Partial<WorkspaceBoardState> = {}): WorkspaceBoardState {
  const status: WorkspaceStatusResult = {
    workspace: { id: 'ws_1', name: 'acme' },
    members: 3,
    agents: { total: 2, byStatus: { working: 1, idle: 1 } },
    objectives: { total: 1, byStatus: { active: 1 } },
    tasks: { total: 3, byStatus: { 'in-progress': 1, ready: 1, pending: 1 } },
    pendingApprovals: 1,
    activeReservations: 1,
    presence: [{ name: 'sarah', kind: 'member', focus: 'Authentication' }],
    latestSeq: 42,
  }
  return {
    status,
    objectives: [{ id: 'obj_1', workspaceId: 'ws_1', projectId: 'p', goal: 'Build a login system', status: 'active', runId: 'r', createdBy: 'm', createdAt: '', updatedAt: '' }],
    tasks: [
      { id: 'tsk_a', objectiveId: 'obj_1', projectId: 'p', title: 'Auth API', instructions: 'build it', role: 'backend', status: 'in-progress', dependsOn: [], files: [], acceptanceCriteria: [], verificationCommands: [], attemptCount: 1, maxAttempts: 2, assigneeId: 'agt_be', createdBy: 'm', createdAt: '', updatedAt: '' },
      { id: 'tsk_b', objectiveId: 'obj_1', projectId: 'p', title: 'Login form', instructions: 'build it', role: 'frontend', status: 'ready', dependsOn: [], files: [], acceptanceCriteria: [], verificationCommands: [], attemptCount: 0, maxAttempts: 2, createdBy: 'm', createdAt: '', updatedAt: '' },
      { id: 'tsk_c', objectiveId: 'obj_1', projectId: 'p', title: 'Auth tests', instructions: 'test it', role: 'tester', status: 'pending', dependsOn: ['tsk_a'], files: [], acceptanceCriteria: [], verificationCommands: [], attemptCount: 0, maxAttempts: 2, createdBy: 'm', createdAt: '', updatedAt: '' },
    ],
    agents: [
      { id: 'agt_be', identityId: 'aid_be', name: 'agent-backend', role: 'backend', status: 'working', currentTaskId: 'tsk_a', startedAt: '', lastHeartbeatAt: '' },
      { id: 'agt_fe', identityId: 'aid_fe', name: 'agent-frontend', role: 'frontend', status: 'idle', startedAt: '', lastHeartbeatAt: '' },
    ],
    feed: [
      { seq: 40, id: 'e40', type: 'TaskCompleted', actorKind: 'agent', actorId: 'agt_be', payload: {}, at: '2026-09-08T10:00:00.000Z' },
      { seq: 41, id: 'e41', type: 'AgentMessageCreated', actorKind: 'agent', actorId: 'agt_be', payload: { kind: 'claim', body: 'POST /login is done' }, at: '2026-09-08T10:00:05.000Z' },
    ],
    ...overrides,
  }
}

test('the board shows who is working, which agent, the task, and pending approvals', () => {
  const lines = renderWorkspaceBoard(state(), true).join('\n')
  expect(lines).toContain('acme')
  expect(lines).toContain('sarah (Authentication)')
  expect(lines).toContain('agent-backend')
  expect(lines).toContain('Auth API')
  expect(lines).toContain('1 pending approval')
  expect(lines).toContain('Build a login system')
  expect(lines).toContain('POST /login is done')
})

test('tasks are grouped by state under their objective', () => {
  const lines = renderWorkspaceBoard(state(), true).join('\n')
  expect(lines).toMatch(/in-progress\s+Auth API/)
  expect(lines).toMatch(/ready\s+Login form/)
  expect(lines).toMatch(/pending\s+Auth tests/)
})

test('it renders with no agents and no tasks', () => {
  const empty = state({ agents: [], tasks: [], objectives: [] })
  expect(() => renderWorkspaceBoard(empty, true)).not.toThrow()
})
