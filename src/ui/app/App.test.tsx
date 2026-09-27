import { expect, test } from 'bun:test'
import { render } from 'ink-testing-library'
import { App, planReceipt, providerPlanItems, shouldPersistActivity } from './App.tsx'
import { REPL_COMMANDS_FOR_TEST, waitForFrame } from './testFixtures.ts'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { eliaBookMenu, listEliaBooks } from '../../eliaBook.ts'
import { reportLiveOutput } from '../../usage.ts'

const SHIFT_TAB = '\x1b[Z'
const settle = () => new Promise((resolve) => setTimeout(resolve, 30))
/** The status row while elia works autonomously (always) — the frame is mounted and idle. */
const READY = '? for shortcuts'

function baseProps() {
  return {
    getEnv: () => ({ model: 'mercury-2', providerLabel: 'Mercury', providerName: 'inception' }),
    commands: REPL_COMMANDS_FOR_TEST,
    messages: [],
    greeting: 'dev mode — say hi',
    version: '0.0.0-test',
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

test('App prints a one-line header and a quiet status row before any turn', async () => {
  // Session spend is process-wide; other suites leave some behind.
  const { resetSessionUsageForTests } = await import('../../usage.ts')
  resetSessionUsageForTests()
  const { lastFrame } = render(<App {...baseProps()} />)
  const frame = await waitForFrame(lastFrame, 'dev mode — say hi')
  expect(frame).toContain('elia v0.0.0-test · dev mode — say hi')
  expect(frame).toContain(READY)
  expect(frame).toContain('mercury-2')
  // The default mode, tokens and cost are not status-row material.
  expect(frame).not.toContain('manual')
  expect(frame).not.toContain('$0')
  expect(frame).not.toContain('[manual]')
})

test('a busy turn shows what is running, not a random verb', async () => {
  let release!: () => void
  const held = new Promise<void>((resolve) => { release = resolve })
  const props = {
    ...baseProps(),
    submitTurn: async (_text: string, hooks: import('./App.tsx').TurnHooks) => {
      hooks.onToolStart({ id: 'r', name: 'read_file', input: { path: 'src/store.ts' } })
      await held
    },
  }
  const { stdin, lastFrame, unmount } = render(<App {...props} />)
  try {
    await waitForFrame(lastFrame, READY)
    await settle()
    stdin.write('look at the store')
    await waitForFrame(lastFrame, 'look at the store')
    stdin.write('\r')
    const frame = await waitForFrame(lastFrame, 'Reading store.ts…')
    expect(frame).toContain('esc to interrupt')
    release()
  } finally {
    unmount()
  }
})

test('App streams a turn: user line, tool card, assistant text', async () => {
  const { stdin, lastFrame } = render(<App {...baseProps()} />)
  await waitForFrame(lastFrame, READY)
  await settle()
  stdin.write('hi there')
  await waitForFrame(lastFrame, 'hi there')
  stdin.write('\r')
  const frame = await waitForFrame(lastFrame, 'Hello world')
  expect(frame).toContain('hi there')
  expect(frame).toContain('Read x') // compact "verb target" tool line
})

test('a fast double-submit starts exactly one turn and echoes the prompt once', async () => {
  let turns = 0
  const props = {
    ...baseProps(),
    // Hold the turn open so the second Enter lands mid-run.
    submitTurn: async (_t: string, _hooks: import('./App.tsx').TurnHooks) => {
      turns += 1
      await new Promise((resolve) => setTimeout(resolve, 120))
    },
  }
  const { stdin, lastFrame } = render(<App {...props} />)
  await waitForFrame(lastFrame, READY)
  await settle()
  stdin.write('build the thing')
  await waitForFrame(lastFrame, 'build the thing')
  stdin.write('\r')
  stdin.write('\r') // second Enter, before `busy` state has propagated
  await new Promise((resolve) => setTimeout(resolve, 200))
  expect(turns).toBe(1)
  const echoes = (lastFrame() ?? '').split('build the thing').length - 1
  expect(echoes).toBe(1)
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
  await waitForFrame(lastFrame, READY)
  await settle()
  stdin.write(SHIFT_TAB) // autonomous → plan
  await waitForFrame(lastFrame, 'plan mode on')
  stdin.write('research the task')
  await waitForFrame(lastFrame, 'research the task')
  stdin.write('\r')
  await waitForFrame(lastFrame, 'Plan ready')
  expect(sawPlanMode).toBe(true)
})

test('App routes a slash command through handleSlash', async () => {
  const { stdin, lastFrame } = render(<App {...baseProps()} />)
  await waitForFrame(lastFrame, READY)
  await settle()
  stdin.write('/cost')
  await waitForFrame(lastFrame, '/cost')
  stdin.write('\r')
  await waitForFrame(lastFrame, 'slash ok')
})

test('App submits an Elia Book workflow returned by a slash command', async () => {
  let submitted = ''
  const props = {
    ...baseProps(),
    handleSlash: async () => ({ handled: true, text: 'Running Elia Book.', submitText: '<elia-book>verified workflow</elia-book>' }),
    submitTurn: async (text: string) => {
      submitted = text
    },
  }
  const { stdin, lastFrame } = render(<App {...props} />)
  await waitForFrame(lastFrame, READY)
  await settle()
  stdin.write('/eliabook run verified-workflow')
  await waitForFrame(lastFrame, '/eliabook run verified-workflow')
  stdin.write('\r')
  await waitForFrame(lastFrame, 'Running Elia Book.')
  await new Promise((resolve) => setTimeout(resolve, 60))
  expect(submitted).toBe('<elia-book>verified workflow</elia-book>')
})

test('Elia Book menu saves the session with Enter and lets the user browse the saved Book', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'elia-book-menu-'))
  const session = {
    sessionId: 'menu-123', messages: [{ role: 'user' as const, content: [{ type: 'text' as const, text: 'Fix the menu' }] }],
    transcriptMarkdown: '# Menu session', checkpoints: [],
    usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, turns: 1, elapsedMs: 10 },
    providerLabel: 'Test', model: 'test', mode: 'dev',
  }
  let modelCalls = 0
  const { stdin, lastFrame, unmount } = render(<App {...baseProps()}
    handleSlash={async (command) => eliaBookMenu(command.slice('/eliabook'.length), () => session, cwd)}
    submitTurn={async () => { modelCalls += 1 }} />)
  try {
    await waitForFrame(lastFrame, READY)
    await settle()
    stdin.write('/eliabook')
    await waitForFrame(lastFrame, '/eliabook')
    stdin.write('\r')
    const menu = await waitForFrame(lastFrame, 'Save this session')
    expect(menu).toContain('Saved Elia Books')
    await settle()
    stdin.write('\r')
    await waitForFrame(lastFrame, 'Saved this session as Elia Book')
    expect(listEliaBooks(cwd)).toHaveLength(1)
    await settle()
    stdin.write('/eliabook saved')
    await waitForFrame(lastFrame, '/eliabook saved')
    stdin.write('\r')
    await waitForFrame(lastFrame, 'Saved Elia Books (1)')
    await settle()
    stdin.write('\r')
    await waitForFrame(lastFrame, 'Run it with: /eliabook run fix-the-menu')
    expect(modelCalls).toBe(0)
  } finally {
    unmount()
    rmSync(cwd, { recursive: true, force: true })
  }
})

test('status bar reflects a live model change from getEnv', async () => {
  let model = 'mercury-2'
  const { lastFrame, rerender } = render(<App {...baseProps()} getEnv={() => ({ model, providerLabel: 'X', providerName: 'inception' })} />)
  await waitForFrame(lastFrame, READY)
  expect(lastFrame()).toContain('mercury-2')
  model = 'gpt-5.6-terra'
  rerender(<App {...baseProps()} getEnv={() => ({ model, providerLabel: 'X', providerName: 'codex' })} />)
  await waitForFrame(lastFrame, 'gpt-5.6-terra')
})

test('fallback routing is named next to the model it is leading with', async () => {
  // Two rows of the /model picker used to claim to be current at once, and the
  // status row said only "mercury-2.5" — nothing on screen said the session
  // would fall back to other providers. It said "auto", which read as one more
  // autonomy switch; it is model fallback, so it says so.
  const { lastFrame } = render(
    <App {...baseProps()} getEnv={() => ({ model: 'mercury-2.5', providerLabel: 'mercury', providerName: 'mercury', routing: 'auto' as const })} />,
  )
  await waitForFrame(lastFrame, READY)
  expect(lastFrame()).toContain('mercury-2.5 + fallback')
})

test('a session on one selected provider says nothing about routing', async () => {
  const { lastFrame } = render(
    <App {...baseProps()} getEnv={() => ({ model: 'mercury-2.5', providerLabel: 'mercury', providerName: 'mercury', routing: 'selected' as const })} />,
  )
  await waitForFrame(lastFrame, READY)
  expect(lastFrame()).toContain('mercury-2.5')
  expect(lastFrame()).not.toContain('fallback')
})

test('a codex-subscription message submits without a per-turn hand-off prompt', async () => {
  // The subscription is confirmed once per session by the agent loop's own
  // governor, not re-approved on every message, so the App submits straight
  // through and never renders the old "Hand this task to Codex?" confirmation.
  let submitted = ''
  const props = {
    ...baseProps(),
    getEnv: () => ({ model: 'gpt-5.6-terra', providerLabel: 'Codex', providerName: 'codex' }),
    submitTurn: async (text: string) => {
      submitted = text
    },
  }
  const { stdin, lastFrame } = render(<App {...props} />)
  await waitForFrame(lastFrame, READY)
  await settle()
  stdin.write('build me a thing')
  await waitForFrame(lastFrame, 'build me a thing')
  stdin.write('\r')
  await new Promise((resolve) => setTimeout(resolve, 60))
  expect(lastFrame()).not.toContain('Hand this task to Codex?')
  expect(submitted).toBe('build me a thing')
})

test('maps structured provider plan activity into workspace todo state', () => {
  expect(providerPlanItems('Reason for the plan\n[done] inspect\n[active] implement\n[pending] verify')).toEqual([
    { content: 'inspect', status: 'completed' },
    { content: 'implement', status: 'in_progress' },
    { content: 'verify', status: 'pending' },
  ])
  // elia's own up-front plan uses the panel's glyphs.
  expect(providerPlanItems('◐ write the data\n□ build the filters\n✓ already done')).toEqual([
    { content: 'write the data', status: 'in_progress' },
    { content: 'build the filters', status: 'pending' },
    { content: 'already done', status: 'completed' },
  ])
})

test('a planned turn shows the thinking, then the plan, before the first tool runs', async () => {
  const props = {
    ...baseProps(),
    submitTurn: async (_text: string, hooks: import('./App.tsx').TurnHooks) => {
      hooks.onActivity({ kind: 'status', status: 'completed', title: '✦ memory · 9 lessons from earlier sessions' })
      hooks.onThinking('The user wants a laptop picker. ')
      hooks.onThinking('A static page previews fastest.')
      hooks.onActivity({ kind: 'plan', status: 'completed', title: 'Plan · 2 steps', detail: '◐ Write index.html\n□ Open the page to check it' })
      hooks.onToolStart({ id: 't1', name: 'write_file', input: { path: 'index.html' } })
      hooks.onTool({ id: 't1', name: 'write_file', input: { path: 'index.html' }, result: 'wrote index.html', isError: false, durationMs: 3, cached: false })
    },
  }
  const { stdin, lastFrame, frames, unmount } = render(<App {...props} />)
  try {
    await waitForFrame(lastFrame, READY)
    await settle()
    stdin.write('create a laptop suggestion website')
    await waitForFrame(lastFrame, 'create a laptop suggestion website')
    stdin.write('\r')
    await waitForFrame(lastFrame, 'index.html')
    const screen = frames.join('\n')
    const thinkingAt = screen.indexOf('✻ The user wants a laptop picker. A static page previews fastest.')
    // The plan shows up in the live panel — once, not also flattened into scrollback.
    const planAt = screen.indexOf('Plan · 0/2')
    const toolAt = screen.lastIndexOf('index.html')
    expect(screen).toContain('✦ memory · 9 lessons from earlier sessions')
    expect(thinkingAt).toBeGreaterThan(-1)
    expect(planAt).toBeGreaterThan(thinkingAt)
    expect(toolAt).toBeGreaterThan(planAt)
    expect(screen).toContain('◐ Write index.html')
    expect(screen).not.toContain('Plan · 2 steps')
  } finally {
    unmount()
  }
})

test('the plan panel follows elia\'s ticks during the turn and gives way to a receipt after it', async () => {
  let release!: () => void
  const held = new Promise<void>((resolve) => { release = resolve })
  const props = {
    ...baseProps(),
    submitTurn: async (_text: string, hooks: import('./App.tsx').TurnHooks) => {
      hooks.onActivity({ kind: 'plan', status: 'completed', title: 'Plan · 3 steps', detail: '◐ Write index.html\n□ Add the styles\n□ Open the page to check it' })
      // What agent.ts surfaces when the evidence ticks a step.
      hooks.onActivity({ kind: 'plan', status: 'updated', title: 'Plan · 1/3 done', detail: '✓ Write index.html\n◐ Add the styles\n□ Open the page to check it' })
      await held
    },
  }
  const { stdin, lastFrame, unmount } = render(<App {...props} />)
  try {
    await waitForFrame(lastFrame, READY)
    await settle()
    stdin.write('create a laptop suggestion website')
    await waitForFrame(lastFrame, 'create a laptop suggestion website')
    stdin.write('\r')
    const during = await waitForFrame(lastFrame, '1/3')
    expect(during).toContain('✓ Write index.html')
    expect(during).toContain('◐ Add the styles')
    release()
    const after = await waitForFrame(lastFrame, 'still open')
    expect(after).toContain('◐ Plan · 1/3 done — still open:')
    expect(after).toContain('□ Add the styles')
    // The live panel (a "Plan · n/m" heading at the left edge) is gone; the receipt is the record.
    expect(after).not.toMatch(/^Plan · /m)
  } finally {
    unmount()
  }
})

test("an escalated run's approved plan shows in the panel and closes with a receipt", async () => {
  let release!: () => void
  const held = new Promise<void>((resolve) => { release = resolve })
  const props = {
    ...baseProps(),
    submitTurn: async (_text: string, hooks: import('./App.tsx').TurnHooks) => {
      hooks.onRunPlan?.([
        { id: 'step-a', title: 'Set up the Streamlit project' },
        { id: 'step-b', title: 'Chart the training metrics' },
      ])
      await held
    },
  }
  const { stdin, lastFrame, unmount } = render(<App {...props} />)
  try {
    await waitForFrame(lastFrame, READY)
    await settle()
    stdin.write('create me a python web app')
    await waitForFrame(lastFrame, 'create me a python web app')
    stdin.write('\r')
    const during = await waitForFrame(lastFrame, 'Plan · 0/2')
    expect(during).toContain('□ Set up the Streamlit project')
    expect(during).toContain('□ Chart the training metrics')
    release()
    const after = await waitForFrame(lastFrame, 'still open')
    expect(after).toContain('◐ Plan · 0/2 done — still open:')
    expect(after).not.toMatch(/^Plan · /m)
  } finally {
    unmount()
  }
})

test('planReceipt says a finished plan is finished and names what is still open', () => {
  expect(planReceipt([{ content: 'a', status: 'completed' }, { content: 'b', status: 'completed' }])).toBe('✓ Plan complete · 2/2 steps')
  expect(planReceipt([{ content: 'a', status: 'completed' }, { content: 'b', status: 'in_progress' }, { content: 'c', status: 'pending' }]))
    .toBe('◐ Plan · 1/3 done — still open:\n  □ b\n  □ c')
})

test('an open approval hides the live workspace panel behind it', async () => {
  const props = {
    ...baseProps(),
    submitTurn: async (_text: string, hooks: import('./App.tsx').TurnHooks) => {
      hooks.onActivity({ kind: 'plan', status: 'updated', title: 'Plan', detail: '[active] build the thing' })
      await hooks.approve({ title: 'Approve edit_file?', lines: ['about to write src/x.ts'], ruleLabel: 'edit_file' })
    },
  }
  const { stdin, lastFrame } = render(<App {...props} />)
  await waitForFrame(lastFrame, READY)
  await settle()
  stdin.write('do the thing')
  await waitForFrame(lastFrame, 'do the thing')
  stdin.write('\r')
  const frame = await waitForFrame(lastFrame, 'Approve edit_file?')
  // The workspace panel (which would show this plan) and the working indicator
  // are frozen out while the modal owns the screen.
  expect(frame).not.toContain('build the thing')
  expect(frame).not.toContain('esc to interrupt')
})

test('a queued command does not auto-run after the turn is aborted with Esc', async () => {
  let shellRuns = 0
  const props = {
    ...baseProps(),
    runShellLine: async (c: string) => {
      shellRuns += 1
      return `ran ${c}`
    },
    // Holds the turn open until its AbortSignal fires — simulates a long-
    // running turn the user interrupts with Esc.
    submitTurn: async (_t: string, hooks: import('./App.tsx').TurnHooks) =>
      new Promise<void>((resolve) => {
        if (hooks.signal.aborted) return resolve()
        hooks.signal.addEventListener('abort', () => resolve(), { once: true })
      }),
  }
  const { stdin, lastFrame } = render(<App {...props} />)
  await waitForFrame(lastFrame, READY)
  await settle()
  stdin.write('long running task')
  await waitForFrame(lastFrame, 'long running task')
  stdin.write('\r')
  await waitForFrame(lastFrame, 'esc to interrupt') // turn is now busy

  // Queue a shell escape while the turn is still running.
  stdin.write('!echo hi')
  await waitForFrame(lastFrame, '!echo hi')
  stdin.write('\r')
  await waitForFrame(lastFrame, '1 queued')

  // Stop the turn — the UI promises queued items are kept, not auto-run.
  stdin.write('\x1B') // Esc
  await waitForFrame(lastFrame, 'Stopping the turn')

  // Let the aborted turn's `runOne` resolve and the post-turn drain loop run.
  await new Promise((resolve) => setTimeout(resolve, 150))
  expect(shellRuns).toBe(0)
  // The queued item is still there, waiting for an explicit send.
  expect(lastFrame()).toContain('1 queued')
})

test('keeps transient progress out of scrollback and preserves outcomes', () => {
  expect(shouldPersistActivity({ kind: 'status', status: 'updated', title: 'Repairing' })).toBe(false)
  expect(shouldPersistActivity({ kind: 'plan', status: 'updated', title: 'Plan updated' })).toBe(false)
  // A plan lives in the plan panel even when it arrives as "completed".
  expect(shouldPersistActivity({ kind: 'plan', status: 'completed', title: 'Plan · 3 steps' })).toBe(false)
  expect(shouldPersistActivity({ kind: 'command', status: 'completed', title: 'Build passed' })).toBe(true)
  expect(shouldPersistActivity({ kind: 'warning', status: 'warning', title: 'Build failed' })).toBe(true)
})

test('a /clear outcome wipes the transcript and continues as the new session', async () => {
  let slashCalls = 0
  const props = {
    ...baseProps(),
    handleSlash: async () => {
      slashCalls += 1
      return { handled: true, text: 'Started a fresh conversation.', clear: { sessionId: 'fresh-session' } }
    },
  }
  const { stdin, lastFrame, stdout, unmount } = render(<App {...props} />)
  try {
    await waitForFrame(lastFrame, READY)
    await settle()
    stdin.write('hi there')
    await waitForFrame(lastFrame, 'hi there')
    stdin.write('\r')
    await waitForFrame(lastFrame, 'Hello world')
    await settle()
    stdin.write('/clear')
    await waitForFrame(lastFrame, '/clear')
    stdin.write('\r')
    // The notice is the first item after the reset — <Static> must not skip it.
    const frame = await waitForFrame(lastFrame, 'Started a fresh conversation.')
    expect(slashCalls).toBe(1)
    // The screen-and-scrollback erase went to the terminal.
    expect(stdout.frames.some((f) => f.includes('\x1b[2J\x1b[3J\x1b[H'))).toBe(true)
    expect(frame.split('\x1b[2J\x1b[3J\x1b[H').at(-1)).not.toContain('Hello world')
  } finally {
    unmount()
  }
})

test('the token count keeps moving through a turn that streams nothing', async () => {
  let release!: () => void
  const held = new Promise<void>((resolve) => { release = resolve })
  const props = {
    ...baseProps(),
    submitTurn: async (_text: string, hooks: import('./App.tsx').TurnHooks) => {
      hooks.onToolStart({ id: 'w', name: 'write_file', input: { path: 'src/parser.ts' } })
      // A silent model call lands: nothing was shown, 1.2k tokens were written.
      reportLiveOutput({ kind: 'settled', outputTokens: 1_200 })
      await held
    },
  }
  const { stdin, lastFrame, unmount } = render(<App {...props} />)
  try {
    await waitForFrame(lastFrame, READY)
    await settle()
    stdin.write('rewrite the parser')
    await waitForFrame(lastFrame, 'rewrite the parser')
    stdin.write('\r')
    expect(await waitForFrame(lastFrame, '1.2k tokens', 5_000)).toContain('esc to interrupt')
    // And it keeps climbing as the next call's arguments stream.
    reportLiveOutput({ kind: 'streaming', chars: 4_000 })
    await waitForFrame(lastFrame, '2.2k tokens', 5_000)
    release()
  } finally {
    unmount()
  }
})

// Session mubbhz5c-tnp9i0: `/settings` was typed while a run was in flight, so
// it was queued. The drain handed it to `runOne`, which sent the literal text
// to the model as a prompt — and the model, seeing a build request and no
// outcome for it, carried on building.
test('a slash command queued during a turn is dispatched, not sent to the model', async () => {
  let slashCalls: string[] = []
  let prompts: string[] = []
  // The turn stays open until the test has seen the command queued. A fixed
  // 80ms turn raced the two screen checks below and, on a loaded machine, ended
  // first — the command then ran directly and the test failed on a correct app.
  let release: () => void = () => {}
  const turnOpen = new Promise<void>((resolve) => {
    release = resolve
  })
  const props = {
    ...baseProps(),
    handleSlash: async (command: string) => {
      slashCalls.push(command)
      return { handled: true, text: 'Settings opened' }
    },
    submitTurn: async (text: string, _hooks: import('./App.tsx').TurnHooks) => {
      prompts.push(text)
      await turnOpen
    },
  }
  const { stdin, lastFrame } = render(<App {...props} />)
  await waitForFrame(lastFrame, READY)
  await settle()
  stdin.write('build the thing')
  await waitForFrame(lastFrame, 'build the thing')
  stdin.write('\r')
  await waitForFrame(lastFrame, 'esc to interrupt')

  stdin.write('/settings')
  await waitForFrame(lastFrame, '/settings')
  stdin.write('\r')
  await waitForFrame(lastFrame, '1 queued')
  expect(slashCalls).toEqual([])

  release()
  await waitForFrame(lastFrame, 'Settings opened')

  expect(slashCalls).toEqual(['/settings'])
  // The whole point: it must not have become a prompt.
  expect(prompts).toEqual(['build the thing'])
})

test('a message typed mid-turn opens the thinking panel, is answered there, and leaves a receipt when it closes', async () => {
  let release!: () => void
  const held = new Promise<void>((resolve) => { release = resolve })
  const drained: string[][] = []
  const asked: Array<{ question: string; request: string; tools: string[] }> = []
  const props = {
    ...baseProps(),
    panelReadMs: 800,
    submitTurn: async (_text: string, hooks: import('./App.tsx').TurnHooks) => {
      hooks.onToolStart({ id: 'r1', name: 'read_file', input: { path: 'src/auth.ts' } })
      hooks.onTool({ id: 'r1', name: 'read_file', input: { path: 'src/auth.ts' }, result: 'export function login() {}', isError: false, durationMs: 2, cached: false })
      await held
      drained.push(hooks.drainSteering())
    },
    liveReply: async (question: string, view: import('../../live/liveReply.ts').LiveView) => {
      asked.push({ question, request: view.request, tools: view.recentTools.map((tool) => tool.name) })
      if (question.startsWith('also')) return { answer: 'Sure — I will add tests after the fix.', steer: 'Add unit tests for login() after fixing it.' }
      return { answer: 'I am reading src/auth.ts to find where the session expires.' }
    },
  }
  const { stdin, lastFrame, unmount } = render(<App {...props} />)
  try {
    await waitForFrame(lastFrame, READY)
    await settle()
    stdin.write('fix the login bug')
    await waitForFrame(lastFrame, 'fix the login bug')
    stdin.write('\r')
    await waitForFrame(lastFrame, 'esc to interrupt')

    stdin.write('what are you doing?')
    await waitForFrame(lastFrame, 'what are you doing?')
    stdin.write('\r')
    const answered = await waitForFrame(lastFrame, 'No plan change.')
    expect(answered).toContain('find where the session expires')
    expect(answered).toContain('Thinking about your note')
    // Where the work stands comes from what ran, not from the model.
    expect(answered).toContain('Right now:')
    expect(answered).toContain('No plan change.')
    // The turn is still running: an answer is not a turn.
    expect(answered).toContain('esc to interrupt')
    // Once read, the panel shuts and the exchange stays as a receipt.
    const closed = await waitForFrame(lastFrame, 'you, mid-task: what are you doing?')
    expect(closed).not.toContain('Thinking about your note')

    stdin.write('also add tests')
    await waitForFrame(lastFrame, 'also add tests')
    stdin.write('\r')
    await waitForFrame(lastFrame, 'your note reaches the work at its next step')

    release()
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(asked[0]).toEqual({ question: 'what are you doing?', request: 'fix the login bug', tools: ['read_file'] })
    // Only the instruction the live lane distilled reaches the work — not the raw chat.
    expect(drained).toEqual([['Add unit tests for login() after fixing it.']])
  } finally {
    unmount()
  }
})

test('the panel streams the thinking, and a plan change lands in the main plan and reaches the run by step id', async () => {
  let release!: () => void
  const held = new Promise<void>((resolve) => { release = resolve })
  let think!: () => void
  const thought = new Promise<void>((resolve) => { think = resolve })
  const drained: string[][] = []
  const props = {
    ...baseProps(),
    panelReadMs: 60_000,
    submitTurn: async (_text: string, hooks: import('./App.tsx').TurnHooks) => {
      hooks.onRunPlan?.([
        { id: 'schema', title: 'Design the schema' },
        { id: 'api', title: 'Build the API' },
        { id: 'ui', title: 'Build the page' },
      ])
      await held
      drained.push(hooks.drainSteering())
    },
    liveReply: async (_question: string, view: import('../../live/liveReply.ts').LiveView, _signal: AbortSignal, onThinking?: (text: string) => void) => {
      expect(view.plan.map((step) => step.content)).toEqual(['Design the schema', 'Build the API', 'Build the page'])
      onThinking?.('They want real data, so the API step changes and seeding comes first.')
      await thought
      return {
        answer: 'The API will read from Postgres, seeded with realistic rows.',
        steer: "The person's note: make it realistic",
        wants: 'realistic data from a real database',
        edits: [
          { kind: 'change' as const, step: 2, to: 'Build the API on Postgres' },
          { kind: 'add' as const, after: 1, title: 'Seed realistic rows' },
        ],
      }
    },
  }
  const { stdin, lastFrame, unmount } = render(<App {...props} />)
  try {
    await waitForFrame(lastFrame, READY)
    await settle()
    stdin.write('build the shop')
    await waitForFrame(lastFrame, 'build the shop')
    stdin.write('\r')
    await waitForFrame(lastFrame, 'Build the API')

    stdin.write('make it realistic')
    await waitForFrame(lastFrame, 'make it realistic')
    stdin.write('\r')
    // The reasoning shows while it is still being written.
    await waitForFrame(lastFrame, 'so the API step changes')
    think()
    const updated = await waitForFrame(lastFrame, 'Plan updated')
    expect(updated).toContain('You want:')
    expect(updated).toContain('realistic data from a real database')
    expect(updated).toContain('~ Build the API → Build the API on Postgres')
    expect(updated).toContain('+ Seed realistic rows')
    // The main chat's plan changed too, and says why.
    expect(updated).toContain('1 changed, 1 added from your note')
    expect(updated).toContain('+ Seed realistic rows')
    expect(updated).toContain('~ Build the API on Postgres')
    expect(updated.indexOf('+ Seed realistic rows')).toBeLessThan(updated.indexOf('~ Build the API on Postgres'))

    release()
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(drained).toHaveLength(1)
    const note = drained[0]![0]!
    expect(note).toContain("The person's note: make it realistic")
    const change = JSON.parse(note.slice(note.indexOf('<plan-change>') + '<plan-change>'.length, note.indexOf('</plan-change>')))
    expect(change).toEqual({
      wants: 'realistic data from a real database',
      edits: [
        { kind: 'change', stepId: 'api', stepTitle: 'Build the API', to: 'Build the API on Postgres' },
        { kind: 'add', title: 'Seed realistic rows', afterId: 'schema', afterTitle: 'Design the schema' },
      ],
    })
  } finally {
    unmount()
  }
})

test('ctrl+w keeps the thinking panel open past its reading time, and ctrl+w again puts it away', async () => {
  let release!: () => void
  const held = new Promise<void>((resolve) => { release = resolve })
  const props = {
    ...baseProps(),
    panelReadMs: 1_000,
    submitTurn: async () => {
      await held
    },
    liveReply: async () => ({ answer: 'Halfway through the parser.' }),
  }
  const { stdin, lastFrame, unmount } = render(<App {...props} />)
  try {
    await waitForFrame(lastFrame, READY)
    await settle()
    stdin.write('go')
    await waitForFrame(lastFrame, 'go')
    stdin.write('\r')
    await waitForFrame(lastFrame, 'esc to interrupt')
    stdin.write('how far along?')
    await waitForFrame(lastFrame, 'how far along?')
    stdin.write('\r')
    await waitForFrame(lastFrame, 'ctrl+w keeps this open')
    stdin.write('\x17')
    await waitForFrame(lastFrame, 'ctrl+w hides this')
    await new Promise((resolve) => setTimeout(resolve, 1_500))
    // Pinned: the reading time passed and it is still there, with no receipt yet.
    expect(lastFrame()).toContain('Halfway through the parser.')
    expect(lastFrame()).not.toContain('you, mid-task')
    // ctrl+w never types into the input.
    expect(lastFrame()).not.toMatch(/❯ w\b/)
    stdin.write('\x17')
    const closed = await waitForFrame(lastFrame, 'you, mid-task: how far along?')
    expect(closed).not.toContain('ctrl+w hides this')
    release()
  } finally {
    unmount()
  }
})

test('when the live lane cannot answer, the message still reaches the work as steering', async () => {
  let release!: () => void
  const held = new Promise<void>((resolve) => { release = resolve })
  const drained: string[][] = []
  const props = {
    ...baseProps(),
    submitTurn: async (_text: string, hooks: import('./App.tsx').TurnHooks) => {
      await held
      drained.push(hooks.drainSteering())
    },
    liveReply: async () => {
      throw new Error('provider down')
    },
  }
  const { stdin, lastFrame, unmount } = render(<App {...props} />)
  try {
    await waitForFrame(lastFrame, READY)
    await settle()
    stdin.write('build it')
    await waitForFrame(lastFrame, 'build it')
    stdin.write('\r')
    await waitForFrame(lastFrame, 'esc to interrupt')
    stdin.write('use postgres not sqlite')
    await waitForFrame(lastFrame, 'use postgres not sqlite')
    stdin.write('\r')
    await waitForFrame(lastFrame, 'could not think it through (provider down)')
    release()
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(drained).toEqual([['use postgres not sqlite']])
  } finally {
    unmount()
  }
})

test('a slash command can run as a turn of its own, and mid-turn messages reach it as steering', async () => {
  let release!: () => void
  const held = new Promise<void>((resolve) => { release = resolve })
  const seen: string[][] = []
  const props = {
    ...baseProps(),
    handleSlash: async () => ({
      handled: true,
      text: 'autopilot starting',
      turn: {
        label: '/autopilot',
        run: async (hooks: import('./App.tsx').TurnHooks) => {
          hooks.onText('◆ surveying the repository…\n')
          await held
          seen.push(hooks.drainSteering())
        },
      },
    }),
    liveReply: async () => ({ answer: 'Adding it to the backlog.', steer: 'add a /health endpoint' }),
  }
  const { stdin, lastFrame, unmount } = render(<App {...props} />)
  try {
    await waitForFrame(lastFrame, READY)
    await settle()
    stdin.write('/autopilot')
    await waitForFrame(lastFrame, '/autopilot')
    stdin.write('\r')
    await waitForFrame(lastFrame, 'surveying the repository')
    await waitForFrame(lastFrame, 'esc to interrupt')
    stdin.write('please add a health endpoint')
    await waitForFrame(lastFrame, 'please add a health endpoint')
    stdin.write('\r')
    await waitForFrame(lastFrame, 'Adding it to the backlog.')
    release()
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(seen).toEqual([['add a /health endpoint']])
  } finally {
    unmount()
  }
})

test('a session can start working by itself, and you can talk to it while it does', async () => {
  let release!: () => void
  const held = new Promise<void>((resolve) => { release = resolve })
  let ran = 0
  const props = {
    ...baseProps(),
    initialTurn: {
      label: '/autopilot',
      notice: 'Working on this project by myself.',
      run: async (hooks: import('./App.tsx').TurnHooks) => {
        ran += 1
        hooks.onActivity({ kind: 'status', title: '◆ surveying the repository…', status: 'completed' })
        await held
      },
    },
    liveReply: async () => ({ answer: 'Surveying the repo, then running its tests.' }),
  }
  const { stdin, lastFrame, unmount } = render(<App {...props} />)
  try {
    const started = await waitForFrame(lastFrame, 'surveying the repository')
    expect(started).toContain('Working on this project by myself.')
    expect(started).toContain('esc to interrupt')
    // Started by the session, not typed: no user line echoes the label.
    expect(started).not.toContain('❯ /autopilot')
    stdin.write('what are you up to')
    await waitForFrame(lastFrame, 'what are you up to')
    stdin.write('\r')
    await waitForFrame(lastFrame, 'then running its tests')
    release()
    await waitForFrame(lastFrame, READY)
    expect(ran).toBe(1)
  } finally {
    unmount()
  }
})

test('a new turn counts its own tokens, not the ones before it', async () => {
  let turns = 0
  let release!: () => void
  const held = new Promise<void>((resolve) => { release = resolve })
  const props = {
    ...baseProps(),
    submitTurn: async (_t: string, hooks: import('./App.tsx').TurnHooks) => {
      turns += 1
      if (turns === 1) {
        reportLiveOutput({ kind: 'settled', outputTokens: 900 })
        return
      }
      hooks.onActivity({ kind: 'status', title: 'Second turn working', status: 'started' })
      await held
    },
  }
  const { stdin, lastFrame, unmount } = render(<App {...props} />)
  try {
    await waitForFrame(lastFrame, READY)
    await settle()
    stdin.write('first')
    await waitForFrame(lastFrame, 'first')
    stdin.write('\r')
    await waitForFrame(lastFrame, READY)
    await settle()
    stdin.write('second')
    await waitForFrame(lastFrame, 'second')
    stdin.write('\r')
    // The second turn's working line starts from zero, not from the first turn's 900.
    expect(await waitForFrame(lastFrame, 'Second turn working')).not.toContain('900')
    release()
  } finally {
    unmount()
  }
})

test('there is one way of working: no approval posture to pick, and shift+tab only toggles plan mode', async () => {
  const { stdin, lastFrame, unmount } = render(<App {...baseProps()} />)
  try {
    const idle = await waitForFrame(lastFrame, READY)
    expect(idle).not.toContain('ask first')
    expect(idle).not.toContain('auto-accept')
    await settle()
    stdin.write('\x1b[Z')
    await waitForFrame(lastFrame, 'plan mode on')
    stdin.write('\x1b[Z')
    const back = await waitForFrame(lastFrame, READY)
    expect(back).not.toContain('plan mode on')
  } finally {
    unmount()
  }
})

test('the status row shows what the session has spent against its limit, once it has spent anything', async () => {
  const { recordUsage, resetSessionUsageForTests } = await import('../../usage.ts')
  const prior = process.env.ELIA_MAX_SPEND_USD
  resetSessionUsageForTests()
  process.env.ELIA_MAX_SPEND_USD = '1'
  try {
    const props = {
      ...baseProps(),
      submitTurn: async () => {
        // 50k input + 2k output on mercury-2.5: $0.0115.
        recordUsage({ inputTokens: 50_000, outputTokens: 2_000, cacheReadTokens: 0, cacheWriteTokens: 0 }, 'mercury-2.5')
      },
    }
    const { stdin, lastFrame, unmount } = render(<App {...props} />)
    try {
      const idle = await waitForFrame(lastFrame, READY)
      expect(idle).not.toContain('of $1.00')
      await settle()
      stdin.write('go')
      await waitForFrame(lastFrame, 'go')
      stdin.write('\r')
      const spent = await waitForFrame(lastFrame, '$0.012 of $1.00')
      expect(spent).toContain('$0.012 of $1.00 · mercury-2')
    } finally {
      unmount()
    }
  } finally {
    resetSessionUsageForTests()
    if (prior === undefined) delete process.env.ELIA_MAX_SPEND_USD
    else process.env.ELIA_MAX_SPEND_USD = prior
  }
})
