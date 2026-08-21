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
