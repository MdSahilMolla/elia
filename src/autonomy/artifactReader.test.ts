import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readArtifact, listArtifacts } from './artifactReader.ts'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'elia-artifacts-'))
  mkdirSync(join(dir, '.elia', 'artifacts'), { recursive: true })
  mkdirSync(join(dir, '.elia', 'runs', 'run-1'), { recursive: true })
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function state(relative: string, content: string): void {
  const full = join(dir, '.elia', relative)
  mkdirSync(join(full, '..'), { recursive: true })
  writeFileSync(full, content)
}

test('the run-owned artifacts and the run plan/receipt documents are readable', () => {
  state('artifacts/plan.md', '# plan')
  state('artifacts/notes.html', '<p>ok</p>')
  state('runs/run-1/plan.md', '# run plan')
  state('runs/run-1/receipt.md', '# receipt')

  expect(readArtifact('plan', dir)?.content).toBe('# plan')
  expect(readArtifact('plan.md', dir)?.content).toBe('# plan')
  expect(readArtifact('notes.html', dir)?.content).toBe('<p>ok</p>')
  expect(readArtifact('runs/run-1/plan.md', dir)?.content).toBe('# run plan')
  expect(readArtifact('runs/run-1/receipt.md', dir)?.content).toBe('# receipt')
})

test('governor control state inside .elia is not readable through read_artifact', () => {
  state('artifacts/plan.md', '# plan')
  state('allow.json', '{ "rules": [] }')
  state('policy.json', '{ "denyTools": [] }')
  state('checkpoints/1.json', '{}')
  state('runs/run-1/goal-graph.json', '{}')
  state('runs/run-1/events.ndjson', '{}')

  expect(readArtifact('allow.json', dir)).toBeNull()
  expect(readArtifact('policy.json', dir)).toBeNull()
  expect(readArtifact('checkpoints/1.json', dir)).toBeNull()
  expect(readArtifact('runs/run-1/goal-graph.json', dir)).toBeNull()
  expect(readArtifact('runs/run-1/events.ndjson', dir)).toBeNull()
})

test('nothing inside .elia but outside the artifact and plan/receipt scope is reachable', () => {
  writeFileSync(join(dir, 'secret.json'), '{"token":"x"}')
  state('artifacts/plan.md', '# plan')
  state('run-2/notices.json', '{}')

  expect(readArtifact('secret.json', dir)).toBeNull()
  expect(readArtifact('run-2/notices.json', dir)).toBeNull()
  expect(readArtifact('plan', dir)?.content).toBe('# plan')
})

test('listArtifacts enumerates only text artifacts, plans and receipts — not governor state', () => {
  state('artifacts/plan.md', '# plan')
  state('artifacts/notes.json', '{}')
  state('artifacts/policy.js', 'export {}')
  state('runs/run-1/plan.md', '# run plan')
  state('runs/run-1/goal-graph.json', '{}')

  const names = listArtifacts(dir).map((entry) => entry.name).sort()
  expect(names).toEqual(['notes.json', 'plan.md', 'runs/run-1/plan.md'].sort())
})

test('a missing artifact is null, including the implicit latest', () => {
  expect(readArtifact('ghost.md', dir)).toBeNull()
  expect(readArtifact(undefined, dir)).toBeNull()
})