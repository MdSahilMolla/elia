import { expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.ANTHROPIC_API_KEY ??= 'test-key-for-export-test'

const { readiness, rejectReason, selectTrainingExamples, writeTrainingExport } = await import('./export.ts')
import type { TrajectoryRow } from '../trajectory/record.ts'

function row(overrides: Partial<TrajectoryRow> = {}): TrajectoryRow {
  return {
    at: 1,
    corr: 'c1',
    kind: 'interactive',
    promptRedacted: 'add a farewell function',
    systemPromptRef: 'p1',
    tools: [{ name: 'edit_file', ok: true, argsDigest: 'path=src/greet.ts' }],
    touched: [{ path: 'src/greet.ts', before: 'a', after: 'b' }],
    verify: 'pass',
    cwdIsEliaRoot: false,
    reward: { scalar: 1, category: 'clean' },
    ...overrides,
  }
}

test('only work a real check passed becomes an example', () => {
  expect(rejectReason(row())).toBeUndefined()
  expect(rejectReason(row({ reward: { scalar: 0.8, category: 'repaired' } }))).toBeUndefined()
  // An unchecked turn keeps a high reward scalar; the filter must not trust it.
  expect(rejectReason(row({ verify: 'none', reward: { scalar: 0.85, category: 'unverified' } }))).toContain('no check passed')
  expect(rejectReason(row({ verify: 'skipped', reward: { scalar: 0.85, category: 'unverified' } }))).toContain('no check passed')
  expect(rejectReason(row({ verify: 'pass', regime: 'judgment', reward: { scalar: 0.85, category: 'unverified' } }))).toContain('opinion')
  expect(rejectReason(row({ verify: 'fail', reward: { scalar: 0.1, category: 'failed' } }))).toContain('failed')
  expect(rejectReason(row({ reward: { scalar: 0, category: 'aborted' } }))).toBe('aborted')
  expect(rejectReason(row({ contradictions: ['claimed verified with no checks'] }))).toContain('contradicted')
  expect(rejectReason(row({ touched: [] }))).toBe('changed no files')
  expect(rejectReason(row({ touched: [{ path: 'x', before: null, after: '[omitted: row too large]' }] }))).toContain('too large')
  expect(rejectReason(row({ touched: [{ path: 'x', before: null, after: 'abc\n…[12 more chars]' }] }))).toContain('truncated')
})

test('selection dedupes identical work, counts every rejection, and redacts on the way out', () => {
  const secret = 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789'  // pragma: allowlist secret
  const rows = [
    row({ corr: 'a', touched: [{ path: 'src/k.ts', before: null, after: `const key = '${secret}'` }] }),
    row({ corr: 'b', touched: [{ path: 'src/k.ts', before: null, after: `const key = '${secret}'` }] }),
    row({ corr: 'c', verify: 'none', reward: { scalar: 0.85, category: 'unverified' } }),
  ]
  const selection = selectTrainingExamples(rows)
  expect(selection.examples.map((example) => example.id)).toEqual(['interactive-a'])
  expect(selection.considered).toBe(3)
  expect(selection.rejectedBy.get('duplicate of an earlier example')).toBe(1)
  expect(selection.rejectedBy.get('no check passed (verify=none)')).toBe(1)
  expect(selection.examples[0]!.files[0]!.after).not.toContain(secret)
})

test('readiness reports how far the set is from worth training on, and how varied it is', () => {
  const rows = [
    row({ corr: 'a', systemPromptRef: 'p1', touched: [{ path: 'workspace/app-one/index.html', before: null, after: 'x' }] }),
    row({ corr: 'b', systemPromptRef: 'p2', touched: [{ path: 'workspace/app-two/index.html', before: null, after: 'y' }] }),
    row({ corr: 'c', cwdIsEliaRoot: true, touched: [{ path: 'src/agent.ts', before: 'a', after: 'z' }] }),
  ]
  const r = readiness(selectTrainingExamples(rows).examples, rows)
  expect(r.examples).toBe(3)
  expect(r.projects).toBe(3)
  expect(r.promptRegimes).toBe(2)
  expect(r.selfShare).toBeCloseTo(1 / 3)
})

test('the export is one example per line', () => {
  const dir = mkdtempSync(join(tmpdir(), 'elia-export-'))
  try {
    const out = join(dir, 'nested', 'export.jsonl')
    writeTrainingExport(selectTrainingExamples([row({ corr: 'a' }), row({ corr: 'b', promptRedacted: 'other' })]).examples, out)
    const lines = readFileSync(out, 'utf8').trim().split('\n')
    expect(lines).toHaveLength(2)
    expect(JSON.parse(lines[0]!).verify).toBe('pass')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
