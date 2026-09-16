import { expect, test } from 'bun:test'
import { render } from 'ink-testing-library'
import { ApprovalMenu, type ApprovalRequest } from './ApprovalMenu.tsx'
import { waitForFrame } from '../testFixtures.ts'
import type { ApprovalResult } from '../../../autonomy/governor.ts'

const tick = () => new Promise((r) => setTimeout(r, 15))

function harness(over: Partial<ApprovalRequest> = {}) {
  let resolved: ApprovalResult | undefined
  const request: ApprovalRequest = {
    title: 'Run this command?',
    lines: ['installs a dependency'],
    preview: ['$ npm install lodash'],
    ruleLabel: '`npm` commands',
    command: 'npm install lodash',
    resolve: (r) => {
      resolved = r
    },
    ...over,
  }
  const app = render(<ApprovalMenu request={request} />)
  return { app, get: () => resolved }
}

test('offers yes / yes-for-the-session / always-in-this-project / no-with-guidance, and shows the command', () => {
  const { app } = harness()
  const frame = app.lastFrame() ?? ''
  expect(frame).toContain('Run this command?')
  expect(frame).toContain('$ npm install lodash')
  expect(frame).toContain("don't ask again for `npm` commands this session")
  expect(frame).toContain('always allow `npm` commands in this project')
  expect(frame).toContain('tell elia what to do instead')
  expect(frame).toContain('e to edit the command')
  // The machine-wide rule and the risk jargon are gone from the prompt.
  expect(frame).not.toContain('on this machine')
  expect(frame).not.toContain('reversible')
})

test('digit 1 approves once', () => {
  const { app, get } = harness()
  app.stdin.write('1')
  expect(get()).toEqual({ approved: true })
})

test('digit 2 approves and remembers for the session', () => {
  const { app, get } = harness()
  app.stdin.write('2')
  expect(get()).toEqual({ approved: true, remember: 'session' })
})

test('digit 3 approves and remembers for the project', () => {
  const { app, get } = harness()
  app.stdin.write('3')
  expect(get()).toEqual({ approved: true, remember: 'project' })
})

test('"n" and Esc are a plain denial', async () => {
  const { app, get } = harness()
  app.stdin.write('n')
  expect(get()).toEqual({ approved: false })
  const esc = harness()
  esc.app.stdin.write('\x1B')
  // A lone ESC is only known to be Esc (not the start of an arrow key) after
  // Ink's escape timeout, so give it a moment.
  for (let i = 0; i < 20 && esc.get() === undefined; i += 1) await tick()
  expect(esc.get()).toEqual({ approved: false })
})

test('the "tell elia instead" path returns a denial carrying the feedback', async () => {
  const { app, get } = harness()
  app.stdin.write('4')
  await waitForFrame(app.lastFrame, 'what should elia do instead?')
  app.stdin.write('use pnpm')
  await tick()
  app.stdin.write('\r')
  await tick()
  expect(get()).toEqual({ approved: false, feedback: 'use pnpm' })
})

test('editing the command declines the original and names the replacement', async () => {
  const { app, get } = harness()
  app.stdin.write('e')
  await waitForFrame(app.lastFrame, 'enter to run this instead')
  app.stdin.write('!')
  await tick()
  app.stdin.write('\r')
  await tick()
  const result = get()
  expect(result).toMatchObject({ approved: false })
  expect((result as { feedback: string }).feedback).toContain('npm install lodash!')
})

test('a non-command request has no edit shortcut', () => {
  const { app } = harness({ command: undefined, ruleLabel: '`codex_delegate`' })
  expect(app.lastFrame() ?? '').not.toContain('edit the command')
})

test('a plan approval asks only run-it or change-it', async () => {
  const { app, get } = harness({ title: 'Run this plan?', variant: 'plan', command: undefined, preview: ['Goal: build a todo app', '1. write index.html'] })
  const frame = app.lastFrame() ?? ''
  expect(frame).toContain('Yes, run it')
  expect(frame).toContain('change something first')
  expect(frame).not.toContain('always allow')
  app.stdin.write('2')
  await waitForFrame(app.lastFrame, 'what should elia do instead?')
  app.stdin.write('use react')
  await tick()
  app.stdin.write('\r')
  await tick()
  expect(get()).toEqual({ approved: false, feedback: 'use react' })
})
