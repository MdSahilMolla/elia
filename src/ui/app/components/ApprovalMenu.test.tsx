import { expect, test } from 'bun:test'
import { render } from 'ink-testing-library'
import { ApprovalMenu, type ApprovalRequest } from './ApprovalMenu.tsx'
import { waitForFrame } from '../testFixtures.ts'
import type { ApprovalResult } from '../../../autonomy/governor.ts'

const tick = () => new Promise((r) => setTimeout(r, 15))

function harness(over: Partial<ApprovalRequest> = {}) {
  let resolved: ApprovalResult | undefined
  const request: ApprovalRequest = {
    title: 'Approve run_command?',
    lines: ['installs a dependency', 'risk: review · reversible: yes'],
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

test('renders the scoped "always allow" options and the command', () => {
  const { app } = harness()
  const frame = app.lastFrame() ?? ''
  expect(frame).toContain('always allow `npm` commands in this project')
  expect(frame).toContain('always allow `npm` commands on this machine')
  expect(frame).toContain('Edit command first')
})

test('digit 1 approves once', () => {
  const { app, get } = harness()
  app.stdin.write('1')
  expect(get()).toEqual({ approved: true })
})

test('digit 3 approves and remembers for the project', () => {
  const { app, get } = harness()
  app.stdin.write('3')
  expect(get()).toEqual({ approved: true, remember: 'project' })
})

test('"no" is a plain denial', () => {
  const { app, get } = harness()
  app.stdin.write('n')
  expect(get()).toEqual({ approved: false })
})

test('the "tell elia instead" path returns a denial carrying the feedback', async () => {
  const { app, get } = harness()
  app.stdin.write('d')
  await waitForFrame(app.lastFrame, 'What should elia do instead?')
  app.stdin.write('use pnpm')
  await tick()
  app.stdin.write('\r')
  await tick()
  expect(get()).toEqual({ approved: false, feedback: 'use pnpm' })
})

test('editing the command declines the original and names the replacement', async () => {
  const { app, get } = harness()
  app.stdin.write('5')
  await waitForFrame(app.lastFrame, 'Edit the command')
  app.stdin.write('!')
  await tick()
  app.stdin.write('\r')
  await tick()
  const result = get()
  expect(result).toMatchObject({ approved: false })
  expect((result as { feedback: string }).feedback).toContain('npm install lodash!')
})

test('a non-command request hides the "Edit command" option', () => {
  const { app } = harness({ command: undefined, ruleLabel: '`codex_delegate`' })
  expect(app.lastFrame() ?? '').not.toContain('Edit command')
})
