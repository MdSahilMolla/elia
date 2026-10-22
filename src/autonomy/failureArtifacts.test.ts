import { describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { writeFailureArtifact } from './failureArtifacts.ts'

describe('failure artifacts', () => {
  test('writes a bounded, redacted artifact keyed by the recurring failure', () => {
    const root = mkdtempSync(join(tmpdir(), 'elia-failure-'))
    const artifact = writeFailureArtifact({
      runId: 'run-1',
      goal: 'fix the service',
      gate: 'build',
      attempts: 3,
      trend: 'stalled',
      fingerprints: ['verify:bun test::error TS2304 at /secret/project/file.ts', 'token=sk-secret-value'],
      diagnosis: 'same failure repeated',
      workspaceRoot: root,
    })
    const path = join(root, '.elia', 'failures', `${artifact.id}.json`)
    expect(existsSync(path)).toBe(true)
    const raw = readFileSync(path, 'utf8')
    expect(raw).toContain('run-1')
    expect(raw).not.toContain('sk-secret-value')
    expect(JSON.parse(raw)).toMatchObject({ id: artifact.id, gate: 'build', attempts: 3 })
  })
})
