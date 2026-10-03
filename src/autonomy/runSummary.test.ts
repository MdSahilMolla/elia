import { expect, test } from 'bun:test'
import { formatAutonomousRunCrash, formatAutonomousRunSummary } from './runSummary.ts'
import type { AutonomousRunResult } from './loop.ts'

function result(overrides: Partial<AutonomousRunResult>): AutonomousRunResult {
  return {
    runId: 'r1',
    workspace: { runId: 'r1', root: '/workspace/r1', kind: 'isolated', launchedFrom: '/elia', allowedRoots: ['/workspace/r1'] },
    outcome: 'needs-attention',
    usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
    elapsedMs: 1000,
    lessons: [],
    completion: { state: 'failed', confidence: 'medium', summary: '', evidence: [], blockers: [], nextActions: [], completedSteps: 3, totalSteps: 4, pendingApprovals: 0 },
    actionBudget: { maxActions: 300, consumed: 85, exhausted: false, blockedByBudget: 0 },
    ...overrides,
  }
}

// Verbatim shape of run 2026-09-11-5q7z-abo2: needs-attention, 3/4 steps done,
// a real (working) deliverable already on disk. The next interactive turn's
// plain "ok" had no file paths to go on and rebuilt the whole thing from
// scratch at a different path — this summary is what fixes that.
test('an unfinished run names the files it touched and warns against starting over', () => {
  const summary = formatAutonomousRunSummary('create a car game in html', result({
    proposal: {
      goal: 'Create a fully functional 2D car racing game in standalone HTML/CSS/JS',
      understanding: '', assumptions: [], risks: [], verification: [], outOfScope: [], acceptanceCriteria: [], sideEffects: [], recovery: [],
      steps: [
        { id: 's1', title: 'Setup', role: 'builder', instructions: '', files: ['workspace/car-game/index.html', 'workspace/car-game/style.css'], dependsOn: [] },
        { id: 's2', title: 'Logic', role: 'builder', instructions: '', files: ['workspace/car-game/game.js'], dependsOn: [] },
      ],
    },
  }))

  expect(summary).toContain('needs-attention')
  expect(summary).toContain('workspace/car-game/index.html')
  expect(summary).toContain('workspace/car-game/game.js')
  expect(summary).toContain('3/4 steps completed')
  expect(summary).toContain('do not start a fresh implementation from scratch')
})

test('a fully completed run still names its files but skips the warning', () => {
  const summary = formatAutonomousRunSummary('goal', result({
    outcome: 'completed',
    completion: { state: 'verified', confidence: 'high', summary: '', evidence: [], blockers: [], nextActions: [], completedSteps: 4, totalSteps: 4, pendingApprovals: 0 },
    proposal: {
      goal: 'goal', understanding: '', assumptions: [], risks: [], verification: [], outOfScope: [], acceptanceCriteria: [], sideEffects: [], recovery: [],
      steps: [{ id: 's1', title: 'Setup', role: 'builder', instructions: '', files: ['workspace/app/index.html'], dependsOn: [] }],
    },
  }))

  expect(summary).toContain('workspace/app/index.html')
  expect(summary).not.toContain('do not start a fresh implementation')
})

test('a run with no proposal (rejected before planning) has no files line at all', () => {
  const summary = formatAutonomousRunSummary('goal', result({ outcome: 'rejected', proposal: undefined }))

  expect(summary).not.toContain('Files this run')
})

// Session mubbhz5c-tnp9i0: the escalated run threw at the proposal gate having
// touched nothing. Nothing was appended to the conversation, so the next turn
// read as a build in progress and wrote 11 unverified pages into the repo root.
test('a run that threw tells the next turn the build never started', () => {
  const crash = formatAutonomousRunCrash('build a makhana shop', new Error('Service temporarily overloaded'))

  expect(crash).toContain('failed to run')
  expect(crash).toContain('Service temporarily overloaded')
  expect(crash).toContain('no plan was approved and nothing was written')
  // The specific wrong turn it has to head off.
  expect(crash).toContain('Do not carry this build on in an ordinary reply')
})

test('a non-Error thrown value still produces a usable record', () => {
  const crash = formatAutonomousRunCrash('build a shop', 'socket hang up')

  expect(crash).toContain('socket hang up')
  expect(crash).toContain('failed to run')
})

// Session muo052t5: the run built tic_tac_toe.py in its own folder, and "go
// ahead" looked for it where elia was launched.
test('a run that worked in its own folder says which, so the next turn can find its files', () => {
  const proposal = {
    goal: 'Create a CLI tic-tac-toe game', understanding: '', assumptions: [], risks: [], verification: [], outOfScope: [], acceptanceCriteria: [], sideEffects: [], recovery: [],
    steps: [{ id: 's1', title: 'Build', role: 'builder' as const, instructions: '', files: ['tic_tac_toe.py'], dependsOn: [] }],
  }
  expect(formatAutonomousRunSummary('tic tac toe', result({ outcome: 'completed', proposal }))).toContain('This run worked in /workspace/r1')
  const inPlace = result({ outcome: 'completed', proposal, workspace: { runId: 'r1', root: '/elia', kind: 'isolated', launchedFrom: '/elia', allowedRoots: ['/elia'] } })
  expect(formatAutonomousRunSummary('tic tac toe', inPlace)).not.toContain('This run worked in')
})
