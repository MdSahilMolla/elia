import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { clearPreauthCaches } from '../autonomy/preauth.ts'
import { projectTrustStorePath } from '../autonomy/projectTrust.ts'
import { hasIgnoredRepoTrustFile, isProjectSkillsTrusted, skillsTrustPath, trustProjectSkills, untrustProjectSkills } from './trust.ts'

const dirs: string[] = []
let previousPreauthDir: string | undefined
beforeEach(() => {
  previousPreauthDir = process.env.ELIA_PREAUTH_DIR
  const secretDir = mkdtempSync(join(tmpdir(), 'elia-skills-trust-user-'))
  dirs.push(secretDir)
  process.env.ELIA_PREAUTH_DIR = secretDir
  clearPreauthCaches()
})
afterEach(() => {
  if (previousPreauthDir === undefined) delete process.env.ELIA_PREAUTH_DIR
  else process.env.ELIA_PREAUTH_DIR = previousPreauthDir
  clearPreauthCaches()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** A project skills dir holding one skill file. */
function projectSkillsDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'elia-skills-trust-'))
  dirs.push(dir)
  const skills = join(dir, '.elia', 'skills')
  mkdirSync(skills, { recursive: true })
  writeFileSync(join(skills, 'one.skill.ts'), 'export default {}\n')
  return skills
}

test('a project with no trust record is untrusted by default', () => {
  expect(isProjectSkillsTrusted(projectSkillsDir())).toBe(false)
})

test('trustProjectSkills records a decision in the user-level store, not in the repo', () => {
  const dir = projectSkillsDir()
  expect(trustProjectSkills(dir)).toBe(true)
  expect(isProjectSkillsTrusted(dir)).toBe(true)
  expect(JSON.parse(readFileSync(projectTrustStorePath(), 'utf8')).mac).toMatch(/^[0-9a-f]{64}$/)
  expect(projectTrustStorePath().startsWith(join(dir, '..'))).toBe(false)
})

test('trust is bound to the skill files: changing, or adding one, voids it', () => {
  const dir = projectSkillsDir()
  trustProjectSkills(dir)
  writeFileSync(join(dir, 'one.skill.ts'), 'export default { changed: true }\n')
  expect(isProjectSkillsTrusted(dir)).toBe(false)
  trustProjectSkills(dir)
  expect(isProjectSkillsTrusted(dir)).toBe(true)
  writeFileSync(join(dir, 'two.skill.ts'), 'export default {}\n')
  expect(isProjectSkillsTrusted(dir)).toBe(false)
})

test('an in-repo skills-trust.json is ignored as trust evidence', () => {
  const dir = projectSkillsDir()
  writeFileSync(skillsTrustPath(dir), JSON.stringify({ trusted: true, trustedAt: '2026-01-01T00:00:00.000Z' }))
  expect(skillsTrustPath(dir)).toBe(join(dir, '..', 'skills-trust.json'))
  expect(hasIgnoredRepoTrustFile(dir)).toBe(true)
  expect(isProjectSkillsTrusted(dir)).toBe(false)
})

test('untrustProjectSkills revokes a prior trust decision', () => {
  const dir = projectSkillsDir()
  trustProjectSkills(dir)
  expect(isProjectSkillsTrusted(dir)).toBe(true)
  untrustProjectSkills(dir)
  expect(isProjectSkillsTrusted(dir)).toBe(false)
})

test('a hand-edited or unsigned trust record trusts nothing', () => {
  const dir = projectSkillsDir()
  trustProjectSkills(dir)
  const saved = JSON.parse(readFileSync(projectTrustStorePath(), 'utf8'))
  writeFileSync(projectTrustStorePath(), JSON.stringify({ ...saved, entries: [...saved.entries, { path: '/elsewhere', sha256: 'a'.repeat(64) }] }))
  expect(isProjectSkillsTrusted(dir)).toBe(false)
  writeFileSync(projectTrustStorePath(), 'not json{{{')
  expect(isProjectSkillsTrusted(dir)).toBe(false)
})

test('nothing to trust when the skills directory has no skill files', () => {
  const dir = projectSkillsDir()
  rmSync(join(dir, 'one.skill.ts'))
  expect(trustProjectSkills(dir)).toBe(false)
  expect(isProjectSkillsTrusted(dir)).toBe(false)
})

test('ELIA_SKILLS_TRUST_PROJECT=on trusts a project with no persisted decision', () => {
  const dir = projectSkillsDir()
  expect(isProjectSkillsTrusted(dir, {})).toBe(false)
  expect(isProjectSkillsTrusted(dir, { ELIA_SKILLS_TRUST_PROJECT: 'on' })).toBe(true)
  expect(isProjectSkillsTrusted(dir, { ELIA_SKILLS_TRUST_PROJECT: 'off' })).toBe(false)
})
