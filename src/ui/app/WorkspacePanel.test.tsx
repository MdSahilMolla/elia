import { expect, test } from 'bun:test'
import { render } from 'ink-testing-library'
import { WorkspacePanel, runPlanFromWorkers } from './components/WorkspacePanel.tsx'
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
  expect(frame).toContain('Plan · 1/3')
  expect(frame).toContain('✓ read the code')
  expect(frame).toContain('◐ make the change')
  expect(frame).toContain('□ run tests')
  // No progress-bar glyphs — the count says it.
  expect(frame).not.toMatch(/[▓░]/)
})

test('shows live subagents and what each is doing; finished ones roll into a receipt', () => {
  const { lastFrame } = render(
    <WorkspacePanel
      plan={[]}
      sessionId="s1"
      agents={[
        agent({ id: '1', sessionId: 's1', role: 'builder', providerName: 'anthropic', model: 'claude-test', wave: 2, title: 'build the settings page', action: 'edit_file', stepsCompleted: 3 }),
        agent({ id: '2', sessionId: 's1', role: 'tester', status: 'done', finishedAt: 5, action: 'ran 42 tests' }),
        agent({ id: '3', sessionId: 's1', role: 'lead', action: 'orchestrating' }),
      ]}
    />,
  )
  const frame = lastFrame() ?? ''
  expect(frame).toContain('Subagents · 1 running')
  expect(frame).toContain('builder')
  // Which provider/model a worker runs on is /task detail, not panel noise.
  expect(frame).not.toContain('anthropic/claude-test')
  expect(frame).toContain('wave 2')
  // What the worker is doing (its task) and how far along — not the name of
  // the last tool that finished, which sat frozen while the model thought.
  expect(frame).toContain('build the settings page · 3 steps')
  expect(frame).not.toContain('edit_file')
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
        agent({ id: 'attempt-2', sessionId: 's1', stepId: 's2', role: 'builder', status: 'running', updatedAt: 2, attempts: 2, title: 'second pass' }),
      ]}
    />,
  )
  const frame = lastFrame() ?? ''
  expect(frame).toContain('Subagents · 1 running')
  expect(frame).toContain('try 2')
  expect(frame).toContain('second pass')
})

// "It's not updating the plan — closing ones that are done": an escalated run's
// plan never reached the panel, so nothing ever ticked. The panel now reads
// each approved step's state off the worker carrying that step's id.
test('an approved run plan ticks each step off from the worker that carries it', () => {
  const steps = [
    { id: 's1', title: 'Set up the project' },
    { id: 's2', title: 'Chart the training metrics' },
    { id: 's3', title: 'Draw the architecture' },
  ]
  const agents = [
    agent({ id: 'w1', sessionId: 'run', stepId: 's1', role: 'builder', status: 'done', updatedAt: 3 }),
    // A failed first attempt, then the retry that is running now.
    agent({ id: 'w2a', sessionId: 'run', stepId: 's2', role: 'frontend', status: 'failed', updatedAt: 1 }),
    agent({ id: 'w2b', sessionId: 'run', stepId: 's2', role: 'frontend', status: 'running', updatedAt: 4 }),
    // Another session's worker for a same-named step id must not count.
    agent({ id: 'old', sessionId: 'yesterday', stepId: 's3', role: 'builder', status: 'done', updatedAt: 9 }),
  ]
  expect(runPlanFromWorkers(steps, agents, 'run')).toEqual([
    { content: 'Set up the project', status: 'completed' },
    { content: 'Chart the training metrics', status: 'in_progress' },
    { content: 'Draw the architecture', status: 'pending' },
  ])
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

test('ctrl+o expands a live subagent into its task and last tool calls (#1239)', () => {
  const worker = agent({ id: 'w', role: 'builder', sessionId: 's1', title: 'add the login form', recentSteps: ['✓ read_file src/app.ts', '✗ run_command bun test'] })
  const collapsed = render(<WorkspacePanel plan={[]} agents={[worker]} sessionId="s1" />).lastFrame() ?? ''
  expect(collapsed).not.toContain('run_command')
  const expanded = render(<WorkspacePanel plan={[]} agents={[worker]} sessionId="s1" expanded />).lastFrame() ?? ''
  expect(expanded).toContain('task: add the login form')
  expect(expanded).toContain('✓ read_file src/app.ts')
  expect(expanded).toContain('✗ run_command bun test')
})
