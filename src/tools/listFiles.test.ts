import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { withAgentIdentity } from '../autonomy/context.ts'

const { listFilesTool } = await import('./listFiles.ts')

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'elia-listfiles-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

test('a missing cwd is a clear error before the glob ever runs', async () => {
  const missing = join(dir, 'does-not-exist')
  await expect(
    withAgentIdentity({ name: 'test', role: 'lead', cwd: dir }, () => listFilesTool.execute({ pattern: '**', cwd: missing })),
  ).rejects.toThrow(/no such directory/)
})

test('a pattern against a real cwd lists matching project files, skipping ignored output', async () => {
  mkdirSync(join(dir, 'src', 'nested'), { recursive: true })
  writeFileSync(join(dir, 'src', 'index.ts'), '')
  writeFileSync(join(dir, 'src', 'nested', 'deep.ts'), '')
  writeFileSync(join(dir, 'src', 'ignored.txt'), '')

  const output = await withAgentIdentity({ name: 'test', role: 'lead', cwd: dir }, () =>
    listFilesTool.execute({ pattern: '**/*.ts' }),
  )
  expect(output.split('\n')).toEqual([join('src', 'index.ts'), join('src', 'nested', 'deep.ts')])
})

test('an empty match produces the polite "nothing matched" message', async () => {
  mkdirSync(join(dir, 'empty'), { recursive: true })

  const output = await withAgentIdentity({ name: 'test', role: 'lead', cwd: join(dir, 'empty') }, () =>
    listFilesTool.execute({ pattern: '**/*.zzz' }),
  )
  expect(output).toBe('No files matched.')
})