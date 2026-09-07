import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  addAllowRule,
  clearAllowCache,
  commandPrefix,
  isAllowlisted,
  ruleFor,
  ruleLabel,
} from './allowStore.ts'
import { assessAction, createActionGovernor } from './governor.ts'

const dirs: string[] = []
afterEach(() => {
  clearAllowCache()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function project(): string {
  const dir = mkdtempSync(join(tmpdir(), 'elia-allow-'))
  dirs.push(dir)
  return dir
}

test('commandPrefix takes the leading token, stripping any path', () => {
  expect(commandPrefix('git push --force')).toBe('git')
  expect(commandPrefix('  npm  install ')).toBe('npm')
  expect(commandPrefix('./gradlew build')).toBe('gradlew')
  expect(commandPrefix('C:\\tools\\node.exe script.js')).toBe('node.exe')
})

test('a persisted project rule permits that command prefix and nothing else', () => {
  const dir = project()
  const push = { name: 'run_command', input: { command: 'git push origin main' } }
  const npm = { name: 'run_command', input: { command: 'npm publish' } }

  expect(isAllowlisted(push, assessAction(push, dir), dir)).toBe(false)

  addAllowRule(ruleFor(push, assessAction(push, dir)), 'project', dir)

  expect(isAllowlisted(push, assessAction(push, dir), dir)).toBe(true)
  expect(isAllowlisted(npm, assessAction(npm, dir), dir)).toBe(false)

  const saved = JSON.parse(readFileSync(join(dir, '.elia', 'allow.json'), 'utf8'))
  expect(saved.rules[0].commandPrefix).toBe('git')
})

test('a non-command rule is scoped to the tool + intent', () => {
  const dir = project()
  const req = { name: 'codex_delegate', input: { task: 'do a thing' } }
  const rule = ruleFor(req, assessAction(req, dir))
  expect(rule.intent).toBeTruthy()
  expect(rule.commandPrefix).toBeUndefined()
  expect(ruleLabel(rule)).toBe('`codex_delegate`')
})

test('addAllowRule does not write a duplicate', () => {
  const dir = project()
  const req = { name: 'run_command', input: { command: 'git status' } }
  addAllowRule(ruleFor(req, assessAction(req, dir)), 'project', dir)
  addAllowRule(ruleFor(req, assessAction(req, dir)), 'project', dir)
  const saved = JSON.parse(readFileSync(join(dir, '.elia', 'allow.json'), 'utf8'))
  expect(saved.rules).toHaveLength(1)
})

test('governor: "remember for this session" stops re-prompting for that command class', async () => {
  const dir = project()
  let asked = 0
  const governor = createActionGovernor({
    mode: 'supervised',
    cwd: dir,
    approve: async () => {
      asked += 1
      return { approved: true, remember: 'session' as const }
    },
  })

  const first = await governor.check({ name: 'run_command', input: { command: 'npm install lodash' } })
  const second = await governor.check({ name: 'run_command', input: { command: 'npm install left-pad' } })
  const other = await governor.check({ name: 'run_command', input: { command: 'pip install requests' } })

  expect(first.allowed).toBe(true)
  expect(second.allowed).toBe(true)
  expect(other.allowed).toBe(true)
  expect(asked).toBe(2) // npm the once, pip the once — never a second npm prompt
})

test('governor: a project "always allow" persists across governor instances', async () => {
  const dir = project()
  const approve = async () => ({ approved: true, remember: 'project' as const })

  const g1 = createActionGovernor({ mode: 'supervised', cwd: dir, approve })
  expect((await g1.check({ name: 'run_command', input: { command: 'npm install' } })).allowed).toBe(true)

  clearAllowCache()
  let asked = false
  const g2 = createActionGovernor({
    mode: 'supervised',
    cwd: dir,
    approve: async () => {
      asked = true
      return false
    },
  })
  expect((await g2.check({ name: 'run_command', input: { command: 'npm ci' } })).allowed).toBe(true)
  expect(asked).toBe(false)
})

test('governor: a denial with feedback surfaces the operator guidance', async () => {
  const dir = project()
  const governor = createActionGovernor({
    mode: 'supervised',
    cwd: dir,
    approve: async () => ({ approved: false, feedback: 'use pnpm, not npm' }),
  })
  const result = await governor.check({ name: 'run_command', input: { command: 'npm install' } })
  expect(result.allowed).toBe(false)
  expect(result.message).toContain('use pnpm, not npm')
})
