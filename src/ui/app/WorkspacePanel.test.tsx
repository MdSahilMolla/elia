import { expect, test } from 'bun:test'
import { render } from 'ink-testing-library'
import { WorkspacePanel } from './components/WorkspacePanel.tsx'
import type { TaskSession } from '../../taskSessions.ts'

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

test('shows live subagents and what each is doing; finished ones roll into a receipt', () => {
  const { lastFrame } = render(
    <WorkspacePanel
      plan={[]}
      sessionId="s1"
      agents={[
        agent({ id: '1', sessionId: 's1', role: 'builder', providerName: 'anthropic', model: 'claude-test', wave: 2, action: 'editing src/foo.ts' }),
        agent({ id: '2', sessionId: 's1', role: 'tester', status: 'done', finishedAt: 5, action: 'ran 42 tests' }),
        agent({ id: '3', sessionId: 's1', role: 'lead', action: 'orchestrating' }),
      ]}
    />,
  )
  const frame = lastFrame() ?? ''
  expect(frame).toContain('SUBAGENTS · 1 active')
  expect(frame).toContain('builder')
  expect(frame).toContain('anthropic/claude-test')
  expect(frame).toContain('wave 2')
  expect(frame).toContain('editing src/foo.ts')
  expect(frame).not.toContain('lead') // the lead agent is not a "subagent"
  // A live worker is still going, so the finished tester is not surfaced yet.
  expect(frame).not.toContain('ran 42 tests')
})

test('collapses to a completion receipt once every worker in the session has finished', () => {
  const { lastFrame } = render(
    <WorkspacePanel
      plan={[]}
      sessionId="s1"
      agents={[
        agent({ id: '1', sessionId: 's1', role: 'builder', status: 'done', finishedAt: 5 }),
        agent({ id: '2', sessionId: 's1', role: 'frontend', status: 'done', finishedAt: 6 }),
        agent({ id: '3', sessionId: 's1', role: 'tester', status: 'needs-review', finishedAt: 7 }),
      ]}
    />,
  )
  const frame = lastFrame() ?? ''
  expect(frame).toContain('3 workers')
  expect(frame).toContain('2 done')
  expect(frame).toContain('1 need review')
})

test('a brand-new session shows nothing for workers reloaded from a previous run', () => {
  const prior: TaskSession[] = [
    agent({ id: 'old-run', sessionId: 'previous', role: 'builder', status: 'needs-review', finishedAt: 10 }),
    agent({ id: 'old-run-2', sessionId: 'previous', role: 'critic', status: 'paused', updatedAt: 10 }),
  ]
  const { lastFrame } = render(<WorkspacePanel plan={[]} agents={prior} sessionId="fresh" />)
  expect((lastFrame() ?? '').trim()).toBe('')
})

test('collapses a retried step to its latest attempt instead of two builder rows', () => {
  const { lastFrame } = render(
    <WorkspacePanel
      plan={[]}
      sessionId="s1"
      agents={[
        agent({ id: 'attempt-1', sessionId: 's1', stepId: 's2', role: 'builder', status: 'failed', updatedAt: 1, finishedAt: 1 }),
        agent({ id: 'attempt-2', sessionId: 's1', stepId: 's2', role: 'builder', status: 'running', updatedAt: 2, attempts: 2, action: 'second pass' }),
      ]}
    />,
  )
  const frame = lastFrame() ?? ''
  expect(frame).toContain('SUBAGENTS · 1 active')
  expect(frame).toContain('try 2')
  expect(frame).toContain('second pass')
})

test('legacy: with no sessionId, unstamped finished work from a reloaded tasks.json stays hidden', () => {
  const done = agent({ id: 'r', role: 'critic', status: 'done', finishedAt: 0, action: 'verified' })
  const { lastFrame } = render(<WorkspacePanel plan={[]} agents={[done]} since={Date.now()} />)
  expect((lastFrame() ?? '').trim()).toBe('')
})

test('is not a dashboard — a fresh chat with other sessions and old artifacts still shows nothing', () => {
  const { lastFrame } = render(<WorkspacePanel plan={[]} agents={[]} />)
  expect((lastFrame() ?? '').trim()).toBe('')
})
