import { expect, test } from 'bun:test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { withProvenance } from '../provenance.ts'
import { commitEverything, switchToNewBranch } from './git.ts'

function sh(root: string, ...args: string[]): string {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' })
  if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`)
  return result.stdout.trim()
}

function fixtureRepo(): string {
  const root = mkdtempSync(join(tmpdir(), 'autopilot-git-'))
  sh(root, 'init', '-q', '-b', 'main')
  sh(root, 'config', 'user.email', 'dev@example.com')
  sh(root, 'config', 'user.name', 'Dev')
  sh(root, 'config', 'commit.gpgsign', 'false')
  writeFileSync(join(root, 'README.md'), '# fixture\n')
  sh(root, 'add', '-A')
  sh(root, 'commit', '-q', '-m', 'initial')
  switchToNewBranch(root, 'elia/autopilot-test')
  return root
}

test('a goal commit made under an active run carries the Elia-Run trailer', async () => {
  const root = fixtureRepo()
  writeFileSync(join(root, 'CHANGED'), 'x')
  const result = await withProvenance({ sessionId: 'run-abc123', surface: 'auto' }, async () =>
    commitEverything(root, 'autopilot: do the thing\n\nverified.', () => false),
  )
  expect(result.committed).toBe(true)
  const message = sh(root, 'log', '-1', '--format=%B')
  expect(message).toContain('Elia-Run: run-abc123')
  expect(message).toContain('Elia-Surface: auto')
})

test('ELIA_FINGERPRINT=off leaves the commit plain even mid-run', async () => {
  const root = fixtureRepo()
  writeFileSync(join(root, 'CHANGED'), 'x')
  process.env.ELIA_FINGERPRINT = 'off'
  try {
    const result = await withProvenance({ sessionId: 'run-abc123', surface: 'auto' }, async () =>
      commitEverything(root, 'autopilot: do the thing', () => false),
    )
    expect(result.committed).toBe(true)
    const message = sh(root, 'log', '-1', '--format=%B')
    expect(message).not.toContain('Elia-Run:')
  } finally {
    delete process.env.ELIA_FINGERPRINT
  }
})
