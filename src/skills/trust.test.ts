import { afterEach, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isProjectSkillsTrusted, skillsTrustPath, trustProjectSkills, untrustProjectSkills } from './trust.ts'

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function projectSkillsDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'elia-skills-trust-'))
  dirs.push(dir)
  return join(dir, '.elia', 'skills')
}

test('a project with no trust file is untrusted by default', () => {
  const dir = projectSkillsDir()
  expect(isProjectSkillsTrusted(dir)).toBe(false)
})

test('trustProjectSkills persists a trust decision that isProjectSkillsTrusted then reports', () => {
  const dir = projectSkillsDir()
  expect(isProjectSkillsTrusted(dir)).toBe(false)
  trustProjectSkills(dir)
  expect(isProjectSkillsTrusted(dir)).toBe(true)

  const saved = JSON.parse(readFileSync(skillsTrustPath(dir), 'utf8'))
  expect(saved.trusted).toBe(true)
  expect(typeof saved.trustedAt).toBe('string')
})

test('the trust file lives next to the skills directory, not inside it', () => {
  const dir = projectSkillsDir()
  expect(skillsTrustPath(dir)).toBe(join(dir, '..', 'skills-trust.json'))
})

test('untrustProjectSkills revokes a prior trust decision', () => {
  const dir = projectSkillsDir()
  trustProjectSkills(dir)
  expect(isProjectSkillsTrusted(dir)).toBe(true)
  untrustProjectSkills(dir)
  expect(isProjectSkillsTrusted(dir)).toBe(false)
})

test('a malformed trust file is treated as untrusted, not thrown', () => {
  const dir = projectSkillsDir()
  trustProjectSkills(dir)
  mkdirSync(dir, { recursive: true })
  writeFileSync(skillsTrustPath(dir), 'not json{{{')
  expect(isProjectSkillsTrusted(dir)).toBe(false)
})

test('ELIA_SKILLS_TRUST_PROJECT=on trusts a project with no persisted decision', () => {
  const dir = projectSkillsDir()
  expect(isProjectSkillsTrusted(dir, {})).toBe(false)
  expect(isProjectSkillsTrusted(dir, { ELIA_SKILLS_TRUST_PROJECT: 'on' })).toBe(true)
  expect(isProjectSkillsTrusted(dir, { ELIA_SKILLS_TRUST_PROJECT: 'off' })).toBe(false)
})
