import { expect, test } from 'bun:test'
import { classifyStuck, extractQuestion } from './stuck.ts'

test('a missing dependency or tool is classified as an environment problem, not a code defect', () => {
  const d = classifyStuck({ failureText: "sh: 1: vitest: command not found", trend: 'stalled' })
  expect(d.category).toBe('environment')
  expect(d.recovery).toBe('fix-environment')
})

test('ENOENT / cannot find module is an environment problem', () => {
  expect(classifyStuck({ failureText: "Error: Cannot find module 'zod'", trend: 'stalled' }).category).toBe('environment')
  expect(classifyStuck({ failureText: 'ENOENT: no such file or directory, open config.json', trend: 'diverging' }).category).toBe('environment')
})

test('a governor block or a credential/rate-limit failure is an external blocker', () => {
  expect(classifyStuck({ failureText: 'Action blocked by Elia’s autonomy governor: irreversible', trend: 'stalled' }).recovery).toBe('resolve-approval')
  expect(classifyStuck({ failureText: 'HTTP 429 Too Many Requests', trend: 'stalled' }).category).toBe('external-blocker')
  expect(classifyStuck({ failureText: 'npm error 401 Unauthorized - GET https://registry', trend: 'stalled' }).category).toBe('external-blocker')
})

test('the agent saying it cannot determine something routes to ask-user with the question extracted', () => {
  const d = classifyStuck({
    failureText: '2 failing',
    agentReport: "I couldn't determine whether the timeout should be in seconds or milliseconds. Which unit does the API expect?",
    trend: 'stalled',
  })
  expect(d.category).toBe('missing-information')
  expect(d.recovery).toBe('ask-user')
  expect(d.question).toContain('unit')
})

test('the same assertion failures surviving every attempt route to replan', () => {
  const d = classifyStuck({
    failureText: 'Expected: 200\nReceived: 404\n1 failing',
    agentReport: 'Adjusted the route handler again.',
    trend: 'stalled',
  })
  expect(d.category).toBe('wrong-approach')
  expect(d.recovery).toBe('replan')
})

test('a logic failure that is still converging is not yet called wrong-approach', () => {
  const d = classifyStuck({ failureText: 'Expected: 200\nReceived: 404', agentReport: 'fixing', trend: 'converging' })
  expect(d.category).toBe('unknown')
  expect(d.recovery).toBe('handoff')
})

test('environment and external-blocker take precedence over a co-occurring assertion failure', () => {
  const d = classifyStuck({ failureText: 'Expected: 1\nReceived: 2\nsh: jest: command not found', trend: 'stalled' })
  expect(d.category).toBe('environment')
})

test('an unrecognised stall hands off rather than guessing', () => {
  expect(classifyStuck({ failureText: 'the build produced unexpected output', trend: 'stalled' }).recovery).toBe('handoff')
})

test('extractQuestion prefers a decision-shaped question over a rhetorical one', () => {
  const q = extractQuestion('This is tricky. Why is it like this? Should I use the v1 or the v2 endpoint?')
  expect(q).toBe('Should I use the v1 or the v2 endpoint?')
})

test('extractQuestion returns undefined when there is no question', () => {
  expect(extractQuestion('I fixed the thing and it works now.')).toBeUndefined()
})
