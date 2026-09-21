import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  independentPasses,
  libraryHealth,
  purgeArtifact,
  readLibrary,
  recordCheck,
  recordReuse,
  registerArtifact,
  retrievable,
  statusFor,
  type Check,
} from './library.ts'

let dir: string
let path: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'elia-vde-library-'))
  path = join(dir, 'library.jsonl')
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

const pass = (family: string, verifier = family): Check => ({ verifier, tier: 'exact', family, passed: true, at: 1 })

test('two passes of one kind are one pass', () => {
  expect(independentPasses([pass('execution', 'bun test'), pass('execution', 'bun test again')])).toBe(1)
  expect(independentPasses([pass('execution'), pass('lint')])).toBe(2)
  expect(statusFor({ kind: 'lesson', trusted: true, checks: [pass('execution'), pass('execution')] }).status).toBe('probation')
  expect(statusFor({ kind: 'lesson', trusted: true, checks: [pass('execution'), pass('lint')] }).status).toBe('admitted')
})

test('a failed check or an untrusted source quarantines', () => {
  expect(statusFor({ kind: 'lesson', trusted: true, checks: [{ ...pass('lint'), passed: false }] }).status).toBe('quarantined')
  expect(statusFor({ kind: 'lesson', trusted: false, checks: [] }).status).toBe('quarantined')
  // A human's say-so lets an untrusted artifact out of quarantine, onto probation.
  expect(statusFor({ kind: 'lesson', trusted: false, checks: [{ ...pass('human'), tier: 'critic' }] }).status).toBe('probation')
})

test('the log folds into artifacts with certificates, reuse and status', () => {
  registerArtifact({ id: 'a', kind: 'lesson', summary: 'use bun', source: 'auto', checks: [pass('lint')] }, path)
  expect(readLibrary(path).get('a')!.status).toBe('probation')
  recordCheck('a', { ...pass('trial', 'randomized-trial'), tier: 'empirical' }, path)
  recordReuse(['a', 'a-missing'], path)
  const artifact = readLibrary(path).get('a')!
  expect(artifact.status).toBe('admitted')
  expect(artifact.reuse).toBe(1)
  expect(retrievable(artifact)).toBe(true)
  expect(retrievable(undefined)).toBe(true) // predates the library
  // Registering again adds checks, never a duplicate artifact.
  registerArtifact({ id: 'a', kind: 'lesson', summary: 'use bun', source: 'auto', checks: [pass('human')] }, path)
  expect(readLibrary(path).size).toBe(1)
  expect(readLibrary(path).get('a')!.checks).toHaveLength(3)
})

test('purging follows provenance: descendants of an unsound artifact go too', () => {
  registerArtifact({ id: 'root', kind: 'skill', summary: 'r', source: 's' }, path)
  registerArtifact({ id: 'child', kind: 'skill', summary: 'c', source: 's', deps: ['root'] }, path)
  registerArtifact({ id: 'grandchild', kind: 'skill', summary: 'g', source: 's', deps: ['child'] }, path)
  registerArtifact({ id: 'other', kind: 'skill', summary: 'o', source: 's' }, path)
  const purged = purgeArtifact('root', 'audit failed', { audit: true, path })
  expect(purged.sort()).toEqual(['child', 'grandchild', 'root'])
  const library = readLibrary(path)
  expect(library.get('grandchild')!.status).toBe('purged')
  expect(library.get('grandchild')!.reason).toContain('depends on purged root')
  expect(library.get('other')!.status).toBe('probation')
  expect(retrievable(library.get('root'))).toBe(false)
})

test('health: σ ≤ 1 means only audits keep the library sound (R2)', () => {
  for (const id of ['c1', 'c2']) registerArtifact({ id, kind: 'lesson', summary: id, source: 's', checks: [pass('lint'), pass('execution')] }, path)
  for (const id of ['u1', 'u2', 'u3']) registerArtifact({ id, kind: 'lesson', summary: id, source: 's', checks: [pass('lint')] }, path)
  recordReuse(['c1', 'c2', 'u1', 'u2', 'u3'], path)
  const flat = libraryHealth(readLibrary(path))
  expect(flat.sigma).toBeCloseTo(1, 9)
  expect(flat.auditFirst).toBe(true)
  expect(flat.notes.join(' ')).toContain('Theorem 1')

  recordReuse(['c1', 'c2', 'c1', 'c2'], path)
  recordCheck('u1', { ...pass('trial', 'randomized-trial'), tier: 'empirical' }, path)
  purgeArtifact('u2', 'trial says it hurts', { audit: true, path })
  const health = libraryHealth(readLibrary(path))
  expect(health.sigma).toBeGreaterThan(1)
  expect(health.slip.trials).toBe(2) // u1 audited and kept, u2 audited and purged
  expect(health.slip.successes).toBe(1)
  expect(health.threshold).toBeGreaterThan(0)
})
