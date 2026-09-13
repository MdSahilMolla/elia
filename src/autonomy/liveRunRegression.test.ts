import { expect, test } from 'bun:test'
import { parseProposal } from './proposal.ts'
import { planWaves } from './fleet.ts'
import type { ProposalStep } from './types.ts'

/**
 * The plan the planner actually produced in run 2026-09-13-l0av-rnq0, copied
 * verbatim out of that run's `events.ndjson`.
 *
 * The run ended `needs-attention` with a working Vite build on disk. Two
 * separate defects in this one plan caused it, and both were accepted silently:
 *
 *  1. `verification` ends with `bun run dev`, a server that never exits. It ran
 *     for 236 seconds, was killed, exited 58, and so the gate could not pass on
 *     any attempt regardless of what the workers built.
 *  2. Every step declares `dependsOn: []`, and s1 (package.json) and s4
 *     (index.html, README.md) had no file overlap, so they were scheduled into
 *     the same wave. Both workers scaffolded the whole project — 116s and 119s
 *     of duplicated, racing work, both reporting success.
 *
 * Kept as one fixture because it is the real shape of a failing plan, not a
 * constructed one.
 */
const LIVE_PLAN = {
  goal: 'Create a dynamic website using Vite + React + TypeScript',
  understanding: 'The workspace directory is empty. Bun and Node.js are available.',
  steps: [
    { id: 's1', title: 'Initialize Vite React TypeScript project', instructions: 'Initialize a new Vite project with React and TypeScript using Bun.', role: 'builder', files: ['package.json', 'vite.config.ts', 'tsconfig.json'], dependsOn: [] },
    { id: 's2', title: 'Create dynamic website components', instructions: 'Create a main App component with dynamic content loading.', role: 'frontend', files: ['src/App.tsx', 'src/components/', 'src/styles.css'], dependsOn: [] },
    { id: 's3', title: 'Add interactivity and data fetching', instructions: 'Implement fetch functions to load dynamic data.', role: 'builder', files: ['src/utils/api.ts', 'src/types.ts'], dependsOn: [] },
    { id: 's4', title: 'Configure build and verify', instructions: 'Update index.html with proper metadata. Ensure build passes and dev server starts correctly.', role: 'builder', files: ['index.html', 'README.md'], dependsOn: [] },
  ],
  verification: ['bun install', 'bun run build', 'bun run dev'],
  acceptanceCriteria: ['Build command completes without errors'],
}

test('the live plan is rejected for naming a dev server as verification', () => {
  const result = parseProposal(LIVE_PLAN)
  expect('error' in result).toBe(true)
  if ('error' in result) {
    expect(result.error).toContain('bun run dev')
    expect(result.error).toContain('never exits')
  }
})

test('the same plan is accepted once the dev server is dropped', () => {
  const result = parseProposal({ ...LIVE_PLAN, verification: ['bun install', 'bun run build'] })
  expect('proposal' in result).toBe(true)
})

// The scheduling defect is independent of the verification one, so it is
// asserted on the plan as corrected above — fixing one must not mask the other.
test('the live plan no longer schedules the scaffold step beside another writer', () => {
  const result = parseProposal({ ...LIVE_PLAN, verification: ['bun install', 'bun run build'] })
  expect('proposal' in result).toBe(true)
  if (!('proposal' in result)) return

  const { waves } = planWaves(result.proposal.steps)
  const waveOf = (id: string) => waves.findIndex((wave) => wave.some((step: ProposalStep) => step.id === id))

  // s1 creates package.json — that is `bun create vite`, which lays down and
  // overwrites a whole tree. Nothing else may write into it concurrently.
  expect(waveOf('s1')).toBeLessThan(waveOf('s4'))
  expect(waveOf('s1')).toBeLessThan(waveOf('s2'))
  expect(waveOf('s1')).toBeLessThan(waveOf('s3'))

  // And no wave may contain two steps that both write.
  const writers = new Set(['builder', 'frontend', 'backend', 'tester', 'polisher', 'scribe'])
  const scaffoldWave = waves[waveOf('s1')]!
  expect(scaffoldWave.filter((step: ProposalStep) => writers.has(step.role))).toHaveLength(1)
})

// Every plan in the recorded history declared `dependsOn: []` on every step.
// The scheduler cannot rely on the planner expressing order, so the ordering
// facts it enforces itself are what actually hold a run together.
test('an all-empty dependsOn plan still gets a sane order', () => {
  const result = parseProposal({
    ...LIVE_PLAN,
    verification: ['bun run build'],
    steps: [
      { id: 'a', title: 'Tests', instructions: 'write tests', role: 'tester', files: ['tests/app.test.ts'], dependsOn: [] },
      { id: 'b', title: 'Manifest', instructions: 'init', role: 'builder', files: ['package.json'], dependsOn: [] },
      { id: 'c', title: 'Source', instructions: 'implement', role: 'backend', files: ['src/app.ts'], dependsOn: [] },
    ],
  })
  expect('proposal' in result).toBe(true)
  if (!('proposal' in result)) return

  const { waves } = planWaves(result.proposal.steps)
  const waveOf = (id: string) => waves.findIndex((wave) => wave.some((step: ProposalStep) => step.id === id))
  expect(waveOf('b')).toBeLessThan(waveOf('c'))
  expect(waveOf('c')).toBeLessThan(waveOf('a'))
})
