import { afterEach, expect, test } from 'bun:test'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { expandCustomCommand, loadCustomCommands, resolveCustomCommand } from './loader.ts'

const dirs: string[] = []

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      // best-effort
    }
  }
})

function scratch(): string {
  const dir = join(tmpdir(), `elia-commands-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  mkdirSync(join(dir, '.elia', 'commands'), { recursive: true })
  dirs.push(dir)
  return dir
}

test('expandCustomCommand substitutes arguments', () => {
  const body = 'Review PR #$1 with focus on $ARGUMENTS'
  expect(expandCustomCommand(body, '/pr-review', '42 security')).toBe('Review PR #42 with focus on 42 security')
  expect(expandCustomCommand('hello $0', '/ping', '')).toBe('hello ping')
})

test('loadCustomCommands reads project markdown with frontmatter', () => {
  const cwd = scratch()
  writeFileSync(
    join(cwd, '.elia', 'commands', 'ship.md'),
    `---
description: Ship the current branch
---
Open a PR titled "$ARGUMENTS" and summarize CI.
`,
  )
  const cmds = loadCustomCommands(cwd)
  expect(cmds).toHaveLength(1)
  expect(cmds[0]!.name).toBe('/ship')
  expect(cmds[0]!.description).toBe('Ship the current branch')
  const resolved = resolveCustomCommand('/ship auth fix', cmds)
  expect(resolved?.expanded).toContain('Open a PR titled "auth fix"')
})

test('$10 and beyond expand to their own token, and argument text is never re-expanded', () => {
  const args = 'a b c d e f g h i j k'
  expect(expandCustomCommand('$1|$9|$10|$11|$12', '/x', args)).toBe('a|i|j|k|')
  // An argument that itself contains a placeholder is inserted literally.
  expect(expandCustomCommand('first=$1 second=$2', '/x', '$2 real')).toBe('first=$2 second=real')
  expect(expandCustomCommand('all=$@', '/x', 'costs $5')).toBe('all=costs $5')
})

test('project commands win the command cap over a large user command set', () => {
  const cwd = scratch()
  const home = scratch()
  // The home directory is passed in rather than faked through `process.env.HOME`:
  // the loader resolves it with `os.homedir()`, which does not re-read `$HOME`
  // per call on Linux, so the env-var version of this test found zero user
  // commands there and passed only on Windows.
  for (let i = 0; i < 70; i++) writeFileSync(join(home, '.elia', 'commands', `u${String(i).padStart(2, '0')}.md`), `user ${i}`)
  writeFileSync(join(cwd, '.elia', 'commands', 'zz-project.md'), 'project only')
  writeFileSync(join(cwd, '.elia', 'commands', 'u05.md'), 'project override')
  const cmds = loadCustomCommands(cwd, home)
  expect(cmds).toHaveLength(64)
  expect(cmds.find((c) => c.name === '/zz-project')?.source).toBe('project')
  expect(cmds.find((c) => c.name === '/u05')?.body).toBe('project override')
})

test('invalid filenames are skipped', () => {
  const cwd = scratch()
  writeFileSync(join(cwd, '.elia', 'commands', 'Bad Name.md'), 'nope')
  writeFileSync(join(cwd, '.elia', 'commands', 'ok.md'), 'yes')
  const cmds = loadCustomCommands(cwd)
  expect(cmds.map((c) => c.name)).toEqual(['/ok'])
})
