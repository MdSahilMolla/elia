import { afterAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { appendActionAudit, readActionLedger, writeRunReceipt } from './audit.ts'
import type { ToolEvent } from '../agentLoop.ts'
import { paths } from '../statePaths.ts'

const runId = `audit-test-${Date.now().toString(36)}`
// Ask the system where runs live rather than re-deriving `<cwd>/.elia/runs`.
// This test used to write its receipt into the developer's real run ledger —
// and audit.ts re-derived the same path, so the two agreed by coincidence.
// They now agree because both read `paths`, which the test preload redirects.
const runDir = join(paths.runs, runId)

describe('autonomy audit ledger and receipt', () => {
  test('writes a redacted action record and a human-readable receipt', async () => {
    const event: ToolEvent = {
      name: 'browser',
      input: { action: 'type', text: 'secret password' },
      result: 'typed into the page',
      isError: false,
      durationMs: 12,
      cached: false,
      assessment: {
        risk: 'critical',
        decision: 'block',
        reason: 'browser type changes page state',
        intent: 'browser.type',
        resources: [],
        reversible: false,
      },
    }

    appendActionAudit(event, runId)
    const actions = readActionLedger(runId)
    expect(actions).toHaveLength(1)
    expect(actions[0]?.input.text).toBe('[REDACTED]')
    expect(actions[0]?.decision).toBe('block')

    writeRunReceipt({
      runId,
      goal: 'test governed execution',
      outcome: 'needs-attention',
      lessons: ['critical browser actions stay blocked without approval'],
      actionBudget: { maxActions: 2, consumed: 2, exhausted: true, blockedByBudget: 1 },
      events: [
        { seq: 1, at: Date.now(), kind: 'verify', data: { passed: false, command: 'bun test' } },
      ],
    })

    const receipt = Bun.file(join(runDir, 'receipt.json'))
    expect(await receipt.exists()).toBe(true)
    const parsed = (await receipt.json()) as { actions: { total: number; blocked: number }; actionBudget: { maxActions: number; consumed: number; exhausted: boolean; blockedByBudget: number }; outcome: string }
    expect(parsed.outcome).toBe('needs-attention')
    expect(parsed.actions.total).toBe(1)
    expect(parsed.actions.blocked).toBe(1)
    expect(parsed.actionBudget).toEqual({ maxActions: 2, consumed: 2, exhausted: true, blockedByBudget: 1 })
    expect(await Bun.file(join(runDir, 'receipt.md')).text()).toContain('**Action budget:** 2/2 consumed (exhausted)')
  })

  test('concurrent appends from several processes never tear a ledger line', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'elia-audit-race-'))
    try {
      const auditModule = pathToFileURL(join(import.meta.dir, 'audit.ts')).href
      const script = join(cwd, 'append.ts')
      // Large results make each record well past a single small write.
      writeFileSync(script, [
        `const { appendActionAudit } = await import(${JSON.stringify(auditModule)})`,
        `const worker = process.argv[2]`,
        `for (let i = 0; i < 40; i++) appendActionAudit({ name: 'read_file', input: { path: 'x' }, result: worker.repeat(1100), isError: false, durationMs: 1, cached: false }, 'race')`,
      ].join('\n'))
      const workers = ['a', 'b', 'c', 'd'].map((worker) => Bun.spawn([process.execPath, script, worker], { cwd, stdout: 'ignore', stderr: 'pipe' }))
      const codes = await Promise.all(workers.map((worker) => worker.exited))
      expect(codes).toEqual([0, 0, 0, 0])
      const lines = readFileSync(join(cwd, '.elia', 'runs', 'race', 'actions.ndjson'), 'utf8').split('\n').filter(Boolean)
      expect(lines).toHaveLength(160)
      for (const line of lines) expect(() => JSON.parse(line)).not.toThrow()
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  }, 60_000)

  test('a run that died before finishing records why, and the phase it died in', () => {
    // A run that throws or is killed never reaches the one place a receipt is
    // written, so it used to leave nothing at all and `elia distill` could say
    // only "run never finished" — no phase, no error, nothing to act on.
    const deadRunId = `${runId}-interrupted`
    writeRunReceipt({
      runId: deadRunId,
      goal: 'build a thing that never finished',
      outcome: 'interrupted',
      events: [],
      interruption: {
        reason: 'the run threw and did not reach its own ending',
        error: 'ENOENT: no such file or directory',
        stack: 'Error: ENOENT\n    at builder',
        lastPhase: 'execute',
      },
    })
    const dir = join(paths.runs, deadRunId)
    try {
      const receipt = JSON.parse(readFileSync(join(dir, 'receipt.json'), 'utf8')) as { outcome: string; interruption?: { reason: string; lastPhase?: string; stack?: string } }
      expect(receipt.outcome).toBe('interrupted')
      expect(receipt.interruption?.lastPhase).toBe('execute')
      expect(receipt.interruption?.stack).toContain('at builder')
      const markdown = readFileSync(join(dir, 'receipt.md'), 'utf8')
      expect(markdown).toContain('Interrupted')
      expect(markdown).toContain('during the execute phase')
      expect(markdown).toContain('ENOENT')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  afterAll(() => {
    rmSync(runDir, { recursive: true, force: true })
  })
})
