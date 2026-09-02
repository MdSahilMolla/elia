import { expect, test } from 'bun:test'
import { render } from 'ink-testing-library'
import { App, providerPlanItems } from './App.tsx'
import { REPL_COMMANDS_FOR_TEST } from './testFixtures.ts'

const SHIFT_TAB = '[Z'

function baseProps() {
  return {
    getEnv: () => ({ model: 'mercury-2', providerLabel: 'Mercury', providerName: 'inception' }),
    commands: REPL_COMMANDS_FOR_TEST,
    initialReplMode: 'manual' as const,
    messages: [],
    greeting: 'dev mode — say hi',
    classifyRisk: async () => ({ risky: false }),
    runShellLine: async (c: string) => `ran ${c}`,
    handleSlash: async () => ({ handled: true, text: 'slash ok' }),
    submitTurn: async (_text: string, hooks: import('./App.tsx').TurnHooks) => {
      hooks.onToolStart({ id: 't1', name: 'read_file', input: { path: 'x' } })
      hooks.onTool({ id: 't1', name: 'read_file', input: { path: 'x' }, result: 'file body', isError: false, durationMs: 3, cached: false })
      hooks.onText('Hello ')
      hooks.onText('world')
    },
  }
}

test('App shows the greeting before any turn', () => {
  const { lastFrame } = render(<App {...baseProps()} />)
  expect(lastFrame() ?? '').toContain('dev mode — say hi')
  expect(lastFrame() ?? '').toContain('mercury-2 · manual')
})

test('App streams a turn: user line, tool card, assistant text', async () => {
  const { stdin, lastFrame } = render(<App {...baseProps()} />)
  await Bun.sleep(20)
  stdin.write('hi there')
  await Bun.sleep(20)
  stdin.write('\r')
  await Bun.sleep(80)
  const frame = lastFrame() ?? ''
  expect(frame).toContain('hi there')
  expect(frame).toContain('Read x') // compact "verb target" tool line
  expect(frame).toContain('Hello world')
})

test('Shift+Tab into plan mode makes the turn read-only and offers to execute', async () => {
  let sawPlanMode: boolean | undefined
  const props = {
    ...baseProps(),
    submitTurn: async (_t: string, hooks: import('./App.tsx').TurnHooks) => {
      sawPlanMode = hooks.planMode
      hooks.onText('Here is the plan: 1. do X  2. do Y')
    },
  }
  const { stdin, lastFrame } = render(<App {...props} />)
  await Bun.sleep(20)
  stdin.write(SHIFT_TAB) // manual → auto
  await Bun.sleep(15)
  stdin.write(SHIFT_TAB) // auto → plan
  await Bun.sleep(15)
  expect(lastFrame() ?? '').toContain('· plan ·')
  stdin.write('research the task')
  await Bun.sleep(10)
  stdin.write('\r')
  await Bun.sleep(60)
  expect(sawPlanMode).toBe(true)
  expect(lastFrame() ?? '').toContain('Plan ready')
})

test('App routes a slash command through handleSlash', async () => {
  const { stdin, lastFrame } = render(<App {...baseProps()} />)
  await Bun.sleep(20)
  stdin.write('/cost')
  await Bun.sleep(20)
  stdin.write('\r')
  await Bun.sleep(40)
  expect(lastFrame() ?? '').toContain('slash ok')
})

test('status bar reflects a live model change from getEnv', async () => {
  let model = 'mercury-2'
  const { lastFrame, rerender } = render(<App {...baseProps()} getEnv={() => ({ model, providerLabel: 'X', providerName: 'inception' })} />)
  await Bun.sleep(20)
  expect(lastFrame() ?? '').toContain('mercury-2 · manual')
  model = 'gpt-5.6-terra'
  rerender(<App {...baseProps()} getEnv={() => ({ model, providerLabel: 'X', providerName: 'codex' })} />)
  await Bun.sleep(20)
  expect(lastFrame() ?? '').toContain('gpt-5.6-terra · manual')
})

test('every codex prompt asks for confirmation, even in auto mode', async () => {
  let submitted = false
  const props = {
    ...baseProps(),
    initialReplMode: 'auto' as const,
    getEnv: () => ({ model: 'gpt-5.6-terra', providerLabel: 'Codex', providerName: 'codex' }),
    submitTurn: async () => {
      submitted = true
    },
  }
  const { stdin, lastFrame } = render(<App {...props} />)
  await Bun.sleep(30)
  stdin.write('build me a thing')
  await Bun.sleep(20)
  stdin.write('\r')
  await Bun.sleep(60)
  expect(lastFrame() ?? '').toContain('Hand this task to Codex?')
  expect(submitted).toBe(false)
  stdin.write('n')
  await Bun.sleep(40)
  expect(submitted).toBe(false)
})

test('maps structured provider plan activity into workspace todo state', () => {
  expect(providerPlanItems('Reason for the plan\n[done] inspect\n[active] implement\n[pending] verify')).toEqual([
    { content: 'inspect', status: 'completed' },
    { content: 'implement', status: 'in_progress' },
    { content: 'verify', status: 'pending' },
  ])
})
