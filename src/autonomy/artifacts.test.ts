import { afterEach, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { savePlanArtifact } from './artifacts.ts'
import { listArtifacts, readArtifact } from './artifactReader.ts'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function fixtureRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'elia-artifacts-'))
  roots.push(root)
  return root
}

const proposal = {
  goal: 'complete plan artifacts',
  understanding: 'the existing proposal renderer owns the format',
  assumptions: [],
  steps: [{ id: 's1', title: 'wire artifacts', instructions: 'reuse the artifact store', role: 'builder' as const, files: ['src/index.ts'], dependsOn: [] }],
  risks: ['CLI dispatch can regress'],
  verification: ['bun test'],
  outOfScope: ['publishing'],
  acceptanceCriteria: ['the plan is readable'],
  sideEffects: [],
  recovery: ['restore the previous dispatch'],
}

test('savePlanArtifact writes the current and run-specific Markdown plans', () => {
  const root = fixtureRoot()
  const path = savePlanArtifact(proposal, 'run-1', root)

  expect(readFileSync(path, 'utf8')).toContain('# Execution Plan: complete plan artifacts')
  expect(readFileSync(join(root, '.elia', 'runs', 'run-1', 'plan.md'), 'utf8')).toContain('## Verification Commands')
  expect(listArtifacts(root).map((artifact) => artifact.name)).toContainAllValues(['plan.md', 'runs/run-1/plan.md'])
})

test('readArtifact resolves state artifacts but rejects paths outside .elia', () => {
  const root = fixtureRoot()
  const outside = join(root, 'secret.md')
  writeFileSync(outside, 'not an artifact')
  savePlanArtifact(proposal, undefined, root)

  expect(readArtifact('plan', root)?.content).toContain('complete plan artifacts')
  expect(readArtifact(outside, root)).toBeNull()
  expect(readArtifact('../secret.md', root)).toBeNull()
  expect(readArtifact('missing', root)).toBeNull()
})

test('artifact reader indexes Battmann Markdown, JSON, and printable HTML companions', () => {
  const root = fixtureRoot()
  const dir = join(root, '.elia', 'artifacts')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'brief.md'), '# Brief')
  writeFileSync(join(dir, 'brief.json'), '{"reportSchemaVersion":2}')
  writeFileSync(join(dir, 'brief.html'), '<!doctype html><title>Brief</title>')
  writeFileSync(join(dir, 'ignore.txt'), 'not an artifact')

  expect(listArtifacts(root).map((artifact) => artifact.name).sort()).toEqual(['brief.html', 'brief.json', 'brief.md'])
  expect(readArtifact('brief.json', root)?.content).toContain('reportSchemaVersion')
  expect(readArtifact('brief.html', root)?.content).toContain('<!doctype html>')
})
