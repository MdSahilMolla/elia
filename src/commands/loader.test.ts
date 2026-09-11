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

test('invalid filenames are skipped', () => {
  const cwd = scratch()
  writeFileSync(join(cwd, '.elia', 'commands', 'Bad Name.md'), 'nope')
  writeFileSync(join(cwd, '.elia', 'commands', 'ok.md'), 'yes')
  const cmds = loadCustomCommands(cwd)
  expect(cmds.map((c) => c.name)).toEqual(['/ok'])
})
