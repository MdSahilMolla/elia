import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { assertWriteWithinSessionScope, currentSessionScope, withSessionScope } from './scope.ts'
import { createActionGovernor } from '../autonomy/governor.ts'
import { currentAgent, withAgentIdentity } from '../autonomy/context.ts'
import { makeSessionId } from './types.ts'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'elia-session-scope-'))
  mkdirSync(join(dir, 'worktree-a'))
  mkdirSync(join(dir, 'worktree-b'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('session scope', () => {
  test('no scope means writes are unrestricted', () => {
    expect(currentSessionScope()).toBeUndefined()
    expect(() => assertWriteWithinSessionScope(join(dir, 'anywhere', 'x.ts'))).not.toThrow()
  })

  test('allows writes inside the worktree, including nested paths', async () => {
    await withSessionScope(makeSessionId('ow'), join(dir, 'worktree-a'), async () => {
      expect(currentSessionScope()?.sessionId).toBeDefined()
      expect(currentSessionScope()?.worktree).toBe(join(dir, 'worktree-a'))
      expect(() => assertWriteWithinSessionScope(join(dir, 'worktree-a', 'a.ts'))).not.toThrow()
      expect(() => assertWriteWithinSessionScope(join(dir, 'worktree-a', 'deep', 'nested', 'b.ts'))).not.toThrow()
    })
  })

  test('blocks writes outside the worktree even inside the same workspace', async () => {
    await withSessionScope(makeSessionId('ow'), join(dir, 'worktree-a'), async () => {
      expect(() => assertWriteWithinSessionScope(join(dir, 'worktree-b', 'b.ts'))).toThrow(/escapes the session worktree/)
      expect(() => assertWriteWithinSessionScope(join(dir, 'outside.ts'))).toThrow(/escapes the session worktree/)
      expect(() => assertWriteWithinSessionScope(join(dir, 'worktree-a..', 'sneaky.ts'))).toThrow(/escapes the session worktree/)
    })
  })

  test('a session with no worktree imposes no restriction', async () => {
    await withSessionScope(makeSessionId('free'), undefined, async () => {
      expect(() => assertWriteWithinSessionScope(join(dir, 'anywhere.ts'))).not.toThrow()
    })
  })

  test('scopes compose with ambient agent identity instead of clobbering it', async () => {
    await withAgentIdentity({ name: 'lead', role: 'lead', cwd: dir }, async () => {
      await withSessionScope(makeSessionId('nested'), join(dir, 'worktree-b'), async () => {
        expect(currentAgent().name).toBe('lead')
        expect(currentAgent().cwd).toBe(dir)
        expect(currentSessionScope()?.worktree).toBe(join(dir, 'worktree-b'))
      })
      expect(currentSessionScope()).toBeUndefined()
    })
  })
})

describe('governor session-scope guard', () => {
  function fileGovernor(): ReturnType<typeof createActionGovernor> {
    return createActionGovernor({ cwd: dir, mode: 'unattended' })
  }

  test('a session agent is blocked from writes outside its worktree but inside the workspace', async () => {
    const governor = fileGovernor()
    const results = await withAgentIdentity({ name: 'session-agent', role: 'lead', cwd: dir }, async () =>
      withSessionScope(makeSessionId('g-one'), join(dir, 'worktree-a'), async () => {
        const inside = await governor.check({ name: 'write_file', input: { path: join('worktree-a', 'fine.ts') } })
        const sibling = await governor.check({ name: 'write_file', input: { path: join('worktree-b', 'out.ts') } })
        return { inside, sibling }
      }),
    )
    expect(results.inside.allowed).toBe(true)
    expect(results.sibling.allowed).toBe(false)
    expect(results.sibling.message).toMatch(/session worktree/)
  })

  test('the guard also applies to edit_file and delete_file', async () => {
    const governor = fileGovernor()
    const results = await withAgentIdentity({ name: 'session-agent', role: 'lead', cwd: dir }, async () =>
      withSessionScope(makeSessionId('g-two'), join(dir, 'worktree-a'), async () => {
        const edit = await governor.check({ name: 'edit_file', input: { path: join('worktree-b', 'out.ts') } })
        const del = await governor.check({ name: 'delete_file', input: { path: join('worktree-b', 'out.ts') } })
        const read = await governor.check({ name: 'read_file', input: { path: join('worktree-b', 'out.ts') } })
        return { edit, del, read }
      }),
    )
    expect(results.edit.allowed).toBe(false)
    expect(results.del.allowed).toBe(false)
    // Reads are not scoped writes; they should not trip the guard.
    expect(results.read.allowed).toBe(true)
  })

  test('the governor behaves unchanged when no session scope is set', async () => {
    const governor = fileGovernor()
    const result = await withAgentIdentity({ name: 'plain', role: 'lead', cwd: dir }, async () =>
      governor.check({ name: 'write_file', input: { path: join('worktree-b', 'out.ts') } }),
    )
    expect(result.allowed).toBe(true)
  })
})