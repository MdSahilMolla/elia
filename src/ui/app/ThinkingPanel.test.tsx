import { expect, test } from 'bun:test'
import { render } from 'ink-testing-library'
import { PANEL_SLIDE_MS, ThinkingPanel, type PanelNote } from './components/ThinkingPanel.tsx'
import { WorkspacePanel } from './components/WorkspacePanel.tsx'
import { waitForFrame } from './testFixtures.ts'

const note: PanelNote = {
  id: 1,
  question: 'make sure its realistic',
  thinking: 'They want real data, not placeholders.',
  rightNow: 'step 2 of 4 — Build the API',
  wants: 'realistic data',
  answer: 'The API will read seeded rows from Postgres.',
  changes: [
    { kind: 'change', text: 'Build the API → Build the API on Postgres' },
    { kind: 'add', text: 'Seed realistic rows' },
    { kind: 'remove', text: 'Mock the data' },
  ],
  state: 'updated',
}

const widest = (frame: string) => Math.max(...frame.split('\n').map((line) => Bun.stringWidth(line)))

test('the side panel slides open to its width without reflowing its content, then slides shut and reports it', async () => {
  let closed = 0
  const view = render(<ThinkingPanel open notes={[note]} width={40} layout="side" pinned={false} onClosed={() => (closed += 1)} />)
  // It starts shut and eases open. Mid-slide the content is already laid out
  // at the full width and only clipped — lines wrap where they will end up.
  expect(widest(view.lastFrame() ?? '')).toBeLessThan(40)
  const midway = await waitForFrame(view.lastFrame, 'ctrl+w keeps this open', PANEL_SLIDE_MS + 1_000)
  await new Promise((resolve) => setTimeout(resolve, PANEL_SLIDE_MS + 150))
  const open = view.lastFrame() ?? ''
  expect(widest(open)).toBeLessThanOrEqual(40)
  expect(widest(open)).toBeGreaterThan(widest(midway) - 1)
  expect(open.split('\n').length).toBe(midway.split('\n').length)
  for (const line of ['◇ Thinking about your note', '❯ make sure its realistic', '✻ They want real data', 'You want: realistic data', 'Right now: step 2 of 4', '● The API will read', 'Plan change', '~ Build the API → Build the API on', '+ Seed realistic rows', '− Mock the data', '✓ Plan updated']) {
    expect(open).toContain(line)
  }
  expect(closed).toBe(0)

  view.rerender(<ThinkingPanel open={false} notes={[note]} width={40} layout="side" pinned={false} onClosed={() => (closed += 1)} />)
  const deadline = Date.now() + PANEL_SLIDE_MS + 1_000
  while (closed === 0 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10))
  expect(closed).toBe(1)
  expect((view.lastFrame() ?? '').trim()).toBe('')
  view.unmount()
})

test('a note still being thought through says so, and a question changes nothing', async () => {
  const thinking: PanelNote = { id: 2, question: 'how far along?', thinking: '', rightNow: 'reading the code — nothing built yet', state: 'thinking' }
  const answered: PanelNote = { id: 3, question: 'is it green?', thinking: '', rightNow: '2 of 3 steps done', answer: 'Yes — the last check passed.', dropped: 1, state: 'answered' }
  const view = render(<ThinkingPanel open notes={[thinking, answered]} width={60} layout="stacked" pinned />)
  const frame = await waitForFrame(view.lastFrame, 'ctrl+w hides this', PANEL_SLIDE_MS + 1_000)
  expect(frame).toContain('✻ reading your note…')
  expect(frame).toContain('… thinking')
  expect(frame).toContain('No plan change.')
  // What the claim check took out is said, not hidden.
  expect(frame).toContain('✂ a claim removed — nothing that ran backs it up')
  // Nothing was thought out loud for the answered note, so no empty thinking line.
  expect(frame.match(/✻/g)).toHaveLength(1)
  view.unmount()
})

test('steps a note changed or added stand out in the main plan, and say why', () => {
  const { lastFrame } = render(
    <WorkspacePanel
      plan={[
        { content: 'Design the schema', status: 'completed' },
        { content: 'Seed realistic rows', status: 'pending' },
        { content: 'Build the API on Postgres', status: 'pending' },
      ]}
      agents={[]}
      highlight={new Map([['Seed realistic rows', 'added'], ['Build the API on Postgres', 'changed']])}
    />,
  )
  const frame = lastFrame() ?? ''
  expect(frame).toContain('1 changed, 1 added from your note')
  expect(frame).toContain('+ Seed realistic rows')
  expect(frame).toContain('~ Build the API on Postgres')
  expect(frame).not.toMatch(/[~+] Design the schema/)
})
