import { afterEach, beforeEach, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { failToPass } from './failToPass.ts'

let live: string
let cand: string
beforeEach(() => {
  live = mkdtempSync(join(tmpdir(), 'f2p-live-'))
  cand = mkdtempSync(join(tmpdir(), 'f2p-cand-'))
  for (const [root, body] of [[live, 'export const v = 1\n'], [cand, 'export const v = 2\n']] as const) {
    mkdirSync(join(root, 'src'), { recursive: true })
    writeFileSync(join(root, 'src/a.ts'), body)
    writeFileSync(join(root, 'package.json'), '{}')
  }
  writeFileSync(join(cand, 'src/a.new.test.ts'), 'new test\n')
})
afterEach(() => {
  rmSync(live, { recursive: true, force: true })
  rmSync(cand, { recursive: true, force: true })
})

test('the new tests run over a copy of the live tree, not the candidate, and the copy is cleaned up', async () => {
  const seen: { command: string; cwd: string; source: string; test: string }[] = []
  const result = await failToPass({
    liveRoot: live,
    candidateRoot: cand,
    testFiles: ['src/a.new.test.ts'],
    scratchParent: join(live, '.scratch'),
    run: async (command, cwd) => {
      seen.push({ command, cwd, source: readFileSync(join(cwd, 'src/a.ts'), 'utf8'), test: readFileSync(join(cwd, 'src/a.new.test.ts'), 'utf8') })
      return { exitCode: 1, stdout: '(fail) a > uses the new limit [0.1ms]', stderr: '' }
    },
  })
  expect(seen).toHaveLength(1)
  expect(seen[0]!.command).toBe("bun test 'src/a.new.test.ts'")
  // The live source, the candidate's test.
  expect(seen[0]!.source).toBe('export const v = 1\n')
  expect(seen[0]!.test).toBe('new test\n')
  expect(result).toMatchObject({ checked: true, proves: true })
  expect(result.detail).toContain('(fail) a > uses the new limit')
  expect(existsSync(seen[0]!.cwd)).toBe(false)
  expect(readdirSync(join(live, '.scratch'))).toEqual([])
})

test('a test that also passes without the change proves nothing', async () => {
  const result = await failToPass({ liveRoot: live, candidateRoot: cand, testFiles: ['src/a.new.test.ts'], scratchParent: join(live, '.scratch'), run: async () => ({ exitCode: 0, stdout: '', stderr: '' }) })
  expect(result).toMatchObject({ checked: true, proves: false })
  expect(result.detail).toContain('do not depend on it')
})

test('a check that cannot run is reported as not checked, never as a failure', async () => {
  const broke = await failToPass({ liveRoot: live, candidateRoot: cand, testFiles: ['src/a.new.test.ts'], scratchParent: join(live, '.scratch'), run: async () => { throw new Error('box unavailable') } })
  expect(broke).toMatchObject({ checked: false, proves: false })
  const missing = await failToPass({ liveRoot: live, candidateRoot: cand, testFiles: ['src/gone.test.ts'], scratchParent: join(live, '.scratch'), run: async () => ({ exitCode: 1, stdout: '', stderr: '' }) })
  expect(missing.checked).toBe(false)
  expect((await failToPass({ liveRoot: live, candidateRoot: cand, testFiles: [], run: async () => ({ exitCode: 1, stdout: '', stderr: '' }) })).checked).toBe(false)
})
