import { afterAll, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { auditAndCorrect, auditBriefing, auditReply, describeAudit, pathsNamedByTools } from './audit.ts'

const repo = mkdtempSync(join(tmpdir(), 'elia-audit-'))
mkdirSync(join(repo, 'src'), { recursive: true })
writeFileSync(join(repo, 'src', 'queue.ts'), 'a\nb\nc\n')
afterAll(() => rmSync(repo, { recursive: true, force: true }))

test('a clean reply has nothing to correct, and is not called a pass', () => {
  const audit = auditReply('The queue is in src/queue.ts:2, and 6 * 7 = 42.', { cwd: repo })
  expect(audit.problems).toBe(0)
  expect(auditBriefing(audit)).toBeUndefined()
  expect(describeAudit(audit)).toBe('1 citation(s) and 1 calculation(s) checked, all hold')
  expect(describeAudit(auditReply('Sounds good.', { cwd: repo }))).toBe('nothing checkable in the reply')
})

test('a wrong citation and a wrong sum are both found, and briefed in one message', () => {
  const audit = auditReply('The worker is in src/worker.ts:10, and 6 * 7 = 48.', { cwd: repo })
  expect(audit.problems).toBe(2)
  const briefing = auditBriefing(audit)!
  expect(briefing).toContain('src/worker.ts:10 — no such file')
  expect(briefing).toContain('6 * 7 = 48')
  expect(describeAudit(audit)).toContain('do not exist')
  expect(describeAudit(audit)).toContain('do not hold')
})

test('exactly one correction runs, and only when something is provably wrong', async () => {
  let reply = 'It lives in src/worker.ts:3.'
  const corrections: string[] = []
  const outcome = await auditAndCorrect({
    reply: () => reply,
    cwd: repo,
    correct: async (briefing, before) => {
      corrections.push(briefing)
      expect(before.problems).toBe(1)
      reply = 'It lives in src/queue.ts:3.'
    },
  })
  expect(corrections).toHaveLength(1)
  expect(outcome.before.problems).toBe(1)
  expect(outcome.after?.problems).toBe(0)

  const clean = await auditAndCorrect({ reply: () => 'fine, see src/queue.ts:1', cwd: repo, correct: async () => { throw new Error('must not run') } })
  expect(clean.after).toBeUndefined()

  const aborted = new AbortController()
  aborted.abort()
  const stopped = await auditAndCorrect({ reply: () => 'see src/nope.ts:1', cwd: repo, signal: aborted.signal, correct: async () => { throw new Error('must not run') } })
  expect(stopped.before.problems).toBe(1)
  expect(stopped.after).toBeUndefined()
})

test('a path the turn\'s own tools named may be cited even when it is gone', () => {
  const messages = [
    { content: [{ type: 'text' }] },
    { content: [{ type: 'tool_use', input: { path: 'src/old.ts' } }, { type: 'tool_use', input: { command: 'ls' } }] },
  ]
  const touched = pathsNamedByTools(messages)
  expect(touched).toEqual(['src/old.ts'])
  expect(auditReply('I removed src/old.ts:12', { cwd: repo, touched }).problems).toBe(0)
  expect(pathsNamedByTools(messages, 2)).toEqual([])
})
