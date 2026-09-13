import { afterEach, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { listLoadedSkills, loadSkills } from './loader.ts'
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

// --- registry isolation ---

// `loadSkills` always also reads the *user* skills directory, and that path is
// `join(homedir(), '.elia', 'skills')` — a constant, with no override. So these
// assertions cannot be absolute: a developer with their own skills installed
// would contribute tools to every load. Instead, load an empty project once to
// learn what this machine contributes on its own, and assert only the delta.
async function machineBaseline(): Promise<string[]> {
  const empty = mkdtempSync(join(tmpdir(), 'elia-skills-empty-'))
  dirs.push(empty)
  const emptySkills = join(empty, '.elia', 'skills')
  mkdirSync(emptySkills, { recursive: true })
  const { allWorkerTools } = await import('../tools/registry.ts')
  await loadSkills({}, emptySkills)
  return allWorkerTools().map((tool) => tool.name).sort()
}

test('a skill loaded by one caller does not stay registered for the next', async () => {
  // `bun test` shares one module registry across every file, so a skill that
  // stayed in `synthesizedTools` leaked into every later test — it reached
  // governor.test.ts's "every registered tool declares a contract" assertion
  // and failed it. Only on Linux, because `readdir` there is not sorted and
  // this file ran before that one; the bug was never OS-specific.
  const { allWorkerTools } = await import('../tools/registry.ts')
  const registered = (): string[] => allWorkerTools().map((tool) => tool.name).sort()
  const baseline = await machineBaseline()

  const { skillsDir } = setupProject()
  trustProjectSkills(skillsDir)
  await loadSkills({}, skillsDir)
  const added = registered().filter((name) => !baseline.includes(name))
  expect(added).toEqual(['evil_tool'])

  // Loading a project with no skills must put the registry back exactly where
  // it started — nothing from the previous load may survive.
  expect(await machineBaseline()).toEqual(baseline)
  expect(listLoadedSkills().map((skill) => skill.name)).not.toContain('evil_tool')
})

test('a skill deleted from disk stops being callable after a reload', async () => {
  const { skillsDir } = setupProject()
  trustProjectSkills(skillsDir)
  const { findTool } = await import('../tools/registry.ts')
  // Only meaningful if this machine has no user skill of the same name, which
  // would be found regardless of what the project directory holds.
  const baseline = await machineBaseline()
  if (baseline.includes('evil_tool')) return

  await loadSkills({}, skillsDir)
  expect(findTool('evil_tool')).toBeDefined()

  rmSync(join(skillsDir, 'evil.skill.ts'))
  await loadSkills({}, skillsDir)
  expect(findTool('evil_tool')).toBeUndefined()
})
