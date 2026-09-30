import { expect, test } from 'bun:test'

process.env.ANTHROPIC_API_KEY ??= 'test-key-for-loop-test'

const { repairFileContext, retryGuidanceFor } = await import('./loop.ts')

// A retried step used to always hear "route around it: use a different
// path" — reasonable advice for a genuine access refusal, but actively wrong
// for an ordinary failure (a stale edit target, a bad verification command).
// Taken literally, it is exactly how one goal ends up built twice at two
// different paths in a single run (seen live: `workspace/car-game/` from the
// plan, `workspace/car-game.html` from a retry that "routed around" a failure
// that had nothing to do with file access).

test('an access-refusal failure still gets told to route around it', () => {
  const guidance = retryGuidanceFor('write_file refused: path is protected by policy')
  expect(guidance).toContain('route around it')
})

test('a governor block still gets told to route around it', () => {
  const guidance = retryGuidanceFor('Action blocked by autonomy governor: critical risk')
  expect(guidance).toContain('route around it')
})

test('an ordinary edit failure is told to fix the target in place, not relocate it', () => {
  const guidance = retryGuidanceFor('old_string not found in workspace/car-game/game.js')
  expect(guidance).not.toContain('route around it')
  expect(guidance).toContain('in place')
})

test('a failed verification command is told to fix the target in place, not relocate it', () => {
  const guidance = retryGuidanceFor("'Open' is not recognized as an internal or external command")
  expect(guidance).not.toContain('route around it')
})

// The top-level repair "lead" agent used to see only the goal and the
// failure text — no file list — so it could plausibly re-scaffold a "clean"
// copy of the deliverable while the original sat untouched on disk. Naming
// the plan's own files closes that gap.
test('repairFileContext names every file the plan declared, deduplicated', () => {
  const context = repairFileContext({
    steps: [
      { id: 's1', title: 'a', role: 'builder', instructions: '', files: ['workspace/car-game/index.html', 'workspace/car-game/game.js'], dependsOn: [] },
      { id: 's2', title: 'b', role: 'builder', instructions: '', files: ['workspace/car-game/game.js'], dependsOn: [] },
    ],
  })
  expect(context).toContain('workspace/car-game/index.html')
  expect(context.match(/workspace\/car-game\/game\.js/g)).toHaveLength(1)
  expect(context).toContain('list_files')
  expect(context).toContain('Do not scaffold a fresh copy')
})

test('repairFileContext is empty when no step declared any files', () => {
  const context = repairFileContext({ steps: [{ id: 's1', title: 'a', role: 'builder', instructions: '', files: [], dependsOn: [] }] })
  expect(context).toBe('')
})

// Run 2026-09-13-gcsd-km67 ("create a dynamic website for navigating kolkata"):
// the workspace was empty, so three list_files returned "No files matched" and
// the scout went to the web instead — ten searches and eight fetches about
// Leaflet, then it hit its own step limit and reported back "stopped early —
// treat this report as incomplete". Ninety seconds, twenty-five actions, no
// plan, and the operator killed it. Step budgets alone never bounded this.
const { autonomyProfileDefaults, orientBudgetMsFor } = await import('./loop.ts')

test('every profile bounds how long orienting may run', () => {
  for (const profile of ['fast', 'balanced', 'thorough'] as const) {
    const budget = autonomyProfileDefaults(profile).orientBudgetMs
    expect(budget).toBeGreaterThan(0)
    expect(budget).toBeLessThanOrEqual(180_000)
  }
})

test('a faster profile does not orient for longer than a slower one', () => {
  const fast = autonomyProfileDefaults('fast').orientBudgetMs
  const balanced = autonomyProfileDefaults('balanced').orientBudgetMs
  const thorough = autonomyProfileDefaults('thorough').orientBudgetMs
  expect(fast).toBeLessThanOrEqual(balanced)
  expect(balanced).toBeLessThanOrEqual(thorough)
})

test('an operator can override the orient budget', () => {
  expect(orientBudgetMsFor(90_000, { ELIA_ORIENT_BUDGET_S: '20' })).toBe(20_000)
  expect(orientBudgetMsFor(90_000, {})).toBe(90_000)
  // Nonsense falls back rather than producing a zero budget that proposes instantly.
  for (const raw of ['0', '-5', 'soon', '']) {
    expect(orientBudgetMsFor(90_000, { ELIA_ORIENT_BUDGET_S: raw })).toBe(90_000)
  }
})

// An escalated turn ("create a expo app for notetaking") produced a plan with
// nothing in front of it: orienting is all read_file and grep, mercury-2.5
// returns no reasoning of its own, and the planner is told not to narrate its
// plan in prose. So between "elia will research this first" and a finished
// five-step plan the user watched a silent minute and asked, fairly, why it had
// not thought before planning — a chat turn had always thought out loud first.
// This drives the real run: the opening thought must reach the thinking channel
// before the proposal does.
test('an autonomous run thinks out loud before it proposes a plan', async () => {
  const { mkdtempSync, rmSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { config } = await import('../config.ts')
  const { createScriptedProvider } = await import('../bench/latency/scriptedProvider.ts')
  const { runAutonomousTask } = await import('./loop.ts')

  const provider = createScriptedProvider([
    { text: 'I read this as a plain Expo notes app. I will scaffold it and keep notes on the device. The risk is the CLI stopping for a prompt.' },
    {
      toolCalls: [
        {
          name: 'submit_proposal',
          input: {
            goal: 'create an expo app for notetaking',
            understanding: 'A fresh Expo app with local note storage.',
            steps: [{ id: 's1', title: 'Scaffold the Expo app', instructions: 'Run create-expo-app', role: 'builder', files: ['package.json'], dependsOn: [] }],
            verification: ['npx tsc --noEmit'],
            acceptanceCriteria: ['The app builds'],
          },
        },
      ],
    },
  ])
  const original = config.provider
  const workspace = mkdtempSync(join(tmpdir(), 'elia-orient-'))
  const seen: string[] = []
  let thinkingBeforePlan = ''
  try {
    config.provider = provider
    const result = await runAutonomousTask({
      goal: 'create a expo app for notetaking',
      workspaceRoot: workspace,
      // The plan is rejected, so the run stops at the gate: this covers
      // orienting only, and nothing is ever built or committed.
      approve: async () => {
        thinkingBeforePlan = seen.join('')
        return { action: 'reject' as const }
      },
      onThinking: (delta) => seen.push(delta),
      profile: 'fast',
      polish: false,
      publish: false,
      learn: false,
    })
    expect(result.outcome).toBe('rejected')
  } finally {
    config.provider = original
    rmSync(workspace, { recursive: true, force: true })
  }

  expect(thinkingBeforePlan).toContain('Expo notes app')
  expect(thinkingBeforePlan).toContain('The risk is')
  // Streamed as it was written, not delivered in one block at the end.
  expect(seen.length).toBeGreaterThan(5)
})

/**
 * A run that is actually approved.
 *
 * Every other test in this file stops at the gate — `approve` returns `reject`,
 * and the comment on the one real run says so outright: "this covers orienting
 * only, and nothing is ever built or committed". So of the seven phases in
 * `runAutonomousTaskInternal`, execute, publish, polish, verify and learn —
 * about 930 lines — have never been driven end to end by anything in the suite.
 *
 * That is the part of elia with the worst history. The debugging rounds that
 * produced `agentBehaviour.test.ts` were nearly all failures past the gate:
 * verification verdicts that were wrong, a repair loop that rebuilt a
 * deliverable at a second path, runs that reported success with no evidence.
 * Those are exactly the phases nothing was watching.
 *
 * This approves the plan and lets the run go. The scripted provider returns a
 * plain "done." once its script is exhausted, so the workers finish without
 * tool calls and the run reaches verification on its own. It is a
 * characterization test: it pins what an approved run *does today* — which
 * phases it enters, that verification really executes, that a result comes back
 * whole — so that the 1,508-line function can be split into those phases
 * without doing it blind.
 */
test('an approved run reaches execution and verification, and returns a whole result', async () => {
  const { mkdtempSync, rmSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { config } = await import('../config.ts')
  const { createScriptedProvider } = await import('../bench/latency/scriptedProvider.ts')
  const { runAutonomousTask } = await import('./loop.ts')

  const provider = createScriptedProvider([
    { text: 'A single text file. Nothing to scaffold; I will write it and check it exists.' },
    {
      toolCalls: [
        {
          name: 'submit_proposal',
          input: {
            goal: 'write a greeting file',
            understanding: 'Create greeting.txt containing a greeting.',
            steps: [{ id: 's1', title: 'Write greeting.txt', instructions: 'Write greeting.txt', role: 'builder', files: ['greeting.txt'], dependsOn: [] }],
            // A command that really runs, so the verify phase is exercised
            // rather than skipped, and that passes on both CI platforms.
            verification: ['echo ok'],
            acceptanceCriteria: ['greeting.txt exists'],
          },
        },
      ],
    },
  ])

  // Pointing `config.provider` at the script is not enough, and finding that out
  // is half of why this test is worth having: workers, the critic and the
  // hygiene reviewer each resolve their own route through `tierConfig`, so the
  // first version of this test quietly reached the network and billed a real
  // mercury + groq run. Every tier and the fallback list have to be redirected
  // or an 'offline' test is nothing of the sort.
  const original = config.provider
  const originalTiers = { fast: config.tiers.fast, deep: config.tiers.deep }
  const originalFallbacks = config.fallbacks
  const originalRouting = config.routingMode
  const scriptedTier = (tier: typeof config.tiers.fast) => ({ ...tier, provider, providerName: 'scripted', model: 'scripted' })
  // An explicit temp root, well outside the repo: a run commits, and an earlier
  // test that wrote under the repo's own workspace/ once landed a commit in
  // elia's production branch.
  const workspace = mkdtempSync(join(tmpdir(), 'elia-approved-'))
  const phases: string[] = []
  try {
    config.provider = provider
    config.tiers.fast = scriptedTier(config.tiers.fast)
    config.tiers.deep = scriptedTier(config.tiers.deep)
    config.fallbacks = []
    config.routingMode = 'selected'
    const result = await runAutonomousTask({
      goal: 'write a greeting file',
      workspaceRoot: workspace,
      approve: async () => ({ action: 'approve' as const }),
      onPhase: (phase: string) => phases.push(phase),
      profile: 'fast',
      polish: false,
      publish: false,
      learn: false,
      maxRepairAttempts: 0,
      maxWallClockMs: 120_000,
    } as Parameters<typeof runAutonomousTask>[0])

    // Past the gate. Orienting and proposing are two calls; anything beyond
    // that is workers, the critic and the reviewers, so this number is the
    // proof that execution really ran *and* that it ran on the script rather
    // than on someone's API key.
    expect(provider.calls).toBeGreaterThan(2)
    expect(result.outcome).not.toBe('rejected')

    // Execute happened: the completion assessment counts the plan's steps.
    expect(result.proposal?.steps?.length).toBe(1)
    expect(result.completion.evidence.join(' ')).toContain('1 planned step')

    // Verify happened, and the review gate reported rather than being skipped.
    expect(result.verdict).toBeDefined()

    // The result is whole — this is what the receipt and callers read.
    expect(result.runId).toBeTruthy()
    expect(result.actionBudget).toBeDefined()
    expect(typeof result.elapsedMs).toBe('number')

    // What today's behaviour actually is, pinned rather than endorsed: the
    // script runs out, so the critic answers in prose instead of calling
    // `submit_verdict`, and the run correctly refuses to call that a pass.
    // If a refactor of the verify phase ever turns this into 'succeeded', it
    // has removed a gate rather than moved one.
    expect(result.outcome).toBe('needs-attention')
    expect(result.completion.state).toBe('partial')
  } finally {
    config.provider = original
    config.tiers.fast = originalTiers.fast
    config.tiers.deep = originalTiers.deep
    config.fallbacks = originalFallbacks
    config.routingMode = originalRouting
    rmSync(workspace, { recursive: true, force: true })
  }
}, 120_000)

/**
 * Orienting changes nothing — and that has to hold in code, not only in the
 * planner's prompt ("you have no write tools in this phase").
 *
 * Seen live (run 2026-09-26-gjlp-c3lh): mid-orient, the planner called `task`
 * with a builder role, the builder fixed the bug and verified it, and only
 * then did the planner submit a proposal "for review". In a supervised run the
 * change was made before anyone approved the plan.
 */
test('the planner cannot launch a worker that writes while it orients', async () => {
  const { existsSync, mkdtempSync, rmSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { config } = await import('../config.ts')
  const { createScriptedProvider } = await import('../bench/latency/scriptedProvider.ts')
  const { runAutonomousTask } = await import('./loop.ts')

  const scripted = createScriptedProvider([
    { text: 'A one-line fix; I will look first.' },
    {
      toolCalls: [
        {
          name: 'task',
          input: {
            description: 'fix it now',
            role: 'builder',
            prompt: 'Write fixed.txt containing "fixed".',
            acceptanceCriteria: ['fixed.txt exists'],
            verificationCommands: ['echo ok'],
          },
        },
      ],
    },
    {
      toolCalls: [
        {
          name: 'submit_proposal',
          input: {
            goal: 'fix the bug',
            understanding: 'A one-line fix.',
            steps: [{ id: 's1', title: 'Fix it', instructions: 'Fix it', role: 'builder', files: ['fixed.txt'], dependsOn: [] }],
            verification: ['echo ok'],
            acceptanceCriteria: ['fixed'],
          },
        },
      ],
    },
  ])
  // Record what the planner was offered and what its `task` call came back with.
  const offered: Array<{ name: string; roles?: string[] }> = []
  const results: string[] = []
  const provider = {
    ...scripted,
    streamTurn: (params: Parameters<typeof scripted.streamTurn>[0]) => {
      if (offered.length === 0) {
        for (const tool of params.tools ?? []) {
          const role = (tool.input_schema.properties as Record<string, { enum?: string[] }>).role
          offered.push({ name: tool.name, ...(role?.enum ? { roles: role.enum } : {}) })
        }
      }
      for (const message of params.messages) {
        for (const block of message.content) if (block.type === 'tool_result') results.push(block.content)
      }
      return scripted.streamTurn(params)
    },
  }

  // Every route points at the script, so even a regression that did launch
  // the builder would stay offline instead of billing a real provider.
  const original = config.provider
  const originalTiers = { fast: config.tiers.fast, deep: config.tiers.deep }
  const originalFallbacks = config.fallbacks
  const originalRouting = config.routingMode
  const scriptedTier = (tier: typeof config.tiers.fast) => ({ ...tier, provider, providerName: 'scripted', model: 'scripted' })
  const workspace = mkdtempSync(join(tmpdir(), 'elia-orient-readonly-'))
  try {
    config.provider = provider
    config.tiers.fast = scriptedTier(config.tiers.fast)
    config.tiers.deep = scriptedTier(config.tiers.deep)
    config.fallbacks = []
    config.routingMode = 'selected'
    const result = await runAutonomousTask({
      goal: 'fix the bug',
      workspaceRoot: workspace,
      approve: async () => ({ action: 'reject' as const }),
      profile: 'fast',
      polish: false,
      publish: false,
      learn: false,
    })
    expect(result.outcome).toBe('rejected')
    expect(existsSync(join(workspace, 'fixed.txt'))).toBe(false)
  } finally {
    config.provider = original
    config.tiers.fast = originalTiers.fast
    config.tiers.deep = originalTiers.deep
    config.fallbacks = originalFallbacks
    config.routingMode = originalRouting
    rmSync(workspace, { recursive: true, force: true })
  }

  // The planner's `task` offers only roles that can look but not touch…
  const task = offered.find((tool) => tool.name === 'task')
  expect(task?.roles).toEqual(['scout', 'designer'])
  // …and a builder asked for anyway is refused, with a reason the model can act on.
  expect(results.some((result) => /while planning/i.test(result) && /proposal/i.test(result))).toBe(true)
})

// Seen live: a person typed "make it realistic" while an escalated run was
// planning, the status row said "1 steering queued" — and the run finished
// without ever reading it, because nothing in the pipeline drained steering.
// A note now reaches the run: its plan change is applied before the first
// worker starts, and its text reaches every worker from there.
test('a note sent while the plan is approved changes the plan before building, and reaches the workers', async () => {
  const { mkdtempSync, rmSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { config } = await import('../config.ts')
  const { createScriptedProvider } = await import('../bench/latency/scriptedProvider.ts')
  const { runAutonomousTask } = await import('./loop.ts')
  const { encodeNote } = await import('./operatorNotes.ts')

  const scripted = createScriptedProvider([
    { text: 'One text file; I will write it and check it exists.' },
    {
      toolCalls: [
        {
          name: 'submit_proposal',
          input: {
            goal: 'write a greeting file',
            understanding: 'Create greeting.txt containing a greeting.',
            steps: [{ id: 's1', title: 'Write greeting.txt', instructions: 'Write greeting.txt', role: 'builder', files: ['greeting.txt'], dependsOn: [] }],
            verification: ['echo ok'],
            acceptanceCriteria: ['greeting.txt exists'],
          },
        },
      ],
    },
  ])
  // Every request the run sends, so the test can see what the workers were told.
  const requests: string[] = []
  const provider = {
    ...scripted,
    get calls() {
      return scripted.calls
    },
    streamTurn(params: Parameters<typeof scripted.streamTurn>[0]) {
      requests.push(JSON.stringify(params.messages))
      return scripted.streamTurn(params)
    },
  }
  const original = config.provider
  const originalTiers = { fast: config.tiers.fast, deep: config.tiers.deep }
  const originalFallbacks = config.fallbacks
  const originalRouting = config.routingMode
  const scriptedTier = (tier: typeof config.tiers.fast) => ({ ...tier, provider, providerName: 'scripted', model: 'scripted' })
  const workspace = mkdtempSync(join(tmpdir(), 'elia-notes-'))
  const inbox: string[] = []
  const revised: Array<Array<{ id: string; title: string }>> = []
  try {
    config.provider = provider
    config.tiers.fast = scriptedTier(config.tiers.fast)
    config.tiers.deep = scriptedTier(config.tiers.deep)
    config.fallbacks = []
    config.routingMode = 'selected'
    const result = await runAutonomousTask({
      goal: 'write a greeting file',
      workspaceRoot: workspace,
      approve: async () => {
        // Typed while the plan waited for approval.
        inbox.push(encodeNote("The person's note: say it in French, and say goodbye too", {
          wants: 'a French greeting and a farewell',
          edits: [
            { kind: 'change', stepId: 's1', stepTitle: 'Write greeting.txt', to: 'Write greeting.txt in French' },
            { kind: 'add', title: 'Write farewell.txt', afterId: 's1', afterTitle: 'Write greeting.txt' },
          ],
        }))
        return { action: 'approve' as const }
      },
      drainDirections: () => inbox.splice(0),
      onPlanRevised: (steps) => revised.push(steps),
      profile: 'fast',
      polish: false,
      publish: false,
      learn: false,
      maxRepairAttempts: 0,
      maxWallClockMs: 120_000,
    } as Parameters<typeof runAutonomousTask>[0])

    expect(revised[0]).toEqual([
      { id: 's1', title: 'Write greeting.txt in French' },
      { id: 'note-1', title: 'Write farewell.txt' },
    ])
    expect(result.proposal?.steps.map((step) => step.title)).toEqual(['Write greeting.txt in French', 'Write farewell.txt'])
    expect(result.completion.evidence.join(' ')).toContain('All 2 planned step(s) completed')
    // The builder of the changed step was told what changed and why.
    const toWorkers = requests.slice(2).join('\n')
    expect(toWorkers).toContain('Changed by the person while the work ran')
    expect(toWorkers).toContain('Notes from the person, sent while the work ran')
    expect(toWorkers).toContain('say it in French')
    expect(inbox).toEqual([])
  } finally {
    config.provider = original
    config.tiers.fast = originalTiers.fast
    config.tiers.deep = originalTiers.deep
    config.fallbacks = originalFallbacks
    config.routingMode = originalRouting
    rmSync(workspace, { recursive: true, force: true })
  }
}, 120_000)

/**
 * The reasoning layer (src/reason/) inside the pipeline — see repairSearch.ts.
 *
 * The check is a git lookup that cannot succeed, so the build is red on every
 * pass, the scripted workers never change that, and the run stalls on the same
 * failure: exactly the case the linear repair could only answer by asking again.
 * The script runs out after the plan, so every worker and every repair pass
 * answers "done." without touching anything.
 */
async function runRedBuild(searchOn: boolean) {
  const { existsSync, mkdtempSync, rmSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { config } = await import('../config.ts')
  const { createScriptedProvider } = await import('../bench/latency/scriptedProvider.ts')
  const { setReportSink } = await import('../ui/report.ts')
  const { runGit } = await import('./worktree.ts')
  const { runAutonomousTask } = await import('./loop.ts')

  const scripted = createScriptedProvider([
    { text: 'A greeting file. The check is a git lookup, so nothing I write can satisfy it.' },
    {
      toolCalls: [
        {
          name: 'submit_proposal',
          input: {
            goal: 'write a greeting file',
            understanding: 'Create greeting.txt containing a greeting.',
            steps: [{ id: 's1', title: 'Write greeting.txt', instructions: 'Write greeting.txt', role: 'builder', files: ['greeting.txt'], dependsOn: [] }],
            // Fails every time, names a test (so the regime is mechanical), and
            // prints a word the stall classifier reads as a logic failure.
            verification: ['git show assertion-x test'],
            acceptanceCriteria: ['greeting.txt exists'],
          },
        },
      ],
    },
  ])
  const prompts: string[] = []
  const provider = {
    ...scripted,
    streamTurn: (params: Parameters<typeof scripted.streamTurn>[0]) => {
      prompts.push(params.messages.map((message) => message.content.map((block) => (block.type === 'text' ? block.text : '')).join('')).join('\n'))
      return scripted.streamTurn(params)
    },
  }

  const original = config.provider
  const originalTiers = { fast: config.tiers.fast, deep: config.tiers.deep }
  const originalFallbacks = config.fallbacks
  const originalRouting = config.routingMode
  const originalSearch = process.env.ELIA_REPAIR_SEARCH
  const scriptedTier = (tier: typeof config.tiers.fast) => ({ ...tier, provider, providerName: 'scripted', model: 'scripted' })
  const workspace = mkdtempSync(join(tmpdir(), 'elia-red-build-'))
  const notes: string[] = []
  try {
    config.provider = provider
    config.tiers.fast = scriptedTier(config.tiers.fast)
    config.tiers.deep = scriptedTier(config.tiers.deep)
    config.fallbacks = []
    config.routingMode = 'selected'
    if (searchOn) process.env.ELIA_REPAIR_SEARCH = 'on'
    else delete process.env.ELIA_REPAIR_SEARCH
    setReportSink((kind, text) => {
      if (kind === 'substep') notes.push(text)
    })
    const result = await runAutonomousTask({
      goal: 'write a greeting file',
      workspaceRoot: workspace,
      approve: async () => ({ action: 'approve' as const }),
      profile: 'fast',
      polish: false,
      publish: false,
      learn: false,
      maxRepairAttempts: 2,
      maxWallClockMs: 120_000,
    } as Parameters<typeof runAutonomousTask>[0])
    const worktrees = existsSync(join(workspace, '.git')) ? (await runGit(['worktree', 'list'], workspace)).stdout.trim().split('\n') : []
    return { result, prompts, notes, worktrees }
  } finally {
    setReportSink(undefined)
    if (originalSearch === undefined) delete process.env.ELIA_REPAIR_SEARCH
    else process.env.ELIA_REPAIR_SEARCH = originalSearch
    config.provider = original
    config.tiers.fast = originalTiers.fast
    config.tiers.deep = originalTiers.deep
    config.fallbacks = originalFallbacks
    config.routingMode = originalRouting
    rmSync(workspace, { recursive: true, force: true })
  }
}

test('each repair pass on a red build starts from a different approach, and nothing searches unless asked', async () => {
  const { APPROACHES_BY_CLASS } = await import('../reason/harness.ts')
  const run = await runRedBuild(false)

  const repairs = run.prompts.filter((prompt) => prompt.includes('## What went wrong'))
  expect(repairs.length).toBeGreaterThanOrEqual(2)
  expect(repairs[0]).toContain(`## Approach for this attempt (${APPROACHES_BY_CLASS.repair[0]!.id})`)
  expect(repairs[1]).toContain(`## Approach for this attempt (${APPROACHES_BY_CLASS.repair[1]!.id})`)
  expect(run.notes.join('\n')).not.toContain('repair search')
  expect(run.result.outcome).toBe('needs-attention')
}, 120_000)

test('with the search on, a wrong-approach stall on a red build is handed to it, and when it finds nothing the linear repair still runs', async () => {
  const { join } = await import('node:path')
  const { paths } = await import('../statePaths.ts')
  const { readLibrary } = await import('../reason/library.ts')
  const run = await runRedBuild(true)
  const notes = run.notes.join('\n')

  expect(notes).toContain('repair search (trio)')
  expect(notes).toContain('none of 3 attempt(s) passed the checks — continuing with the linear repair')
  // Three attempts were opened, the planner's opening shape (each is a worker whose task is the repair brief)…
  expect(run.prompts.filter((prompt) => prompt.includes('## Your task\n## What went wrong')).length).toBe(3)
  // …and the linear repair that follows a search that found nothing did run.
  expect(run.prompts.filter((prompt) => prompt.includes('## Approach for this attempt')).length).toBeGreaterThanOrEqual(2)
  // Every attempt's checkout was torn down: only the project's own remains.
  expect(run.worktrees).toHaveLength(1)
  expect(run.result.outcome).toBe('needs-attention')

  // The outcome is filed under the stalled key, in the run's own state
  // directory — not in a developer's real library.
  const [record] = readLibrary(join(paths.state, 'reason', 'library.json')).records
  expect(record).toMatchObject({ harnessId: 'trio', runs: 1, verifiedRuns: 0 })
  expect(record?.signature.startsWith('stalled-repair/')).toBe(true)
}, 120_000)
