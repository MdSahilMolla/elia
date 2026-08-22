import { expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.ANTHROPIC_API_KEY ??= 'test-key-for-sandbox-test'

const { changedFiles, promote, rollback, violatedImmutables } = await import('./sandbox.ts')

function write(path: string, content: string): void {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, content)
}

test('promotion and rollback restore edits, deletions, and newly introduced files', () => {
  const temp = mkdtempSync(join(tmpdir(), 'elia-sandbox-'))
  const live = join(temp, 'live')
  const candidate = join(temp, 'candidate')
  const backupDir = join(temp, 'backup')

  try {
    write(join(live, 'src/existing.ts'), 'old')
    write(join(live, 'src/deleted.ts'), 'restore me')
    write(join(live, 'package.json'), '{}')
    write(join(live, 'tsconfig.json'), '{}')
    write(join(candidate, 'src/existing.ts'), 'new')
    write(join(candidate, 'src/added.ts'), 'added')
    write(join(candidate, 'package.json'), '{}')
    write(join(candidate, 'tsconfig.json'), '{}')

    const sandbox = { generation: 1, root: candidate, backupDir }
    const changed = changedFiles(sandbox, live)
    expect(changed).toEqual(['src/added.ts', 'src/deleted.ts', 'src/existing.ts'])

    promote(sandbox, changed, live)
    expect(readFileSync(join(live, 'src/existing.ts'), 'utf8')).toBe('new')
    expect(existsSync(join(live, 'src/deleted.ts'))).toBe(false)
    expect(readFileSync(join(live, 'src/added.ts'), 'utf8')).toBe('added')

    rollback(sandbox, changed, live)
    expect(readFileSync(join(live, 'src/existing.ts'), 'utf8')).toBe('old')
    expect(readFileSync(join(live, 'src/deleted.ts'), 'utf8')).toBe('restore me')
    expect(existsSync(join(live, 'src/added.ts'))).toBe(false)
  } finally {
    rmSync(temp, { recursive: true, force: true })
  }
})

test('gate configuration and tests are detected and immutable', () => {
  expect(violatedImmutables(['package.json', 'tsconfig.json', 'src/example.test.ts', 'src/agent.ts'])).toEqual([
    'package.json',
    'tsconfig.json',
    'src/example.test.ts',
  ])
})

test('root gate configuration changes are included in candidate change detection', () => {
  const temp = mkdtempSync(join(tmpdir(), 'elia-config-'))
  const live = join(temp, 'live')
  const candidate = join(temp, 'candidate')

  try {
    write(join(live, 'package.json'), '{"version":1}')
    write(join(live, 'tsconfig.json'), '{}')
    write(join(candidate, 'package.json'), '{"version":2}')
    write(join(candidate, 'tsconfig.json'), '{}')
    expect(changedFiles({ generation: 1, root: candidate, backupDir: join(temp, 'backup') }, live)).toEqual([
      'package.json',
    ])
  } finally {
    rmSync(temp, { recursive: true, force: true })
  }
})
