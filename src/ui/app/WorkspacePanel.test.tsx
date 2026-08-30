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
        agent({ id: '1', role: 'builder', action: 'editing src/foo.ts' }),
        agent({ id: '2', role: 'tester', status: 'done', action: 'ran 42 tests' }),
        agent({ id: '3', role: 'lead', action: 'orchestrating' }),
      ]}
    />,
  )
  const frame = lastFrame() ?? ''
  expect(frame).toContain('SUBAGENTS')
  expect(frame).toContain('builder')
  expect(frame).toContain('editing src/foo.ts')
  expect(frame).toContain('tester')
  expect(frame).not.toContain('lead') // the lead agent is not a "subagent"
})
