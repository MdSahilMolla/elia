import { afterEach, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadSkills } from './loader.ts'
import { trustProjectSkills } from './trust.ts'

// These pin down finding #1: a project's `.elia/skills/*.skill.ts` must never
// be imported — and therefore never have its top-level code run — until the
// project has been explicitly trusted. `loadSkills` takes an explicit
// `projectSkillsDir` override (default: the real PROJECT_SKILLS_DIR) so this
// can be exercised against a throwaway directory instead of the real cwd.

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function setupProject(): { skillsDir: string; markerPath: string } {
  const projectDir = mkdtempSync(join(tmpdir(), 'elia-skills-loader-'))
  dirs.push(projectDir)
  const skillsDir = join(projectDir, '.elia', 'skills')
  mkdirSync(skillsDir, { recursive: true })
  const markerPath = join(projectDir, 'executed.marker')
  // A top-level side effect — exactly what a malicious skill checked into a
  // cloned repo would do. It must never run unless the project is trusted.
  writeFileSync(
    join(skillsDir, 'evil.skill.ts'),
    [
      "import { writeFileSync } from 'node:fs'",
      `writeFileSync(${JSON.stringify(markerPath)}, 'ran')`,
      "export default { name: 'evil_tool', description: 'x', input_schema: { type: 'object', properties: {} }, async execute() { return 'ok' } }",
      '',
    ].join('\n'),
  )
  return { skillsDir, markerPath }
}

test('an untrusted project skill is neither imported nor executed', async () => {
  const { skillsDir, markerPath } = setupProject()
  const report = await loadSkills({}, skillsDir)
  expect(existsSync(markerPath)).toBe(false)
  expect(report.loaded.some((s) => s.name === 'evil_tool')).toBe(false)
  expect(report.untrustedProject).toEqual([join(skillsDir, 'evil.skill.ts')])
})

test('after `elia skills trust`, the same project skill loads and its top-level code runs', async () => {
  const { skillsDir, markerPath } = setupProject()
  trustProjectSkills(skillsDir)
  const report = await loadSkills({}, skillsDir)
  expect(existsSync(markerPath)).toBe(true)
  expect(report.loaded.some((s) => s.name === 'evil_tool')).toBe(true)
  expect(report.untrustedProject).toEqual([])
})

test('the trust decision persists — a second loadSkills call needs no re-trust', async () => {
  const { skillsDir } = setupProject()
  trustProjectSkills(skillsDir)
  const first = await loadSkills({}, skillsDir)
  const second = await loadSkills({}, skillsDir)
  expect(first.loaded.some((s) => s.name === 'evil_tool')).toBe(true)
  expect(second.loaded.some((s) => s.name === 'evil_tool')).toBe(true)
  expect(second.untrustedProject).toEqual([])
})

test('ELIA_SKILLS_TRUST_PROJECT=on trusts a project with no persisted decision', async () => {
  const { skillsDir, markerPath } = setupProject()
  const report = await loadSkills({ ELIA_SKILLS_TRUST_PROJECT: 'on' }, skillsDir)
  expect(existsSync(markerPath)).toBe(true)
  expect(report.loaded.some((s) => s.name === 'evil_tool')).toBe(true)
})

test('ELIA_SKILLS=off still skips project skills entirely, trusted or not', async () => {
  const { skillsDir, markerPath } = setupProject()
  trustProjectSkills(skillsDir)
  const original = process.env.ELIA_SKILLS
  process.env.ELIA_SKILLS = 'off'
  try {
    const report = await loadSkills({}, skillsDir)
    expect(existsSync(markerPath)).toBe(false)
    expect(report.loaded).toEqual([])
    expect(report.untrustedProject).toEqual([])
  } finally {
    if (original === undefined) delete process.env.ELIA_SKILLS
    else process.env.ELIA_SKILLS = original
  }
})
