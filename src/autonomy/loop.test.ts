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
