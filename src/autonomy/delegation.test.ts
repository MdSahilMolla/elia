import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createDelegationTool } from '../tools/delegate.ts'
import { GoalGraphStore } from './goalGraph.ts'
import { role } from './roles.ts'

const temporaryDirectories: string[] = []

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

describe('hierarchical delegation', () => {
  test('coding leads expose bounded child roles while child-only roles cannot delegate', () => {
    expect(role('frontend').canDelegate).toBe(true)
    expect(role('frontend').delegateRoles).toEqual(['scout', 'designer', 'frontend', 'accessibility', 'tester', 'scribe'])
    expect(role('designer').canDelegate).not.toBe(true)
    expect(role('accessibility').canDelegate).not.toBe(true)
  })

  test('child depth refuses recursive delegation', async () => {
    const tool = createDelegationTool({ parentRole: 'frontend', parentName: 'frontend#child', depth: 1 })
    await expect(tool.execute({ assignments: [{ id: 'a', title: 'A', role: 'designer', prompt: 'inspect' }] })).rejects.toThrow('delegation depth limit')
  })

  test('rejects unknown child roles and dependency cycles before execution', async () => {
    const tool = createDelegationTool({ parentRole: 'frontend', parentName: 'frontend#1', depth: 0 })
    await expect(tool.execute({ assignments: [{ id: 'a', title: 'A', role: 'backend', prompt: 'not allowed' }] })).rejects.toThrow('must be one of')
    await expect(tool.execute({ assignments: [
      { id: 'a', title: 'A', role: 'designer', prompt: 'a', dependsOn: ['b'] },
      { id: 'b', title: 'B', role: 'tester', prompt: 'b', dependsOn: ['a'] },
    ] })).rejects.toThrow('dependency cycle')
  })

  test('a runFleet that throws mid-delegation still journals delegation-end and names the unrun assignments', async () => {
    const events: Array<{ kind: string; data: Record<string, unknown> }> = []
    const journal = { append: (kind: string, data: Record<string, unknown> = {}) => { events.push({ kind, data }); return { kind, data } } } as never
    let wave = 0
    const tool = createDelegationTool({
      parentRole: 'frontend', parentName: 'frontend#1', depth: 0, journal,
      runFleet: (async (options: { assignments: Array<{ id: string; title: string; role: string }> }) => {
        wave++
        if (wave === 2) throw new Error('fleet exploded')
        return { results: options.assignments.map((a) => ({ id: a.id, title: a.title, role: a.role, ok: true, report: 'done', steps: 1, elapsedMs: 5 })) }
      }) as never,
    })
    await expect(tool.execute({ assignments: [
      { id: 'design', title: 'Design', role: 'designer', prompt: 'a' },
      { id: 'tests', title: 'Tests', role: 'tester', prompt: 'b', dependsOn: ['design'] },
    ] })).rejects.toThrow('fleet exploded')
    const end = events.find((event) => event.kind === 'delegation-end')
    expect(end).toBeDefined()
    expect(end!.data.children).toEqual([{ id: 'design', role: 'designer', ok: true, steps: 1, elapsedMs: 5 }])
    expect(end!.data.unrun).toEqual([{ id: 'tests', title: 'Tests', role: 'tester' }])
    expect(end!.data.error).toBe('fleet exploded')
  })

  test('persists a child node under its lead and preserves sibling dependencies', () => {
    const dir = mkdtempSync(join(tmpdir(), 'elia-delegation-'))
    temporaryDirectories.push(dir)
    const graph = GoalGraphStore.open({ runId: 'delegation-test', goal: 'landing page', dir })
    graph.seedProposal({
      goal: 'landing page', understanding: '', assumptions: [], risks: [], verification: ['bun test'], outOfScope: [],
      steps: [{ id: 'frontend', title: 'Frontend lead', role: 'frontend', instructions: 'Build', files: ['src/App.tsx'], dependsOn: [] }],
    })
    const child = graph.registerDelegationNode({ parentId: 'step:frontend', id: 'design', title: 'Design brief', role: 'designer', instructions: 'Design', depth: 1, acceptanceCriteria: ['brief covers responsive states'], verificationCommands: ['bun test'], sideEffects: ['do not publish'] })
    const dependent = graph.registerDelegationNode({ parentId: 'step:frontend', id: 'tests', title: 'Tests', role: 'tester', instructions: 'Test', dependsOn: ['design'], depth: 1 })
    expect(child.id).toBe('step:frontend/child:design')
    expect(dependent.dependsOn).toEqual(['step:frontend/child:design'])
    expect(graph.node(dependent.id)?.parentId).toBe('step:frontend')
    expect(graph.node(child.id)?.acceptanceCriteria).toEqual(['brief covers responsive states'])
    expect(graph.node(child.id)?.verificationCommands).toEqual(['bun test'])
    expect(graph.node(child.id)?.sideEffects).toEqual(['do not publish'])
  })
})
