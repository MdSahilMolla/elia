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
