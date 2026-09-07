import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { assessEnvironment, formatEnvironmentAssessment } from './envReadiness.ts'

let dir: string
const has =
  (...present: string[]) =>
  (cmd: string) =>
    present.includes(cmd)

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'env-readiness-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function file(name: string, content = ''): void {
  const full = join(dir, name)
  mkdirSync(join(full, '..'), { recursive: true })
  writeFileSync(full, content)
}

test('a lockfile with no node_modules is a blocker with the right install command', () => {
  file('package.json', '{}')
  file('bun.lock', '')
  const a = assessEnvironment({ cwd: dir, has: has('bun', 'node'), versions: {} })
  expect(a.ready).toBe(false)
  expect(a.blockers[0]?.what).toContain('dependencies are not installed')
  expect(a.setup).toContain('bun install')
})

test('npm project chooses `npm ci`', () => {
  file('package.json', '{}')
  file('package-lock.json', '{}')
  const a = assessEnvironment({ cwd: dir, has: has('node', 'npm'), versions: {} })
  expect(a.setup).toContain('npm ci')
})

test('installed node_modules clears the blocker', () => {
  file('package.json', '{}')
  file('bun.lock', '')
  for (const p of ['a', 'b', 'c', 'd', 'e']) file(`node_modules/${p}/index.js`, '')
  const a = assessEnvironment({ cwd: dir, has: has('bun', 'node'), versions: {} })
  expect(a.ready).toBe(true)
})

test('a major Node version mismatch is a blocker', () => {
  file('package.json', '{}')
  file('.nvmrc', '20\n')
  const a = assessEnvironment({ cwd: dir, has: has('node'), versions: { node: 'v22.4.0' } })
  expect(a.blockers.some((b) => b.what.includes('Node 22') && b.what.includes('pins 20'))).toBe(true)
})

test('a matching Node version is silent', () => {
  file('package.json', '{}')
  file('.node-version', '20.11.0')
  const a = assessEnvironment({ cwd: dir, has: has('node'), versions: { node: 'v20.10.0' } })
  expect(a.blockers).toEqual([])
})

test('a compose file without docker is a blocker; with docker it is a warning + setup', () => {
  file('docker-compose.yml', 'services:\n  db:\n    image: postgres\n  redis:\n    image: redis\n')
  const withoutDocker = assessEnvironment({ cwd: dir, has: has(), versions: {} })
  expect(withoutDocker.blockers.some((b) => b.what.includes('Docker'))).toBe(true)

  const withDocker = assessEnvironment({ cwd: dir, has: has('docker'), versions: {} })
  expect(withDocker.ready).toBe(true)
  expect(withDocker.setup).toContain('docker compose up -d')
  expect(withDocker.declared.some((d) => d.includes('db') && d.includes('redis'))).toBe(true)
})

test('a devcontainer surfaces its postCreateCommand as a warning + setup', () => {
  file('.devcontainer/devcontainer.json', '{ "postCreateCommand": "pnpm i && pnpm build" }')
  const a = assessEnvironment({ cwd: dir, has: has(), versions: {} })
  expect(a.declared).toContain('Dev Container')
  expect(a.setup).toContain('pnpm i && pnpm build')
  expect(a.warnings.some((w) => w.includes('devcontainer'))).toBe(true)
})

test('a Rust crate without cargo is a blocker', () => {
  file('Cargo.toml', '[package]\nname = "x"\n')
  const a = assessEnvironment({ cwd: dir, has: has(), versions: {} })
  expect(a.blockers.some((b) => b.what.includes('Rust toolchain'))).toBe(true)
})

test('.env.example without .env is a warning, not a blocker', () => {
  file('.env.example', 'API_KEY=')
  const a = assessEnvironment({ cwd: dir, has: has(), versions: {} })
  expect(a.ready).toBe(true)
  expect(a.warnings.some((w) => w.includes('.env.example'))).toBe(true)
})

test('a clean, fully-provisioned project reports ready with nothing to do', () => {
  file('go.mod', 'module x\n')
  const a = assessEnvironment({ cwd: dir, has: has('go'), versions: {} })
  expect(a.ready).toBe(true)
  expect(a.setup).toEqual([])
  expect(a.blockers).toEqual([])
})

test('a directory with no project markers has nothing to say', () => {
  const a = assessEnvironment({ cwd: dir, has: has(), versions: {} })
  expect(a.ready).toBe(true)
  expect(a.declared).toEqual([])
  expect(formatEnvironmentAssessment(a)).toContain('nothing the project declares is missing')
})

test('the formatted block leads with blockers', () => {
  file('package.json', '{}')
  file('yarn.lock', '')
  const text = formatEnvironmentAssessment(assessEnvironment({ cwd: dir, has: has('node', 'yarn'), versions: {} }))
  expect(text).toContain('BLOCKERS')
  expect(text).toContain('yarn install --immutable')
})
