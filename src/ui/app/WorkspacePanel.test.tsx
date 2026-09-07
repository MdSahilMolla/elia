import { expect, test } from 'bun:test'
import { render } from 'ink-testing-library'
import { WorkspacePanel } from './components/WorkspacePanel.tsx'
import type { TaskSession } from '../../taskSessions.ts'

test('renders nothing when there is no plan and no fleet', () => {
  const { lastFrame } = render(<WorkspacePanel plan={[]} agents={[]} />)
  expect((lastFrame() ?? '').trim()).toBe('')
})

test('shows the plan with status markers', () => {
  const { lastFrame } = render(
    <WorkspacePanel
      plan={[
        { content: 'read the code', status: 'completed' },
        { content: 'make the change', status: 'in_progress' },
        { content: 'run tests', status: 'pending' },
      ]}
      agents={[]}
    />,
  )
  const frame = lastFrame() ?? ''
  expect(frame).toContain('PLAN')
  expect(frame).toContain('✓ read the code')
  expect(frame).toContain('◐ make the change')
  expect(frame).toContain('□ run tests')
})

test('shows active subagents and what each is doing', () => {
  const agent = (over: Partial<TaskSession>): TaskSession => ({
    id: over.id ?? 'a',
    kind: 'code',
    title: 't',
    status: 'running',
    action: '',
    detail: '',
    createdAt: 0,
    updatedAt: 0,
    stepsCompleted: 0,
    progress: 0,
    attempts: 0,
    ...over,
  })
  const { lastFrame } = render(
    <WorkspacePanel
      plan={[]}
      agents={[
        agent({ id: '1', role: 'builder', providerName: 'anthropic', model: 'claude-test', wave: 2, action: 'editing src/foo.ts' }),
        agent({ id: '2', role: 'tester', status: 'done', action: 'ran 42 tests' }),
        agent({ id: '3', role: 'lead', action: 'orchestrating' }),
      ]}
    />,
  )
  const frame = lastFrame() ?? ''
  expect(frame).toContain('SUBAGENTS')
  expect(frame).toContain('builder')
  expect(frame).toContain('anthropic/claude-test')
  expect(frame).toContain('wave 2')
  expect(frame).toContain('editing src/foo.ts')
  expect(frame).toContain('tester')
  expect(frame).not.toContain('lead') // the lead agent is not a "subagent"
})

test('hides finished subagents from earlier sessions but keeps this session\'s', () => {
  const base: TaskSession = {
    id: 'x', kind: 'code', title: 't', status: 'done', action: 'done', detail: '',
    createdAt: 0, updatedAt: 0, stepsCompleted: 0, progress: 0, attempts: 0,
  }
  const { lastFrame } = render(
    <WorkspacePanel
      plan={[]}
      since={1_000}
      agents={[
        { ...base, id: 'old', role: 'critic', finishedAt: 500, action: 'stale critic' },
        { ...base, id: 'new', role: 'critic', finishedAt: 1_500, action: 'fresh critic' },
        { ...base, id: 'live', role: 'builder', status: 'running', action: 'still going' },
      ]}
    />,
  )
  const frame = lastFrame() ?? ''
  expect(frame).not.toContain('stale critic')
  expect(frame).toContain('fresh critic')
  expect(frame).toContain('still going')
})

test('with no `since`, a fresh REPL shows nothing from a reloaded tasks.json of finished work', () => {
  const done: TaskSession = {
    id: 'r', kind: 'code', title: 't', status: 'done', action: 'verified', detail: '',
    createdAt: 0, updatedAt: 0, finishedAt: 0, stepsCompleted: 0, progress: 0, attempts: 0, role: 'critic',
  }
  const { lastFrame } = render(<WorkspacePanel plan={[]} agents={[done]} since={Date.now()} />)
  expect((lastFrame() ?? '').trim()).toBe('')
})

test('is not a dashboard — a fresh chat with other sessions and old artifacts still shows nothing', () => {
  // The panel intentionally takes no chats/artifacts props any more; those live
  // in /sessions and /artifact. Only current activity (plan, fleet) shows here.
  const { lastFrame } = render(<WorkspacePanel plan={[]} agents={[]} />)
  expect((lastFrame() ?? '').trim()).toBe('')
})
