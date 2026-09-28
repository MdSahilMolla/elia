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
  // Armed from the start: these tests are about the choices, not the typing guard.
  const app = render(<ApprovalMenu request={request} armMs={0} />)
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

// --- a menu that pops up while the person is typing ---

function typingHarness() {
  let resolved: ApprovalResult | undefined
  const typed: string[] = []
  const request: ApprovalRequest = {
    title: 'Run this command?',
    lines: ['not in the read-only policy'],
    preview: ['$ cat package.json'],
    ruleLabel: '`cat` commands',
    command: 'cat package.json',
    resolve: (r) => {
      resolved = r
    },
  }
  const app = render(<ApprovalMenu request={request} armMs={200} onTypeThrough={(input) => typed.push(input)} />)
  return { app, typed, get: () => resolved }
}

const typeSlowly = async (app: ReturnType<typeof render>, text: string) => {
  for (const ch of text) {
    app.stdin.write(ch)
    await tick()
  }
}

test('keys typed while the menu appears are not answers — they go on into the message', async () => {
  const { app, typed, get } = typingHarness()
  // "make sure" has an "e" (edit the command) and Enter picks "Yes".
  await typeSlowly(app, 'make sure 1 thing')
  app.stdin.write('\r')
  await tick()
  expect(get()).toBeUndefined()
  expect(typed.join('')).toBe('make sure 1 thing')
  expect(app.lastFrame()).not.toContain('enter to run this instead')
  expect(app.lastFrame()).toContain('waiting for you to finish typing')
})

test('once the keyboard has been quiet, the menu answers as before', async () => {
  const { app, get } = typingHarness()
  await typeSlowly(app, 'abc')
  await new Promise((r) => setTimeout(r, 260))
  app.stdin.write('1')
  await tick()
  expect(get()).toEqual({ approved: true })
})

test('a text key the menu has no use for, even when armed, is typing and makes it wait again', async () => {
  const { app, typed, get } = typingHarness()
  await new Promise((r) => setTimeout(r, 260))
  app.stdin.write('m')
  await tick()
  app.stdin.write('1')
  await tick()
  expect(get()).toBeUndefined()
  expect(typed).toEqual(['m', '1'])
})

test('Esc always declines, typing or not', async () => {
  const { app, get } = typingHarness()
  app.stdin.write('x')
  await tick()
  app.stdin.write('\x1B')
  await waitForFrame(() => (get() ? 'done' : ''), 'done')
  expect(get()).toEqual({ approved: false })
})
