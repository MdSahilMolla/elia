import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// grep.ts's import chain pulls in config.ts (via goindex), which resolves a
// provider on import.
process.env.ANTHROPIC_API_KEY ??= 'test-key-for-grep-test'

const { searchWithJs } = await import('./grep.ts')

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'elia-grep-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

test('the JS path caps output at 200 matches and says so', async () => {
  writeFileSync(join(dir, 'many.txt'), Array.from({ length: 250 }, (_, i) => `needle ${i}`).join('\n'))

  const result = await searchWithJs('needle', dir, 'dir', undefined, undefined)
  const matchLines = result.split('\n').filter((line) => /:[0-9]+:needle/.test(line))
  expect(matchLines).toHaveLength(200)
  expect(result).toContain('[stopped after 200 matches]')
})

test('context and separator lines do not count toward the 200-match cap', async () => {
  // 80 matches × (before + match + after) = 240 candidate lines a
  // lines-based counter would misread as "past 200" and truncate mid-group.
  const parts: string[] = []
  for (let m = 0; m < 80; m++) {
    parts.push(`before ${m}`)
    parts.push(`needle ${m}`)
    parts.push(`after ${m}`)
  }
  writeFileSync(join(dir, 'ctx.txt'), parts.join('\n'))

  const result = await searchWithJs('needle', dir, 'dir', undefined, 1)
  const matchLines = result.split('\n').filter((line) => /:[0-9]+:needle/.test(line))
  expect(matchLines).toHaveLength(80)
  expect(result).not.toContain('[stopped after 200 matches]')
})

test('a file path searches that one file, with the path the model gave', async () => {
  const { mkdirSync } = await import('node:fs')
  const { withAgentIdentity } = await import('../autonomy/context.ts')
  const { grepTool } = await import('./grep.ts')
  mkdirSync(join(dir, 'src', 'lib'), { recursive: true })
  writeFileSync(join(dir, 'src', 'lib', 'one.ts'), 'const a = 1\nexport const needle = 2\n')
  writeFileSync(join(dir, 'src', 'lib', 'two.ts'), 'export const needle = 3\n')
  writeFileSync(join(dir, 'top.txt'), 'needle at the top\n')

  const nested = await withAgentIdentity({ name: 'test', role: 'lead', cwd: dir }, () => grepTool.execute({ pattern: 'needle', path: 'src/lib/one.ts' }))
  expect(nested).toBe('src/lib/one.ts:2:export const needle = 2')
  const withContext = await withAgentIdentity({ name: 'test', role: 'lead', cwd: dir }, () => grepTool.execute({ pattern: 'needle', path: 'src\\lib\\one.ts', context: 1 }))
  expect(withContext).toBe('src/lib/one.ts-1-const a = 1\nsrc/lib/one.ts:2:export const needle = 2')
  const top = await withAgentIdentity({ name: 'test', role: 'lead', cwd: dir }, () => grepTool.execute({ pattern: 'needle', path: 'top.txt' }))
  expect(top).toBe('./top.txt:1:needle at the top')
  const none = await withAgentIdentity({ name: 'test', role: 'lead', cwd: dir }, () => grepTool.execute({ pattern: 'absent', path: 'top.txt' }))
  expect(none).toBe('No matches found.')
})

test('a file path to a protected file is still refused', async () => {
  const { withAgentIdentity } = await import('../autonomy/context.ts')
  const { grepTool } = await import('./grep.ts')
  writeFileSync(join(dir, '.env'), 'TOKEN=abc\n')
  await expect(withAgentIdentity({ name: 'test', role: 'lead', cwd: dir }, () => grepTool.execute({ pattern: 'TOKEN', path: '.env' }))).rejects.toThrow(/protected sensitive path/)
})

test('a plain scan with fewer than 200 matches reports no cap note', async () => {
  writeFileSync(join(dir, 'few.txt'), Array.from({ length: 5 }, (_, i) => `needle ${i}`).join('\n'))

  const result = await searchWithJs('needle', dir, 'dir', undefined, undefined)
  expect(result.split('\n').filter((line) => /:[0-9]+:needle/.test(line))).toHaveLength(5)
  expect(result).not.toContain('[stopped after 200 matches]')
})