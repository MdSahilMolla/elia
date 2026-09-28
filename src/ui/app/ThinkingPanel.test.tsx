import { expect, test } from 'bun:test'
import chalk from 'chalk'
import { render } from 'ink-testing-library'
import { FIRST_ROW_MS, PANEL_SLIDE_MS, ROW_FADE_MS, ROW_STAGGER_MS, ThinkingPanel, type PanelNote } from './components/ThinkingPanel.tsx'
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
    { kind: 'change', text: 'Build the API → Postgres' },
    { kind: 'add', text: 'Seed realistic rows' },
    { kind: 'remove', text: 'Mock the data' },
  ],
  state: 'updated',
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
const widest = (frame: string) => Math.max(...frame.split('\n').map((line) => Bun.stringWidth(line)))
/** Every row, stagger and fade included, has had time to appear. */
const allRowsIn = (rows: number) => FIRST_ROW_MS + rows * ROW_STAGGER_MS + ROW_FADE_MS + 150

/** Frames as the panel animates, so the order things appeared in can be read back. */
async function watch(lastFrame: () => string | undefined, ms: number): Promise<string[]> {
  const frames: string[] = []
  const end = Date.now() + ms
  while (Date.now() < end) {
    frames.push(lastFrame() ?? '')
    await sleep(15)
  }
  return frames
}
const firstSeen = (frames: string[], text: string) => frames.findIndex((frame) => frame.includes(text))

test('the side panel slides open, its rows appear one after another, and it slides shut and reports it', async () => {
  let closed = 0
  const view = render(<ThinkingPanel open notes={[note]} width={46} layout="side" pinned={false} onClosed={() => (closed += 1)} />)
  // It starts shut and eases open.
  expect(widest(view.lastFrame() ?? '')).toBeLessThan(46)
  const frames = await watch(view.lastFrame, allRowsIn(10))
  const open = frames.at(-1)!
  expect(widest(open)).toBeLessThanOrEqual(46)
  for (const line of ['◇ Thinking about your note', '❯ make sure its realistic', '✻ They want real data', 'You want: realistic data', 'Right now: step 2 of 4', '● The API will read', 'Plan change', '~ Build the API → Postgres', '+ Seed realistic rows', '− Mock the data', '✓ Plan updated', 'ctrl+w keeps this open']) {
    expect(open).toContain(line)
  }
  // Nothing shows before the first row is due, and then in the design's order,
  // each a stagger after the one above.
  const order = ['◇ Thinking about your note', '❯ make sure', '✻ They want', 'You want:', 'Right now:', '● The API', 'Plan change', '✓ Plan updated', 'ctrl+w keeps']
  const seen = order.map((text) => firstSeen(frames, text))
  expect(seen.every((at) => at >= 0)).toBe(true)
  for (let i = 1; i < seen.length; i += 1) expect(seen[i]!).toBeGreaterThan(seen[i - 1]!)
  expect(closed).toBe(0)

  view.rerender(<ThinkingPanel open={false} notes={[note]} width={46} layout="side" pinned={false} onClosed={() => (closed += 1)} />)
  const deadline = Date.now() + PANEL_SLIDE_MS + 1_000
  while (closed === 0 && Date.now() < deadline) await sleep(10)
  expect(closed).toBe(1)
  expect((view.lastFrame() ?? '').trim()).toBe('')
  view.unmount()
})

test('the panel wears the design: a violet edge and heading on its own band, labels plain and values quiet', async () => {
  const level = chalk.level
  chalk.level = 3
  try {
    const view = render(<ThinkingPanel open notes={[note]} width={46} layout="side" pinned={false} />)
    await sleep(allRowsIn(10))
    const frame = view.lastFrame() ?? ''
    // Violet (#B98CF2) edge and heading; the panel band (#24212D) behind the rows.
    expect(frame).toContain('\x1b[38;2;185;140;242m│')
    expect(frame).toContain('\x1b[38;2;185;140;242m◇ Thinking about your note')
    expect(frame).toContain('\x1b[48;2;36;33;45m')
    // "You want:" in the terminal's own colour, not bold; its value muted.
    expect(frame).toContain('You want: \x1b[38;2;140;140;140mrealistic data')
    expect(frame).not.toContain('\x1b[1mYou want')
    view.unmount()
  } finally {
    chalk.level = level
  }
})

test('while a note is thought through only the thinking shows; a question lands with where things stand and no plan change', async () => {
  const thinking: PanelNote = { id: 2, question: 'how far along?', thinking: '', rightNow: 'reading the code — nothing built yet', state: 'thinking' }
  const answered: PanelNote = { id: 3, question: 'is it green?', thinking: '', rightNow: '2 of 3 steps done', answer: 'Yes — the last check passed.', dropped: 1, state: 'answered' }
  const view = render(<ThinkingPanel open notes={[thinking, answered]} width={60} layout="stacked" pinned />)
  const frame = await waitForFrame(view.lastFrame, 'ctrl+w hides this', allRowsIn(12))
  expect(frame).toContain('✻ reading your note…')
  // "Right now" comes with the reply, as in the design — not ahead of it.
  expect(frame).not.toContain('reading the code — nothing built yet')
  expect(frame).toContain('Right now: 2 of 3 steps done')
  expect(frame).toContain('No plan change.')
  // What the claim check took out is said, not hidden.
  expect(frame).toContain('✂ a claim removed — nothing that ran backs it up')
  // Nothing was thought out loud for the answered note, so no empty thinking line.
  expect(frame.match(/✻/g)).toHaveLength(1)
  view.unmount()
})

test('steps a note changed or added glow in the main plan, and the glow steps down as it fades', () => {
  const plan = [
    { content: 'Design the schema', status: 'completed' as const },
    { content: 'Seed realistic rows', status: 'pending' as const },
    { content: 'Build the API on Postgres', status: 'pending' as const },
  ]
  const highlight = new Map([['Seed realistic rows', 'added'], ['Build the API on Postgres', 'changed']] as const)
  const level = chalk.level
  chalk.level = 3
  try {
    const glowing = render(<WorkspacePanel plan={plan} agents={[]} highlight={highlight} />).lastFrame() ?? ''
    // #40364D behind both changed steps, and not behind the one left alone.
    expect(glowing).toContain('\x1b[48;2;64;54;77mSeed realistic rows')
    expect(glowing).toContain('\x1b[48;2;64;54;77mBuild the API on Postgres')
    expect(glowing).not.toMatch(/\x1b\[48;2;64;54;77m[^\n]*Design the schema/)
    // The glow is the mark: no ~/+ when there is colour to show it.
    expect(glowing).not.toMatch(/[~+] (?:\x1b\[[0-9;]*m)*Seed realistic rows/)
    const fading = render(<WorkspacePanel plan={plan} agents={[]} highlight={highlight} highlightFade={2} />).lastFrame() ?? ''
    expect(fading).toContain('\x1b[48;2;42;38;51mSeed realistic rows')
  } finally {
    chalk.level = level
  }
})
