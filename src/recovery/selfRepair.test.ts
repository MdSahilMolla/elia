import { afterAll, expect, test } from 'bun:test'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { FaultGroup } from './faults.ts'
import { renderSelfCheck, repairBrief, runSelfRepair, selfRepairTarget, summarizeDiagnostics } from './selfRepair.ts'

const base = mkdtempSync(join(tmpdir(), 'elia-self-repair-'))
afterAll(() => rmSync(base, { recursive: true, force: true }))

const group: FaultGroup = {
  signature: 'abc1234567',
  count: 3,
  fatal: 1,
  firstAt: '2026-09-28T10:00:00.000Z',
  lastAt: '2026-09-28T12:00:00.000Z',
  latest: {
    at: '2026-09-28T12:00:00.000Z', pid: 1, version: '1.2.3', command: 'auto', source: 'uncaught-exception', fatal: true,
    name: 'TypeError', message: "Cannot read properties of undefined (reading 'nodes')", frames: ['src/autonomy/loop.ts:713 runAutonomousTask', 'src/cli/agent.ts:120 runAuto'], signature: 'abc1234567',
  },
  commands: ['auto', 'repl'],
  versions: ['1.2.3'],
}

function sh(command: string[], cwd: string): { exitCode: number; stdout: string } {
  const result = Bun.spawnSync(command, { cwd, stdout: 'pipe', stderr: 'pipe' })
  return { exitCode: result.exitCode ?? 1, stdout: new TextDecoder().decode(result.stdout) }
}

function sourceCheckout(name: string): string {
  const root = join(base, name)
  mkdirSync(join(root, 'node_modules', 'dep'), { recursive: true })
  writeFileSync(join(root, 'package.json'), '{"name":"elia-ai"}\n')
  writeFileSync(join(root, '.gitignore'), 'node_modules\n')
  for (const command of [['git', 'init', '-q'], ['git', 'add', '-A'], ['git', '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'init']]) sh(command, root)
  return root
}

test('the brief states the evidence, then asks for cause before fix and proof before done', () => {
  const brief = repairBrief(group)
  expect(brief).toContain('abc1234567')
  expect(brief).toContain('3 times between 2026-09-28T10:00:00.000Z and 2026-09-28T12:00:00.000Z')
  expect(brief).toContain('`elia auto`, `elia repl`')
  expect(brief).toContain('1 of them ended the process')
  expect(brief).toContain("TypeError: Cannot read properties of undefined (reading 'nodes')")
  expect(brief).toContain('    at src/autonomy/loop.ts:713 runAutonomousTask')
  const steps = ['State the assumption that fails', 'Reproduce it', 'Fix the cause', 'bun test']
  const positions = steps.map((step) => brief.indexOf(step))
  expect(positions.every((position) => position > 0)).toBe(true)
  expect([...positions].sort((a, b) => a - b)).toEqual(positions)
})

test('an install that is not a source checkout says what to report, and changes nothing', () => {
  const target = selfRepairTarget('abc1234567', join(base, 'installed'))
  const calls: string[][] = []
  const result = runSelfRepair(group, target, { run: (command) => (calls.push(command), { exitCode: 0, stdout: '' }), log: () => {} })
  expect(result.status).toBe('not-a-checkout')
  expect(result.message).toContain('Report it instead')
  expect(calls).toEqual([])
})

test('a repair runs in its own worktree and branch, with the checkout\'s dependencies, and reports what landed', () => {
  const root = sourceCheckout('elia')
  const target = selfRepairTarget('abc1234567', root)
  expect(target).toMatchObject({ checkout: true, branch: 'elia/self-repair-abc1234567', worktree: join(base, 'elia-self-repair-abc1234567') })

  let autoCall: { command: string[]; cwd: string } | undefined
  const result = runSelfRepair(group, target, {
    log: () => {},
    run: (command, options) => {
      if (command.includes('auto')) {
        autoCall = { command, cwd: options.cwd }
        // Stands in for the repair run: it commits a fix on the branch.
        writeFileSync(join(options.cwd, 'fix.ts'), 'export const fixed = true\n')
        sh(['git', 'add', 'fix.ts'], options.cwd)
        sh(['git', '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'fix'], options.cwd)
        return { exitCode: 0, stdout: '' }
      }
      return sh(command, options.cwd)
    },
  })

  expect(result.status).toBe('ran')
  expect(autoCall?.cwd).toBe(target.worktree)
  expect(autoCall?.command.slice(-3)).toEqual(['auto', repairBrief(group), '--unattended'])
  expect(lstatSync(join(target.worktree, 'node_modules')).isSymbolicLink()).toBe(true)
  expect(result.message).toContain('1 commit(s), 0 uncommitted file(s)')
  expect(result.message).toContain('Nothing was merged')
  // The person's checkout is untouched: still on its own branch, without the fix.
  expect(sh(['git', 'branch', '--show-current'], root).stdout.trim()).not.toBe(target.branch)
  expect(existsSync(join(root, 'fix.ts'))).toBe(false)

  // A second attempt at the same bug points at the first instead of stacking another.
  const again = runSelfRepair(group, target, { log: () => {}, run: (command, options) => sh(command, options.cwd) })
  expect(again.status).toBe('already-attempted')
  expect(again.message).toContain(target.branch)
})

test('the handled-error log is finally read, counted by where it came from', () => {
  const path = join(base, 'diagnostics.ndjson')
  writeFileSync(path, ['{"scope":"mcp-registry","message":"a"}', '{"scope":"usage","message":"b"}', '{"scope":"mcp-registry","message":"c"}', 'torn'].join('\n'))
  expect(summarizeDiagnostics(path)).toEqual({ total: 3, scopes: [{ scope: 'mcp-registry', count: 2, last: 'c' }, { scope: 'usage', count: 1, last: 'b' }] })
  expect(summarizeDiagnostics(join(base, 'missing.ndjson'))).toEqual({ total: 0, scopes: [] })
})

test('the doctor section names each bug, each unclean exit, and how to repair', () => {
  const text = renderSelfCheck({
    groups: [group],
    exits: [{ kind: 'run', id: 'r1', at: Date.now() - 60_000, pid: 5, busy: true, detail: 'add rate limiting', resumable: true }],
    diagnostics: { total: 2, scopes: [{ scope: 'usage', count: 2, last: 'x' }] },
    target: { root: '/src/elia', checkout: true },
  })
  expect(text).toContain('internal errors    1 distinct bug(s), 3 occurrence(s)')
  expect(text).toContain('abc1234567  3× (1 crash)')
  expect(text).toContain('unclean exits      1')
  expect(text).toContain('elia resume r1')
  expect(text).toContain('handled errors     2 degraded gracefully — usage ×2')
  expect(text).toContain('elia doctor --repair [signature]')

  const clean = renderSelfCheck({ groups: [], exits: [], diagnostics: { total: 0, scopes: [] }, target: { root: '/x', checkout: false } })
  expect(clean).toContain('internal errors    none recorded')
  expect(clean).not.toContain('self-repair')
})
